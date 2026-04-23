import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { acquireSessionWriteLock, emitSessionTranscriptUpdate } from "openclaw/plugin-sdk/agent-harness";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { resolve43ChatAccount } from "./accounts.js";
import { get43ChatRuntime } from "./runtime.js";
import { sendMessage43Chat } from "./send.js";
import { ensureGroupRoleName, resolveGroupRoleName } from "./prompt-group-context.js";
import { buildSkillEventContext } from "./skill-event-context.js";
import { extract43ChatTextContent, truncateForLog, mapGroupRoleName } from "./message-content.js";
import { ensureSessionLogDir, resolveSessionLogDir } from "./session-log-dir.js";
import type {
  Chat43AnySSEEvent,
  Chat43FriendAcceptedEventData,
  Chat43FriendRequestEventData,
  Chat43GroupInvitationEventData,
  Chat43GroupMemberJoinedEventData,
  Chat43GroupMessageEventData,
  Chat43MessageContext,
  Chat43PrivateMessageEventData,
  Chat43SystemNoticeEventData,
} from "./types.js";
import packageJson from "../package.json" with { type: "json" };

type InboundDescriptor = {
  dedupeKey: string;
  messageId: string;
  chatType: "direct" | "group";
  target: string;
  fromAddress: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  groupSubject?: string;
  conversationLabel: string;
  groupSystemPrompt?: string;
  isFromOwner?: boolean;
  commandAuthorized?: boolean;
};

const processedEvents = new Map<string, number>();
const MAX_PROCESSED_EVENTS = 2048;
const CHANNEL_ID = packageJson.openclaw.channel.id;
const MAX_EMPTY_MAIN_REPLY_ATTEMPTS = 2;
const NO_REPLY_TOKEN = "NO_REPLY";

export function formatNoReplySystemEvent(messageId: string): string {
  return `模型本轮选择了 ${NO_REPLY_TOKEN}，已静默处理，未向 43Chat 发送消息。 [message_id:${messageId}]`;
}

export function formatNoReplyTranscriptMessage(messageId: string): string {
  return `[43Chat 插件] 模型本轮选择了 ${NO_REPLY_TOKEN}，已静默处理，本地已记录，未向 43Chat 发送消息。 [message_id:${messageId}]`;
}

type DispatchAttemptOutcome =
  | { kind: "reply"; replyText: string; reason: string }
  | { kind: "no_reply"; reason: string }
  | { kind: "empty"; reason: string };

export function summarizeReplyPayloadForLog(reply: {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToCurrent?: boolean;
  isError?: boolean;
}): string {
  const summary = { ...reply };
  if (typeof summary.text === "string" && summary.text.trim()) {
    summary.text = truncateForLog(summary.text, 240);
  }
  return JSON.stringify(summary);
}

async function appendLocalTranscriptMessage(params: {
  sessionFile: string;
  sessionKey: string;
  text: string;
}): Promise<void> {
  await mkdir(path.dirname(params.sessionFile), { recursive: true });
  const lock = await acquireSessionWriteLock({
    sessionFile: params.sessionFile,
    timeoutMs: 10_000,
  });
  try {
    const sessionManager = SessionManager.open(params.sessionFile);
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: params.text }],
      api: "openai-responses",
      provider: "43chat-openclaw-plugin",
      model: "43chat-local-note",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
  } finally {
    await lock.release();
  }
  emitSessionTranscriptUpdate({
    sessionFile: params.sessionFile,
    sessionKey: params.sessionKey,
  });
}

export function looksLikeInternalToolFailureReplyText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return /^⚠️\s+📝\s+(?:Edit|Write|Read):\s+in\s+.+\s+failed$/u.test(trimmed)
    || /^⚠️\s+📝\s+(?:Edit|Write|Read):\s+.+\s+failed$/u.test(trimmed);
}

export type RecentAssistantOutputTrace = {
  eventTs: string;
  role: string;
  contentCount: number;
  blockTypes: string[];
  textCount: number;
  thinkingCount: number;
  hasText: boolean;
  hasThinking: boolean;
  textPreview: string;
  thinkingPreview: string;
  finalText: string;
  summary: string;
  traceStatus:
    | "found"
    | "log_dir_missing"
    | "log_dir_empty"
    | "logger_files_missing"
    | "no_candidate_records"
    | "all_records_before_window"
    | "nearest_before_window";
};

function buildEmptyAssistantTrace(
  traceStatus: RecentAssistantOutputTrace["traceStatus"],
  extra: Record<string, unknown> = {},
): RecentAssistantOutputTrace {
  return {
    eventTs: "", role: "", contentCount: 0, blockTypes: [], textCount: 0,
    thinkingCount: 0, hasText: false, hasThinking: false, textPreview: "",
    thinkingPreview: "", finalText: "",
    summary: JSON.stringify({ trace_status: traceStatus, ...extra }),
    traceStatus,
  };
}

const SESSION_LOG_TIME_WINDOW_TOLERANCE_MS = 10_000;
const SESSION_LOG_MAX_CANDIDATE_FILES = 4;
const SESSION_LOG_TAIL_BYTES = 65_536;

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unwrapFinalReplyTag(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^<final>([\s\S]*)<\/final>$/i);
  if (!match) return trimmed;
  return (match[1] ?? "").trim();
}

function inspectAssistantOutputRecord(record: unknown): RecentAssistantOutputTrace | null {
  if (!isPlainObject(record) || record.eventType !== "llm_output" || !isPlainObject(record.payload)) {
    return null;
  }
  const lastAssistant = isPlainObject(record.payload.lastAssistant) ? record.payload.lastAssistant : null;
  const content = Array.isArray(lastAssistant?.content) ? lastAssistant.content : [];
  const blockTypes: string[] = [];
  const textBlocks: string[] = [];
  const thinkingBlocks: string[] = [];

  for (const entry of content) {
    if (!isPlainObject(entry)) continue;
    const type = readOptionalString(entry.type) ?? "unknown";
    blockTypes.push(type);
    if (type === "text") {
      const text = readOptionalString(entry.text) ?? "";
      if (text) textBlocks.push(text);
    } else if (type === "thinking") {
      const thinking = readOptionalString(entry.thinking) ?? "";
      if (thinking) thinkingBlocks.push(thinking);
    }
  }

  const finalText = textBlocks.join("\n").trim();
  return {
    eventTs: readOptionalString(record.ts) ?? "",
    role: readOptionalString(lastAssistant?.role) ?? "",
    contentCount: content.length,
    blockTypes,
    textCount: textBlocks.length,
    thinkingCount: thinkingBlocks.length,
    hasText: finalText.length > 0,
    hasThinking: thinkingBlocks.length > 0,
    textPreview: finalText ? truncateForLog(finalText, 240) : "",
    thinkingPreview: thinkingBlocks.length > 0 ? truncateForLog(thinkingBlocks.join("\n"), 160) : "",
    finalText: unwrapFinalReplyTag(finalText),
    summary: JSON.stringify({ event_ts: readOptionalString(record.ts) ?? "" }),
    traceStatus: "found",
  };
}

export async function inspectRecentAssistantOutputFromSessionLog(params: {
  sessionKey: string;
  sinceTimestamp: number;
  env?: NodeJS.ProcessEnv;
}): Promise<RecentAssistantOutputTrace | null> {
  const logDir = resolveSessionLogDir(params.sessionKey, params.env);
  if (!existsSync(logDir)) {
    return buildEmptyAssistantTrace("log_dir_missing", { log_dir: logDir });
  }
  const entries = await readdir(logDir).catch(() => [] as string[]);
  if (entries.length === 0) {
    return buildEmptyAssistantTrace("log_dir_empty", { log_dir: logDir });
  }
  const candidates = entries
    .filter((name) => /^llm-logger-openclaw-plugin-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .sort().reverse().slice(0, SESSION_LOG_MAX_CANDIDATE_FILES);
  if (candidates.length === 0) {
    return buildEmptyAssistantTrace("logger_files_missing", { log_dir: logDir });
  }
  let nearestBeforeWindow: RecentAssistantOutputTrace | null = null;
  let stoppedByWindow = false;
  let sawCandidateRecord = false;

  for (const fileName of candidates) {
    try {
      const raw = await readFile(`${logDir}/${fileName}`, "utf8").catch(() => "");
      const tail = raw.length > SESSION_LOG_TAIL_BYTES ? raw.slice(-SESSION_LOG_TAIL_BYTES) : raw;
      const lines = tail.split("\n").filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const record = JSON.parse(lines[i]!) as unknown;
          const ts = isPlainObject(record) ? Date.parse(readOptionalString(record.ts) ?? "") : Number.NaN;
          const trace = inspectAssistantOutputRecord(record);
          if (trace && Number.isFinite(ts) && ts < params.sinceTimestamp - SESSION_LOG_TIME_WINDOW_TOLERANCE_MS) {
            if (!nearestBeforeWindow) nearestBeforeWindow = { ...trace, traceStatus: "nearest_before_window" };
            stoppedByWindow = true;
            break;
          }
          if (trace) { sawCandidateRecord = true; return trace; }
        } catch { continue; }
      }
    } catch { continue; }
  }

  if (nearestBeforeWindow) return nearestBeforeWindow;
  return buildEmptyAssistantTrace(
    stoppedByWindow && !sawCandidateRecord ? "all_records_before_window" : "no_candidate_records",
    { log_dir: logDir },
  );
}

export async function recoverRecentFinalReplyFromSessionLog(params: {
  sessionKey: string;
  sinceTimestamp: number;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  return (await inspectRecentAssistantOutputFromSessionLog(params))?.finalText ?? "";
}

function formatVisibleInboundContent(contentType: string, content: string): string {
  switch (contentType) {
    case "text":
      return content;
    case "image":
      return `[图片]${content || ""}`;
    case "file":
      return `[文件]${content || ""}`;
    case "sharegroup":
      return `[群组卡片]${content || ""}`;
    case "shareuser":
      return `[用户卡片]${content || ""}`;
    default:
      return content || `[${contentType}]`;
  }
}

function buildOwnerAllowFromEntries(inbound: InboundDescriptor): string[] {
  const values = [inbound.senderId, inbound.fromAddress];
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

export function buildDispatchConfigForInbound(cfg: ClawdbotConfig, isFromOwner: boolean): ClawdbotConfig {
  if (isFromOwner) return cfg;
  return {
    ...cfg,
    tools: {
      ...cfg.tools,
      deny: Array.from(new Set([...(cfg.tools?.deny ?? []), "*"])),
    },
  };
}

function wrapMessageText(text: string, _isFromOwner: boolean): string {
  return text;
}

function rememberProcessedEvent(key: string): boolean {
  if (processedEvents.has(key)) return true;
  processedEvents.set(key, Date.now());
  if (processedEvents.size > MAX_PROCESSED_EVENTS) {
    processedEvents.delete(processedEvents.keys().next().value!);
  }
  return false;
}

function fallbackMessageId(event: Chat43AnySSEEvent): string {
  return createHash("sha1").update(JSON.stringify(event)).digest("hex").slice(0, 16);
}

function resolveBusinessId(event: Chat43AnySSEEvent): string {
  switch (event.event_type) {
    case "private_message":
      return String((event.data as Chat43PrivateMessageEventData).message_id || fallbackMessageId(event));
    case "group_message":
      return String((event.data as Chat43GroupMessageEventData).message_id || fallbackMessageId(event));
    case "friend_request":
      return `friend_request:${(event.data as Chat43FriendRequestEventData).request_id}`;
    case "friend_accepted":
      return `friend_accepted:${(event.data as Chat43FriendAcceptedEventData).request_id}`;
    case "group_invitation":
      return `group_invitation:${(event.data as Chat43GroupInvitationEventData).invitation_id}`;
    case "group_member_joined": {
      const d = event.data as Chat43GroupMemberJoinedEventData;
      return `group_member_joined:${d.group_id}:${d.user_id}:${d.join_method}`;
    }
    case "system_notice":
      return `system_notice:${(event.data as Chat43SystemNoticeEventData).notice_id || fallbackMessageId(event)}`;
    default:
      return fallbackMessageId(event);
  }
}

function buildInboundDescriptor(
  event: Chat43AnySSEEvent,
  options?: { cfg?: ClawdbotConfig; accountId?: string; resolvedRoleNameOverride?: string; resolvedSenderRoleNameOverride?: string },
): InboundDescriptor | null {
  const businessId = resolveBusinessId(event);
  const messageId = businessId;
  const dedupeKey = `${event.event_type}:${event.id || businessId}`;

  switch (event.event_type) {
    case "private_message": {
      const data = event.data as Chat43PrivateMessageEventData;
      const senderId = String(data.from_user_id);
      const senderName = data.from_nickname || senderId;
      const rawContent = String(data.content ?? "").trim();
      const content = data.content_type === "text" ? extract43ChatTextContent(rawContent) : rawContent;
      const skillContext = buildSkillEventContext({
        cfg: options?.cfg,
        eventType: "private_message",
        accountId: options?.accountId,
        isFromOwner: data.is_from_owner ?? false,
        userId: senderId,
        senderName,
      });
      const text = formatVisibleInboundContent(data.content_type, content);
      if (!text) return null;
      return {
        dedupeKey, messageId, chatType: "direct", target: `user:${senderId}`,
        fromAddress: `${CHANNEL_ID}:user:${senderId}`, senderId, senderName,
        text: wrapMessageText(text, data.is_from_owner ?? false),
        timestamp: data.timestamp || event.timestamp || Date.now(),
        conversationLabel: `user:${senderId}`,
        groupSystemPrompt: skillContext.prompt,
        isFromOwner: data.is_from_owner ?? false,
        commandAuthorized: data.is_from_owner ?? false,
      };
    }
    case "group_message": {
      const data = event.data as Chat43GroupMessageEventData;
      const groupId = String(data.group_id);
      const groupName = data.group_name || `群${groupId}`;
      const senderId = String(data.from_user_id);
      const senderName = data.from_nickname || senderId;
      const rawContent = String(data.content ?? "").trim();
      const content = data.content_type === "text" ? extract43ChatTextContent(rawContent) : rawContent;
      const roleName = options?.resolvedRoleNameOverride
        ?? mapGroupRoleName(data.user_role, data.user_role_name)
        ?? "未知";
      const senderRoleName = options?.resolvedSenderRoleNameOverride
        ?? mapGroupRoleName(
          data.from_user_role ?? data.user_role,
          data.from_user_role_name ?? data.user_role_name,
        )
        ?? "未知";
      const skillContext = buildSkillEventContext({
        cfg: options?.cfg,
        eventType: "group_message",
        accountId: options?.accountId,
        isFromOwner: data.is_from_owner ?? false,
        roleName,
        messageText: content,
        groupId,
        groupName,
        userId: senderId,
        senderName,
        senderRoleName,
      });
      const text = formatVisibleInboundContent(data.content_type, content);
      if (!text) return null;
      return {
        dedupeKey, messageId, chatType: "group", target: `group:${groupId}`,
        fromAddress: `${CHANNEL_ID}:group:${groupId}`, senderId, senderName,
        text: wrapMessageText(text, data.is_from_owner ?? false),
        timestamp: data.timestamp || event.timestamp || Date.now(),
        groupSubject: groupId, conversationLabel: `group:${groupId}`,
        groupSystemPrompt: skillContext.prompt,
        isFromOwner: data.is_from_owner ?? false,
        commandAuthorized: data.is_from_owner ?? false,
      };
    }
    case "friend_request": {
      const data = event.data as Chat43FriendRequestEventData;
      const senderId = String(data.from_user_id);
      const senderName = data.from_nickname || senderId;
      const skillContext = buildSkillEventContext({
        cfg: options?.cfg,
        eventType: "friend_request",
        accountId: options?.accountId,
        isFromOwner: false,
        userId: senderId,
        senderName,
      });
      return {
        dedupeKey, messageId, chatType: "direct", target: `user:${senderId}`,
        fromAddress: `${CHANNEL_ID}:user:${senderId}`, senderId, senderName,
        text: wrapMessageText(`[43Chat好友请求] 用户 ${senderId}${data.from_nickname ? `(${data.from_nickname})` : ""} 请求添加好友，附言：${data.request_msg || "无"}，request_id=${data.request_id}`, false),
        timestamp: data.timestamp || event.timestamp || Date.now(),
        conversationLabel: `user:${senderId}`,
        groupSystemPrompt: skillContext.prompt,
        isFromOwner: false,
        commandAuthorized: false,
      };
    }
    case "friend_accepted": {
      const data = event.data as Chat43FriendAcceptedEventData;
      const senderId = String(data.from_user_id);
      const senderName = data.from_nickname || senderId;
      const skillContext = buildSkillEventContext({
        cfg: options?.cfg,
        eventType: "friend_accepted",
        accountId: options?.accountId,
        isFromOwner: false,
        userId: senderId,
        senderName,
      });
      return {
        dedupeKey, messageId, chatType: "direct", target: `user:${senderId}`,
        fromAddress: `${CHANNEL_ID}:user:${senderId}`, senderId, senderName,
        text: `[43Chat好友通过] 用户 ${senderId}${data.from_nickname ? `(${data.from_nickname})` : ""} 已通过好友请求，request_id=${data.request_id}`,
        timestamp: data.timestamp || event.timestamp || Date.now(),
        conversationLabel: `user:${senderId}`,
        groupSystemPrompt: skillContext.prompt,
        isFromOwner: false,
        commandAuthorized: false,
      };
    }
    case "group_invitation": {
      const data = event.data as Chat43GroupInvitationEventData;
      const groupId = String(data.group_id);
      const groupName = data.group_name || `群${groupId}`;
      const applicantUserId = String(data.inviter_id);
      const applicantName = data.inviter_name || applicantUserId;
      const roleName = resolveGroupRoleName({ groupId, accountId: options?.accountId, fallbackRoleName: "管理员" });
      const skillContext = buildSkillEventContext({
        cfg: options?.cfg,
        eventType: "group_invitation",
        accountId: options?.accountId,
        isFromOwner: false,
        roleName,
        groupId,
        groupName,
        userId: applicantUserId,
        senderName: applicantName,
      });
      const requestId = String(data.invitation_id);
      const text = [
        "[系统提示]", "【待处理任务：43Chat 入群申请审核】",
        "这不是普通聊天消息，而是一个需要你执行后续动作的管理任务。",
        "不要只回复收到或等待审核。你必须先根据申请信息做判断。",
        "如决定通过或拒绝，请调用工具 chat43_handle_group_join_request 执行动作。",
        "", "[申请信息]",
        `account_id=${options?.accountId ?? "default"}`, `group_id=${groupId}`,
        `group_name=${data.group_name || "未知群"}`, `request_id=${requestId}`,
        `invitation_id=${requestId}`, `applicant_user_id=${applicantUserId}`,
        `applicant_name=${applicantName}`, `application_message=${data.invite_msg || "无"}`,
      ].join("\n");
      return {
        dedupeKey, messageId, chatType: "group", target: `group:${groupId}`,
        fromAddress: `${CHANNEL_ID}:group:${groupId}`, senderId: applicantUserId,
        senderName: applicantName, text: wrapMessageText(text, false),
        timestamp: data.timestamp || event.timestamp || Date.now(),
        groupSubject: groupId, conversationLabel: `group:${groupId}`,
        groupSystemPrompt: skillContext.prompt,
        isFromOwner: false,
        commandAuthorized: false,
      };
    }
    case "group_member_joined": {
      const data = event.data as Chat43GroupMemberJoinedEventData;
      const groupId = String(data.group_id);
      const userId = String(data.user_id);
      const groupName = data.group_name || `群${groupId}`;
      const roleName = resolveGroupRoleName({ groupId, accountId: options?.accountId, fallbackRoleName: "成员" });
      const skillContext = buildSkillEventContext({
        cfg: options?.cfg,
        eventType: "group_member_joined",
        accountId: options?.accountId,
        isFromOwner: false,
        roleName,
        groupId,
        groupName,
        userId,
        senderName: data.nickname || userId,
      });
      return {
        dedupeKey, messageId, chatType: "group", target: `group:${groupId}`,
        fromAddress: `${CHANNEL_ID}:group:${groupId}`, senderId: userId,
        senderName: data.nickname || userId,
        text: wrapMessageText(`[43Chat群通知] 新成员入群，group_id=${groupId}，group_name=${data.group_name || "未知群"}，user_id=${userId}，nickname=${data.nickname || userId}，join_method=${data.join_method || "unknown"}`, false),
        timestamp: data.timestamp || event.timestamp || Date.now(),
        groupSubject: groupId, conversationLabel: `group:${groupId}`,
        groupSystemPrompt: skillContext.prompt,
        isFromOwner: false,
        commandAuthorized: false,
      };
    }
    case "system_notice": {
      const data = event.data as Chat43SystemNoticeEventData;
      const skillContext = buildSkillEventContext({
        cfg: options?.cfg,
        eventType: "system_notice",
        accountId: options?.accountId,
        isFromOwner: false,
      });
      return {
        dedupeKey, messageId, chatType: "direct", target: "user:0",
        fromAddress: `${CHANNEL_ID}:user:0`, senderId: "0", senderName: "system",
        text: wrapMessageText(`[43Chat系统通知][${data.level || "info"}] ${data.title || "系统通知"}: ${data.content || ""}`.trim(), false),
        timestamp: data.timestamp || event.timestamp || Date.now(),
        conversationLabel: "user:0",
        groupSystemPrompt: skillContext.prompt,
        isFromOwner: false,
        commandAuthorized: false,
      };
    }
    default:
      return null;
  }
}

function chunkReplyText(
  text: string,
  chunkMode: "length" | "newline" | "raw",
  textChunkLimit: number,
  chunkTextWithMode: (text: string, limit: number, mode: "length" | "newline") => Iterable<string>,
): string[] {
  if (!text) return [];
  if (chunkMode === "raw") {
    if (text.length <= textChunkLimit) return [text];
    return Array.from(chunkTextWithMode(text, textChunkLimit, "length"));
  }
  return Array.from(chunkTextWithMode(text, textChunkLimit, chunkMode));
}

export function looksLikeDispatchTimeoutError(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /\btimeout\b|\btimed out\b|\babort(?:ed|error)?\b/iu.test(message);
}

export function shouldRetryDispatchAfterFailure(params: {
  attempt: number;
  maxAttempts: number;
  error?: unknown;
  replyDispatcherErrored?: boolean;
}): boolean {
  if (params.attempt >= params.maxAttempts) return false;
  return Boolean(params.error) || params.replyDispatcherErrored === true;
}

export function map43ChatEventToInboundDescriptor(
  event: Chat43AnySSEEvent,
  options?: { cfg?: ClawdbotConfig; accountId?: string; resolvedRoleNameOverride?: string; resolvedSenderRoleNameOverride?: string },
): InboundDescriptor | null {
  return buildInboundDescriptor(event, options);
}

export type Handle43ChatEventParams = {
  cfg: ClawdbotConfig;
  event: Chat43AnySSEEvent;
  accountId: string;
  runtime?: RuntimeEnv;
};

export async function handle43ChatEvent(
  params: Handle43ChatEventParams,
): Promise<Chat43MessageContext | null> {
  const { cfg, event, accountId, runtime } = params;
  const consoleRef = (globalThis as any)?.console;
  const log = runtime?.log ?? consoleRef?.log?.bind(consoleRef) ?? (() => {});
  const error = runtime?.error ?? consoleRef?.error?.bind(consoleRef) ?? (() => {});

  log(`43chat[${accountId}]: inbound event ${event.event_type} (${resolveBusinessId(event)}) ${JSON.stringify(event)}`);

  const account = resolve43ChatAccount({ cfg, accountId });
  if (!account.enabled || !account.configured) {
    error(`43chat[${accountId}]: account not enabled or configured`);
    return null;
  }

  let resolvedRoleNameOverride: string | undefined;
  let resolvedSenderRoleNameOverride: string | undefined;
  if (event.event_type === "group_message") {
    const data = event.data as Chat43GroupMessageEventData;
    resolvedRoleNameOverride = mapGroupRoleName(data.user_role, data.user_role_name);
    resolvedSenderRoleNameOverride = mapGroupRoleName(
      data.from_user_role ?? data.user_role,
      data.from_user_role_name ?? data.user_role_name,
    );
  } else if (event.event_type === "group_invitation" || event.event_type === "group_member_joined") {
    const groupId = event.event_type === "group_invitation"
      ? String((event.data as Chat43GroupInvitationEventData).group_id)
      : String((event.data as Chat43GroupMemberJoinedEventData).group_id);
    resolvedRoleNameOverride = await ensureGroupRoleName({ account, groupId, runtime });
  }

  const earlyDedupeKey = resolveBusinessId(event);
  if (rememberProcessedEvent(earlyDedupeKey)) return null;

  const inbound = buildInboundDescriptor(event, { cfg, accountId, resolvedRoleNameOverride, resolvedSenderRoleNameOverride });
  if (!inbound) return null;

  if (inbound.dedupeKey !== earlyDedupeKey && rememberProcessedEvent(inbound.dedupeKey)) return null;

  const core = get43ChatRuntime();
  const route = core.channel.routing.resolveAgentRoute({
    cfg, channel: CHANNEL_ID, accountId,
    peer: { kind: inbound.chatType === "group" ? "group" : "direct", id: inbound.target },
  });

  if (!route.agentId) {
    log(`43chat[${accountId}]: no agent route found for ${inbound.target}`);
    return null;
  }

  const sessionKey = route.sessionKey;
  const sessionStorePath = core.agent.session.resolveStorePath(cfg.session?.store, { agentId: route.agentId });
  const sessionStore = core.agent.session.loadSessionStore(sessionStorePath);
  const sessionEntry = sessionStore[sessionKey];
  const sessionFile = sessionEntry?.sessionId
    ? core.agent.session.resolveSessionFilePath(sessionEntry.sessionId, sessionEntry, { agentId: route.agentId })
    : undefined;

  try { ensureSessionLogDir(sessionKey); } catch {}

  core.system.enqueueSystemEvent(`43Chat[${accountId}] ${inbound.chatType} ${inbound.target}:`, {
    sessionKey,
    contextKey: `${CHANNEL_ID}:${inbound.messageId}`,
  });

  const textChunkLimit = core.channel.text.resolveTextChunkLimit(cfg, CHANNEL_ID, accountId, {
    fallbackLimit: account.config.textChunkLimit ?? 1800,
  });
  const chunkMode = account.config.chunkMode ?? core.channel.text.resolveChunkMode(cfg, CHANNEL_ID, accountId);

  const sendReply = async (text: string): Promise<void> => {
    if (!text.trim() || text.trim() === NO_REPLY_TOKEN) return;
    const chunks = chunkReplyText(text, chunkMode, textChunkLimit, core.channel.text.chunkTextWithMode)
      .filter((c) => c.length > 0);
    for (const chunk of chunks) {
      await sendMessage43Chat({ cfg, to: inbound.target, text: chunk, accountId });
    }
  };

  const maxAttempts = MAX_EMPTY_MAIN_REPLY_ATTEMPTS;
  let retryAttempted = false;
  let retryReason = "";

  const runDispatchAttempt = async (attemptInbound: InboundDescriptor) => {
    const attemptStartedAt = Date.now();
    const dispatchCfg = buildDispatchConfigForInbound(cfg, attemptInbound.isFromOwner === true);
    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: core.channel.reply.formatInboundEnvelope({
        channel: CHANNEL_ID, from: attemptInbound.conversationLabel,
        body: attemptInbound.text, timestamp: attemptInbound.timestamp,
        chatType: attemptInbound.chatType,
        sender: { name: attemptInbound.senderName, id: attemptInbound.senderId },
      }),
      BodyForAgent: attemptInbound.text,
      BodyForCommands: attemptInbound.text,
      RawBody: attemptInbound.text, CommandBody: attemptInbound.text,
      From: attemptInbound.fromAddress, To: attemptInbound.target,
      SessionKey: sessionKey, AccountId: route.accountId,
      ChatType: attemptInbound.chatType, ConversationLabel: attemptInbound.conversationLabel,
      GroupSubject: attemptInbound.groupSubject,
      GroupSystemPrompt: attemptInbound.groupSystemPrompt,
      OwnerAllowFrom: attemptInbound.isFromOwner ? buildOwnerAllowFromEntries(attemptInbound) : [],
      SenderName: attemptInbound.senderName, SenderId: attemptInbound.senderId,
      Provider: CHANNEL_ID, Surface: CHANNEL_ID,
      MessageSid: attemptInbound.messageId, Timestamp: attemptInbound.timestamp,
      WasMentioned: attemptInbound.chatType !== "group",
      CommandAuthorized: attemptInbound.commandAuthorized ?? true,
      ForceSenderIsOwnerFalse: attemptInbound.isFromOwner ? undefined : true,
      OriginatingChannel: CHANNEL_ID, OriginatingTo: attemptInbound.target,
    });

    let deliverSawFinal = false;
    let replyDispatcherErrored = false;
    let finalText = "";

    const { dispatcher, replyOptions, markDispatchIdle } = core.channel.reply.createReplyDispatcherWithTyping({
      deliver: async (reply: { text?: string; mediaUrl?: string; mediaUrls?: string[]; replyToCurrent?: boolean }, { kind }: { kind: string }) => {
        if (kind !== "final") return;
        if ((reply as any).isError || looksLikeInternalToolFailureReplyText(reply.text ?? "")) return;
        deliverSawFinal = true;
        const text = reply.text ?? "";
        if (!text.trim() && ((reply as any).mediaUrl || ((reply as any).mediaUrls?.length ?? 0) > 0)) {
          finalText = "[43Chat 插件暂不支持媒体消息发送]";
          return;
        }
        if (text.trim()) finalText = unwrapFinalReplyTag(text);
      },
      onError: (err: unknown, info: { kind: string }) => {
        replyDispatcherErrored = true;
        error(`43chat[${accountId}] ${info.kind} reply failed: ${String(err)}`);
      },
      onIdle: () => {},
    });

    const runDispatch = () => core.channel.reply.dispatchReplyFromConfig({
      ctx: ctxPayload, cfg: dispatchCfg, dispatcher,
      replyOptions: { ...replyOptions, disableBlockStreaming: !(account.config.blockStreaming ?? false) },
    });

    const withReplyDispatcher = (core.channel.reply as any).withReplyDispatcher;
    let dispatchResult: { queuedFinal: boolean; counts: { final: number } } | undefined;
    if (typeof withReplyDispatcher === "function") {
      dispatchResult = await withReplyDispatcher({ dispatcher, run: runDispatch, onSettled: () => markDispatchIdle() });
    } else {
      try { dispatchResult = await runDispatch(); } finally { markDispatchIdle(); }
    }

    if (!finalText.trim() || replyDispatcherErrored) {
      const trace = await inspectRecentAssistantOutputFromSessionLog({ sessionKey, sinceTimestamp: attemptStartedAt });
      if (trace?.finalText) {
        finalText = trace.finalText.trim();
        log(`43chat[${accountId}]: recovered final reply from llm log`);
      }
    }

    return { dispatchResult, deliverSawFinal, replyDispatcherErrored, finalText: finalText.trim() };
  };

  try {
    log(`43chat[${accountId}]: dispatch attempt=1/${maxAttempts} message=${inbound.messageId} session=${sessionKey}`);
    let result: Awaited<ReturnType<typeof runDispatchAttempt>> | null = null;
    let firstAttemptError: unknown;

    try { result = await runDispatchAttempt(inbound); } catch (err) { firstAttemptError = err; }

    if (shouldRetryDispatchAfterFailure({ attempt: 1, maxAttempts, error: firstAttemptError, replyDispatcherErrored: result?.replyDispatcherErrored })) {
      retryReason = firstAttemptError
        ? (looksLikeDispatchTimeoutError(firstAttemptError) ? "first attempt timed out" : "first attempt failed")
        : "reply dispatcher reported an error";
      retryAttempted = true;
      log(`43chat[${accountId}]: dispatch attempt=2/${maxAttempts} retry_reason=${retryReason}`);
      result = await runDispatchAttempt(inbound);
    } else if (firstAttemptError) {
      throw firstAttemptError;
    }

    if (!result) throw new Error(`43chat[${accountId}]: dispatch settled without result`);

    const finalReplyText = result.finalText;
    log(`43chat[${accountId}]: final reply=${truncateForLog(finalReplyText || "<empty>", 240)} retry=${retryAttempted} retry_reason=${retryReason}`);

    if (result.replyDispatcherErrored) {
      return { messageId: inbound.messageId, senderId: inbound.senderId, text: inbound.text, timestamp: inbound.timestamp, target: inbound.target, chatType: inbound.chatType };
    }

    if (finalReplyText && finalReplyText !== NO_REPLY_TOKEN) {
      await sendReply(finalReplyText);
    } else {
      log(`43chat[${accountId}]: model chose ${NO_REPLY_TOKEN} for ${inbound.messageId}`);
      core.system.enqueueSystemEvent(formatNoReplySystemEvent(inbound.messageId), {
        sessionKey,
        contextKey: `${CHANNEL_ID}:${inbound.messageId}:no_reply`,
      });
      if (sessionFile) {
        try {
          await appendLocalTranscriptMessage({
            sessionFile,
            sessionKey,
            text: formatNoReplyTranscriptMessage(inbound.messageId),
          });
        } catch (appendErr) {
          error(`43chat[${accountId}]: failed to append local NO_REPLY transcript note: ${String(appendErr)}`);
        }
      } else {
        log(`43chat[${accountId}]: missing session file for local NO_REPLY transcript note session=${sessionKey}`);
      }
    }
  } catch (err) {
    error(`43chat[${accountId}]: failed to dispatch message: ${String(err)}`);
  }

  return {
    messageId: inbound.messageId, senderId: inbound.senderId,
    text: inbound.text, timestamp: inbound.timestamp,
    target: inbound.target, chatType: inbound.chatType,
  };
}

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { resolve43ChatAccount } from "./accounts.js";
import { create43ChatClient } from "./client.js";
import { get43ChatRuntime } from "./runtime.js";
import { sendMessage43Chat } from "./send.js";
import { ensureGroupRoleName, resolveGroupRoleName } from "./prompt-group-context.js";
import {
  type CognitionWriteRequirementIssue,
  ensureSkillCognitionBootstrap,
  finalizeSkillDecision,
  inspectGroupMessageCognitionWriteRequirements,
  inspectPrivateMessageCognitionWriteRequirements,
  normalizeSkillCognitionWriteContent,
  updateSkillAgentRole,
  updateSkillCognitionFromEvent,
} from "./cognition-bootstrap.js";
import { buildSkillEventContext } from "./skill-event-context.js";
import {
  buildDecisionBriefPromptBlocks,
  scheduleDecisionBriefRefresh,
} from "./cognition-batch.js";
import { scheduleLongTermCognitionRefresh } from "./cognition-worker.js";
import { extract43ChatTextContent, truncateForLog } from "./message-content.js";
import { evaluateReplyPolicy } from "./reply-policy.js";
import { ensureSessionLogDir, resolveSessionLogDir } from "./session-log-dir.js";
import {
  load43ChatSkillRuntime,
  resolveSkillCognitionPolicy,
  resolveSkillModerationPolicy,
  resolveSkillReplyDelivery,
  shouldRequireStructuredModerationDecisionForRole,
  type SkillRuntimeModerationDecisionKind,
  type SkillRuntimeModerationStage,
  type SkillRuntimePromptBlock,
} from "./skill-runtime.js";
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
  suppressTextReply?: boolean;
};

const processedEvents = new Map<string, number>();
const MAX_PROCESSED_EVENTS = 2048;
const CHANNEL_ID = packageJson.openclaw.channel.id;
const COGNITION_STORAGE_ROOT = join(homedir(), ".config", "43chat");

type CognitionWriteEnvelope = {
  writes: Array<{
    path: string;
    content: Record<string, unknown>;
  }>;
  replyText: string;
  decision?: CognitionEnvelopeModerationDecision;
};

type CognitionEnvelopeModerationDecision = {
  kind: SkillRuntimeModerationDecisionKind;
  reason?: string;
  scenario?: string;
  stage?: SkillRuntimeModerationStage;
  targetUserId?: string;
  publicReply?: boolean;
};

type DispatchAttemptOutcome =
  | {
    kind: "reply";
    replyText: string;
    reason: string;
  }
  | {
    kind: "no_reply";
    reason: string;
  }
  | {
    kind: "empty";
    reason: string;
  }
  | {
    kind: "suppressed";
    reason: string;
  };

type GroupAttemptResolution =
  | {
    action: "record";
    decision: string;
    reason: string;
  }
  | {
    action: "send_reply";
    replyText: string;
    reason: string;
  };
const MAX_EMPTY_MAIN_REPLY_ATTEMPTS = 2;

export function summarizeReplyPayloadForLog(reply: {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToCurrent?: boolean;
  isError?: boolean;
}): string {
  const summary: {
    text?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
    replyToCurrent?: boolean;
    isError?: boolean;
  } = {
    ...reply,
  };
  if (typeof summary.text === "string" && summary.text.trim()) {
    summary.text = truncateForLog(summary.text, 240);
  }
  return JSON.stringify(summary);
}

export function looksLikeInternalToolFailureReplyText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  return /^⚠️\s+📝\s+(?:Edit|Write|Read):\s+in\s+.+\s+failed$/u.test(trimmed)
    || /^⚠️\s+📝\s+(?:Edit|Write|Read):\s+.+\s+failed$/u.test(trimmed);
}

export function describeFinalReplyResolutionForLog(params: {
  cognitionEnvelope: CognitionWriteEnvelope | null;
  finalReplyText: string;
  noReplyToken: string;
}): string {
  const rawKind = params.cognitionEnvelope ? "cognition_envelope" : "plain_text";
  const writesCount = params.cognitionEnvelope?.writes.length ?? 0;
  if (!params.finalReplyText) {
    return `raw_kind=${rawKind} writes=${writesCount} outward=<empty>`;
  }
  if (params.finalReplyText === params.noReplyToken) {
    return `raw_kind=${rawKind} writes=${writesCount} outward=${params.noReplyToken}`;
  }
  return `raw_kind=${rawKind} writes=${writesCount} outward=${truncateForLog(params.finalReplyText, 240)}`;
}

function extractTextFromLlmLoggerOutputRecord(record: unknown): string {
  if (!isPlainObject(record) || record.eventType !== "llm_output" || !isPlainObject(record.payload)) {
    return "";
  }
  const lastAssistant = isPlainObject(record.payload.lastAssistant)
    ? record.payload.lastAssistant
    : null;
  const content = Array.isArray(lastAssistant?.content) ? lastAssistant.content : [];
  return content
    .map((entry) => {
      if (!isPlainObject(entry) || entry.type !== "text") {
        return "";
      }
      return readOptionalString(entry.text) ?? "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function unwrapFinalReplyTag(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^<final>([\s\S]*)<\/final>$/i);
  if (!match) {
    return trimmed;
  }
  return (match[1] ?? "").trim();
}

function extractLegacyXmlEnvelopeBlock(raw: string, tagName: string): string | undefined {
  const match = raw.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, "i"));
  return match?.[1]?.trim();
}

function parseLegacyXmlStyleCognitionEnvelope(raw: string): CognitionWriteEnvelope | null {
  const replyText = extractLegacyXmlEnvelopeBlock(raw, "reply");
  const writesRaw = extractLegacyXmlEnvelopeBlock(raw, "writes");
  const decisionRaw = extractLegacyXmlEnvelopeBlock(raw, "decision");

  if (replyText === undefined && writesRaw === undefined && decisionRaw === undefined) {
    return null;
  }

  let writes: Array<{ path: string; content: Record<string, unknown> }> = [];
  if (writesRaw !== undefined) {
    try {
      const parsedWrites = parseLooseCognitionEnvelopeJson(writesRaw);
      const normalizedWrites = parseEnvelopeWrites(parsedWrites);
      if (!normalizedWrites) {
        return null;
      }
      writes = normalizedWrites;
    } catch {
      return null;
    }
  }

  let decision: CognitionEnvelopeModerationDecision | undefined;
  if (decisionRaw !== undefined) {
    try {
      const parsedDecision = parseLooseCognitionEnvelopeJson(decisionRaw);
      decision = parseCognitionEnvelopeDecision(parsedDecision)
        ?? parseLegacyCognitionEnvelopeModerationDecision(parsedDecision);
    } catch {
      return null;
    }
  }

  return {
    writes,
    replyText: replyText ?? "",
    ...(decision ? { decision } : {}),
  };
}

export function extractReusableOutwardReplyText(text: string): string {
  const parsedEnvelope = parseCognitionWriteEnvelope(text);
  if (parsedEnvelope) {
    return parsedEnvelope.replyText.trim();
  }
  return unwrapFinalReplyTag(text).trim();
}

export function recoverRecentFinalReplyFromSessionLog(params: {
  sessionKey: string;
  sinceTimestamp: number;
  env?: NodeJS.ProcessEnv;
}): string {
  const logDir = resolveSessionLogDir(params.sessionKey, params.env);
  if (!existsSync(logDir)) {
    return "";
  }

  const candidates = readdirSync(logDir)
    .filter((name) => /^llm-logger-openclaw-plugin-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .sort()
    .reverse()
    .slice(0, 2);

  for (const fileName of candidates) {
    try {
      const raw = readFileSync(join(logDir, fileName), "utf8");
      const tail = raw.length > 1_000_000 ? raw.slice(-1_000_000) : raw;
      const lines = tail.split("\n").filter(Boolean);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        try {
          const record = JSON.parse(line) as unknown;
          const ts = isPlainObject(record) ? Date.parse(readOptionalString(record.ts) ?? "") : Number.NaN;
          if (Number.isFinite(ts) && ts < params.sinceTimestamp - 1_000) {
            break;
          }
          const text = extractTextFromLlmLoggerOutputRecord(record);
          if (text) {
            return unwrapFinalReplyTag(text);
          }
        } catch {
          continue;
        }
      }
    } catch {
      continue;
    }
  }

  return "";
}

function mapGroupRoleName(roleValue?: number, roleNameValue?: string): string | undefined {
  const normalizedRoleName = roleNameValue?.trim();
  if (roleValue === 2 || normalizedRoleName === "owner") {
    return "群主";
  }
  if (roleValue === 1 || normalizedRoleName === "admin") {
    return "管理员";
  }
  if (roleValue === 0 || normalizedRoleName === "member") {
    return "成员";
  }
  return normalizedRoleName || undefined;
}

function rememberProcessedEvent(key: string): boolean {
  if (processedEvents.has(key)) {
    return true;
  }
  processedEvents.set(key, Date.now());
  if (processedEvents.size > MAX_PROCESSED_EVENTS) {
    const entries = Array.from(processedEvents.entries())
      .sort((a, b) => a[1] - b[1])
      .slice(0, Math.floor(MAX_PROCESSED_EVENTS / 2));
    for (const [entryKey] of entries) {
      processedEvents.delete(entryKey);
    }
  }
  return false;
}

function fallbackMessageId(event: Chat43AnySSEEvent): string {
  return createHash("sha1")
    .update(JSON.stringify(event))
    .digest("hex")
    .slice(0, 16);
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
    case "group_member_joined":
      return `group_member_joined:${(event.data as Chat43GroupMemberJoinedEventData).group_id}:${(event.data as Chat43GroupMemberJoinedEventData).user_id}:${(event.data as Chat43GroupMemberJoinedEventData).join_method}`;
    case "system_notice":
      return `system_notice:${(event.data as Chat43SystemNoticeEventData).notice_id || fallbackMessageId(event)}`;
    default:
      return fallbackMessageId(event);
  }
}

function buildInboundDescriptor(
  event: Chat43AnySSEEvent,
  options?: {
    cfg?: ClawdbotConfig;
    accountId?: string;
    resolvedRoleNameOverride?: string;
    resolvedSenderRoleNameOverride?: string;
    extraPromptBlocks?: SkillRuntimePromptBlock[];
  },
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
      const content = data.content_type === "text"
        ? extract43ChatTextContent(rawContent)
        : rawContent;
      let text: string;
      switch (data.content_type) {
        case "text":
          text = `[43Chat私聊消息][类型：文本][来源用户昵称：${senderName}][来源用户ID：${senderId}][内容：${content}]`;
          break;
        case "image":
          text = `[43Chat私聊消息][类型：图片][来源用户昵称：${senderName}][来源用户ID：${senderId}][图片对象：${content || "<empty>"}]`;
          break;
        case "file":
          text = `[43Chat私聊消息][类型：文件][来源用户昵称：${senderName}][来源用户ID：${senderId}][文件对象：${content || "<empty>"}]`;
          break;
        case "sharegroup":
          text = `[43Chat私聊消息][类型：群组卡片][来源用户昵称：${senderName}][来源用户ID：${senderId}][卡片对象：${content || "<empty>"}]`;
          break;
        case "shareuser":
          text = `[43Chat私聊消息][类型：用户卡片][来源用户昵称：${senderName}][来源用户ID：${senderId}][卡片对象：${content || "<empty>"}]`;
          break;
        default:
          text = `[43Chat私聊消息][类型：${data.content_type}][来源用户昵称：${senderName}][来源用户ID：${senderId}][内容：${content || "<empty>"}]`;
          break;
      }
      if (!text) {
        return null;
      }

      const skillContext = buildSkillEventContext({
        cfg: options?.cfg,
        eventType: "private_message",
        accountId: options?.accountId,
        userId: senderId,
        senderName,
        extraPromptBlocks: options?.extraPromptBlocks,
      });

      return {
        dedupeKey,
        messageId,
        chatType: "direct",
        target: `user:${senderId}`,
        fromAddress: `${CHANNEL_ID}:user:${senderId}`,
        senderId,
        senderName,
        text,
        timestamp: data.timestamp || event.timestamp || Date.now(),
        conversationLabel: `user:${senderId}`,
        groupSystemPrompt: skillContext.prompt,
        suppressTextReply: skillContext.replyMode === "suppress_text_reply",
      };
    }
    case "group_message": {
      const data = event.data as Chat43GroupMessageEventData;
      const groupId = String(data.group_id);
      const groupName = data.group_name || `群${groupId}`;
      const senderId = String(data.from_user_id);
      const senderName = data.from_nickname || senderId;
      const senderRoleName = options?.resolvedSenderRoleNameOverride
        ?? mapGroupRoleName(
          data.from_user_role ?? data.user_role,
          data.from_user_role_name ?? data.user_role_name,
        )
        ?? "未知";
      const roleName = options?.resolvedRoleNameOverride
        ?? mapGroupRoleName(data.user_role, data.user_role_name)
        ?? "未知";
      const rawContent = String(data.content ?? "").trim();
      const content = data.content_type === "text"
        ? extract43ChatTextContent(rawContent)
        : rawContent;
      const skillContext = buildSkillEventContext({
        cfg: options?.cfg,
        eventType: "group_message",
        accountId: options?.accountId,
        roleName,
        messageText: content,
        groupId,
        groupName,
        userId: senderId,
        senderName,
        senderRoleName,
        extraPromptBlocks: options?.extraPromptBlocks,
      });

      let text: string;
      switch (data.content_type) {
        case "text":
          text = content;
          break;
        case "image":
          text = `[图片]${content || ""}`;
          break;
        case "file":
          text = `[文件]${content || ""}`;
          break;
        case "sharegroup":
          text = `[群组卡片]${content || ""}`;
          break;
        case "shareuser":
          text = `[用户卡片]${content || ""}`;
          break;
        default:
          text = content || `[${data.content_type}]`;
          break;
      }
      if (!text) {
        return null;
      }
      return {
        dedupeKey,
        messageId,
        chatType: "group",
        target: `group:${groupId}`,
        fromAddress: `${CHANNEL_ID}:group:${groupId}`,
        senderId,
        senderName,
        text,
        timestamp: data.timestamp || event.timestamp || Date.now(),
        groupSubject: groupId,
        conversationLabel: `group:${groupId}`,
        groupSystemPrompt: skillContext.prompt,
        suppressTextReply: skillContext.replyMode === "suppress_text_reply",
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
        userId: senderId,
        senderName,
        extraPromptBlocks: options?.extraPromptBlocks,
      });
      return {
        dedupeKey,
        messageId,
        chatType: "direct",
        target: `user:${senderId}`,
        fromAddress: `${CHANNEL_ID}:user:${senderId}`,
        senderId,
        senderName,
        text: `[43Chat好友请求] 用户 ${senderId}${data.from_nickname ? `(${data.from_nickname})` : ""} 请求添加好友，附言：${data.request_msg || "无"}，request_id=${data.request_id}`,
        timestamp: data.timestamp || event.timestamp || Date.now(),
        conversationLabel: `user:${senderId}`,
        groupSystemPrompt: skillContext.prompt,
        suppressTextReply: skillContext.replyMode === "suppress_text_reply",
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
        userId: senderId,
        senderName,
        extraPromptBlocks: options?.extraPromptBlocks,
      });
      return {
        dedupeKey,
        messageId,
        chatType: "direct",
        target: `user:${senderId}`,
        fromAddress: `${CHANNEL_ID}:user:${senderId}`,
        senderId,
        senderName,
        text: `[43Chat好友通过] 用户 ${senderId}${data.from_nickname ? `(${data.from_nickname})` : ""} 已通过好友请求，request_id=${data.request_id}`,
        timestamp: data.timestamp || event.timestamp || Date.now(),
        conversationLabel: `user:${senderId}`,
        groupSystemPrompt: skillContext.prompt,
        suppressTextReply: skillContext.replyMode === "suppress_text_reply",
      };
    }
    case "group_invitation": {
      const data = event.data as Chat43GroupInvitationEventData;
      const groupId = String(data.group_id);
      const applicantUserId = String(data.inviter_id);
      const applicantName = data.inviter_name || applicantUserId;
      const roleName = resolveGroupRoleName({
        groupId,
        accountId: options?.accountId,
        fallbackRoleName: "管理员",
      });
      const skillContext = buildSkillEventContext({
        cfg: options?.cfg,
        eventType: "group_invitation",
        accountId: options?.accountId,
        roleName,
        groupId,
        groupName: data.group_name || `群${groupId}`,
        userId: applicantUserId,
        senderName: applicantName,
        extraPromptBlocks: options?.extraPromptBlocks,
      });
      const requestId = String(data.invitation_id);
      const text = [
        "[系统提示]",
        "【待处理任务：43Chat 入群申请审核】",
        "这不是普通聊天消息，而是一个需要你执行后续动作的管理任务。",
        "不要只回复“收到”或“等待审核”。你必须先根据 Skill 文档、认知文件和申请信息做判断。",
        "如决定通过或拒绝，请调用工具 `chat43_handle_group_join_request` 执行动作。",
        "工具调用建议：优先传 `requestId`，先使用本事件的 `invitation_id`；如不确定，可同时传 `groupId` 与 `applicantUserId` 让工具自动匹配 pending 请求。",
        "",
        "[申请信息]",
        `account_id=${options?.accountId ?? "default"}`,
        `group_id=${groupId}`,
        `group_name=${data.group_name || "未知群"}`,
        `request_id=${requestId}`,
        `invitation_id=${requestId}`,
        `applicant_user_id=${applicantUserId}`,
        `applicant_name=${applicantName}`,
        `application_message=${data.invite_msg || "无"}`,
      ].join("\n");
      return {
        dedupeKey,
        messageId,
        chatType: "group",
        target: `group:${groupId}`,
        fromAddress: `${CHANNEL_ID}:group:${groupId}`,
        senderId: applicantUserId,
        senderName: applicantName,
        text,
        timestamp: data.timestamp || event.timestamp || Date.now(),
        groupSubject: groupId,
        conversationLabel: `group:${groupId}`,
        groupSystemPrompt: skillContext.prompt,
        suppressTextReply: skillContext.replyMode === "suppress_text_reply",
      };
    }
    case "group_member_joined": {
      const data = event.data as Chat43GroupMemberJoinedEventData;
      const groupId = String(data.group_id);
      const groupName = data.group_name || `群${groupId}`;
      const userId = String(data.user_id);
      const roleName = resolveGroupRoleName({
        groupId,
        accountId: options?.accountId,
        fallbackRoleName: "成员",
      });
      const skillContext = buildSkillEventContext({
        cfg: options?.cfg,
        eventType: "group_member_joined",
        accountId: options?.accountId,
        roleName,
        groupId,
        groupName,
        userId,
        senderName: data.nickname || userId,
        extraPromptBlocks: options?.extraPromptBlocks,
      });
      const defaultText = `[43Chat群通知] 新成员入群，group_id=${groupId}，group_name=${data.group_name || "未知群"}，user_id=${userId}，nickname=${data.nickname || userId}，join_method=${data.join_method || "unknown"}`;
      return {
        dedupeKey,
        messageId,
        chatType: "group",
        target: `group:${groupId}`,
        fromAddress: `${CHANNEL_ID}:group:${groupId}`,
        senderId: userId,
        senderName: data.nickname || userId,
        text: defaultText,
        timestamp: data.timestamp || event.timestamp || Date.now(),
        groupSubject: data.group_name || groupId,
        conversationLabel: `group:${groupId}`,
        groupSystemPrompt: skillContext.prompt,
        suppressTextReply: skillContext.replyMode === "suppress_text_reply",
      };
    }
    case "system_notice": {
      const data = event.data as Chat43SystemNoticeEventData;
      const skillContext = buildSkillEventContext({
        cfg: options?.cfg,
        eventType: "system_notice",
        accountId: options?.accountId,
        extraPromptBlocks: options?.extraPromptBlocks,
      });
      return {
        dedupeKey,
        messageId,
        chatType: "direct",
        target: "user:0",
        fromAddress: `${CHANNEL_ID}:user:0`,
        senderId: "0",
        senderName: "system",
        text: `[43Chat系统通知][${data.level || "info"}] ${data.title || "系统通知"}: ${data.content || ""}`.trim(),
        timestamp: data.timestamp || event.timestamp || Date.now(),
        conversationLabel: "user:0",
        groupSystemPrompt: skillContext.prompt,
        suppressTextReply: skillContext.replyMode === "suppress_text_reply",
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
  if (!text) {
    return [];
  }
  if (chunkMode === "raw") {
    if (text.length <= textChunkLimit) {
      return [text];
    }
    return Array.from(chunkTextWithMode(text, textChunkLimit, "length"));
  }
  return Array.from(chunkTextWithMode(text, textChunkLimit, chunkMode));
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseCognitionWriteContent(value: unknown): Record<string, unknown> | null {
  if (isPlainObject(value)) {
    return value;
  }
  const raw = readOptionalString(value);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isModerationDecisionKind(value: string | undefined): value is SkillRuntimeModerationDecisionKind {
  return value === "observe"
    || value === "no_reply"
    || value === "redirect"
    || value === "warn"
    || value === "mark_risk"
    || value === "remove_member";
}

function isModerationStage(value: string | undefined): value is SkillRuntimeModerationStage {
  return value === "first_occurrence"
    || value === "repeat_occurrence"
    || value === "after_warning_repeat";
}

function parseCognitionEnvelopeDecision(value: unknown): CognitionEnvelopeModerationDecision | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const kind = readOptionalString(value.kind);
  if (!isModerationDecisionKind(kind)) {
    return undefined;
  }

  const parsed: CognitionEnvelopeModerationDecision = {
    kind,
  };
  const reason = readOptionalString(value.reason);
  const scenario = readOptionalString(value.scenario);
  const stage = readOptionalString(value.stage);
  const targetUserId = readOptionalString(value.target_user_id);
  const publicReply = readOptionalBoolean(value.public_reply);

  if (reason) {
    parsed.reason = reason;
  }
  if (scenario) {
    parsed.scenario = scenario;
  }
  if (isModerationStage(stage)) {
    parsed.stage = stage;
  }
  if (targetUserId) {
    parsed.targetUserId = targetUserId;
  }
  if (typeof publicReply === "boolean") {
    parsed.publicReply = publicReply;
  }

  return parsed;
}

function parseLegacyCognitionEnvelopeModerationDecision(
  value: unknown,
): CognitionEnvelopeModerationDecision | undefined {
  if (typeof value === "string") {
    return isModerationDecisionKind(value)
      ? { kind: value }
      : undefined;
  }

  return parseCognitionEnvelopeDecision(value);
}

function resolveEventIsoTime(event: Chat43AnySSEEvent): string {
  const dataTimestamp = isPlainObject(event.data) && typeof event.data.timestamp === "number"
    ? event.data.timestamp
    : undefined;
  return new Date(dataTimestamp ?? event.timestamp ?? Date.now()).toISOString();
}

function shouldStampSemanticUpdatedAt(pathValue: string): boolean {
  return pathValue.endsWith("/soul.json")
    || pathValue.endsWith("/members_graph.json")
    || /(?:^|\/)profiles\/[^/]+\.json$/.test(pathValue);
}

export function resolveCognitionFullPath(pathValue: string): string | null {
  const trimmedPath = pathValue.trim();
  if (!trimmedPath) {
    return null;
  }

  const rootPath = normalize(COGNITION_STORAGE_ROOT);
  const fullPath = normalize(
    isAbsolute(trimmedPath)
      ? trimmedPath
      : join(COGNITION_STORAGE_ROOT, trimmedPath),
  );

  if (fullPath === rootPath) {
    return fullPath;
  }

  const rootPrefix = rootPath.endsWith(sep) ? rootPath : `${rootPath}${sep}`;
  if (!fullPath.startsWith(rootPrefix)) {
    return null;
  }

  return fullPath;
}

function repairXmlCorruptedJsonKeys(raw: string): string {
  // MiniMax sometimes outputs `<writes":` or `<chat43-writes":` instead of `"writes":`
  return raw.replace(/<(?:chat43-)?([a-z_]+)"(\s*:)/gi, '"$1"$2');
}

export function parseCognitionWriteEnvelope(text: string): CognitionWriteEnvelope | null {
  const match = text.match(/<chat43-cognition>\s*([\s\S]*?)\s*<\/chat43-cognition>/i)
    ?? text.match(/```chat43-cognition\s*([\s\S]*?)```/i);
  if (!match) {
    return null;
  }

  const inner = repairXmlCorruptedJsonKeys(match[1]);

  try {
    const parsed = parseLooseCognitionEnvelopeJson(inner) as unknown;
    return normalizeParsedCognitionWriteEnvelope({
      parsed,
      fallbackReplyText: text.replace(match[0], "").trim(),
    });
  } catch {
    return parseMalformedCognitionWriteEnvelope(inner)
      ?? parseLegacyXmlStyleCognitionEnvelope(inner);
  }
}

function normalizeParsedCognitionWriteEnvelope(params: {
  parsed: unknown;
  fallbackReplyText: string;
}): CognitionWriteEnvelope | null {
  if (!isPlainObject(params.parsed)) {
    return null;
  }

  const nestedEnvelope = isPlainObject(params.parsed.envelope) ? params.parsed.envelope : null;
  const writes = parseEnvelopeWrites(params.parsed.writes ?? nestedEnvelope?.writes);
  if (!writes) {
    return null;
  }

  const replyText = readOptionalString(params.parsed.reply)
    ?? readOptionalString(nestedEnvelope?.reply)
    ?? params.fallbackReplyText;
  const decision = parseCognitionEnvelopeDecision(params.parsed.decision)
    ?? parseCognitionEnvelopeDecision(nestedEnvelope?.decision)
    ?? parseLegacyCognitionEnvelopeModerationDecision(params.parsed.moderation)
    ?? parseLegacyCognitionEnvelopeModerationDecision(nestedEnvelope?.moderation);

  return {
    writes,
    replyText: replyText ?? "",
    ...(decision ? { decision } : {}),
  };
}

function parseEnvelopeWrites(value: unknown): Array<{ path: string; content: Record<string, unknown> }> | null {
  const rawWrites = value === undefined
    ? []
    : (Array.isArray(value) ? value : null);
  if (!rawWrites) {
    return null;
  }

  const parsedWrites = rawWrites
    .map((entry) => {
      if (!isPlainObject(entry)) {
        return null;
      }
      const path = readOptionalString(entry.path);
      const content = parseCognitionWriteContent(entry.content);
      if (!path || !content || !path.endsWith(".json")) {
        return null;
      }
      return { path, content };
    });
  if (parsedWrites.some((entry) => entry === null)) {
    return null;
  }
  return parsedWrites
    .filter((entry): entry is { path: string; content: Record<string, unknown> } => Boolean(entry));
}

function parseMalformedCognitionWriteEnvelope(raw: string): CognitionWriteEnvelope | null {
  const replyText = extractMalformedEnvelopeReplyText(raw);
  const writes = parseEnvelopeWrites(parseMalformedJsonValue(raw, "writes"));
  if (!writes) {
    return null;
  }

  const decision = parseCognitionEnvelopeDecision(parseMalformedJsonValue(raw, "decision"))
    ?? parseLegacyCognitionEnvelopeModerationDecision(parseMalformedJsonValue(raw, "moderation"));

  if (replyText === undefined && !decision && writes.length === 0) {
    return null;
  }

  return {
    writes,
    replyText: replyText ?? "",
    ...(decision ? { decision } : {}),
  };
}

function extractMalformedEnvelopeReplyText(raw: string): string | undefined {
  return extractMalformedQuotedStringField(raw, "reply");
}

function extractMalformedQuotedStringField(raw: string, key: string): string | undefined {
  const keyMatch = new RegExp(`"${key}"\\s*:\\s*"`, "i").exec(raw);
  if (!keyMatch) {
    return undefined;
  }

  const start = keyMatch.index + keyMatch[0].length;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char !== "\"") {
      continue;
    }

    const suffix = raw.slice(index + 1);
    if (
      /^\s*,\s*"(?:writes|decision|moderation|reply)"\s*:/i.test(suffix)
      || /^\s*}\s*,\s*"(?:writes|decision|moderation)"\s*:/i.test(suffix)
      || /^\s*}\s*$/i.test(suffix)
      || /^\s*$/i.test(suffix)
    ) {
      return decodeLooseJsonStringContent(raw.slice(start, index));
    }
  }

  return undefined;
}

function decodeLooseJsonStringContent(raw: string): string {
  let output = "";

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char !== "\\") {
      output += char;
      continue;
    }

    const next = raw[index + 1];
    if (!next) {
      output += "\\";
      break;
    }

    index += 1;
    switch (next) {
      case "\"":
      case "\\":
      case "/":
        output += next;
        break;
      case "b":
        output += "\b";
        break;
      case "f":
        output += "\f";
        break;
      case "n":
        output += "\n";
        break;
      case "r":
        output += "\r";
        break;
      case "t":
        output += "\t";
        break;
      case "u": {
        const hex = raw.slice(index + 1, index + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          output += String.fromCharCode(Number.parseInt(hex, 16));
          index += 4;
        } else {
          output += "u";
        }
        break;
      }
      default:
        output += next;
        break;
    }
  }

  return output;
}

function parseMalformedJsonValue(raw: string, key: string): unknown {
  const keyPattern = new RegExp(`"${key}"\\s*:\\s*`, "i");
  const match = keyPattern.exec(raw);
  if (!match) {
    return undefined;
  }

  let index = match.index + match[0].length;
  while (index < raw.length && /\s/u.test(raw[index] ?? "")) {
    index += 1;
  }

  const startChar = raw[index];
  if (startChar === "{"
    || startChar === "[") {
    const fragment = extractBalancedJsonFragment(raw, index);
    if (!fragment) {
      return undefined;
    }
    try {
      return parseLooseCognitionEnvelopeJson(fragment);
    } catch {
      return undefined;
    }
  }

  if (startChar === "\"") {
    return extractMalformedQuotedStringField(raw.slice(match.index), key);
  }

  return undefined;
}

function extractBalancedJsonFragment(raw: string, start: number): string | null {
  const opening = raw[start];
  if (opening !== "{"
    && opening !== "[") {
    return null;
  }

  const stack = [opening === "{" ? "}" : "]"];
  let inString = false;
  let escaped = false;

  for (let index = start + 1; index < raw.length; index += 1) {
    const char = raw[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      stack.push("}");
      continue;
    }
    if (char === "[") {
      stack.push("]");
      continue;
    }

    const expected = stack[stack.length - 1];
    if (char === expected) {
      stack.pop();
      if (stack.length === 0) {
        return raw.slice(start, index + 1);
      }
    }
  }

  return null;
}

function parseLooseCognitionEnvelopeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(escapeJsonControlCharsInsideStrings(raw));
  }
}

function escapeJsonControlCharsInsideStrings(raw: string): string {
  let inString = false;
  let escaped = false;
  let output = "";

  for (const char of raw) {
    if (!inString) {
      output += char;
      if (char === "\"") {
        inString = true;
      }
      continue;
    }

    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      output += char;
      escaped = true;
      continue;
    }

    if (char === "\"") {
      output += char;
      inString = false;
      continue;
    }

    if (char === "\n") {
      output += "\\n";
      continue;
    }
    if (char === "\r") {
      output += "\\r";
      continue;
    }
    if (char === "\t") {
      output += "\\t";
      continue;
    }

    output += char;
  }

  return output;
}

function validateModerationDecision(params: {
  cfg?: ClawdbotConfig;
  eventType: string;
  decision: CognitionEnvelopeModerationDecision | undefined;
  accountId: string;
  log: (message: string) => void;
}): CognitionEnvelopeModerationDecision | undefined {
  if (!params.decision || params.eventType !== "group_message") {
    return undefined;
  }

  const runtime = load43ChatSkillRuntime(params.cfg);
  const moderationPolicy = resolveSkillModerationPolicy(runtime, params.eventType);
  const allowedKinds = new Set(moderationPolicy.allowed_decision_kinds);
  if (!allowedKinds.has(params.decision.kind)) {
    params.log(
      `43chat[${params.accountId}]: ignore moderation decision kind=${params.decision.kind} because it is not declared in runtime`,
    );
    return undefined;
  }

  if (params.decision.scenario && params.decision.stage) {
    const scenario = moderationPolicy.scenarios[params.decision.scenario];
    if (!scenario?.enabled) {
      params.log(
        `43chat[${params.accountId}]: ignore moderation decision scenario=${params.decision.scenario} because it is not enabled in runtime`,
      );
      return undefined;
    }
    const expected = scenario.steps[params.decision.stage];
    if (expected.decision !== params.decision.kind) {
      params.log(
        `43chat[${params.accountId}]: ignore moderation decision scenario=${params.decision.scenario} stage=${params.decision.stage} kind=${params.decision.kind} expected=${expected.decision}`,
      );
      return undefined;
    }
    return {
      ...params.decision,
      publicReply: expected.public_reply,
    };
  }

  return params.decision;
}

export function resolveObserveFallbackModerationDecision(params: {
  cfg?: ClawdbotConfig;
  eventType: string;
  decisionRequired: boolean;
  accountId: string;
  log: (message: string) => void;
}): CognitionEnvelopeModerationDecision | undefined {
  if (params.eventType !== "group_message") {
    return undefined;
  }

  if (params.decisionRequired) {
    params.log(
      `43chat[${params.accountId}]: skip observe fallback because structured moderation decision is mandatory`,
    );
    return undefined;
  }

  const runtime = load43ChatSkillRuntime(params.cfg);
  const moderationPolicy = resolveSkillModerationPolicy(runtime, params.eventType);
  if (
    !moderationPolicy.enforcement.enabled
    || !moderationPolicy.enforcement.allow_observe_fallback
    || !moderationPolicy.allowed_decision_kinds.includes("observe")
  ) {
    return undefined;
  }

  params.log(
    `43chat[${params.accountId}]: synthesize moderation decision kind=observe via runtime fallback`,
  );
  return {
    kind: "observe",
    reason: "runtime observe fallback synthesized by plugin because structured moderation decision was missing",
  };
}

function applyCognitionWriteEnvelope(params: {
  envelope: CognitionWriteEnvelope;
  event: Chat43AnySSEEvent;
  log: (message: string) => void;
  error: (message: string) => void;
  accountId: string;
}): string[] {
  const written: string[] = [];
  const semanticUpdatedAt = resolveEventIsoTime(params.event);

  for (const write of params.envelope.writes) {
    const fullPath = resolveCognitionFullPath(write.path);
    if (!fullPath) {
      params.error(`43chat[${params.accountId}]: cognition envelope path rejected ${write.path}`);
      continue;
    }

    try {
      mkdirSync(dirname(fullPath), { recursive: true });
      const normalizedContent = normalizeSkillCognitionWriteContent({
        cfg: undefined,
        event: params.event,
        path: fullPath,
        content: write.content,
      });
      const guardedContent = applyEventFactGuardsToCognitionContent({
        event: params.event,
        fullPath,
        content: normalizedContent,
      });
      const content = shouldStampSemanticUpdatedAt(write.path)
        ? { ...guardedContent, updated_at: semanticUpdatedAt }
        : guardedContent;
      writeFileSync(fullPath, `${JSON.stringify(content, null, 2)}\n`, "utf8");
      written.push(write.path);
    } catch (cause) {
      params.error(`43chat[${params.accountId}]: failed to apply cognition envelope ${write.path}: ${String(cause)}`);
    }
  }

  if (written.length > 0) {
    params.log(`43chat[${params.accountId}]: applied cognition envelope writes ${written.join(", ")}`);
  }

  return written;
}

function resolveEventSenderProfileAlias(event: Chat43AnySSEEvent): string | null {
  switch (event.event_type) {
    case "private_message":
      return `profiles/${String((event.data as Chat43PrivateMessageEventData).from_user_id)}.json`;
    case "friend_request":
      return `profiles/${String((event.data as Chat43FriendRequestEventData).from_user_id)}.json`;
    case "friend_accepted":
      return `profiles/${String((event.data as Chat43FriendAcceptedEventData).from_user_id)}.json`;
    case "group_message":
      return `profiles/${String((event.data as Chat43GroupMessageEventData).from_user_id)}.json`;
    case "group_invitation":
      return `profiles/${String((event.data as Chat43GroupInvitationEventData).inviter_id)}.json`;
    case "group_member_joined":
      return `profiles/${String((event.data as Chat43GroupMemberJoinedEventData).user_id)}.json`;
    default:
      return null;
  }
}

export function applyEventFactGuardsToCognitionContent(params: {
  event: Chat43AnySSEEvent;
  fullPath: string;
  content: Record<string, unknown>;
}): Record<string, unknown> {
  const profileAlias = resolveEventSenderProfileAlias(params.event);
  if (!profileAlias) {
    return params.content;
  }

  const resolvedProfilePath = resolveCognitionFullPath(profileAlias);
  if (!resolvedProfilePath || resolvedProfilePath !== params.fullPath) {
    return params.content;
  }

  switch (params.event.event_type) {
    case "private_message":
    case "friend_accepted":
      return { ...params.content, is_friend: true };
    case "friend_request":
      return { ...params.content, is_friend: false };
    default:
      return params.content;
  }
}

function buildRetryAttemptInbound(
  inbound: InboundDescriptor,
  attempt: number,
): InboundDescriptor {
  if (attempt <= 1) {
    return inbound;
  }

  return {
    ...inbound,
    messageId: `${inbound.messageId}:retry:${attempt}`,
    dedupeKey: `${inbound.dedupeKey}:retry:${attempt}`,
  };
}

function buildMissingCognitionPromptBlocks(
  missingSummaries: string[],
  noReplyToken: string,
): SkillRuntimePromptBlock[] {
  if (missingSummaries.length === 0) {
    return [];
  }

  const missingRequirements = missingSummaries.flatMap((summary) => {
    if (summary.startsWith("group_soul:")) {
      return [
        "先补 `group_soul`：至少写出 `soul.purpose` / `soul.topics` / `soul.boundaries` / `soul.expectations`，可以用简洁抽象结论，不要空字符串。",
      ];
    }
    if (summary.startsWith("user_profile:")) {
      return [
        "先补 `user_profile`：至少写出能复用的人物结论，如 `tags` / `expertise` / `personality` / `notes`，有足够信号再写 `influence_level`。",
        "如果当前稳定信号已经推翻旧画像，要直接改写冲突的旧标签和旧备注，不要只因为文件里已有内容就沿用过期话题。",
      ];
    }
    if (summary.startsWith("dialog_state:")) {
      return [
        "先补 `dialog_state`：至少写出 `current_topics` 或 `rapport_summary`，让后续私聊知道这轮在延续什么关系或话题。",
        "如果这轮出现了偏好、自我定义、关系定位、持续话题或明确计划，不允许继续返回 `writes: []`。",
      ];
    }
    if (summary.startsWith("group_members_graph:")) {
      return [
        "先补 `group_members_graph`：`role` 必须使用 `opinion_leader` / `contributor` / `active` / `newcomer` / `silent` / `risk` 之一，并补 `in_group_tags` 或 `strategy`。",
        "如果成员在群里的职责、关注点或影响力已发生稳定变化，要覆盖旧的 role / strategy / in_group_tags，不要把首次判断一直保留下去。",
      ];
    }
    return [];
  });

  return [{
    title: "首轮认知写入守卫",
    lines: [
      `当前仍缺失的认知槽位: ${missingSummaries.join(" / ")}`,
      ...missingRequirements,
      "这不是可选优化；如果你本轮判断需要回复，就必须把长期认知和回复一起放进同一个 cognition envelope。",
      "如果当前消息需要正常公开回复，不要输出 `<final>`；请把完整公开回复文本写进 envelope 的 `reply` 字段里，插件会发送这个 `reply`。",
      "不要只输出普通文本回复；缺失槽位仍存在时，普通文本会被插件直接拦截。",
      "最终输出必须以 `<chat43-cognition>{...}</chat43-cognition>` 开头，标签里放合法 JSON。",
      `这个 JSON 必须是 { "writes": [{"path":"groups/...json","content":{...}}], "reply": "..." }；若本轮不回复，则 reply 写为 "${noReplyToken}"。`,
    ],
  }];
}

function buildEnvelopeRetryPromptBlocks(params: {
  missingSummaries: string[];
  noReplyToken: string;
  priorReplyText: string;
  moderationDecisionRequired?: boolean;
  writesRequired?: boolean;
}): SkillRuntimePromptBlock[] {
  const writesRequired = params.writesRequired ?? params.missingSummaries.length > 0;
  const missingSummaryLine = params.missingSummaries.length > 0
    ? `当前仍缺失的认知槽位: ${params.missingSummaries.join(" / ")}`
    : (writesRequired
      ? "当前消息没有新的缺失槽位；若你输出 cognition envelope，仍需保持结构合法。"
      : "当前没有额外的长期认知写入要求；若只需返回管理决策，`writes` 直接写空数组 `[]`。");
  const reusablePriorReplyText = extractReusableOutwardReplyText(params.priorReplyText);

  return [{
    title: "认知 Envelope 重试",
    lines: [
      writesRequired
        ? "上一轮输出格式无效：当前仍有必须写入的长期认知，但你输出了普通文本或普通 `NO_REPLY`。"
        : "上一轮输出格式无效：本轮必须显式返回结构化管理决策，但你输出了普通文本或普通 `NO_REPLY`。",
      "本轮必须只输出一个 `<chat43-cognition>{...}</chat43-cognition>` envelope，不能输出裸文本，不能输出 `<final>...</final>`。",
      "唯一合法示例：`<chat43-cognition>{\"envelope\":{\"reply\":\"你好\"},\"writes\":[]}</chat43-cognition>`。",
      "不要输出 `<thinking>`、`<envelope>`、`<reply>`、`<writes>` 这类 XML 标签；标签内部必须是合法 JSON。",
      "如果当前消息需要公开回复，把完整公开回复文本放进 envelope.reply；插件只会对外发送这个 `reply`。",
      `如果当前消息不该公开回复，envelope.reply 必须写为 "${params.noReplyToken}"。`,
      writesRequired
        ? "writes 里必须补齐当前缺失的长期认知。"
        : "当前 envelope 里的 `writes` 可以为空数组 `[]`；不要借此回写群聊长期认知。",
      ...(params.moderationDecisionRequired
        ? [
          "你当前处于文档声明的管理决策强制模式，本轮 envelope 里必须带 `decision` 字段。",
          "如果消息命中文档里的管理场景，`decision.scenario` / `decision.stage` / `decision.kind` 必须与 runtime 一致；如果未命中，也必须显式输出 `decision.kind = observe`。",
        ]
        : []),
      missingSummaryLine,
      reusablePriorReplyText
        ? `你上一轮的公开回复纯文本候选如下；若内容合适，请只复用这段文字到 envelope.reply：${reusablePriorReplyText}`
        : "你上一轮没有形成可发送的公开回复；如本轮也不需要公开回复，请把 envelope.reply 写为 NO_REPLY。",
    ],
  }];
}

function buildEmptyReplyRetryPromptBlocks(params: {
  noReplyToken: string;
  priorReplyText: string;
  requireCognitionEnvelope?: boolean;
}): SkillRuntimePromptBlock[] {
  const expectedReplyForms = params.requireCognitionEnvelope
    ? "一个合法的 `<chat43-cognition>{...}</chat43-cognition>` envelope。"
    : "普通文本或 `NO_REPLY`。";
  const reusablePriorReplyText = extractReusableOutwardReplyText(params.priorReplyText);
  return [{
    title: "主回复空结果重试",
    lines: [
      "上一轮没有产出可发送的最终回复，可能是空响应、只思考未输出，或生成过程异常中断。",
      `本轮必须给出一个明确可发送结果：${expectedReplyForms}`,
      ...(params.requireCognitionEnvelope
        ? [
          "唯一合法示例：`<chat43-cognition>{\"envelope\":{\"reply\":\"你好\"},\"writes\":[]}</chat43-cognition>`。",
          "如果需要公开回复，把完整文本放进 envelope.reply；如果不该公开回复，就把 envelope.reply 写成 `NO_REPLY`。",
          "不要输出 `<thinking>`、`<envelope>`、`<reply>`、`<writes>` 这类 XML 标签；标签内部必须是合法 JSON。",
          "不要输出裸文本、不要输出裸 `NO_REPLY`、不要让最终回复留空。",
        ]
        : ["不要只输出空白、不要只思考不输出、不要让最终回复留空。"]),
      reusablePriorReplyText
        ? `上一轮已捕获到的纯文本候选如下；如果它本身可用，可以直接复用：${reusablePriorReplyText}`
        : `如果你判断当前不该回复，请明确输出 \`${params.noReplyToken}\`，不要留空。`,
    ],
  }];
}

function resolveGroupFinalReplyText(text: string): string {
  const envelope = parseCognitionWriteEnvelope(text);
  if (!envelope) {
    return unwrapFinalReplyTag(text);
  }
  return envelope.replyText.trim();
}

export function resolvePrimaryDispatchSessionKey(params: {
  baseSessionKey: string;
  chatType: "direct" | "group";
  eventType: Chat43AnySSEEvent["event_type"];
  messageId: string;
}): string {
  void params.messageId;
  if (params.chatType !== "direct") {
    return params.baseSessionKey;
  }

  if (params.eventType === "friend_request") {
    return "agent:main:43chat-openclaw-plugin:friend-request";
  }

  if (params.eventType === "friend_accepted") {
    return params.baseSessionKey.replace(":direct:", ":friend-accepted:");
  }

  return params.baseSessionKey;
}

export function resolveDispatchSessionKey(baseSessionKey: string, messageId: string, attempt: number): string {
  if (attempt <= 1) {
    return baseSessionKey;
  }
  return `${baseSessionKey}:cognition-retry:${messageId}:attempt:${attempt}`;
}

function classifyNonSendableReplyText(text: string, noReplyToken: string): "no_reply" | "cognition_envelope" | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === noReplyToken) {
    return "no_reply";
  }
  if (
    /^<chat43-cognition>[\s\S]*<\/chat43-cognition>$/i.test(trimmed)
    || /^```chat43-cognition[\s\S]*```$/i.test(trimmed)
  ) {
    return "cognition_envelope";
  }
  return null;
}

export function classifyDispatchAttemptOutcome(params: {
  finalReplyText: string;
  suppressTextReply?: boolean;
  noReplyToken: string;
  deliverSawFinal?: boolean;
  queuedFinal?: boolean;
  finalCount?: number;
}): DispatchAttemptOutcome {
  if (params.suppressTextReply && params.finalReplyText) {
    return {
      kind: "suppressed",
      reason: "group event requires tool action or non-text handling",
    };
  }

  const nonSendableReplyKind = classifyNonSendableReplyText(params.finalReplyText, params.noReplyToken);
  if (nonSendableReplyKind === "no_reply") {
    return {
      kind: "no_reply",
      reason: `model explicitly returned ${params.noReplyToken}`,
    };
  }
  if (nonSendableReplyKind === "cognition_envelope") {
    return {
      kind: "suppressed",
      reason: "model returned a raw cognition envelope instead of sendable reply text",
    };
  }

  if (params.finalReplyText) {
    return {
      kind: "reply",
      replyText: params.finalReplyText,
      reason: "plugin delivered final text reply",
    };
  }

  if (params.deliverSawFinal || params.queuedFinal || (params.finalCount ?? 0) > 0) {
    return {
      kind: "no_reply",
      reason: `dispatcher settled without recorded final reply; treating as explicit ${params.noReplyToken}`,
    };
  }

  return {
    kind: "empty",
    reason: "dispatcher settled without final reply",
  };
}

export function filterCognitionIssuesToRequiredAliases(params: {
  issues: CognitionWriteRequirementIssue[];
  requiredAliases: ReadonlySet<CognitionWriteRequirementIssue["alias"]>;
}): CognitionWriteRequirementIssue[] {
  if (params.requiredAliases.size === 0) {
    return [];
  }
  return params.issues.filter((issue) => params.requiredAliases.has(issue.alias));
}

function inspectCognitionWriteRequirementsForEvent(params: {
  cfg: ClawdbotConfig;
  event: Chat43AnySSEEvent;
}): CognitionWriteRequirementIssue[] {
  if (params.event.event_type === "group_message") {
    return inspectGroupMessageCognitionWriteRequirements(params).issues;
  }
  if (params.event.event_type === "private_message") {
    return inspectPrivateMessageCognitionWriteRequirements(params).issues;
  }
  return [];
}

export function shouldRetryDispatchForEmptyOutcome(params: {
  outcome: DispatchAttemptOutcome;
  attempt: number;
  maxAttempts: number;
}): boolean {
  return params.outcome.kind === "empty" && params.attempt < params.maxAttempts;
}

export function resolveRetryFallbackForMissingEnvelope(params: {
  chatType: "direct" | "group";
  retryFinalText: string;
  retryForEnvelope: boolean;
  firstAttemptOutcome: DispatchAttemptOutcome;
}): {
  keepFirstOutwardReply: boolean;
  finalReplyText: string;
} {
  const retryFallbackReplyText = params.chatType === "group"
    ? resolveGroupFinalReplyText(params.retryFinalText)
    : params.retryFinalText.trim();
  const keepFirstOutwardReply = params.retryForEnvelope && params.firstAttemptOutcome.kind === "reply";

  return {
    keepFirstOutwardReply,
    finalReplyText: keepFirstOutwardReply
      ? (params.firstAttemptOutcome as { kind: "reply"; replyText: string; reason: string }).replyText
      : retryFallbackReplyText,
  };
}

export function shouldParseCognitionEnvelopeForInbound(params: {
  eventType: Chat43AnySSEEvent["event_type"];
  moderationDecisionRequired?: boolean;
}): boolean {
  void params.moderationDecisionRequired;
  return true;
}

function shouldForceEnvelopeForEvent(eventType: Chat43AnySSEEvent["event_type"]): boolean {
  return eventType === "friend_request"
    || eventType === "friend_accepted";
}

function shouldRequireStructuredModerationDecision(params: {
  eventType: Chat43AnySSEEvent["event_type"];
  roleName?: string;
  messageText?: string;
  cfg?: ClawdbotConfig;
}): boolean {
  const runtime = load43ChatSkillRuntime(params.cfg);
  return shouldRequireStructuredModerationDecisionForRole({
    runtime,
    eventType: params.eventType,
    roleName: params.roleName,
    messageText: params.messageText,
  });
}

function extractModerationProbeMessageText(event: Chat43AnySSEEvent): string | undefined {
  if (event.event_type !== "group_message") {
    return undefined;
  }

  const data = event.data as Chat43GroupMessageEventData;
  const rawContent = String(data.content ?? "").trim();
  if (!rawContent) {
    return undefined;
  }

  return data.content_type === "text"
    ? extract43ChatTextContent(rawContent)
    : rawContent;
}

function applyModerationReplyVisibility(params: {
  outcome: DispatchAttemptOutcome;
  moderationDecision?: CognitionEnvelopeModerationDecision;
}): DispatchAttemptOutcome {
  if (
    params.outcome.kind !== "reply"
    || !params.moderationDecision
    || params.moderationDecision.publicReply !== false
  ) {
    return params.outcome;
  }

  return {
    kind: "no_reply",
    reason: `suppressed public reply because moderation decision kind=${params.moderationDecision.kind} requires no public reply`,
  };
}

async function executeModerationAction(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  event: Chat43AnySSEEvent;
  moderationDecision?: CognitionEnvelopeModerationDecision;
  log: (message: string) => void;
  error: (message: string) => void;
}): Promise<void> {
  if (
    params.event.event_type !== "group_message"
    || !params.moderationDecision
    || params.moderationDecision.kind !== "remove_member"
  ) {
    return;
  }

  const data = params.event.data as Chat43GroupMessageEventData;
  const groupId = String(data.group_id);
  const targetUserId = params.moderationDecision.targetUserId?.trim()
    || String(data.from_user_id);
  const account = resolve43ChatAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });

  if (!account.configured) {
    params.error(
      `43chat[${params.accountId}]: skip remove_member because account is not configured for group=${groupId} target=${targetUserId}`,
    );
    return;
  }

  try {
    const client = create43ChatClient(account);
    const removalReason = normalizeRemoveMemberReason(params.moderationDecision.reason);
    if (
      removalReason
      && params.moderationDecision.reason
      && removalReason !== params.moderationDecision.reason
    ) {
      params.log(
        `43chat[${params.accountId}]: truncated remove_member reason from ${Array.from(params.moderationDecision.reason).length} to ${Array.from(removalReason).length} chars for group=${groupId} target=${targetUserId}`,
      );
    }
    await client.removeGroupMember({
      groupId,
      userId: targetUserId,
      reason: removalReason,
    });
    params.log(
      `43chat[${params.accountId}]: executed moderation action remove_member group=${groupId} target=${targetUserId}`,
    );
  } catch (cause) {
    params.error(
      `43chat[${params.accountId}]: failed moderation action remove_member group=${groupId} target=${targetUserId}: ${String(cause)}`,
    );
  }
}

export function normalizeRemoveMemberReason(reason: string | undefined, maxChars = 200): string | undefined {
  const normalized = reason?.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return undefined;
  }
  const chars = Array.from(normalized);
  if (chars.length <= maxChars) {
    return normalized;
  }
  return chars.slice(0, maxChars).join("").trim();
}

export function resolveGroupAttemptResolution(params: {
  outcome: DispatchAttemptOutcome;
  missingSummaries: string[];
  blockedForCognition: boolean;
  blockedForModerationDecision?: boolean;
  attempt: number;
  maxAttempts: number;
}): GroupAttemptResolution {
  if (params.blockedForModerationDecision) {
    switch (params.outcome.kind) {
      case "reply":
        return {
          action: "record",
          decision: "reply_blocked_for_missing_moderation_decision",
          reason: "blocked final reply because required structured moderation decision remained missing",
        };
      case "suppressed":
      case "no_reply":
      case "empty":
        return {
          action: "record",
          decision: "no_reply_missing_moderation_decision",
          reason: "required structured moderation decision remained missing",
        };
    }
  }

  if (params.blockedForCognition && params.missingSummaries.length > 0) {
    switch (params.outcome.kind) {
      case "reply":
        return {
          action: "record",
          decision: "reply_blocked_for_cognition",
          reason: `blocked final reply because required cognition writes remained incomplete: ${params.missingSummaries.join(" | ")}`,
        };
      case "suppressed":
        return {
          action: "record",
          decision: "reply_suppressed",
          reason: params.outcome.reason,
        };
      case "no_reply":
      case "empty":
        return {
          action: "record",
          decision: "no_reply",
          reason: params.outcome.reason,
        };
    }
  }

  switch (params.outcome.kind) {
    case "reply":
      return {
        action: "send_reply",
        replyText: params.outcome.replyText,
        reason: params.outcome.reason,
      };
    case "suppressed":
      return {
        action: "record",
        decision: "reply_suppressed",
        reason: params.outcome.reason,
      };
    case "no_reply":
    case "empty":
      return {
        action: "record",
        decision: "no_reply",
        reason: params.outcome.reason,
      };
  }
}

export function map43ChatEventToInboundDescriptor(
  event: Chat43AnySSEEvent,
  options?: {
    cfg?: ClawdbotConfig;
    accountId?: string;
    resolvedRoleNameOverride?: string;
    resolvedSenderRoleNameOverride?: string;
  },
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

  log(
    `43chat[${accountId}]: inbound event ${event.event_type} (${resolveBusinessId(event)}) ${JSON.stringify(
      event,
    )}`,
  );

  const account = resolve43ChatAccount({ cfg, accountId });
  if (!account.enabled || !account.configured) {
    error(`43chat[${accountId}]: account not enabled or configured`);
    return null;
  }
  const skillRuntime = load43ChatSkillRuntime(cfg);
  const replyDelivery = resolveSkillReplyDelivery(skillRuntime, event.event_type);
  const replyPolicy = evaluateReplyPolicy({ cfg, event });
  let resolvedRoleNameOverride: string | undefined;
  let resolvedSenderRoleNameOverride: string | undefined;
  if (event.event_type === "group_message") {
    const data = event.data as Chat43GroupMessageEventData;
    resolvedRoleNameOverride = mapGroupRoleName(data.user_role, data.user_role_name);
    resolvedSenderRoleNameOverride = mapGroupRoleName(
      data.from_user_role ?? data.user_role,
      data.from_user_role_name ?? data.user_role_name,
    );
  } else if (
    event.event_type === "group_invitation"
    || event.event_type === "group_member_joined"
  ) {
    const groupId = event.event_type === "group_invitation"
      ? String((event.data as Chat43GroupInvitationEventData).group_id)
      : String((event.data as Chat43GroupMemberJoinedEventData).group_id);
    resolvedRoleNameOverride = await ensureGroupRoleName({
      account,
      groupId,
      runtime,
    });
  }

  const bootstrap = ensureSkillCognitionBootstrap({
    cfg,
    event,
    log,
    error,
  });
  if (bootstrap.created.length > 0) {
    log(`43chat[${accountId}]: bootstrap created ${bootstrap.created.join(", ")}`);
  }
  if (bootstrap.updated.length > 0) {
    log(`43chat[${accountId}]: bootstrap updated ${bootstrap.updated.join(", ")}`);
  }
  if (resolvedRoleNameOverride) {
    const myRoleUpdate = updateSkillAgentRole({
      cfg,
      event,
      roleName: resolvedRoleNameOverride,
      source: event.event_type === "group_message" ? "sse" : "api",
      log,
      error,
    });
    if (myRoleUpdate.updated.length > 0) {
      log(`43chat[${accountId}]: persisted my role ${myRoleUpdate.updated.join(", ")}`);
    }
  }

  const cognitionUpdate = updateSkillCognitionFromEvent({
    cfg,
    event,
    senderRoleName: resolvedSenderRoleNameOverride,
    log,
    error,
  });
  if (cognitionUpdate.updated.length > 0) {
    log(`43chat[${accountId}]: cognition updated ${cognitionUpdate.updated.join(", ")}`);
  }

  const cognitionEnforcement = resolveSkillCognitionPolicy(skillRuntime, event.event_type).write_enforcement;
  const moderationDecisionRequired = shouldRequireStructuredModerationDecision({
    cfg,
    eventType: event.event_type,
    roleName: resolvedRoleNameOverride,
    messageText: extractModerationProbeMessageText(event),
  });
  const forceInlineCognitionEnvelopeForMainFlow = shouldForceEnvelopeForEvent(event.event_type);
  const requireEnvelopeForMainFlow = shouldParseCognitionEnvelopeForInbound({
    eventType: event.event_type,
    moderationDecisionRequired,
  });
  let requiredIssueAliasesForEvent = new Set<CognitionWriteRequirementIssue["alias"]>();
  let initialMissingIssues: CognitionWriteRequirementIssue[] = [];
  let initialMissingSummaries: string[] = [];
  let initialPromptBlocks: SkillRuntimePromptBlock[] = [];
  const decisionBriefPromptBlocks = buildDecisionBriefPromptBlocks({ event });
  const shouldPromptInlineCognition = forceInlineCognitionEnvelopeForMainFlow;
  if (
    cognitionEnforcement.enabled
    && (event.event_type === "group_message" || forceInlineCognitionEnvelopeForMainFlow)
  ) {
    const issues = inspectCognitionWriteRequirementsForEvent({
      cfg,
      event,
    });
    requiredIssueAliasesForEvent = new Set(issues.map((issue) => issue.alias));
    initialMissingIssues = filterCognitionIssuesToRequiredAliases({
      issues,
      requiredAliases: requiredIssueAliasesForEvent,
    });
    initialMissingSummaries = initialMissingIssues.map((issue) => `${issue.alias}: ${issue.summary} (${issue.path})`);
    if (shouldPromptInlineCognition) {
      initialPromptBlocks = buildMissingCognitionPromptBlocks(initialMissingSummaries, replyPolicy.noReplyToken);
    }
  }
  const mainFlowMissingSummaries = forceInlineCognitionEnvelopeForMainFlow ? initialMissingSummaries : [];

  let inbound = buildInboundDescriptor(event, {
    cfg,
    accountId,
    resolvedRoleNameOverride,
    resolvedSenderRoleNameOverride,
    extraPromptBlocks: [...decisionBriefPromptBlocks, ...initialPromptBlocks],
  });
  if (!inbound) {
    return null;
  }

  if (rememberProcessedEvent(inbound.dedupeKey)) {
    return null;
  }

  const core = get43ChatRuntime();
  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId,
    peer: {
      kind: inbound.chatType === "group" ? "group" : "direct",
      id: inbound.target,
    },
  });

  if (!route.agentId) {
    log(`43chat[${accountId}]: no agent route found for ${inbound.target}`);
    return null;
  }

  const baseDispatchSessionKey = resolvePrimaryDispatchSessionKey({
    baseSessionKey: route.sessionKey,
    chatType: inbound.chatType,
    eventType: event.event_type,
    messageId: inbound.messageId,
  });

  try {
    ensureSessionLogDir(baseDispatchSessionKey);
  } catch (cause) {
    error(`43chat[${accountId}]: failed to ensure session log dir for ${baseDispatchSessionKey}: ${String(cause)}`);
  }

  // 暂时不需要预览
  //const preview = inbound.text.replace(/\s+/g, " ").slice(0, 160);
  const preview = "";
  core.system.enqueueSystemEvent(`43Chat[${accountId}] ${inbound.chatType} ${inbound.target}: ${preview}`, {
    sessionKey: baseDispatchSessionKey,
    contextKey: `${CHANNEL_ID}:${inbound.messageId}`,
  });

  if (inbound.groupSystemPrompt?.trim()) {
    log(
      `43chat[${accountId}]: GroupSystemPrompt for ${inbound.target} (${inbound.messageId})\n${inbound.groupSystemPrompt}`,
    );
  }

  const buildCtxPayload = (attemptInbound: InboundDescriptor, attemptSessionKey: string) => {
    const attemptBody = core.channel.reply.formatInboundEnvelope({
      channel: CHANNEL_ID,
      from: attemptInbound.conversationLabel,
      body: attemptInbound.text,
      timestamp: attemptInbound.timestamp,
      chatType: attemptInbound.chatType,
      sender: {
        name: attemptInbound.senderName,
        id: attemptInbound.senderId,
      },
    });

    return core.channel.reply.finalizeInboundContext({
      Body: attemptBody,
      BodyForAgent: attemptInbound.text,
      BodyForCommands: attemptInbound.text,
      RawBody: attemptInbound.text,
      CommandBody: attemptInbound.text,
      From: attemptInbound.fromAddress,
      To: attemptInbound.target,
      SessionKey: attemptSessionKey,
      AccountId: route.accountId,
      ChatType: attemptInbound.chatType,
      ConversationLabel: attemptInbound.conversationLabel,
      GroupSubject: attemptInbound.groupSubject,
      GroupSystemPrompt: attemptInbound.groupSystemPrompt,
      SenderName: attemptInbound.senderName,
      SenderId: attemptInbound.senderId,
      Provider: CHANNEL_ID,
      Surface: CHANNEL_ID,
      MessageSid: attemptInbound.messageId,
      Timestamp: attemptInbound.timestamp,
      WasMentioned: attemptInbound.chatType !== "group",
      CommandAuthorized: true,
      OriginatingChannel: CHANNEL_ID,
      OriginatingTo: attemptInbound.target,
    });
  };

  const textChunkLimit = replyDelivery.text_chunk_limit > 0
    ? replyDelivery.text_chunk_limit
    : core.channel.text.resolveTextChunkLimit(cfg, CHANNEL_ID, accountId, {
      fallbackLimit: account.config.textChunkLimit ?? 1800,
    });
  const chunkMode = replyDelivery.chunk_mode
    ?? account.config.chunkMode
    ?? core.channel.text.resolveChunkMode(cfg, CHANNEL_ID, accountId);

  const sendReply = async (text: string): Promise<void> => {
    const suppressedReason = classifyNonSendableReplyText(text, replyPolicy.noReplyToken);
    if (suppressedReason) {
      log(`43chat[${accountId}]: suppress direct reply ${suppressedReason}`);
      return;
    }
    log(`43chat[${accountId}]: send reply ${text}`);
    const chunks = chunkReplyText(
      text,
      chunkMode,
      textChunkLimit,
      core.channel.text.chunkTextWithMode,
    ).filter((chunk) => chunk.length > 0);

    for (const chunk of chunks) {
      await sendMessage43Chat({
        cfg,
        to: inbound.target,
        text: chunk,
        accountId,
      });
    }
  };

  let decisionRecorded = false;
  const recordDecision = (
    decision: string,
    reason: string,
    replyText?: string,
    moderationDecision?: CognitionEnvelopeModerationDecision,
  ): void => {
    if (decisionRecorded) {
      return;
    }
    decisionRecorded = true;
    const result = finalizeSkillDecision({
      cfg,
      event,
      decision,
      reason,
      replyText,
      moderationDecision,
      log,
      error,
    });
    if (result.updated.length > 0 || result.appended.length > 0) {
      log(
        `43chat[${accountId}]: cognition finalized updated=${result.updated.join(", ") || "-"} appended=${result.appended.join(", ") || "-"}`,
      );
    }
    scheduleDecisionBriefRefresh({
      event,
      log,
      error,
    });
    scheduleLongTermCognitionRefresh({
      cfg,
      event,
      log,
      error,
    });
  };

  const runDispatchAttempt = async (
    attemptInbound: InboundDescriptor,
    attempt: number,
    options?: { sessionKeyOverride?: string },
  ) => {
    const attemptStartedAt = Date.now();
    const attemptSessionKey = options?.sessionKeyOverride
      ?? resolveDispatchSessionKey(baseDispatchSessionKey, inbound.messageId, attempt);
    const ctxPayload = buildCtxPayload(attemptInbound, attemptSessionKey);
    let deliverSawFinal = false;
    let replyDispatcherErrored = false;
    let finalText = "";

    const { dispatcher, replyOptions, markDispatchIdle } = core.channel.reply.createReplyDispatcherWithTyping({
      deliver: async (reply: { text?: string; mediaUrl?: string; mediaUrls?: string[]; replyToCurrent?: boolean}, { kind }) => {
        if (kind === "final") {
          log(`43chat[${accountId}]: reply candidate final ${summarizeReplyPayloadForLog(reply)}`);
        } else {
          log(`43chat[${accountId}]: reply ${kind} ${summarizeReplyPayloadForLog(reply)}`);
        }
        if (kind !== "final") {
          return;
        }
        if (
          (reply as { isError?: boolean }).isError
          || looksLikeInternalToolFailureReplyText(reply.text ?? "")
        ) {
          log(`43chat[${accountId}]: ignore internal tool error final reply`);
          return;
        }
        deliverSawFinal = true;
        const mediaUrl = (reply as { mediaUrl?: string }).mediaUrl;
        const mediaUrls = (reply as { mediaUrls?: string[] }).mediaUrls;
        const text = reply.text ?? "";

        if (!text.trim() && (mediaUrl || (Array.isArray(mediaUrls) && mediaUrls.length > 0))) {
          finalText = "[43Chat 插件暂不支持媒体消息发送]";
          return;
        }

        if (!text.trim()) {
          return;
        }

        finalText = unwrapFinalReplyTag(text);
      },
      onError: (err: unknown, info: { kind: string }) => {
        replyDispatcherErrored = true;
        if (err instanceof Error) {
          error(`43chat[${accountId}] ${info.kind} reply failed: ${err.message}`);
        } else {
          error(`43chat[${accountId}] ${info.kind} reply failed: ${String(err ?? "unknown error")}`);
        }
      },
      onIdle: () => {
        log(`43chat[${accountId}]: reply dispatcher idle`);
      },
    });

    let dispatchResult: { queuedFinal: boolean; counts: { final: number } } | undefined;
    const runDispatch = () =>
      core.channel.reply.dispatchReplyFromConfig({
        ctx: ctxPayload,
        cfg,
        dispatcher,
        replyOptions: {
          ...replyOptions,
          disableBlockStreaming: !(account.config.blockStreaming ?? false),
        },
      });

    const withReplyDispatcher = (core.channel.reply as {
      withReplyDispatcher?: (params: {
        dispatcher: unknown;
        run: () => Promise<{ queuedFinal: boolean; counts: { final: number } }>;
        onSettled?: () => Promise<void> | void;
      }) => Promise<{ queuedFinal: boolean; counts: { final: number } }>;
    }).withReplyDispatcher;

    if (typeof withReplyDispatcher === "function") {
      dispatchResult = await withReplyDispatcher({
        dispatcher,
        run: runDispatch,
        onSettled: () => markDispatchIdle(),
      });
    } else {
      try {
        dispatchResult = await runDispatch();
      } finally {
        markDispatchIdle();
      }
    }

    if (!finalText.trim()) {
      const recoveredFinalText = recoverRecentFinalReplyFromSessionLog({
        sessionKey: attemptSessionKey,
        sinceTimestamp: attemptStartedAt,
      });
      if (recoveredFinalText) {
        finalText = recoveredFinalText.trim();
        log(`43chat[${accountId}]: recovered final reply from llm log ${truncateForLog(finalText, 160)}`);
      }
    }

    return {
      attemptSessionKey,
      dispatchResult,
      deliverSawFinal,
      replyDispatcherErrored,
      finalText: finalText.trim(),
    };
  };

  try {
    const mainAttempt = 1;
    const requiresCognitionEnvelope = requireEnvelopeForMainFlow
      || moderationDecisionRequired
      || (inbound.chatType === "direct" && mainFlowMissingSummaries.length > 0);
    const maxMainAttempts = Math.max(
      requiresCognitionEnvelope
        ? Math.max(1, cognitionEnforcement.max_retry_attempts || MAX_EMPTY_MAIN_REPLY_ATTEMPTS)
        : 1,
      MAX_EMPTY_MAIN_REPLY_ATTEMPTS,
    );
    const attemptSessionKey = resolveDispatchSessionKey(baseDispatchSessionKey, inbound.messageId, mainAttempt);
    log(`43chat[${accountId}]: dispatch attempt=${mainAttempt}/${maxMainAttempts} message=${inbound.messageId} session=${attemptSessionKey}`);
    const firstResult = await runDispatchAttempt(inbound, mainAttempt);

    let result = firstResult;
    const firstParsedEnvelope = parseCognitionWriteEnvelope(firstResult.finalText);
    let cognitionEnvelope = shouldParseCognitionEnvelopeForInbound({
      eventType: event.event_type,
      moderationDecisionRequired,
    })
      ? firstParsedEnvelope
      : null;
    let finalReplyText = cognitionEnvelope?.replyText.trim()
      ?? (inbound.chatType === "group"
        ? resolveGroupFinalReplyText(firstResult.finalText)
        : firstResult.finalText);
    let moderationDecision = validateModerationDecision({
      cfg,
      eventType: event.event_type,
      decision: cognitionEnvelope?.decision,
      accountId,
      log,
    });
    if (!moderationDecision) {
      moderationDecision = resolveObserveFallbackModerationDecision({
        cfg,
        eventType: event.event_type,
        decisionRequired: moderationDecisionRequired,
        accountId,
        log,
      });
    }
    const firstAttemptOutcome = classifyDispatchAttemptOutcome({
      finalReplyText,
      suppressTextReply: inbound.suppressTextReply,
      noReplyToken: replyPolicy.noReplyToken,
      deliverSawFinal: firstResult.deliverSawFinal,
      queuedFinal: firstResult.dispatchResult?.queuedFinal,
      finalCount: firstResult.dispatchResult?.counts.final,
    });
    const retryForEnvelope = requiresCognitionEnvelope
      && cognitionEnvelope === null
      && mainAttempt < maxMainAttempts;
    const retryForEmptyOutcome = shouldRetryDispatchForEmptyOutcome({
      outcome: firstAttemptOutcome,
      attempt: mainAttempt,
      maxAttempts: maxMainAttempts,
    });

    if (
      retryForEnvelope
      || retryForEmptyOutcome
    ) {
      const retryAttempt = mainAttempt + 1;
      const retryInbound = buildRetryAttemptInbound(buildInboundDescriptor(event, {
        cfg,
        accountId,
        resolvedRoleNameOverride,
        resolvedSenderRoleNameOverride,
        extraPromptBlocks: [
          ...(retryForEnvelope
            ? buildEnvelopeRetryPromptBlocks({
              missingSummaries: mainFlowMissingSummaries,
              noReplyToken: replyPolicy.noReplyToken,
              priorReplyText: firstResult.finalText,
              moderationDecisionRequired,
              writesRequired: forceInlineCognitionEnvelopeForMainFlow || mainFlowMissingSummaries.length > 0,
            })
            : buildEmptyReplyRetryPromptBlocks({
              noReplyToken: replyPolicy.noReplyToken,
              priorReplyText: firstResult.finalText,
              requireCognitionEnvelope: requireEnvelopeForMainFlow,
            })),
          ...decisionBriefPromptBlocks,
          ...initialPromptBlocks,
        ],
      }) ?? inbound, retryAttempt);
      log(`43chat[${accountId}]: dispatch attempt=${retryAttempt}/${maxMainAttempts} message=${retryInbound.messageId} session=${baseDispatchSessionKey}`);
      const retryResult = await runDispatchAttempt(retryInbound, retryAttempt, {
        sessionKeyOverride: baseDispatchSessionKey,
      });
      const retryParsedEnvelope = parseCognitionWriteEnvelope(retryResult.finalText);
      const retryEnvelope = shouldParseCognitionEnvelopeForInbound({
        eventType: event.event_type,
        moderationDecisionRequired,
      })
        ? retryParsedEnvelope
        : null;
      if (retryEnvelope) {
        result = retryResult;
        cognitionEnvelope = retryEnvelope;
        finalReplyText = retryEnvelope.replyText.trim();
        moderationDecision = validateModerationDecision({
          cfg,
          eventType: event.event_type,
          decision: retryEnvelope.decision,
          accountId,
          log,
        });
        if (!moderationDecision) {
          moderationDecision = resolveObserveFallbackModerationDecision({
            cfg,
            eventType: event.event_type,
            decisionRequired: moderationDecisionRequired,
            accountId,
            log,
          });
        }
        if (moderationDecisionRequired && !moderationDecision) {
          log(`43chat[${accountId}]: cognition envelope recovered on retry attempt=${retryAttempt}, but structured moderation decision is still missing`);
        } else {
          log(`43chat[${accountId}]: cognition envelope recovered on retry attempt=${retryAttempt}`);
        }
      } else {
        const retryFallback = resolveRetryFallbackForMissingEnvelope({
          chatType: inbound.chatType,
          retryFinalText: retryResult.finalText,
          retryForEnvelope,
          firstAttemptOutcome,
        });
        if (retryFallback.keepFirstOutwardReply) {
          result = firstResult;
          cognitionEnvelope = null;
          finalReplyText = retryFallback.finalReplyText;
          log(`43chat[${accountId}]: cognition envelope still missing after retry; keeping first outward reply to avoid blocking message`);
        } else {
          result = retryResult;
          cognitionEnvelope = null;
          finalReplyText = retryFallback.finalReplyText;
          log(
            retryForEnvelope
              ? `43chat[${accountId}]: cognition envelope still missing after retry; falling back to latest outward reply`
              : `43chat[${accountId}]: final reply still empty after retry; falling back to dispatch outcome classification`,
          );
        }
      }
    }

    if (result.replyDispatcherErrored) {
      recordDecision("dispatch_error", "reply dispatcher completed after reply error");
      return {
        messageId: inbound.messageId,
        senderId: inbound.senderId,
        text: inbound.text,
        timestamp: inbound.timestamp,
        target: inbound.target,
        chatType: inbound.chatType,
      };
    }

    log(
      `43chat[${accountId}]: resolved final reply ${
        describeFinalReplyResolutionForLog({
          cognitionEnvelope,
          finalReplyText,
          noReplyToken: replyPolicy.noReplyToken,
        })
      }`,
    );
    if (moderationDecisionRequired && !moderationDecision) {
      log(`43chat[${accountId}]: required structured moderation decision missing for ${inbound.messageId}`);
    }

    if (cognitionEnvelope) {
      applyCognitionWriteEnvelope({
        envelope: cognitionEnvelope,
        event,
        log,
        error,
        accountId,
      });
    }

    const attemptOutcome = classifyDispatchAttemptOutcome({
      finalReplyText,
      suppressTextReply: inbound.suppressTextReply,
      noReplyToken: replyPolicy.noReplyToken,
      deliverSawFinal: result.deliverSawFinal,
      queuedFinal: result.dispatchResult?.queuedFinal,
      finalCount: result.dispatchResult?.counts.final,
    });
    const outwardOutcome = applyModerationReplyVisibility({
      outcome: attemptOutcome,
      moderationDecision,
    });

    let currentMissingIssues: CognitionWriteRequirementIssue[] = [];
    let currentMissingSummaries: string[] = [];
    if (
      cognitionEnforcement.enabled
      && (event.event_type === "group_message" || forceInlineCognitionEnvelopeForMainFlow)
    ) {
      const issues = inspectCognitionWriteRequirementsForEvent({
        cfg,
        event,
      });
      currentMissingIssues = filterCognitionIssuesToRequiredAliases({
        issues,
        requiredAliases: requiredIssueAliasesForEvent,
      });
      currentMissingSummaries = currentMissingIssues.map((issue) => `${issue.alias}: ${issue.summary} (${issue.path})`);
    }

    const resolution = resolveGroupAttemptResolution({
      outcome: outwardOutcome,
      missingSummaries: currentMissingSummaries,
      blockedForCognition: forceInlineCognitionEnvelopeForMainFlow
        && cognitionEnforcement.enabled
        && cognitionEnforcement.block_final_reply_when_incomplete
        && currentMissingSummaries.length > 0,
      blockedForModerationDecision: moderationDecisionRequired && !moderationDecision,
      attempt: 1,
      maxAttempts: 1,
    });

    if (resolution.action === "record") {
      if (resolution.decision === "reply_blocked_for_cognition") {
        log(`43chat[${accountId}]: blocked final text reply for ${inbound.messageId} missing=${currentMissingSummaries.join(" | ")}`);
      } else if (outwardOutcome.kind === "suppressed") {
        log(`43chat[${accountId}]: suppressing final text reply for ${inbound.messageId}`);
      } else if (outwardOutcome.kind === "no_reply") {
        log(`43chat[${accountId}]: model chose ${replyPolicy.noReplyToken} for ${inbound.messageId}`);
      }
      await executeModerationAction({
        cfg,
        accountId,
        event,
        moderationDecision,
        log,
        error,
      });
      recordDecision(resolution.decision, resolution.reason, undefined, moderationDecision);
    } else {
      await executeModerationAction({
        cfg,
        accountId,
        event,
        moderationDecision,
        log,
        error,
      });
      await sendReply(resolution.replyText);
      recordDecision("reply_sent", resolution.reason, resolution.replyText, moderationDecision);
    }

    if (
      (event.event_type === "group_message" || forceInlineCognitionEnvelopeForMainFlow)
      && currentMissingSummaries.length > 0
    ) {
      log(
        `43chat[${accountId}]: cognition writes still missing after main decision envelope=${cognitionEnvelope ? "present" : "absent"} missing=${currentMissingSummaries.join(" | ")}`,
      );
    }

  } catch (err) {
    error(`43chat[${accountId}]: failed to dispatch message: ${String(err)}`);
    recordDecision("dispatch_error", String(err));
  }

  return {
    messageId: inbound.messageId,
    senderId: inbound.senderId,
    text: inbound.text,
    timestamp: inbound.timestamp,
    target: inbound.target,
    chatType: inbound.chatType,
  };
}

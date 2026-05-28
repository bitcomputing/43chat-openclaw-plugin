import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import { resolve43ChatAccount } from "./accounts.js";
import { get43ChatRuntime } from "./runtime.js";
import { extract43ChatTextContent, truncateForLog } from "./message-content.js";
import { sendMessage43Chat } from "./send.js";
import type {
  Chat43AnySSEEvent,
  Chat43FriendAcceptedEventData,
  Chat43FriendRequestEventData,
  Chat43GroupInvitationEventData,
  Chat43GroupMemberJoinedEventData,
  Chat43GroupMessageEventData,
  Chat43GroupNoticeEventData,
  Chat43PrivateMessageEventData,
  Chat43SystemNoticeEventData,
} from "./types.js";
import packageJson from "../package.json" with { type: "json" };

type InboundNotification = {
  dedupeKey: string;
  messageId: string;
  chatType: "direct" | "group";
  target: string;
  fromAddress: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  conversationLabel: string;
  isFromOwner: boolean;
  isAgent?: boolean;
  groupSubject?: string;
};

type AgentHarnessModule = {
  appendSessionTranscriptMessage: (params: {
    transcriptPath: string;
    message: unknown;
    now?: number;
    config?: unknown;
  }) => Promise<{ messageId: string }>;
  emitSessionTranscriptUpdate: (update: {
    sessionFile: string;
    sessionKey?: string;
    message?: unknown;
    messageId?: string;
  }) => void;
};

type TranscriptNotificationMessage = {
  role: "assistant";
  content: Array<{ type: "text"; text: string }>;
  api: string;
  provider: string;
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
  };
  stopReason: "stop";
  timestamp: number;
};

const CHANNEL_ID = packageJson.openclaw.channel.id;
const MAIN_SESSION_KEY = "agent:main:main";
const MAIN_SESSION_NAME = "main";
const MAX_PROCESSED_EVENTS = 2048;

const processedEvents = new Map<string, number>();
let agentHarnessModulePromise: Promise<AgentHarnessModule> | null = null;

function rememberProcessedEvent(key: string): boolean {
  if (processedEvents.has(key)) return true;
  processedEvents.set(key, Date.now());
  if (processedEvents.size > MAX_PROCESSED_EVENTS) {
    const oldest = [...processedEvents.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, processedEvents.size - MAX_PROCESSED_EVENTS);
    for (const [eventKey] of oldest) processedEvents.delete(eventKey);
  }
  return false;
}

function rememberOutboundMessage(messageId: string | undefined): void {
  if (!messageId) return;
  rememberProcessedEvent(`private_message:${messageId}`);
  rememberProcessedEvent(`group_message:${messageId}`);
}

function resolvePnpmGlobalCandidates(harnessRelative: string): string[] {
  const pnpmHome = process.env.PNPM_HOME;
  if (!pnpmHome) return [];
  const globalDir = path.join(pnpmHome, "global");
  try {
    return readdirSync(globalDir).map(v =>
      path.join(globalDir, v, "node_modules", harnessRelative)
    );
  } catch {
    return [];
  }
}

function resolveOpenClawHarnessModuleCandidates(): string[] {
  const harnessRelative = "openclaw/dist/plugin-sdk/agent-harness.js";
  return [
    process.env.OPENCLAW_AGENT_HARNESS_MODULE,
    "/opt/homebrew/lib/node_modules/" + harnessRelative,
    "/usr/local/lib/node_modules/" + harnessRelative,
    path.resolve(process.execPath, "../../lib/node_modules/" + harnessRelative),
    ...resolvePnpmGlobalCandidates(harnessRelative),
    path.join(os.homedir(), ".bun/install/global/node_modules/" + harnessRelative),
  ].filter((candidate): candidate is string => Boolean(candidate?.trim()));
}

async function loadAgentHarnessModule(): Promise<AgentHarnessModule> {
  agentHarnessModulePromise ??= (async () => {
    for (const candidate of resolveOpenClawHarnessModuleCandidates()) {
      if (!existsSync(candidate)) continue;
      const mod = await import(pathToFileURL(candidate).href) as Partial<AgentHarnessModule>;
      if (typeof mod.appendSessionTranscriptMessage === "function" && typeof mod.emitSessionTranscriptUpdate === "function") {
        return mod as AgentHarnessModule;
      }
    }

    const mod = await import("openclaw/plugin-sdk/agent-harness") as Partial<AgentHarnessModule>;
    if (typeof mod.appendSessionTranscriptMessage === "function" && typeof mod.emitSessionTranscriptUpdate === "function") {
      return mod as AgentHarnessModule;
    }
    throw new Error("openclaw agent harness module is missing transcript append/update exports");
  })();
  return agentHarnessModulePromise;
}

function resolveBusinessId(event: Chat43AnySSEEvent): string {
  const data = event.data as Record<string, unknown>;
  const id = data.message_id ?? data.request_id ?? data.invitation_id ?? data.notice_id ?? event.id;
  return `${event.event_type}:${String(id)}`;
}

function buildInboundNotification(event: Chat43AnySSEEvent): InboundNotification | null {
  switch (event.event_type) {
    case "private_message": {
      const data = event.data as Chat43PrivateMessageEventData;
      return {
        dedupeKey: resolveBusinessId(event),
        messageId: String(data.message_id || event.id),
        chatType: "direct",
        target: `user:${data.from_user_id}`,
        fromAddress: `user:${data.from_user_id}`,
        senderId: String(data.from_user_id),
        senderName: data.from_nickname || String(data.from_user_id),
        text: extract43ChatTextContent(data.content, data.content_type ?? data.msg_type),
        timestamp: data.timestamp || event.timestamp || Date.now(),
        conversationLabel: data.from_nickname || `user:${data.from_user_id}`,
        isFromOwner: data.is_from_owner === true,
        isAgent: data.is_agent === true,
      };
    }
    case "group_message": {
      const data = event.data as Chat43GroupMessageEventData;
      return {
        dedupeKey: resolveBusinessId(event),
        messageId: String(data.message_id || event.id),
        chatType: "group",
        target: `group:${data.group_id}`,
        fromAddress: `group:${data.group_id}:user:${data.from_user_id}`,
        senderId: String(data.from_user_id),
        senderName: data.from_nickname || String(data.from_user_id),
        text: extract43ChatTextContent(data.content, data.content_type ?? data.msg_type),
        timestamp: data.timestamp || event.timestamp || Date.now(),
        conversationLabel: data.group_name || `group:${data.group_id}`,
        isFromOwner: data.is_from_owner === true,
        isAgent: data.is_agent === true,
        groupSubject: data.group_name,
      };
    }
    case "friend_request": {
      const data = event.data as Chat43FriendRequestEventData;
      return systemLikeNotification(event, {
        messageId: `friend_request:${data.request_id}`,
        target: `user:${data.from_user_id}`,
        senderId: String(data.from_user_id),
        senderName: data.from_nickname,
        text: `好友申请: ${data.request_msg || ""}`.trim(),
        label: "好友申请",
        timestamp: data.timestamp,
        isFromOwner: false,
      });
    }
    case "friend_accepted": {
      const data = event.data as Chat43FriendAcceptedEventData;
      return systemLikeNotification(event, {
        messageId: `friend_accepted:${data.request_id}`,
        target: `user:${data.from_user_id}`,
        senderId: String(data.from_user_id),
        senderName: data.from_nickname,
        text: "好友申请已通过",
        label: "好友通过",
        timestamp: data.timestamp,
        isFromOwner: false,
      });
    }
    case "group_invitation": {
      const data = event.data as Chat43GroupInvitationEventData;
      return systemLikeNotification(event, {
        messageId: `group_invitation:${data.invitation_id}`,
        target: `group:${data.group_id}`,
        senderId: String(data.inviter_id),
        senderName: data.inviter_name,
        text: `群邀请: ${data.invite_msg || ""}`.trim(),
        label: data.group_name || "群邀请",
        timestamp: data.timestamp,
        isFromOwner: false,
        groupSubject: data.group_name,
      });
    }
    case "group_member_joined": {
      const data = event.data as Chat43GroupMemberJoinedEventData;
      return systemLikeNotification(event, {
        messageId: `group_member_joined:${data.group_id}:${data.user_id}:${data.timestamp}`,
        target: `group:${data.group_id}`,
        senderId: String(data.user_id),
        senderName: data.nickname,
        text: `${data.nickname || data.user_id} 加入了群聊`,
        label: data.group_name || "群成员加入",
        timestamp: data.timestamp,
        isFromOwner: false,
        groupSubject: data.group_name,
      });
    }
    case "system_notice": {
      const data = event.data as Chat43SystemNoticeEventData;
      return systemLikeNotification(event, {
        messageId: `system_notice:${data.notice_id}`,
        target: "system",
        senderId: "system",
        senderName: data.title || "43Chat",
        text: data.content || data.title || "系统通知",
        label: data.title || "系统通知",
        timestamp: data.timestamp,
        isFromOwner: false,
      });
    }
    case "group_notice": {
      const data = event.data as Chat43GroupNoticeEventData;
      return systemLikeNotification(event, {
        messageId: `group_notice:${data.group_id}:${data.timestamp}`,
        target: `group:${data.group_id}`,
        senderId: "system",
        senderName: "43Chat",
        text: data.notice || "群通知",
        label: data.group_name || "群通知",
        timestamp: data.timestamp,
        isFromOwner: false,
        groupSubject: data.group_name,
      });
    }
    default:
      return null;
  }
}

function systemLikeNotification(
  event: Chat43AnySSEEvent,
  params: {
    messageId: string;
    target: string;
    senderId: string;
    senderName: string;
    text: string;
    label: string;
    timestamp?: number;
    isFromOwner?: boolean;
    groupSubject?: string;
  },
): InboundNotification {
  const chatType = params.target.startsWith("group:") ? "group" : "direct";
  return {
    dedupeKey: resolveBusinessId(event),
    messageId: params.messageId,
    chatType,
    target: params.target,
    fromAddress: chatType === "group"
      ? `${params.target}:user:${params.senderId}`
      : params.target,
    senderId: params.senderId,
    senderName: params.senderName || params.senderId,
    text: params.text,
    timestamp: params.timestamp || event.timestamp || Date.now(),
    conversationLabel: params.label,
    isFromOwner: params.isFromOwner === true,
    groupSubject: params.groupSubject,
  };
}

export function formatMainSessionNotificationEvent(params: {
  accountId: string;
  inbound: InboundNotification;
}): string {
  const { inbound } = params;
  const chatLabel = inbound.chatType === "group" ? "群聊" : "私聊";
  const groupId = inbound.chatType === "group"
    ? inbound.target.match(/^group:(.+)$/u)?.[1]
    : undefined;
  const subjectBase = inbound.groupSubject || inbound.conversationLabel || inbound.target;
  const subject = groupId ? `${subjectBase} (群ID: ${groupId})` : subjectBase;
  const agentLabel = inbound.isAgent === true ? "[来自 Agent]" : "";
  const sender = `${inbound.senderName} (${inbound.senderId})${agentLabel}`;
  const preview = truncateForLog(inbound.text, 500) || "[非文本消息]";
  return inbound.chatType === "group"
    ? `🔔来自43Chat的${chatLabel}消息 ${subject}\n${sender} : ${preview}`
    : `🔔来自43Chat的${chatLabel}消息\n${sender} : ${preview}`;
}

async function appendMainSessionNotification(params: {
  sessionFile: string;
  sessionKey: string;
  text: string;
  messageId: string;
}): Promise<void> {
  await mkdir(path.dirname(params.sessionFile), { recursive: true });
  const harness = await loadAgentHarnessModule();
  const message: TranscriptNotificationMessage = {
    role: "assistant",
    content: [{ type: "text", text: params.text }],
    api: "openai-responses",
    provider: "43chat-openclaw-plugin",
    model: "43chat-notification",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };

  const { messageId } = await harness.appendSessionTranscriptMessage({
    transcriptPath: params.sessionFile,
    message,
    now: message.timestamp,
    config: { sessionWriteLockAcquireTimeoutMs: 10_000 },
  });

  for (const sessionKey of [params.sessionKey, "main"]) {
    harness.emitSessionTranscriptUpdate({
      sessionFile: params.sessionFile,
      sessionKey,
      message,
      messageId: params.messageId || messageId,
    });
  }
}

function resolveSessionFile(params: {
  cfg: ClawdbotConfig;
  routeAgentId: string;
  sessionKey: string;
}): string | undefined {
  const core = get43ChatRuntime();
  const storePath = core.agent.session.resolveStorePath(params.cfg.session?.store, {
    agentId: params.routeAgentId,
  });
  const store = core.agent.session.loadSessionStore(storePath);
  const entry = store[params.sessionKey];
  return entry?.sessionId
    ? core.agent.session.resolveSessionFilePath(entry.sessionId, entry, { agentId: params.routeAgentId })
    : undefined;
}

async function setMainSessionName(params: {
  storePath: string;
  sessionKey: string;
  error: (message: string) => void;
}): Promise<void> {
  try {
    const raw = await readFile(params.storePath, "utf8");
    const store = JSON.parse(raw) as Record<string, Record<string, unknown> | undefined>;
    const entry = store[params.sessionKey];
    if (!entry) return;
    if (entry.displayName === MAIN_SESSION_NAME && entry.label === MAIN_SESSION_NAME) return;

    store[params.sessionKey] = {
      ...entry,
      displayName: MAIN_SESSION_NAME,
      label: MAIN_SESSION_NAME,
    };
    await writeFile(params.storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  } catch (err) {
    params.error(`43chat: failed to set main session name: ${String(err)}`);
  }
}

export function shouldDispatchToAgent(inbound: InboundNotification): boolean {
  return inbound.isFromOwner && !inbound.isAgent && inbound.chatType === "direct";
}

function shouldSkipOutboundReplyText(text: string): boolean {
  const trimmed = text.trim();
  return !trimmed || trimmed === "NO_REPLY" || trimmed === "[[silent]]";
}

async function dispatchOwnerPrivateReply(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  routeAgentId: string;
  routeAccountId: string;
  inbound: InboundNotification;
  ctx: ReturnType<typeof get43ChatRuntime>["channel"]["reply"]["finalizeInboundContext"] extends (...args: any[]) => infer R ? R : never;
  runtime?: RuntimeEnv;
}): Promise<void> {
  const core = get43ChatRuntime();
  const error = params.runtime?.error ?? console.error;
  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    cfg: params.cfg,
    agentId: params.routeAgentId,
    channel: CHANNEL_ID,
    accountId: params.routeAccountId,
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: params.ctx,
    cfg: params.cfg,
    dispatcherOptions: {
      ...replyPipeline,
      deliver: async (payload) => {
        if (payload.isReasoning || payload.isCompactionNotice) {
          return;
        }
        const text = payload.text?.trim();
        if (!text || shouldSkipOutboundReplyText(text)) {
          return;
        }
        const result = await sendMessage43Chat({
          cfg: params.cfg,
          to: params.inbound.target,
          text,
          accountId: params.routeAccountId,
        });
        rememberOutboundMessage(result.messageId);
      },
      onError: (err, info) => {
        error(`43chat[${params.accountId}]: ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: {
      onModelSelected,
    },
  });
}

export async function handle43ChatEvent({
  cfg,
  event,
  accountId = "default",
  runtime,
}: {
  cfg: ClawdbotConfig;
  event: Chat43AnySSEEvent;
  accountId?: string;
  runtime?: RuntimeEnv;
}): Promise<InboundNotification | null> {
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;
  const account = resolve43ChatAccount({ cfg, accountId });
  if (!account.enabled || !account.configured) return null;

  const inbound = buildInboundNotification(event);
  if (!inbound || rememberProcessedEvent(inbound.dedupeKey)) return null;

  const core = get43ChatRuntime();
  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId,
    peer: { kind: inbound.chatType === "group" ? "group" : "direct", id: inbound.target },
  });
  if (!route.agentId) {
    error(`43chat[${accountId}]: no agent route found for ${inbound.target}`);
    return null;
  }

  const notificationText = formatMainSessionNotificationEvent({ accountId, inbound });
  const dispatchToAgent = shouldDispatchToAgent(inbound);
  const inboundBody = dispatchToAgent ? inbound.text : notificationText;
  const storePath = core.agent.session.resolveStorePath(cfg.session?.store, { agentId: route.agentId });
  const ctx = core.channel.reply.finalizeInboundContext({
    Body: inboundBody,
    BodyForAgent: inboundBody,
    BodyForCommands: inbound.text,
    RawBody: inbound.text,
    CommandBody: inbound.text,
    From: inbound.fromAddress,
    To: inbound.target,
    SessionKey: MAIN_SESSION_KEY,
    AccountId: route.accountId,
    ChatType: inbound.chatType,
    ConversationLabel: inbound.conversationLabel,
    GroupSubject: inbound.groupSubject,
    OwnerAllowFrom: dispatchToAgent ? [inbound.senderId, inbound.fromAddress] : undefined,
    SenderName: inbound.senderName,
    SenderId: inbound.senderId,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: inbound.messageId,
    Timestamp: inbound.timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: inbound.target,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: MAIN_SESSION_KEY,
    ctx,
    createIfMissing: true,
    updateLastRoute: {
      sessionKey: MAIN_SESSION_KEY,
      channel: CHANNEL_ID,
      to: inbound.target,
      accountId: route.accountId,
    },
    onRecordError: (err) => error(`43chat[${accountId}]: failed to record session: ${String(err)}`),
  });
  await setMainSessionName({
    storePath,
    sessionKey: MAIN_SESSION_KEY,
    error,
  });

  const sessionFile = resolveSessionFile({ cfg, routeAgentId: route.agentId, sessionKey: MAIN_SESSION_KEY });
  if (!sessionFile) {
    error(`43chat[${accountId}]: missing main session file`);
    return inbound;
  }

  if (dispatchToAgent) {
    await dispatchOwnerPrivateReply({
      cfg,
      accountId,
      routeAgentId: route.agentId,
      routeAccountId: route.accountId,
      inbound,
      ctx,
      runtime,
    });
    log(`43chat[${accountId}]: dispatched owner private message=${inbound.messageId}`);
    return inbound;
  }

  await appendMainSessionNotification({
    sessionFile,
    sessionKey: MAIN_SESSION_KEY,
    text: notificationText,
    messageId: `${CHANNEL_ID}:${inbound.messageId}`,
  });

  log(`43chat[${accountId}]: notified main session message=${inbound.messageId}`);
  return inbound;
}

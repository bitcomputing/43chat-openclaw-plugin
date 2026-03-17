import { createHash } from "node:crypto";
import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { resolve43ChatAccount } from "./accounts.js";
import { get43ChatRuntime } from "./runtime.js";
import { sendMessage43Chat } from "./send.js";
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
};

const processedEvents = new Map<string, number>();
const MAX_PROCESSED_EVENTS = 2048;

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

function buildInboundDescriptor(event: Chat43AnySSEEvent): InboundDescriptor | null {
  const businessId = resolveBusinessId(event);
  const messageId = businessId;
  const dedupeKey = `${event.event_type}:${event.id || businessId}`;

  switch (event.event_type) {
    case "private_message": {
      const data = event.data as Chat43PrivateMessageEventData;
      const senderId = String(data.from_user_id);
      const content = String(data.content ?? "").trim();
      let text: string;
      switch (data.content_type) {
        case "text":
          text = `[43Chat私聊消息][类型：文本][来自：${senderId}][内容：${content}]`;
          break;
        case "image":
          text = `[43Chat私聊消息][类型：图片][来自：${senderId}][图片对象：${content || "<empty>"}]`;
          break;
        case "file":
          text = `[43Chat私聊消息][类型：文件][来自：${senderId}][文件对象：${content || "<empty>"}]`;
          break;
        case "sharegroup":
          text = `[43Chat私聊消息][类型：群组卡片][来自：${senderId}][卡片对象：${content || "<empty>"}]`;
          break;
        case "shareuser":
          text = `[43Chat私聊消息][类型：用户卡片][来自：${senderId}][卡片对象：${content || "<empty>"}]`;
          break;
        default:
          text = `[43Chat私聊消息][类型：${data.content_type}][来自：${senderId}][内容：${content || "<empty>"}]`;
          break;
      }
      if (!text) {
        return null;
      }
      return {
        dedupeKey,
        messageId,
        chatType: "direct",
        target: `user:${senderId}`,
        fromAddress: `43chat:user:${senderId}`,
        senderId,
        senderName: senderId,
        text,
        timestamp: data.timestamp || event.timestamp || Date.now(),
        conversationLabel: `user:${senderId}`,
      };
    }
    case "group_message": {
      const data = event.data as Chat43GroupMessageEventData;
      const groupId = String(data.group_id);
      const senderId = String(data.from_user_id);
      const content = String(data.content ?? "").trim();
      let text: string;
      switch (data.content_type) {
        case "text":
          text = `[43Chat群消息][类型：文本][来自：${senderId}][内容：${content}]`;
          break;
        case "image":
          text = `[43Chat群消息][类型：图片][来自：${senderId}][图片对象：${content || "<empty>"}]`;
          break;
        case "file":
          text = `[43Chat群消息][类型：文件][来自：${senderId}][文件对象：${content || "<empty>"}]`;
          break;
        case "sharegroup":
          text = `[43Chat群消息][类型：群组卡片][来自：${senderId}][卡片对象：${content || "<empty>"}]`;
          break;
        case "shareuser":
          text = `[43Chat群消息][类型：用户卡片][来自：${senderId}][卡片对象：${content || "<empty>"}]`;
          break;
        default:
          text = `[43Chat群消息][类型：${data.content_type}][来自：${senderId}][内容：${content || "<empty>"}]`;
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
        fromAddress: `43chat:group:${groupId}`,
        senderId,
        senderName: senderId,
        text,
        timestamp: data.timestamp || event.timestamp || Date.now(),
        groupSubject: groupId,
        conversationLabel: `group:${groupId}`,
      };
    }
    case "friend_request": {
      const data = event.data as Chat43FriendRequestEventData;
      const senderId = String(data.from_user_id);
      return {
        dedupeKey,
        messageId,
        chatType: "direct",
        target: `user:${senderId}`,
        fromAddress: `43chat:user:${senderId}`,
        senderId,
        senderName: data.from_nickname || senderId,
        text: `[43Chat好友请求] 用户 ${senderId}${data.from_nickname ? `(${data.from_nickname})` : ""} 请求添加好友，附言：${data.request_msg || "无"}，request_id=${data.request_id}`,
        timestamp: data.timestamp || event.timestamp || Date.now(),
        conversationLabel: `user:${senderId}`,
      };
    }
    case "friend_accepted": {
      const data = event.data as Chat43FriendAcceptedEventData;
      const senderId = String(data.from_user_id);
      return {
        dedupeKey,
        messageId,
        chatType: "direct",
        target: `user:${senderId}`,
        fromAddress: `43chat:user:${senderId}`,
        senderId,
        senderName: data.from_nickname || senderId,
        text: `[43Chat好友通过] 用户 ${senderId}${data.from_nickname ? `(${data.from_nickname})` : ""} 已通过好友请求，request_id=${data.request_id}`,
        timestamp: data.timestamp || event.timestamp || Date.now(),
        conversationLabel: `user:${senderId}`,
      };
    }
    case "group_invitation": {
      const data = event.data as Chat43GroupInvitationEventData;
      const groupId = String(data.group_id);
      const inviterId = String(data.inviter_id);
      return {
        dedupeKey,
        messageId,
        chatType: "group",
        target: `group:${groupId}`,
        fromAddress: `43chat:group:${groupId}`,
        senderId: inviterId,
        senderName: data.inviter_name || inviterId,
        text: `[43Chat群通知] 你收到群组邀请/入群申请通知，group_id=${groupId}，group_name=${data.group_name || "未知群"}，inviter=${data.inviter_name || inviterId}(${inviterId})，message=${data.invite_msg || "无"}，invitation_id=${data.invitation_id}`,
        timestamp: data.timestamp || event.timestamp || Date.now(),
        groupSubject: data.group_name || groupId,
        conversationLabel: `group:${groupId}`,
      };
    }
    case "group_member_joined": {
      const data = event.data as Chat43GroupMemberJoinedEventData;
      const groupId = String(data.group_id);
      const userId = String(data.user_id);
      return {
        dedupeKey,
        messageId,
        chatType: "group",
        target: `group:${groupId}`,
        fromAddress: `43chat:group:${groupId}`,
        senderId: userId,
        senderName: data.nickname || userId,
        text: `[43Chat群通知] 新成员入群，group_id=${groupId}，group_name=${data.group_name || "未知群"}，user_id=${userId}，nickname=${data.nickname || userId}，join_method=${data.join_method || "unknown"}`,
        timestamp: data.timestamp || event.timestamp || Date.now(),
        groupSubject: data.group_name || groupId,
        conversationLabel: `group:${groupId}`,
      };
    }
    case "system_notice": {
      const data = event.data as Chat43SystemNoticeEventData;
      return {
        dedupeKey,
        messageId,
        chatType: "direct",
        target: "user:0",
        fromAddress: "43chat:user:0",
        senderId: "0",
        senderName: "system",
        text: `[43Chat系统通知][${data.level || "info"}] ${data.title || "系统通知"}: ${data.content || ""}`.trim(),
        timestamp: data.timestamp || event.timestamp || Date.now(),
        conversationLabel: "user:0",
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
    return [text];
  }
  return Array.from(chunkTextWithMode(text, textChunkLimit, chunkMode));
}

export function map43ChatEventToInboundDescriptor(event: Chat43AnySSEEvent): InboundDescriptor | null {
  return buildInboundDescriptor(event);
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

  const inbound = buildInboundDescriptor(event);
  if (!inbound) {
    return null;
  }

  if (rememberProcessedEvent(inbound.dedupeKey)) {
    return null;
  }

  const core = get43ChatRuntime();
  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: "43chat",
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

  // 暂时不需要预览
  //const preview = inbound.text.replace(/\s+/g, " ").slice(0, 160);
  const preview = "";
  core.system.enqueueSystemEvent(`43Chat[${accountId}] ${inbound.chatType} ${inbound.target}: ${preview}`, {
    sessionKey: route.sessionKey,
    contextKey: `43chat:${inbound.messageId}`,
  });

  const body = core.channel.reply.formatInboundEnvelope({
    channel: "43Chat",
    from: inbound.conversationLabel,
    body: inbound.text,
    timestamp: inbound.timestamp,
    chatType: inbound.chatType,
    sender: {
      name: inbound.senderName,
      id: inbound.senderId,
    },
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: inbound.text,
    BodyForCommands: inbound.text,
    RawBody: inbound.text,
    CommandBody: inbound.text,
    From: inbound.fromAddress,
    To: inbound.target,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: inbound.chatType,
    ConversationLabel: inbound.conversationLabel,
    GroupSubject: inbound.groupSubject,
    SenderName: inbound.senderName,
    SenderId: inbound.senderId,
    Provider: "43chat" as const,
    Surface: "43chat" as const,
    MessageSid: inbound.messageId,
    Timestamp: inbound.timestamp,
    WasMentioned: true,
    CommandAuthorized: true,
    OriginatingChannel: "43chat" as const,
    OriginatingTo: inbound.target,
  });

  const textChunkLimit = core.channel.text.resolveTextChunkLimit(cfg, "43chat", accountId, {
    fallbackLimit: account.config.textChunkLimit ?? 1800,
  });
  const chunkMode = account.config.chunkMode
    ?? core.channel.text.resolveChunkMode(cfg, "43chat", accountId);

  const sendReply = async (text: string): Promise<void> => {
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

  const { dispatcher, replyOptions, markDispatchIdle } = core.channel.reply.createReplyDispatcherWithTyping({
    deliver: async (reply: { text?: string; mediaUrl?: string; mediaUrls?: string[] }, { kind }) => {
      // 只发最终回复，忽略 tool/block
      if (kind !== "final") {
        return;
      }
      const mediaUrl = (reply as { mediaUrl?: string }).mediaUrl;
      const mediaUrls = (reply as { mediaUrls?: string[] }).mediaUrls;
      const text = reply.text ?? "";

      if (!text.trim() && (mediaUrl || (Array.isArray(mediaUrls) && mediaUrls.length > 0))) {
        await sendReply("[43Chat 插件暂不支持媒体消息发送]");
        return;
      }

      if (!text.trim()) {
        return;
      }

      await sendReply(text);
    },
    onError: (err: unknown, info: { kind: string }) => {
      if (err instanceof Error) {
        error(`43chat[${accountId}] ${info.kind} reply failed: ${err.message}`);
      } else {
        error(`43chat[${accountId}] ${info.kind} reply failed: ${String(err ?? "unknown error")}`);
      }
      return;
    },
    onIdle: () => {
      log(`43chat[${accountId}]: reply dispatcher idle`);
    },
  });

  try {
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
      await withReplyDispatcher({
        dispatcher,
        run: runDispatch,
        onSettled: () => markDispatchIdle(),
      });
    } else {
      try {
        await runDispatch();
      } finally {
        markDispatchIdle();
      }
    }
  } catch (err) {
    error(`43chat[${accountId}]: failed to dispatch message: ${String(err)}`);
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

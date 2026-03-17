import type { z } from "zod";
import type { Chat43AccountConfigSchema, Chat43ConfigSchema } from "./config-schema.js";

export type Chat43Config = z.infer<typeof Chat43ConfigSchema>;
export type Chat43AccountConfig = z.infer<typeof Chat43AccountConfigSchema>;

export type Resolved43ChatAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  config: Chat43AccountConfig;
};

export type Chat43ConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "backoff"
  | "error"
  | "stopped";

export type Chat43DisconnectInfo = {
  code: number;
  reason: string;
  at: number;
};

export type Chat43RuntimeStatusPatch = {
  running?: boolean;
  connected?: boolean;
  connectionState?: Chat43ConnectionState;
  reconnectAttempts?: number;
  nextRetryAt?: number | null;
  lastConnectedAt?: number | null;
  lastDisconnect?: Chat43DisconnectInfo | null;
  lastError?: string | null;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
};

export type Chat43EventType =
  | "private_message"
  | "group_message"
  | "friend_request"
  | "friend_accepted"
  | "group_invitation"
  | "group_member_joined"
  | "system_notice"
  | "heartbeat";

export type Chat43SSEEventEnvelope<T = unknown> = {
  id: string;
  event_type: Chat43EventType;
  data: T;
  timestamp: number;
};

export type Chat43PrivateMessageEventData = {
  message_id: string;
  from_user_id: number;
  from_nickname: string;
  to_user_id: number;
  content: string;
  content_type: string;
  timestamp: number;
};

export type Chat43GroupMessageEventData = {
  message_id: string;
  group_id: number;
  from_user_id: number;
  from_nickname: string;
  content: string;
  content_type: string;
  timestamp: number;
};

export type Chat43FriendRequestEventData = {
  request_id: number;
  from_user_id: number;
  from_nickname: string;
  from_avatar: string;
  request_msg: string;
  timestamp: number;
};

export type Chat43FriendAcceptedEventData = {
  request_id: number;
  from_user_id: number;
  from_nickname: string;
  timestamp: number;
};

export type Chat43GroupInvitationEventData = {
  invitation_id: number;
  group_id: number;
  group_name: string;
  inviter_id: number;
  inviter_name: string;
  invite_msg: string;
  timestamp: number;
};

export type Chat43GroupMemberJoinedEventData = {
  group_id: number;
  group_name: string;
  user_id: number;
  nickname: string;
  join_method: string;
  timestamp: number;
};

export type Chat43SystemNoticeEventData = {
  notice_id: string;
  title: string;
  content: string;
  level: string;
  timestamp: number;
};

export type Chat43AnySSEEvent =
  | Chat43SSEEventEnvelope<Chat43PrivateMessageEventData>
  | Chat43SSEEventEnvelope<Chat43GroupMessageEventData>
  | Chat43SSEEventEnvelope<Chat43FriendRequestEventData>
  | Chat43SSEEventEnvelope<Chat43FriendAcceptedEventData>
  | Chat43SSEEventEnvelope<Chat43GroupInvitationEventData>
  | Chat43SSEEventEnvelope<Chat43GroupMemberJoinedEventData>
  | Chat43SSEEventEnvelope<Chat43SystemNoticeEventData>;

export type Chat43OpenApiResponse<T> = {
  code: number;
  message: string;
  timestamp: number;
  data?: T;
};

export type Chat43AgentProfile = {
  agent_id: string;
  name: string;
  avatar: string;
  thumbnail_url: string;
  description: string;
  user_id: number;
  im_user_id: string;
  developer_name: string;
  developer_email: string;
  gender: number;
  birthday: string;
  city: string;
  status: number;
  created_at: number;
  claim_url?: string;
};

export type Chat43Probe = {
  ok: boolean;
  agentId?: string;
  userId?: number;
  name?: string;
  status?: number;
  error?: string;
};

export type Chat43SendResult = {
  messageId: string;
  chatId: string;
  targetType: "user" | "group";
};

export type Chat43MessageContext = {
  messageId: string;
  senderId: string;
  text: string;
  timestamp: number;
  target: string;
  chatType: "direct" | "group";
};

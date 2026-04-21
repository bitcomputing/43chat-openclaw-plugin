import { describe, expect, it } from "vitest";
import {
  looksLikeDispatchTimeoutError,
  looksLikeInternalToolFailureReplyText,
  map43ChatEventToInboundDescriptor,
  shouldRetryDispatchAfterFailure,
} from "../bot.js";

describe("43Chat event mapping", () => {
  it("maps friend request into a direct task", () => {
    const descriptor = map43ChatEventToInboundDescriptor({
      id: "evt-1",
      event_type: "friend_request",
      timestamp: 1000,
      data: {
        request_id: 42,
        from_user_id: 12445,
        from_nickname: "你好啊，世界",
        request_msg: "我是从群里加你的",
        timestamp: 1000,
      },
    });

    expect(descriptor).toMatchObject({
      chatType: "direct",
      target: "user:12445",
      senderId: "12445",
    });
    expect(descriptor?.text).toContain("43Chat好友请求");
    expect(descriptor?.text).toContain("request_id=42");
  });

  it("keeps private message body clean", () => {
    const descriptor = map43ChatEventToInboundDescriptor({
      id: "evt-2",
      event_type: "private_message",
      timestamp: 1000,
      data: {
        message_id: 789,
        from_user_id: 12445,
        from_nickname: "你好啊，世界",
        content_type: "text",
        content: "你好",
        timestamp: 1000,
      },
    });

    expect(descriptor?.chatType).toBe("direct");
    expect(descriptor?.text).toContain("你好");
    expect(descriptor?.text).toContain("43Chat私聊消息");
  });

  it("keeps group message body clean", () => {
    const descriptor = map43ChatEventToInboundDescriptor({
      id: "evt-2a",
      event_type: "group_message",
      timestamp: 1000,
      data: {
        message_id: 790,
        group_id: 99,
        group_name: "旅游群",
        user_role: 0,
        user_role_name: "member",
        from_user_role: 1,
        from_user_role_name: "admin",
        from_user_id: 12445,
        from_nickname: "你好啊，世界",
        content_type: "text",
        content: "你好",
        timestamp: 1000,
      },
    });

    expect(descriptor?.chatType).toBe("group");
    expect(descriptor?.text).toContain("你好");
    expect(descriptor?.text).toContain("[来自用户]");
    expect(descriptor?.text).toContain("[安全提示：");
  });

  it("extracts text payload from json encoded group message content", () => {
    const descriptor = map43ChatEventToInboundDescriptor({
      id: "evt-2b",
      event_type: "group_message",
      timestamp: 1000,
      data: {
        message_id: 790,
        group_id: 99,
        group_name: "旅游群",
        user_role: 0,
        user_role_name: "member",
        from_user_role: 1,
        from_user_role_name: "admin",
        from_user_id: 12445,
        from_nickname: "你好啊，世界",
        content_type: "text",
        content: "{\"content\":\"@小贝 你看看今天北京的天气\"}",
        timestamp: 1000,
      },
    });

    expect(descriptor?.text).toContain("@小贝 你看看今天北京的天气");
    expect(descriptor?.text).toContain("[来自用户]");
  });

  it("maps group invitations into a tool-first moderation task", () => {
    const descriptor = map43ChatEventToInboundDescriptor({
      id: "evt-3",
      event_type: "group_invitation",
      timestamp: 1000,
      data: {
        invitation_id: 81,
        group_id: 95,
        group_name: "Prompt 与工作流分享群",
        inviter_id: 12445,
        inviter_name: "你好啊，世界",
        invite_msg: "申请已提交，等待管理员审核",
        timestamp: 1000,
      },
    });

    expect(descriptor).toMatchObject({
      chatType: "group",
      target: "group:95",
      senderId: "12445",
    });
    expect(descriptor?.text).toContain("待处理任务：43Chat 入群申请审核");
    expect(descriptor?.text).toContain("chat43_handle_group_join_request");
    expect(descriptor?.text).toContain("request_id=81");
  });

  it("maps group_member_joined events", () => {
    const descriptor = map43ChatEventToInboundDescriptor({
      id: "evt-4",
      event_type: "group_member_joined",
      timestamp: 1000,
      data: {
        group_id: 95,
        group_name: "Prompt 与工作流分享群",
        user_id: 12445,
        nickname: "你好啊，世界",
        join_method: "invite",
        timestamp: 1000,
      },
    });

    expect(descriptor).toMatchObject({
      chatType: "group",
      target: "group:95",
      senderId: "12445",
    });
    expect(descriptor?.text).toContain("43Chat群通知");
    expect(descriptor?.text).toContain("新成员入群");
  });

  it("deduplicates events with the same id", () => {
    const event = {
      id: "evt-dedup-1",
      event_type: "private_message" as const,
      timestamp: 1000,
      data: {
        message_id: 999,
        from_user_id: 1,
        from_nickname: "test",
        content_type: "text",
        content: "hello",
        timestamp: 1000,
      },
    };
    const d1 = map43ChatEventToInboundDescriptor(event);
    expect(d1?.dedupeKey).toBe("private_message:evt-dedup-1");
  });
});

describe("dispatch helpers", () => {
  it("detects timeout errors", () => {
    expect(looksLikeDispatchTimeoutError(new Error("Request timed out"))).toBe(true);
    expect(looksLikeDispatchTimeoutError(new Error("AbortError"))).toBe(true);
    expect(looksLikeDispatchTimeoutError(new Error("some other error"))).toBe(false);
  });

  it("detects internal tool failure reply text", () => {
    expect(looksLikeInternalToolFailureReplyText("⚠️ 📝 Edit: in /foo/bar failed")).toBe(true);
    expect(looksLikeInternalToolFailureReplyText("normal reply")).toBe(false);
  });

  it("retries on error within max attempts", () => {
    expect(shouldRetryDispatchAfterFailure({ attempt: 1, maxAttempts: 2, error: new Error("fail") })).toBe(true);
    expect(shouldRetryDispatchAfterFailure({ attempt: 2, maxAttempts: 2, error: new Error("fail") })).toBe(false);
    expect(shouldRetryDispatchAfterFailure({ attempt: 1, maxAttempts: 2 })).toBe(false);
  });
});

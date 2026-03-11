import { describe, expect, it } from "vitest";
import { map43ChatEventToInboundDescriptor } from "../bot.js";

describe("43Chat event mapping", () => {
  it("maps friend request into a direct system message", () => {
    const descriptor = map43ChatEventToInboundDescriptor({
      id: "evt-1",
      event_type: "friend_request",
      timestamp: 1000,
      data: {
        request_id: 123,
        from_user_id: 456,
        from_nickname: "Alice",
        from_avatar: "",
        request_msg: "hello",
        timestamp: 1000,
      },
    });

    expect(descriptor).toMatchObject({
      chatType: "direct",
      target: "user:456",
      senderId: "456",
      senderName: "Alice",
    });
    expect(descriptor?.text).toContain("好友请求");
    expect(descriptor?.text).toContain("request_id=123");
  });
});

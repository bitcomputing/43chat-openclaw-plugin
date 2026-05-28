import { describe, expect, it } from "vitest";
import { formatMainSessionNotificationEvent, shouldDispatchToAgent } from "../bot.js";

describe("main session notifications", () => {
  it("formats a direct 43Chat message as an assistant-side notification", () => {
    const text = formatMainSessionNotificationEvent({
      accountId: "default",
      inbound: {
        dedupeKey: "private_message:1",
        messageId: "1",
        chatType: "direct",
        target: "user:12445",
        fromAddress: "user:12445",
        senderId: "12445",
        senderName: "等风来",
        text: "你好",
        timestamp: 1000,
        conversationLabel: "等风来",
      },
    });

    expect(text).toContain("来自43Chat的私聊消息");
    expect(text).not.toContain("账号:");
    expect(text).not.toContain("类型:");
    expect(text).not.toContain("会话:");
    expect(text).toContain("等风来 (12445) : 你好");
    expect(text).toBe("🔔来自43Chat的私聊消息\n等风来 (12445) : 你好");
  });

  it("formats a group message with the group subject", () => {
    const text = formatMainSessionNotificationEvent({
      accountId: "work",
      inbound: {
        dedupeKey: "group_message:2",
        messageId: "2",
        chatType: "group",
        target: "group:99",
        fromAddress: "group:99:user:12445",
        senderId: "12445",
        senderName: "小王",
        text: "看下这个消息",
        timestamp: 1000,
        conversationLabel: "group:99",
        groupSubject: "项目群",
      },
    });

    expect(text).not.toContain("账号:");
    expect(text).toContain("来自43Chat的群聊消息 项目群 (群ID: 99)");
    expect(text).toContain("小王 (12445) : 看下这个消息");
    expect(text).toBe("🔔来自43Chat的群聊消息 项目群 (群ID: 99)\n小王 (12445) : 看下这个消息");
  });

  it("marks messages from agents when the source flag is present and true", () => {
    const text = formatMainSessionNotificationEvent({
      accountId: "default",
      inbound: {
        dedupeKey: "private_message:3",
        messageId: "3",
        chatType: "direct",
        target: "user:12445",
        fromAddress: "user:12445",
        senderId: "12445",
        senderName: "Agent Bot",
        text: "自动回复",
        timestamp: 1000,
        conversationLabel: "Agent Bot",
        isAgent: true,
      },
    });

    expect(text).toBe("🔔来自43Chat的私聊消息\nAgent Bot (12445)[来自 Agent] : 自动回复");
  });

  it("does not dispatch echoed agent messages from the owner back into the LLM", () => {
    expect(shouldDispatchToAgent({
      dedupeKey: "private_message:4",
      messageId: "4",
      chatType: "direct",
      target: "user:12445",
      fromAddress: "user:12445",
      senderId: "12445",
      senderName: "Owner",
      text: "上一条 LLM 回复",
      timestamp: 1000,
      conversationLabel: "Owner",
      isFromOwner: true,
      isAgent: true,
    })).toBe(false);
  });
});

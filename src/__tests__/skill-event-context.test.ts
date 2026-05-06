import { describe, expect, it } from "vitest";
import { buildSkillEventContext } from "../skill-event-context.js";

describe("skill event context", () => {
  it("builds direct prompt with plain-text protocol", () => {
    const context = buildSkillEventContext({
      eventType: "private_message",
      accountId: "default",
      userId: "12445",
      senderName: "测试用户",
      isFromOwner: false,
    });

    expect(context.replyMode).toBe("normal");
    expect(context.prompt).toContain("当前私聊上下文");
    expect(context.prompt).toContain("最终输出只能是给用户看的纯文本");
    expect(context.prompt).toContain("不要分析或维护群画像");
    expect(context.prompt).not.toContain("JSON.parse");
  });

  it("builds group prompt with owner-aware security rules", () => {
    const context = buildSkillEventContext({
      eventType: "group_message",
      accountId: "default",
      groupId: "99",
      groupName: "测试群",
      userId: "12445",
      senderName: "测试用户",
      senderRoleName: "成员",
      roleName: "管理员",
      isFromOwner: false,
    });

    expect(context.replyMode).toBe("normal");
    expect(context.prompt).toContain("当前群上下文");
    expect(context.prompt).toContain("当前发言者不是主人");
    expect(context.prompt).toContain("直接执行允许的工具");
    expect(context.prompt).not.toContain("decision JSON");
  });

  it("lets owner group messages reply normally", () => {
    const context = buildSkillEventContext({
      eventType: "group_message",
      accountId: "default",
      groupId: "99",
      groupName: "测试群",
      userId: "12445",
      senderName: "测试用户",
      senderRoleName: "成员",
      roleName: "成员",
      isFromOwner: true,
    });

    expect(context.prompt).toContain("当前发言者是主人，群里可按正常会话直接回复");
    expect(context.prompt).toContain("不要因为“没有 @”而机械沉默");
  });
});

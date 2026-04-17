import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyEventFactGuardsToCognitionContent,
  classifyDispatchAttemptOutcome,
  describeFinalReplyResolutionForLog,
  filterCognitionIssuesToRequiredAliases,
  looksLikeDispatchTimeoutError,
  looksLikeInternalToolFailureReplyText,
  map43ChatEventToInboundDescriptor,
  normalizeRemoveMemberReason,
  normalizeDispatchFinalOutput,
  parseCognitionWriteEnvelope,
  inspectRecentAssistantOutputFromSessionLog,
  resolveCognitionFullPath,
  resolveDispatchSessionKey,
  resolveObserveFallbackModerationDecision,
  resolvePrimaryDispatchSessionKey,
  resolveGroupAttemptResolution,
  recoverRecentFinalReplyFromSessionLog,
  extractReusableOutwardReplyText,
  resolveRetryFallbackForMissingEnvelope,
  shouldParseCognitionEnvelopeForInbound,
  shouldRetryForMissingCognitionEnvelope,
  shouldRetryDispatchAfterFailure,
  summarizeFinalOutcomeForLog,
  summarizeReplyPayloadForLog,
} from "../bot.js";

describe("43Chat event mapping", () => {
  it("maps friend request into a direct task with skill runtime context", () => {
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
    expect(descriptor?.text).not.toContain("user_profile: alias=`profiles/456.json`");
    expect(descriptor?.text).not.toContain("【43Chat Skill Runtime】");
    expect(descriptor?.groupSystemPrompt).toContain("user_profile: alias=`profiles/456.json`");
    expect(descriptor?.groupSystemPrompt).toContain("/.config/43chat/profiles/456.json");
    expect(descriptor?.groupSystemPrompt).toContain("【43Chat Skill Runtime】");
  });

  it("keeps private message body clean and moves runtime guidance into the prompt field", () => {
    const descriptor = map43ChatEventToInboundDescriptor({
      id: "evt-direct-1",
      event_type: "private_message",
      timestamp: 1000,
      data: {
        message_id: "pm-1",
        from_user_id: 12373,
        from_nickname: "下雪啦",
        to_user_id: 12441,
        content_type: "text",
        content: "{\"content\":\"小贝贝，你在干什么\"}",
        timestamp: 1000,
      },
    });

    expect(descriptor).toMatchObject({
      chatType: "direct",
      target: "user:12373",
      senderId: "12373",
      senderName: "下雪啦",
      suppressTextReply: false,
    });
    expect(descriptor?.text).toContain("43Chat私聊消息");
    expect(descriptor?.text).toContain("小贝贝，你在干什么");
    expect(descriptor?.text).not.toContain("【43Chat Skill Runtime】");
    expect(descriptor?.groupSystemPrompt).toContain("【43Chat Skill Runtime】");
    expect(descriptor?.groupSystemPrompt).toContain("【当前私聊上下文】");
    expect(descriptor?.groupSystemPrompt).toContain("profiles/12373.json");
    expect(descriptor?.groupSystemPrompt).toContain("私聊长期认知默认改由后台 cognition worker 异步维护");
    expect(descriptor?.groupSystemPrompt).toContain("私聊主流程不要调用 `edit` / `write` 直接改写 `user_profile` / `dialog_state`");
    expect(descriptor?.groupSystemPrompt).toContain("【这些长期认知文件由后台 worker 异步补写】");
    expect(descriptor?.groupSystemPrompt).toContain("私聊主流程最终输出改为两段");
    expect(descriptor?.groupSystemPrompt).toContain("最稳妥模板：`<公开回复或NO_REPLY>");
    expect(descriptor?.groupSystemPrompt).toContain("真正对外发送的文本直接写在正文里");
    expect(descriptor?.groupSystemPrompt).toContain("回复示例：`在呢，你说。");
    expect(descriptor?.groupSystemPrompt).toContain("不回复示例：`NO_REPLY");
    expect(descriptor?.groupSystemPrompt).toContain("不要输出 `<thinking>`、`<envelope>`、`<reply>`、`<writes>`、`<chat43-cognition>` 这类 XML 标签");
    expect(descriptor?.groupSystemPrompt).toContain("最后那个 JSON 顶层只允许 `decision`");
  });

  it("keeps group message body clean and moves runtime guidance into GroupSystemPrompt", () => {
    const descriptor = map43ChatEventToInboundDescriptor({
      id: "evt-2",
      event_type: "group_message",
      timestamp: 1000,
      data: {
        message_id: 789,
        group_id: 987654321,
        group_name: "测试群",
        user_role: 1,
        user_role_name: "admin",
        from_user_role: 2,
        from_user_role_name: "owner",
        from_user_id: 456,
        from_nickname: "Alice",
        content_type: "text",
        content: "这个问题怎么看？",
        timestamp: 1000,
      },
    }, {
      cfg: {
        channels: {
          "43chat-openclaw-plugin": {
            skillDocsDir: "/tmp/43chat-test-no-runtime",
            skillRuntimePath: "/tmp/43chat-test-no-runtime/skill.runtime.json",
          },
        },
      } as any,
    });

    expect(descriptor).toMatchObject({
      chatType: "group",
      target: "group:987654321",
      senderId: "456",
      senderName: "Alice",
      text: "这个问题怎么看？",
      suppressTextReply: false,
    });
    expect(descriptor?.groupSystemPrompt).toContain("当前群上下文");
    expect(descriptor?.groupSystemPrompt).toContain("当前消息处理约束");
    expect(descriptor?.groupSystemPrompt).toContain("群定位边界优先");
    expect(descriptor?.groupSystemPrompt).toContain("私聊偏好、称呼习惯、线下邀约、一次性兴趣");
    expect(descriptor?.groupSystemPrompt).toContain("认知写入执行要求");
    expect(descriptor?.groupSystemPrompt).toContain("【回复策略】");
    expect(descriptor?.groupSystemPrompt).toContain("若本轮不回复，仍要输出合法 JSON");
    expect(descriptor?.groupSystemPrompt).toContain("群聊长期认知默认改由后台 cognition worker 异步维护");
    expect(descriptor?.groupSystemPrompt).toContain("当前群聊主流程必须忽略，不能模仿、不能复述、不能继续输出");
    expect(descriptor?.groupSystemPrompt).toContain("群聊主流程最终输出改为两段");
    expect(descriptor?.groupSystemPrompt).toContain("合法示例：`收到，今晚簋街见。");
    expect(descriptor?.groupSystemPrompt).toContain("不回复示例：`NO_REPLY");
    expect(descriptor?.groupSystemPrompt).toContain("当前主流程可以参考已有认知文件做判断，但不要承担 `group_soul` / `user_profile` / `group_members_graph` 的补写任务");
    expect(descriptor?.groupSystemPrompt).toContain("我的身份: 管理员");
    expect(descriptor?.groupSystemPrompt).toContain("当前发言者: Alice（user:456）");
    expect(descriptor?.groupSystemPrompt).toContain("当前发言者身份: 群主");
    expect(descriptor?.groupSystemPrompt).toContain("当当前消息明显背离 `group_soul.boundaries` 时");
    expect(descriptor?.groupSystemPrompt).toContain("【文档约束的管理梯度】");
    expect(descriptor?.groupSystemPrompt).toContain("允许的管理决策种类: observe / redirect / warn / mark_risk / remove_member");
    expect(descriptor?.groupSystemPrompt).toContain("本轮群聊最终输出改为“正文/NO_REPLY + 最后一个 decision JSON”");
    expect(descriptor?.groupSystemPrompt).toContain("若你本轮没有额外管理动作，最稳妥的写法是显式给出 `decision.kind = observe`");
    expect(descriptor?.groupSystemPrompt).toContain("43Chat 认知文件根目录");
    expect(descriptor?.groupSystemPrompt).toContain("group_soul: alias=`groups/987654321/soul.json`");
    expect(descriptor?.groupSystemPrompt).toContain("/.config/43chat/groups/987654321/soul.json");
    expect(descriptor?.groupSystemPrompt).toContain("group_state / group_decision_log 由插件在决策后自动维护");
    expect(descriptor?.groupSystemPrompt).toContain("【这些长期认知文件由后台 worker 异步补写】");
    expect(descriptor?.groupSystemPrompt).not.toContain("【本轮需要你显式维护的长期认知文件】");
    expect(descriptor?.groupSystemPrompt).not.toContain("认知写入不是可选优化");
    expect(descriptor?.groupSystemPrompt).not.toContain("主流程没有额外的认知补写回合");
    expect(descriptor?.groupSystemPrompt).not.toContain("更新群 Soul、成员画像、互动认知");
    expect(descriptor?.groupSystemPrompt).not.toContain("当前群聊主流程统一只输出普通文本或 `NO_REPLY`");
    expect(descriptor?.text).not.toContain("understanding.json");
    expect(descriptor?.groupSubject).toBe("987654321");
  });

  it("adds stricter decision requirements for admin moderation-like group messages", () => {
    const descriptor = map43ChatEventToInboundDescriptor({
      id: "evt-2-moderation",
      event_type: "group_message",
      timestamp: 1000,
      data: {
        message_id: 790,
        group_id: 99,
        group_name: "旅游群",
        user_role: 1,
        user_role_name: "admin",
        from_user_role: 0,
        from_user_role_name: "member",
        from_user_id: 12443,
        from_nickname: "素菜不好吃",
        content_type: "text",
        content: "群外还有更全的实操内容，感兴趣的直接私聊我，我拉你进小群。",
        timestamp: 1000,
      },
    });

    expect(descriptor?.groupSystemPrompt).toContain("当前是管理员结构化管理回合");
    expect(descriptor?.groupSystemPrompt).toContain("本轮结构化 `decision` 为必填");
    expect(descriptor?.groupSystemPrompt).toContain("最终输出改为“正文/NO_REPLY + 最后一个 decision JSON”");
    expect(descriptor?.groupSystemPrompt).toContain("你只需输出合法 `decision`，插件会按 `decision.kind` 执行对应管理动作");
  });

  it("prefers resolved sender role override over raw SSE role when building group prompt", () => {
    const descriptor = map43ChatEventToInboundDescriptor({
      id: "evt-2c",
      event_type: "group_message",
      timestamp: 1000,
      data: {
        message_id: 791,
        group_id: 99,
        group_name: "旅游群",
        user_role: 0,
        user_role_name: "member",
        from_user_role: 0,
        from_user_role_name: "member",
        from_user_id: 12445,
        from_nickname: "你好啊，世界",
        content_type: "text",
        content: "收到",
        timestamp: 1000,
      },
    }, {
      resolvedSenderRoleNameOverride: "管理员",
    });

    expect(descriptor?.groupSystemPrompt).toContain("当前发言者身份: 管理员");
    expect(descriptor?.groupSystemPrompt).not.toContain("当前发言者身份: 成员");
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

    expect(descriptor?.text).toBe("@小贝 你看看今天北京的天气");
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
      suppressTextReply: true,
    });
    expect(descriptor?.text).toContain("待处理任务：43Chat 入群申请审核");
    expect(descriptor?.text).toContain("chat43_handle_group_join_request");
    expect(descriptor?.text).toContain("request_id=81");
    expect(descriptor?.groupSystemPrompt).toContain("本事件默认不发送普通文本回复");
    expect(descriptor?.groupSystemPrompt).toContain("group_decision_log: alias=`groups/95/decision_log.jsonl`");
    expect(descriptor?.groupSystemPrompt).toContain("这些运行态文件由插件自动维护");
  });

  it("adds runtime cognition guidance to group_member_joined events", () => {
    const descriptor = map43ChatEventToInboundDescriptor({
      id: "evt-4",
      event_type: "group_member_joined",
      timestamp: 1000,
      data: {
        group_id: 987654329,
        group_name: "全新测试群",
        user_id: 12441,
        nickname: "小贝",
        join_method: "approved",
        timestamp: 1000,
      },
    });

    expect(descriptor).toMatchObject({
      chatType: "group",
      target: "group:987654329",
      senderId: "12441",
      senderName: "小贝",
      suppressTextReply: false,
    });
    expect(descriptor?.text).toContain("新成员入群");
    expect(descriptor?.groupSystemPrompt).toContain("当前群上下文");
    expect(descriptor?.groupSystemPrompt).toContain("group_members_graph: alias=`groups/987654329/members_graph.json`");
    expect(descriptor?.groupSystemPrompt).not.toContain("生成群组理解文档");
  });

  it("parses cognition write envelope from final text", () => {
    const parsed = parseCognitionWriteEnvelope(`
\`\`\`json
{"writes":[{"path":"groups/100/soul.json","content":{"schema_version":"1.0","group_id":"100"}}],"reply":"这是一条回复"}
\`\`\`
    `);

    expect(parsed).toEqual({
      writes: [{
        path: "groups/100/soul.json",
        content: {
          schema_version: "1.0",
          group_id: "100",
        },
      }],
      replyText: "这是一条回复",
    });
  });

  it("rejects legacy xml-style wrapper output", () => {
    const parsed = parseCognitionWriteEnvelope(`
<chat43-cognition>
{"writes":[{"path":"profiles/12445.json","content":{"schema_version":"1.0","user_id":"12445"}}],"reply":"NO_REPLY"}
</chat43-cognition>
    `);

    expect(parsed).toBeNull();
  });

  it("parses cognition envelope when reply contains raw multiline text", () => {
    const parsed = parseCognitionWriteEnvelope(`
{"writes":[],"decision":{"kind":"observe","reason":"直接给清单"},"reply":"来咯～

🔥 火锅：大龙燚、小龙坎
🍢 串串：玉林串串、马路边边

记得空腹来！"}
    `);

    expect(parsed).toEqual({
      writes: [],
      decision: {
        kind: "observe",
        reason: "直接给清单",
      },
      replyText: `来咯～

🔥 火锅：大龙燚、小龙坎
🍢 串串：玉林串串、马路边边

记得空腹来！`,
    });
  });

  it("normalizes trailing decision json by using the leading text as outward reply", () => {
    expect(normalizeDispatchFinalOutput({
      rawFinalText: `
这首小诗还挺有意境的，"吹撒多少星光"这个"撒"字用得妙 😊
{"decision":{"kind":"observe","reason":"群成员诗词创作，适度欣赏回应"}}
      `,
      noReplyToken: "NO_REPLY",
    })).toEqual({
      cognitionEnvelope: {
        replyText: "这首小诗还挺有意境的，\"吹撒多少星光\"这个\"撒\"字用得妙 😊",
        writes: [],
        decision: {
          kind: "observe",
          reason: "群成员诗词创作，适度欣赏回应",
        },
      },
      finalReplyText: "这首小诗还挺有意境的，\"吹撒多少星光\"这个\"撒\"字用得妙 😊",
      rawFinalKind: "plain_text",
      normalizedProtocol: "text_plus_decision_json",
    });
  });

  it("rejects nested envelope reply shape", () => {
    const parsed = parseCognitionWriteEnvelope(`
{"envelope":{"reply":"广州的话，长隆野生动物世界、长隆欢乐世界、广州动物园、广东科学中心都适合带小朋友去。"},"writes":[],"decision":{"kind":"reply","reason":"用户直接提问，给出出行建议"}}
    `);

    expect(parsed).toBeNull();
  });

  it("rejects nested envelope writes and decision shape", () => {
    const parsed = parseCognitionWriteEnvelope(`
{"envelope":{"reply":"NO_REPLY","writes":[{"path":"profiles/12445.json","content":{"schema_version":"1.0","user_id":"12445"}}],"decision":{"kind":"observe","reason":"普通群聊观察"}}}
    `);

    expect(parsed).toBeNull();
  });

  it("rejects legacy xml-style inner tags", () => {
    const parsed = parseCognitionWriteEnvelope(`
<chat43-cognition>
<thinking>
对方：等风来
</thinking>
<envelope>
<reply>好的，不回去就不回去。</reply>
<writes>[]</writes>
</envelope>
</chat43-cognition>
    `);

    expect(parsed).toBeNull();
  });

  it("repairs malformed envelope when reply contains unescaped quotes", () => {
    const parsed = parseCognitionWriteEnvelope(`
{
  "reply": "这里不好玩"这句话有点伤群友的心了 😅 大家来这个群是为了交流旅游经验、有用信息的～有什么好的目的地或玩法，欢迎直接分享 😄",
  "writes": [],
  "decision": {
    "kind": "redirect",
    "reason": "重试消息，保持上一轮决策不变"
  }
}
    `);

    expect(parsed).toEqual({
      writes: [],
      decision: {
        kind: "redirect",
        reason: "重试消息，保持上一轮决策不变",
      },
      replyText: "这里不好玩\"这句话有点伤群友的心了 😅 大家来这个群是为了交流旅游经验、有用信息的～有什么好的目的地或玩法，欢迎直接分享 😄",
    });
  });

  it("repairs malformed envelope when trailing extra brace is present", () => {
    const parsed = parseCognitionWriteEnvelope(`
{"reply":"哈哈，确实是我的数据有问题！看来以后不能随便"记"东西了，得严谨点 😂\\n\\n你09年的记忆比我靠谱多了","writes":[],"decision":{"kind":"observe","reason":"承认失误，轻松化解"}}}
    `);

    expect(parsed).toEqual({
      writes: [],
      decision: {
        kind: "observe",
        reason: "承认失误，轻松化解",
      },
      replyText: "哈哈，确实是我的数据有问题！看来以后不能随便\"记\"东西了，得严谨点 😂\n\n你09年的记忆比我靠谱多了",
    });
  });

  it("parses structured moderation decision from cognition envelope", () => {
    const parsed = parseCognitionWriteEnvelope(`
{"writes":[],"decision":{"scenario":"off_topic","stage":"first_occurrence","kind":"redirect","public_reply":true,"reason":"偏离工作群主题","target_user_id":"12373"},"reply":"先回到工作话题"}
    `);

    expect(parsed).toEqual({
      writes: [],
      decision: {
        scenario: "off_topic",
        stage: "first_occurrence",
        kind: "redirect",
        publicReply: true,
        reason: "偏离工作群主题",
        targetUserId: "12373",
      },
      replyText: "先回到工作话题",
    });
  });

  it("rejects legacy moderation shorthand fields", () => {
    const parsed = parseCognitionWriteEnvelope(`
{"decision":{"kind":"reply_sent","reason":"direct_question_match_group_soul"},"moderation":"observe","reply":"长隆野生动物世界很适合亲子游。","writes":[]}
    `);

    expect(parsed).toBeNull();
  });

  it("parses cognition write envelope even when writes is empty", () => {
    const parsed = parseCognitionWriteEnvelope(`
{"writes":[],"reply":"这是一条普通回复"}
    `);

    expect(parsed).toEqual({
      writes: [],
      replyText: "这是一条普通回复",
    });
  });

  it("rejects cognition write envelopes when any write entry uses an unsupported shape", () => {
    const parsed = parseCognitionWriteEnvelope(`
{"writes":[{"type":"edit","path":"profiles/12386.json","oldText":"\\"tags\\": []","newText":"\\"tags\\": [\\"喜欢旅游\\"]"}],"reply":"到处走挺好的"}
    `);

    expect(parsed).toBeNull();
  });

  it("rejects mixed plain text and trailing wrapper", () => {
    const parsed = parseCognitionWriteEnvelope(`
天气好确实让人心情舒畅～ 你今天有什么计划吗？
{"writes":[{"path":"profiles/12373.json","content":{"schema_version":"1.0","user_id":"12373"}}],"reply":"天气好确实让人心情舒畅～ 你今天有什么计划吗？"}
    `);

    expect(parsed).toBeNull();
  });

  it("parses cognition write envelope when write content is a stringified json object", () => {
    const parsed = parseCognitionWriteEnvelope(`
{"writes":[{"path":"groups/100/members_graph.json","content":"{\\"schema_version\\":\\"1.0\\",\\"group_id\\":\\"100\\",\\"members\\":{\\"12443\\":{\\"role\\":\\"opinion_leader\\",\\"in_group_tags\\":[\\"成本优化\\"],\\"strategy\\":\\"主导成本优化议题\\"}}}"}],"reply":"NO_REPLY"}
    `);

    expect(parsed).toEqual({
      writes: [{
        path: "groups/100/members_graph.json",
        content: {
          schema_version: "1.0",
          group_id: "100",
          members: {
            "12443": {
              role: "opinion_leader",
              in_group_tags: ["成本优化"],
              strategy: "主导成本优化议题",
            },
          },
        },
      }],
      replyText: "NO_REPLY",
    });
  });

  it("forces factual is_friend=true for private-message profile writes before persistence", () => {
    const guarded = applyEventFactGuardsToCognitionContent({
      event: {
        id: "evt-direct-guard",
        event_type: "private_message",
        timestamp: 1000,
        data: {
          message_id: "pm-guard-1",
          from_user_id: 12373,
          from_nickname: "下雪啦",
          to_user_id: 12441,
          content_type: "text",
          content: "{\"content\":\"你好呀\"}",
          timestamp: 1000,
        },
      },
      fullPath: "/Users/make/.config/43chat/profiles/12373.json",
      content: {
        schema_version: "1.0",
        user_id: "12373",
        is_friend: false,
      },
    });

    expect(guarded).toMatchObject({
      user_id: "12373",
      is_friend: true,
    });
  });

  it("summarizes raw candidate replies for logs without dumping the full body", () => {
    expect(summarizeReplyPayloadForLog({
      text: "这是一条非常长的最终候选回复，需要在日志里被截断显示，但保留主要开头信息。",
      replyToCurrent: false,
    })).toContain("\"text\":\"这是一条非常长的最终候选回复");
  });

  it("detects internal tool failure text so it will not leak as a final reply", () => {
    expect(looksLikeInternalToolFailureReplyText("⚠️ 📝 Edit: in ~/.config/43chat/profiles/12445.json failed")).toBe(true);
    expect(looksLikeInternalToolFailureReplyText("⚠️ 📝 Write: in /Users/make/.config/43chat/groups/100/soul.json failed")).toBe(true);
    expect(looksLikeInternalToolFailureReplyText("这个文件我先不改，先聊结论。")).toBe(false);
  });

  it("describes resolved final reply separately from raw envelope output", () => {
    expect(describeFinalReplyResolutionForLog({
      cognitionEnvelope: {
        writes: [{
          path: "profiles/12445.json",
          content: {
            schema_version: "1.0",
          },
        }],
        replyText: "NO_REPLY",
      },
      finalReplyText: "NO_REPLY",
      noReplyToken: "NO_REPLY",
    })).toBe("raw_kind=cognition_json writes=1 outward=NO_REPLY");

    expect(describeFinalReplyResolutionForLog({
      cognitionEnvelope: {
        writes: [],
        replyText: "NO_REPLY",
      },
      finalReplyText: "NO_REPLY",
      noReplyToken: "NO_REPLY",
      rawFinalKind: "plain_text",
      normalizedProtocol: "plain_no_reply_to_cognition_json",
    })).toBe("raw_kind=plain_text writes=0 outward=NO_REPLY normalized=plain_no_reply_to_cognition_json");

    expect(describeFinalReplyResolutionForLog({
      cognitionEnvelope: {
        writes: [{
          path: "groups/100/soul.json",
          content: {
            schema_version: "1.0",
          },
        }],
        replyText: "这是一条真正要发到群里的文本回复",
      },
      finalReplyText: "这是一条真正要发到群里的文本回复",
      noReplyToken: "NO_REPLY",
    })).toContain("raw_kind=cognition_json writes=1 outward=这是一条真正要发到群里的文本回复");
  });

  it("summarizes final outcome diagnostics for logs", () => {
    expect(summarizeFinalOutcomeForLog({
      messageId: "msg-1",
      decision: "no_reply",
      reason: "model explicitly returned NO_REPLY",
      diagnostics: {
        rawFinalKind: "plain_text",
        normalizedProtocol: "plain_no_reply_to_cognition_json",
        rawFinalText: "NO_REPLY",
        resolvedReplyText: "NO_REPLY",
        attemptOutcomeKind: "no_reply",
        outwardOutcomeKind: "no_reply",
        resolutionAction: "record",
        retryAttempted: true,
        retryReason: "first attempt timed out",
      },
      moderationDecisionKind: "observe",
    })).toContain("\"decision\":\"no_reply\"");
    expect(summarizeFinalOutcomeForLog({
      messageId: "msg-1",
      decision: "no_reply",
      reason: "model explicitly returned NO_REPLY",
      diagnostics: {
        rawFinalKind: "plain_text",
        normalizedProtocol: "plain_no_reply_to_cognition_json",
        rawFinalText: "NO_REPLY",
      },
    })).toContain("\"normalized_protocol\":\"plain_no_reply_to_cognition_json\"");
    expect(summarizeFinalOutcomeForLog({
      messageId: "msg-1",
      decision: "no_reply",
      reason: "model explicitly returned NO_REPLY",
      diagnostics: {
        rawFinalKind: "plain_text",
        rawFinalText: "NO_REPLY",
      },
    })).toContain("\"raw_final_text\":\"NO_REPLY\"");
  });

  it("keeps the first outward private reply when retry still lacks cognition envelope", () => {
    expect(resolveRetryFallbackForMissingEnvelope({
      chatType: "direct",
      retryFinalText: "这是重试发送的消息，请忽略。",
      retryForEnvelope: true,
      firstAttemptOutcome: {
        kind: "reply",
        replyText: "第一次的正常私聊回复",
        reason: "plugin delivered final text reply",
      },
      noReplyToken: "NO_REPLY",
    })).toEqual({
      keepFirstOutwardReply: true,
      finalReplyText: "第一次的正常私聊回复",
    });
  });

  it("extracts reusable outward text from structured cognition json", () => {
    expect(extractReusableOutwardReplyText(`
{"reply":"好的，不回去就不回去。","writes":[]}
    `)).toBe("好的，不回去就不回去。");
  });

  it("extracts reusable outward text from invalid cognition json when reply is present", () => {
    expect(extractReusableOutwardReplyText(`
{"reply":"没问题雪姐！7点准时叫你，咱簋街见～","writes":[],"decision":{"kind":"reply_sent","reason":"下雪啦明确@我让我叫她，属于明确请求，直接回应确认"}}
    `)).toBe("没问题雪姐！7点准时叫你，咱簋街见～");
  });

  it("extracts reusable outward text from trailing decision json", () => {
    expect(extractReusableOutwardReplyText(`
没问题雪姐！7点准时叫你，咱簋街见～
{"decision":{"kind":"observe","reason":"直接回应确认"}}
    `)).toBe("没问题雪姐！7点准时叫你，咱簋街见～");
  });

  it("normalizes bare NO_REPLY into canonical cognition json semantics", () => {
    expect(normalizeDispatchFinalOutput({
      rawFinalText: "\nNO_REPLY",
      noReplyToken: "NO_REPLY",
    })).toEqual({
      cognitionEnvelope: {
        writes: [],
        replyText: "NO_REPLY",
      },
      finalReplyText: "NO_REPLY",
      rawFinalKind: "plain_text",
      normalizedProtocol: "plain_no_reply_to_cognition_json",
    });
  });

  it("normalizes mixed plain text plus trailing cognition json by preferring the json reply", () => {
    expect(normalizeDispatchFinalOutput({
      rawFinalText: `
这首小诗还挺有意境的，"吹撒多少星光"这个"撒"字用得妙 😊

{"reply":"这首小诗还挺有意境的，\\"吹撒多少星光\\"这个\\"撒\\"字用得妙 😊","writes":[],"decision":{"kind":"observe","reason":"群成员诗词创作，适度欣赏回应"}}
      `,
      noReplyToken: "NO_REPLY",
    })).toEqual({
      cognitionEnvelope: {
        replyText: "这首小诗还挺有意境的，\"吹撒多少星光\"这个\"撒\"字用得妙 😊",
        writes: [],
        decision: {
          kind: "observe",
          reason: "群成员诗词创作，适度欣赏回应",
        },
      },
      finalReplyText: "这首小诗还挺有意境的，\"吹撒多少星光\"这个\"撒\"字用得妙 😊",
      rawFinalKind: "plain_text",
      normalizedProtocol: "mixed_text_plus_cognition_json",
    });
  });

  it("strips trailing decision json even when decision kind is unsupported", () => {
    expect(normalizeDispatchFinalOutput({
      rawFinalText: "还没呢，正在被你们聊饿了 😄 {\"decision\":{\"kind\":\"reply_sent\",\"reason\":\"下雪啦的日常闲聊问候，轻松接话回应\"}}",
      noReplyToken: "NO_REPLY",
    })).toEqual({
      cognitionEnvelope: {
        replyText: "还没呢，正在被你们聊饿了 😄",
        writes: [],
      },
      finalReplyText: "还没呢，正在被你们聊饿了 😄",
      rawFinalKind: "plain_text",
      normalizedProtocol: "text_plus_decision_json",
    });
  });

  it("strips malformed trailing decision json from outward reply text", () => {
    expect(normalizeDispatchFinalOutput({
      rawFinalText: "是的，护国寺那碗面茶确实是一绝！ {\"decision\":{\"kind\":\"reply_sent\",\"reason\":\"群内美食话题延续\"}",
      noReplyToken: "NO_REPLY",
    })).toEqual({
      cognitionEnvelope: {
        replyText: "是的，护国寺那碗面茶确实是一绝！",
        writes: [],
      },
      finalReplyText: "是的，护国寺那碗面茶确实是一绝！",
      rawFinalKind: "plain_text",
      normalizedProtocol: "text_plus_decision_json",
    });
  });

  it("suppresses pure malformed structured json with no outward reply text", () => {
    expect(normalizeDispatchFinalOutput({
      rawFinalText: "{\"decision\":{\"kind\":\"reply_sent\",\"reason\":\"群内美食话题延续\"}",
      noReplyToken: "NO_REPLY",
    })).toEqual({
      cognitionEnvelope: {
        replyText: "",
        writes: [],
      },
      finalReplyText: "",
      rawFinalKind: "plain_text",
      normalizedProtocol: "text_plus_decision_json",
    });
  });

  it("falls back to the latest retry reply when no first outward reply exists", () => {
    expect(resolveRetryFallbackForMissingEnvelope({
      chatType: "direct",
      retryFinalText: "NO_REPLY",
      retryForEnvelope: true,
      firstAttemptOutcome: {
        kind: "no_reply",
        reason: "model explicitly returned NO_REPLY",
      },
      noReplyToken: "NO_REPLY",
    })).toEqual({
      keepFirstOutwardReply: false,
      finalReplyText: "NO_REPLY",
    });
  });

  it("uses extracted reply for group fallback when cognition json is still missing after retry", () => {
    expect(resolveRetryFallbackForMissingEnvelope({
      chatType: "group",
      retryFinalText: "{\"reply\":\"没问题雪姐！7点准时叫你，咱簋街见～\",\"writes\":[],\"decision\":{\"kind\":\"reply_sent\",\"reason\":\"下雪啦明确@我让我叫她，属于明确请求，直接回应确认\"}}",
      retryForEnvelope: true,
      firstAttemptOutcome: {
        kind: "suppressed",
        reason: "model returned raw cognition json instead of sendable reply text",
      },
      noReplyToken: "NO_REPLY",
    })).toEqual({
      keepFirstOutwardReply: false,
      finalReplyText: "没问题雪姐！7点准时叫你，咱簋街见～",
    });
  });

  it("normalizes remove-member reasons to fit API limits", () => {
    expect(normalizeRemoveMemberReason("  违反群规\n请移除  ")).toBe("违反群规 请移除");

    const longReason = "A".repeat(260);
    const normalized = normalizeRemoveMemberReason(longReason);
    expect(normalized).toHaveLength(200);
    expect(normalized).toBe("A".repeat(200));
  });

  it("resolves cognition paths for both relative aliases and absolute storage paths", () => {
    expect(resolveCognitionFullPath("profiles/12445.json"))
      .toBe("/Users/make/.config/43chat/profiles/12445.json");

    expect(resolveCognitionFullPath("/Users/make/.config/43chat/profiles/12445.json"))
      .toBe("/Users/make/.config/43chat/profiles/12445.json");

    expect(resolveCognitionFullPath("/tmp/not-allowed.json"))
      .toBeNull();
  });

  it("recovers recent NO_REPLY from the session llm log when dispatcher final text is empty", () => {
    const openclawHome = mkdtempSync(join(tmpdir(), "43chat-openclaw-home-"));
    const sessionDir = join(openclawHome, "logs", "agent_main_43chat-openclaw-plugin_group_group_68");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "llm-logger-openclaw-plugin-2026-04-08.jsonl"), [
      JSON.stringify({
        ts: "2026-04-08T12:59:10.959Z",
        eventType: "llm_output",
        payload: {
          lastAssistant: {
            content: [
              { type: "thinking", thinking: "..." },
              { type: "text", text: "NO_REPLY" },
            ],
          },
        },
      }),
      "",
    ].join("\n"), "utf8");

    expect(recoverRecentFinalReplyFromSessionLog({
      sessionKey: "agent:main:43chat-openclaw-plugin:group:group:68",
      sinceTimestamp: Date.parse("2026-04-08T12:59:06.000Z"),
      env: {
        ...process.env,
        OPENCLAW_HOME: openclawHome,
      },
    })).toBe("NO_REPLY");
  });

  it("unwraps final-tagged text recovered from the session llm log", () => {
    const openclawHome = mkdtempSync(join(tmpdir(), "43chat-openclaw-home-"));
    const sessionDir = join(openclawHome, "logs", "agent_main_43chat-openclaw-plugin_group_group_100");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "llm-logger-openclaw-plugin-2026-04-09.jsonl"), [
      JSON.stringify({
        ts: "2026-04-09T02:28:47.472Z",
        eventType: "llm_output",
        payload: {
          lastAssistant: {
            content: [
              { type: "thinking", thinking: "..." },
              { type: "text", text: "<final>后端视角补得关键。</final>" },
            ],
          },
        },
      }),
      "",
    ].join("\n"), "utf8");

    expect(recoverRecentFinalReplyFromSessionLog({
      sessionKey: "agent:main:43chat-openclaw-plugin:group:group:100",
      sinceTimestamp: Date.parse("2026-04-09T02:28:00.000Z"),
      env: {
        ...process.env,
        OPENCLAW_HOME: openclawHome,
      },
    })).toBe("后端视角补得关键。");
  });

  it("reports trace status when session log dir is missing", () => {
    const openclawHome = mkdtempSync(join(tmpdir(), "43chat-openclaw-home-"));

    const trace = inspectRecentAssistantOutputFromSessionLog({
      sessionKey: "agent:main:43chat-openclaw-plugin:group:group:68",
      sinceTimestamp: Date.parse("2026-04-15T10:00:00.000Z"),
      env: {
        ...process.env,
        OPENCLAW_HOME: openclawHome,
      },
    });

    expect(trace?.traceStatus).toBe("log_dir_missing");
    expect(trace?.summary).toContain("log_dir_missing");
  });

  it("reports trace status when session log dir exists but is empty", () => {
    const openclawHome = mkdtempSync(join(tmpdir(), "43chat-openclaw-home-"));
    const sessionDir = join(openclawHome, "logs", "agent_main_43chat-openclaw-plugin_group_group_68");
    mkdirSync(sessionDir, { recursive: true });

    const trace = inspectRecentAssistantOutputFromSessionLog({
      sessionKey: "agent:main:43chat-openclaw-plugin:group:group:68",
      sinceTimestamp: Date.parse("2026-04-15T10:00:00.000Z"),
      env: {
        ...process.env,
        OPENCLAW_HOME: openclawHome,
      },
    });

    expect(trace?.traceStatus).toBe("log_dir_empty");
    expect(trace?.summary).toContain("log_dir_empty");
  });

  it("reports trace status when session log dir has no llm logger files", () => {
    const openclawHome = mkdtempSync(join(tmpdir(), "43chat-openclaw-home-"));
    const sessionDir = join(openclawHome, "logs", "agent_main_43chat-openclaw-plugin_group_group_68");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "not-a-logger.txt"), "noop", "utf8");

    const trace = inspectRecentAssistantOutputFromSessionLog({
      sessionKey: "agent:main:43chat-openclaw-plugin:group:group:68",
      sinceTimestamp: Date.parse("2026-04-15T10:00:00.000Z"),
      env: {
        ...process.env,
        OPENCLAW_HOME: openclawHome,
      },
    });

    expect(trace?.traceStatus).toBe("logger_files_missing");
    expect(trace?.summary).toContain("logger_files_missing");
  });

  it("returns the nearest trace before the time window for debugging", () => {
    const openclawHome = mkdtempSync(join(tmpdir(), "43chat-openclaw-home-"));
    const sessionDir = join(openclawHome, "logs", "agent_main_43chat-openclaw-plugin_group_group_68");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "llm-logger-openclaw-plugin-2026-04-15.jsonl"), [
      JSON.stringify({
        ts: "2026-04-15T09:59:00.000Z",
        eventType: "llm_output",
        payload: {
          lastAssistant: {
            content: [
              { type: "text", text: "过早的一条输出" },
            ],
          },
        },
      }),
      "",
    ].join("\n"), "utf8");

    const trace = inspectRecentAssistantOutputFromSessionLog({
      sessionKey: "agent:main:43chat-openclaw-plugin:group:group:68",
      sinceTimestamp: Date.parse("2026-04-15T10:05:00.000Z"),
      env: {
        ...process.env,
        OPENCLAW_HOME: openclawHome,
      },
    });

    expect(trace?.traceStatus).toBe("nearest_before_window");
    expect(trace?.summary).toContain("nearest_before_window");
    expect(trace?.summary).toContain("过早的一条输出");
  });

  it("keeps retry cognition requirements stable within one event", () => {
    const filtered = filterCognitionIssuesToRequiredAliases({
      issues: [
        { alias: "group_soul", path: "groups/100/soul.json", summary: "group soul missing" },
        { alias: "user_profile", path: "profiles/12443.json", summary: "profile missing" },
        { alias: "group_members_graph", path: "groups/100/members_graph.json", summary: "graph missing" },
      ],
      requiredAliases: new Set(["group_soul", "user_profile"]),
    });

    expect(filtered).toEqual([
      { alias: "group_soul", path: "groups/100/soul.json", summary: "group soul missing" },
      { alias: "user_profile", path: "profiles/12443.json", summary: "profile missing" },
    ]);
  });

  it("classifies dispatch attempt outcomes before cognition guard", () => {
    expect(classifyDispatchAttemptOutcome({
      finalReplyText: "NO_REPLY",
      noReplyToken: "NO_REPLY",
    })).toEqual({
      kind: "no_reply",
      reason: "model explicitly returned NO_REPLY",
    });

    expect(classifyDispatchAttemptOutcome({
      finalReplyText: "",
      noReplyToken: "NO_REPLY",
      deliverSawFinal: true,
    })).toEqual({
      kind: "no_reply",
      reason: "dispatcher settled without recorded final reply; treating as explicit NO_REPLY",
    });

    expect(classifyDispatchAttemptOutcome({
      finalReplyText: "",
      noReplyToken: "NO_REPLY",
      queuedFinal: true,
    })).toEqual({
      kind: "no_reply",
      reason: "dispatcher settled without recorded final reply; treating as explicit NO_REPLY",
    });

    expect(classifyDispatchAttemptOutcome({
      finalReplyText: "这是一条回复",
      noReplyToken: "NO_REPLY",
    })).toEqual({
      kind: "reply",
      replyText: "这是一条回复",
      reason: "plugin delivered final text reply",
    });

    expect(classifyDispatchAttemptOutcome({
      finalReplyText: "{\"writes\":[],\"reply\":\"NO_REPLY\"}",
      noReplyToken: "NO_REPLY",
    })).toEqual({
      kind: "suppressed",
      reason: "model returned raw cognition json instead of sendable reply text",
    });

    expect(classifyDispatchAttemptOutcome({
      finalReplyText: "{\"reply\":\"没问题雪姐！7点准时叫你，咱簋街见～\",\"writes\":[],\"decision\":{\"kind\":\"reply_sent\",\"reason\":\"下雪啦明确@我让我叫她，属于明确请求，直接回应确认\"}}",
      noReplyToken: "NO_REPLY",
    })).toEqual({
      kind: "suppressed",
      reason: "model returned raw cognition json instead of sendable reply text",
    });

    expect(classifyDispatchAttemptOutcome({
      finalReplyText: "群里先按这个方案推进，我晚点补风险清单。",
      noReplyToken: "NO_REPLY",
    })).toEqual({
      kind: "reply",
      replyText: "群里先按这个方案推进，我晚点补风险清单。",
      reason: "plugin delivered final text reply",
    });
  });

  it("detects timeout-like dispatch failures for retry logging", () => {
    expect(looksLikeDispatchTimeoutError(new Error("Request timed out"))).toBe(true);
    expect(looksLikeDispatchTimeoutError(new Error("AbortError: The operation was aborted"))).toBe(true);
    expect(looksLikeDispatchTimeoutError(new Error("model request failed"))).toBe(false);
  });

  it("retries only when dispatch failed or timed out", () => {
    expect(shouldRetryDispatchAfterFailure({
      attempt: 1,
      maxAttempts: 2,
      error: new Error("Request timed out"),
    })).toBe(true);

    expect(shouldRetryDispatchAfterFailure({
      attempt: 1,
      maxAttempts: 2,
      error: new Error("upstream 500"),
    })).toBe(true);

    expect(shouldRetryDispatchAfterFailure({
      attempt: 1,
      maxAttempts: 2,
      replyDispatcherErrored: true,
    })).toBe(true);

    expect(shouldRetryDispatchAfterFailure({
      attempt: 1,
      maxAttempts: 2,
      replyDispatcherErrored: false,
    })).toBe(false);

    expect(shouldRetryDispatchAfterFailure({
      attempt: 2,
      maxAttempts: 2,
      error: new Error("Request timed out"),
    })).toBe(false);
  });

  it("retries once when a required json envelope is missing", () => {
    expect(shouldRetryForMissingCognitionEnvelope({
      attempt: 1,
      maxAttempts: 2,
      requiresCognitionEnvelope: true,
      cognitionEnvelope: null,
    })).toBe(true);

    expect(shouldRetryForMissingCognitionEnvelope({
      attempt: 2,
      maxAttempts: 2,
      requiresCognitionEnvelope: true,
      cognitionEnvelope: null,
    })).toBe(false);

    expect(shouldRetryForMissingCognitionEnvelope({
      attempt: 1,
      maxAttempts: 2,
      requiresCognitionEnvelope: true,
      cognitionEnvelope: {
        writes: [],
        replyText: "你好",
      },
    })).toBe(false);

    expect(shouldRetryForMissingCognitionEnvelope({
      attempt: 1,
      maxAttempts: 2,
      requiresCognitionEnvelope: true,
      cognitionEnvelope: null,
      finalReplyText: "这是一条普通文本回复",
    })).toBe(false);

    expect(shouldRetryForMissingCognitionEnvelope({
      attempt: 1,
      maxAttempts: 2,
      requiresCognitionEnvelope: true,
      cognitionEnvelope: {
        writes: [],
        replyText: "",
      },
      finalReplyText: "",
    })).toBe(true);
  });

  it("resolves group attempt outcomes with cognition guard in one place", () => {
    expect(resolveGroupAttemptResolution({
      outcome: {
        kind: "reply",
        replyText: "草稿回复",
        reason: "plugin delivered final text reply",
      },
      missingSummaries: [],
      blockedForMissingEnvelope: true,
      blockedForCognition: false,
      blockedForModerationDecision: false,
      attempt: 2,
      maxAttempts: 2,
    })).toEqual({
      action: "record",
      decision: "reply_blocked_for_missing_envelope",
      reason: "blocked final reply because required json envelope remained missing",
    });

    expect(resolveGroupAttemptResolution({
      outcome: {
        kind: "reply",
        replyText: "草稿回复",
        reason: "plugin delivered final text reply",
      },
      missingSummaries: ["group_soul: missing"],
      blockedForCognition: false,
      blockedForModerationDecision: true,
      attempt: 1,
      maxAttempts: 1,
    })).toEqual({
      action: "record",
      decision: "reply_blocked_for_missing_moderation_decision",
      reason: "blocked final reply because required structured moderation decision remained missing",
    });

    expect(resolveGroupAttemptResolution({
      outcome: {
        kind: "no_reply",
        reason: "model explicitly returned NO_REPLY",
      },
      missingSummaries: [],
      blockedForCognition: false,
      blockedForModerationDecision: true,
      attempt: 1,
      maxAttempts: 1,
    })).toEqual({
      action: "record",
      decision: "no_reply_missing_moderation_decision",
      reason: "required structured moderation decision remained missing",
    });

    expect(resolveGroupAttemptResolution({
      outcome: {
        kind: "reply",
        replyText: "草稿回复",
        reason: "plugin delivered final text reply",
      },
      missingSummaries: ["group_soul: missing", "user_profile: missing"],
      blockedForCognition: true,
      blockedForModerationDecision: false,
      attempt: 1,
      maxAttempts: 1,
    })).toEqual({
      action: "record",
      decision: "reply_blocked_for_cognition",
      reason: "blocked final reply because required cognition writes remained incomplete: group_soul: missing | user_profile: missing",
    });

    expect(resolveGroupAttemptResolution({
      outcome: {
        kind: "no_reply",
        reason: "model explicitly returned NO_REPLY",
      },
      missingSummaries: ["group_soul: missing", "user_profile: missing"],
      blockedForCognition: true,
      blockedForModerationDecision: false,
      attempt: 2,
      maxAttempts: 2,
    })).toEqual({
      action: "record",
      decision: "no_reply",
      reason: "model explicitly returned NO_REPLY",
    });

    expect(resolveGroupAttemptResolution({
      outcome: {
        kind: "empty",
        reason: "dispatcher settled without final reply",
      },
      missingSummaries: [],
      blockedForCognition: false,
      blockedForModerationDecision: false,
      attempt: 1,
      maxAttempts: 2,
    })).toEqual({
      action: "record",
      decision: "no_reply",
      reason: "dispatcher settled without final reply",
    });
  });

  it("does not synthesize observe moderation decision when structured moderation is required", () => {
    const logs: string[] = [];
    expect(resolveObserveFallbackModerationDecision({
      eventType: "group_message",
      decisionRequired: true,
      accountId: "default",
      log: (message) => logs.push(message),
    })).toBeUndefined();
    expect(logs.some((line) => line.includes("skip observe fallback because structured moderation decision is mandatory"))).toBe(true);
  });

  it("does not synthesize observe moderation decision when runtime disables fallback", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "chat43-runtime-"));
    const runtimePath = join(tempDir, "skill.runtime.json");
    writeFileSync(runtimePath, JSON.stringify({
      version: "1.0",
      moderation_policy_defaults: {
        enforcement: {
          enabled: true,
          roles: ["管理员"],
          require_decision: true,
          allow_observe_fallback: false,
        },
      },
    }), "utf8");

    expect(resolveObserveFallbackModerationDecision({
      cfg: {
        channels: {
          "43chat-openclaw-plugin": {
            skillDocsDir: tempDir,
            skillRuntimePath: runtimePath,
          },
        },
      } as any,
      eventType: "group_message",
      decisionRequired: true,
      accountId: "default",
      log: () => undefined,
    })).toBeUndefined();
  });

  it("parses cognition envelopes for all 43chat inbound events", () => {
    expect(shouldParseCognitionEnvelopeForInbound({
      eventType: "group_message",
    })).toBe(true);

    expect(shouldParseCognitionEnvelopeForInbound({
      eventType: "private_message",
    })).toBe(true);

    expect(shouldParseCognitionEnvelopeForInbound({
      eventType: "friend_request",
    })).toBe(true);
  });

  it("keeps retry attempts on the original dispatch session", () => {
    expect(resolveDispatchSessionKey("group:v1:100", "msg-1", 1))
      .toBe("group:v1:100");

    expect(resolveDispatchSessionKey("group:v1:100", "msg-1", 2))
      .toBe("group:v1:100");
  });

  it("uses canonical OpenClaw session keys when routing helpers exist", () => {
    expect(resolvePrimaryDispatchSessionKey({
      baseSessionKey: "agent:main:43chat-openclaw-plugin:group:group:100",
      target: "group:100",
      chatType: "group",
      agentId: "main",
      accountId: "default",
      buildAgentSessionKey: ({ agentId, channel, peer }) => `agent:${agentId}:${channel}:${peer?.kind}:${peer?.id}`,
      runtime: {
        source: "builtin",
        docsDir: "/tmp/43chat-runtime",
        runtimePath: "/tmp/43chat-runtime/skill.runtime.json",
        data: {
          version: "4.1.0",
          session: { version: "v1" },
        },
      } as any,
    })).toBe("agent:main:43chat-openclaw-plugin:group:v1:100");

    expect(resolvePrimaryDispatchSessionKey({
      baseSessionKey: "agent:main:43chat-openclaw-plugin:direct:user:123",
      target: "user:123",
      chatType: "direct",
      agentId: "main",
      accountId: "default",
      buildAgentSessionKey: ({ agentId, channel, peer, dmScope }) =>
        `agent:${agentId}:${channel}:${dmScope}:${peer?.kind}:${peer?.id}`,
      runtime: {
        source: "builtin",
        docsDir: "/tmp/43chat-runtime",
        runtimePath: "/tmp/43chat-runtime/skill.runtime.json",
        data: {
          version: "4.1.0",
          session: { version: "v3" },
        },
      } as any,
    })).toBe("agent:main:43chat-openclaw-plugin:per-channel-peer:direct:v3:123");
  });

  it("falls back to short session keys when the OpenClaw routing helper is unavailable", () => {
    expect(resolvePrimaryDispatchSessionKey({
      baseSessionKey: "agent:main:43chat-openclaw-plugin:direct:user:123",
      target: "user:123",
      chatType: "direct",
      runtime: {
        source: "builtin",
        docsDir: "/tmp/43chat-runtime",
        runtimePath: "/tmp/43chat-runtime/skill.runtime.json",
        data: {
          version: "4.1.0",
          session: { version: "v1" },
        },
      } as any,
    })).toBe("user:v1:123");

    expect(resolvePrimaryDispatchSessionKey({
      baseSessionKey: "agent:main:43chat-openclaw-plugin:direct:user:123",
      target: "user:123",
      chatType: "direct",
      runtime: {
        source: "builtin",
        docsDir: "/tmp/43chat-runtime",
        runtimePath: "/tmp/43chat-runtime/skill.runtime.json",
        data: {
          version: "4.1.0",
          session: { version: "v1" },
        },
      } as any,
    })).toBe("user:v1:123");
  });
});

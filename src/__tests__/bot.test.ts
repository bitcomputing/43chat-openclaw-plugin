import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyEventFactGuardsToCognitionContent,
  classifyDispatchAttemptOutcome,
  describeFinalReplyResolutionForLog,
  filterCognitionIssuesToRequiredAliases,
  looksLikeInternalToolFailureReplyText,
  map43ChatEventToInboundDescriptor,
  parseCognitionWriteEnvelope,
  resolveCognitionFullPath,
  resolveDispatchSessionKey,
  resolveObserveFallbackModerationDecision,
  resolveGroupAttemptResolution,
  recoverRecentFinalReplyFromSessionLog,
  shouldParseCognitionEnvelopeForInbound,
  shouldRetryDispatchForEmptyOutcome,
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
    expect(descriptor?.groupSystemPrompt).toContain("私聊与好友事件的最终输出也统一使用 `<chat43-cognition>");
    expect(descriptor?.groupSystemPrompt).toContain("\"writes\":[],\"reply\":\"...\"");
    expect(descriptor?.groupSystemPrompt).toContain("私聊一旦出现偏好、自我定义、关系定位、持续话题、后续约定等长期信号，就不允许继续用 `writes: []`");
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
    expect(descriptor?.groupSystemPrompt).toContain("不回复时必须只输出: `NO_REPLY`");
    expect(descriptor?.groupSystemPrompt).toContain("群聊长期认知默认改由后台 cognition worker 异步维护");
    expect(descriptor?.groupSystemPrompt).toContain("普通群聊主流程本轮只负责回复判断与公开回复");
    expect(descriptor?.groupSystemPrompt).toContain("群聊主流程不要调用 `edit` / `write` 直接改写 `group_soul` / `user_profile` / `group_members_graph`");
    expect(descriptor?.groupSystemPrompt).toContain("当前群聊主流程必须忽略，不能模仿、不能复述、不能继续输出");
    expect(descriptor?.groupSystemPrompt).toContain("最终答案只允许是可发送的普通文本，或精确的 `NO_REPLY`");
    expect(descriptor?.groupSystemPrompt).toContain("不能输出 XML/JSON 包裹、不能输出 `writes` 字段");
    expect(descriptor?.groupSystemPrompt).toContain("当前主流程可以参考已有认知文件做判断，但不要承担 `group_soul` / `user_profile` / `group_members_graph` 的补写任务");
    expect(descriptor?.groupSystemPrompt).toContain("我的身份: 管理员");
    expect(descriptor?.groupSystemPrompt).toContain("当前发言者: Alice（user:456）");
    expect(descriptor?.groupSystemPrompt).toContain("当前发言者身份: 群主");
    expect(descriptor?.groupSystemPrompt).toContain("当当前消息明显背离 `group_soul.boundaries` 时");
    expect(descriptor?.groupSystemPrompt).toContain("【文档约束的管理梯度】");
    expect(descriptor?.groupSystemPrompt).toContain("允许的管理决策种类: observe / redirect / warn / mark_risk / remove_member");
    expect(descriptor?.groupSystemPrompt).toContain("当前群聊主流程统一只输出普通文本或 `NO_REPLY`");
    expect(descriptor?.groupSystemPrompt).toContain("若文档声明当前阶段应公开提醒，就直接给出可发送的公开文本");
    expect(descriptor?.groupSystemPrompt).toContain("43Chat 认知文件根目录");
    expect(descriptor?.groupSystemPrompt).toContain("group_soul: alias=`groups/987654321/soul.json`");
    expect(descriptor?.groupSystemPrompt).toContain("/.config/43chat/groups/987654321/soul.json");
    expect(descriptor?.groupSystemPrompt).toContain("group_state / group_decision_log 由插件在决策后自动维护");
    expect(descriptor?.groupSystemPrompt).toContain("【这些长期认知文件由后台 worker 异步补写】");
    expect(descriptor?.groupSystemPrompt).not.toContain("【本轮需要你显式维护的长期认知文件】");
    expect(descriptor?.groupSystemPrompt).not.toContain("认知写入不是可选优化");
    expect(descriptor?.groupSystemPrompt).not.toContain("主流程没有额外的认知补写回合");
    expect(descriptor?.groupSystemPrompt).not.toContain("<chat43-cognition>");
    expect(descriptor?.groupSystemPrompt).not.toContain("更新群 Soul、成员画像、互动认知");
    expect(descriptor?.groupSystemPrompt).not.toContain("最终输出必须使用 `<chat43-cognition>");
    expect(descriptor?.groupSystemPrompt).not.toContain("本轮结构化 `decision` 为必填");
    expect(descriptor?.text).not.toContain("understanding.json");
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
\`\`\`chat43-cognition
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

  it("parses cognition write envelope from xml-style wrapper", () => {
    const parsed = parseCognitionWriteEnvelope(`
<chat43-cognition>
{"writes":[{"path":"profiles/12445.json","content":{"schema_version":"1.0","user_id":"12445"}}],"reply":"NO_REPLY"}
</chat43-cognition>
    `);

    expect(parsed).toEqual({
      writes: [{
        path: "profiles/12445.json",
        content: {
          schema_version: "1.0",
          user_id: "12445",
        },
      }],
      replyText: "NO_REPLY",
    });
  });

  it("parses structured moderation decision from cognition envelope", () => {
    const parsed = parseCognitionWriteEnvelope(`
<chat43-cognition>{"writes":[],"decision":{"scenario":"off_topic","stage":"first_occurrence","kind":"redirect","public_reply":true,"reason":"偏离工作群主题","target_user_id":"12373"},"reply":"先回到工作话题"}</chat43-cognition>
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

  it("parses cognition write envelope even when writes is empty", () => {
    const parsed = parseCognitionWriteEnvelope(`
<chat43-cognition>{"writes":[],"reply":"这是一条普通回复"}</chat43-cognition>
    `);

    expect(parsed).toEqual({
      writes: [],
      replyText: "这是一条普通回复",
    });
  });

  it("parses cognition write envelope from mixed reply text and trailing xml-style wrapper", () => {
    const parsed = parseCognitionWriteEnvelope(`
天气好确实让人心情舒畅～ 你今天有什么计划吗？
<chat43-cognition>{"writes":[{"path":"profiles/12373.json","content":{"schema_version":"1.0","user_id":"12373"}}],"reply":"天气好确实让人心情舒畅～ 你今天有什么计划吗？"}</chat43-cognition>
    `);

    expect(parsed).toEqual({
      writes: [{
        path: "profiles/12373.json",
        content: {
          schema_version: "1.0",
          user_id: "12373",
        },
      }],
      replyText: "天气好确实让人心情舒畅～ 你今天有什么计划吗？",
    });
  });

  it("parses cognition write envelope when write content is a stringified json object", () => {
    const parsed = parseCognitionWriteEnvelope(`
<chat43-cognition>{"writes":[{"path":"groups/100/members_graph.json","content":"{\\"schema_version\\":\\"1.0\\",\\"group_id\\":\\"100\\",\\"members\\":{\\"12443\\":{\\"role\\":\\"opinion_leader\\",\\"in_group_tags\\":[\\"成本优化\\"],\\"strategy\\":\\"主导成本优化议题\\"}}}"}],"reply":"NO_REPLY"}</chat43-cognition>
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
    })).toBe("raw_kind=cognition_envelope writes=1 outward=NO_REPLY");

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
    })).toContain("raw_kind=cognition_envelope writes=1 outward=这是一条真正要发到群里的文本回复");
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
      finalReplyText: "<chat43-cognition>{\"writes\":[],\"reply\":\"NO_REPLY\"}</chat43-cognition>",
      noReplyToken: "NO_REPLY",
    })).toEqual({
      kind: "suppressed",
      reason: "model returned a raw cognition envelope instead of sendable reply text",
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

  it("retries only when dispatch settled with an empty outcome", () => {
    expect(shouldRetryDispatchForEmptyOutcome({
      outcome: {
        kind: "empty",
        reason: "dispatcher settled without final reply",
      },
      attempt: 1,
      maxAttempts: 2,
    })).toBe(true);

    expect(shouldRetryDispatchForEmptyOutcome({
      outcome: {
        kind: "reply",
        replyText: "在呢",
        reason: "plugin delivered final text reply",
      },
      attempt: 1,
      maxAttempts: 2,
    })).toBe(false);

    expect(shouldRetryDispatchForEmptyOutcome({
      outcome: {
        kind: "no_reply",
        reason: "dispatcher settled without recorded final reply; treating as explicit NO_REPLY",
      },
      attempt: 1,
      maxAttempts: 2,
    })).toBe(false);
  });

  it("resolves group attempt outcomes with cognition guard in one place", () => {
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

  it("synthesizes observe moderation decision from runtime fallback instead of blocking normal reply", () => {
    const logs: string[] = [];
    expect(resolveObserveFallbackModerationDecision({
      eventType: "group_message",
      decisionRequired: true,
      accountId: "default",
      log: (message) => logs.push(message),
    })).toEqual({
      kind: "observe",
      reason: "runtime observe fallback synthesized by plugin because structured moderation decision was missing",
    });
    expect(logs.some((line) => line.includes("synthesize moderation decision kind=observe"))).toBe(true);
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

  it("parses cognition envelopes only for direct inbound events", () => {
    expect(shouldParseCognitionEnvelopeForInbound({
      chatType: "group",
    })).toBe(false);

    expect(shouldParseCognitionEnvelopeForInbound({
      chatType: "direct",
    })).toBe(true);
  });

  it("isolates retry attempts into a separate dispatch session", () => {
    expect(resolveDispatchSessionKey("agent:main:43chat-openclaw-plugin:group:group:100", "msg-1", 1))
      .toBe("agent:main:43chat-openclaw-plugin:group:group:100");

    expect(resolveDispatchSessionKey("agent:main:43chat-openclaw-plugin:group:group:100", "msg-1", 2))
      .toBe("agent:main:43chat-openclaw-plugin:group:group:100:cognition-retry:msg-1:attempt:2");
  });
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { map43ChatEventToInboundDescriptor } from "../bot.js";
import { buildSkillEventContext } from "../skill-event-context.js";
import {
  load43ChatSkillRuntime,
  shouldRequireStructuredModerationDecisionForRole,
  resolveSkillCognitionPolicy,
  resolveSkillModerationPolicy,
  resolveSkillReplyDelivery,
  resolveSkillReplyPolicy,
} from "../skill-runtime.js";

describe("43Chat skill runtime", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to builtin runtime when skill.runtime.json is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-skill-runtime-"));
    tempDirs.push(dir);

    const runtime = load43ChatSkillRuntime({
      channels: {
        "43chat-openclaw-plugin": {
          skillDocsDir: dir,
        },
      },
    } as any);

    expect(runtime.source).toBe("builtin");
    expect(runtime.data.storage.group_soul).toBe("groups/{group_id}/soul.json");
    expect(runtime.data.event_profiles.private_message.prompt_blocks?.[0]?.title).toBe("私聊主流程协议");
    expect(runtime.data.event_profiles.private_message.prompt_blocks?.[0]?.lines?.[0]).toContain("<chat43-cognition>");
    expect(runtime.data.event_profiles.private_message.prompt_blocks?.[0]?.lines?.[1]).toContain("\"envelope\":{\"reply\":\"你好\"}");
  });

  it("uses runtime file overrides without changing plugin code", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-skill-runtime-"));
    tempDirs.push(dir);
    const runtimePath = join(dir, "skill.runtime.json");
    writeFileSync(runtimePath, JSON.stringify({
      version: "4.1.0",
      storage: {
        group_state: "groups/{group_id}/state-v2.json",
      },
      event_profiles: {
        group_message: {
          docs: ["cognition", "groups"],
          reads: ["group_state"],
          writes: ["group_state"],
          reply_mode: "suppress_text_reply",
          chat_type: "group",
          required_think_fields: ["群Soul", "决策"],
        },
      },
    }), "utf8");

    const descriptor = map43ChatEventToInboundDescriptor({
      id: "evt-runtime",
      event_type: "group_message",
      timestamp: 1000,
      data: {
        message_id: 790,
        group_id: 1001,
        group_name: "Runtime 测试群",
        from_user_id: 2001,
        from_nickname: "Alice",
        content_type: "text",
        content: "hello",
        user_role: 0,
        user_role_name: "member",
        timestamp: 1000,
      },
    }, {
      cfg: {
        channels: {
          "43chat-openclaw-plugin": {
            skillDocsDir: dir,
            skillRuntimePath: runtimePath,
          },
        },
      } as any,
    });

    expect(descriptor?.suppressTextReply).toBe(true);
    expect(descriptor?.groupSystemPrompt).toContain("state-v2.json");
    expect(descriptor?.groupSystemPrompt).toContain(runtimePath);
    expect(descriptor?.groupSystemPrompt).toContain("<think> 至少包含: 群Soul / 决策");
    expect(descriptor?.groupSystemPrompt).toContain("当前消息处理约束");
  });

  it("allows reply delivery strategy to be overridden by skill runtime", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-skill-runtime-"));
    tempDirs.push(dir);
    const runtimePath = join(dir, "skill.runtime.json");
    writeFileSync(runtimePath, JSON.stringify({
      reply_delivery_defaults: {
        chunk_mode: "length",
        text_chunk_limit: 100,
      },
      event_profiles: {
        group_message: {
          docs: ["cognition", "groups"],
          reads: ["group_state"],
          writes: ["group_state"],
          reply_mode: "normal",
          chat_type: "group",
          required_think_fields: ["群Soul", "决策"],
          reply_delivery: {
            chunk_mode: "raw",
          },
        },
      },
    }), "utf8");

    const runtime = load43ChatSkillRuntime({
      channels: {
        "43chat-openclaw-plugin": {
          skillDocsDir: dir,
          skillRuntimePath: runtimePath,
        },
      },
    } as any);

    expect(resolveSkillReplyDelivery(runtime, "group_message")).toEqual({
      chunk_mode: "raw",
      text_chunk_limit: 100,
    });
  });

  it("allows no-reply policy to be overridden by skill runtime", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-skill-runtime-"));
    tempDirs.push(dir);
    const runtimePath = join(dir, "skill.runtime.json");
    writeFileSync(runtimePath, JSON.stringify({
      reply_policy_defaults: {
        mode: "hybrid",
        no_reply_token: "SKIP_IT",
        plugin_enforced: {
          recent_reply_window: 7,
          max_recent_replies: 3,
          allow_question_like_bypass: false,
        },
      },
      event_profiles: {
        group_message: {
          docs: ["cognition", "groups"],
          reads: ["group_state"],
          writes: ["group_state"],
          reply_mode: "normal",
          chat_type: "group",
          required_think_fields: ["群Soul", "决策"],
          reply_policy: {
            model_guidance: {
              no_reply_when: ["群成员之间已形成完整对话"],
            },
          },
        },
      },
    }), "utf8");

    const runtime = load43ChatSkillRuntime({
      channels: {
        "43chat-openclaw-plugin": {
          skillDocsDir: dir,
          skillRuntimePath: runtimePath,
        },
      },
    } as any);

    expect(resolveSkillReplyPolicy(runtime, "group_message")).toEqual({
      mode: "hybrid",
      no_reply_token: "SKIP_IT",
      plugin_enforced: {
        recent_reply_window: 7,
        max_recent_replies: 3,
        allow_question_like_bypass: false,
      },
      model_guidance: {
        must_reply: ["被明确@到", "明确提问"],
        should_reply: ["话题匹配群Soul", "当前回复能推进讨论", "最近回复频率未超限"],
        no_reply_when: ["群成员之间已形成完整对话"],
      },
    });
  });

  it("renders role definitions and prompt blocks from skill runtime", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-skill-runtime-"));
    tempDirs.push(dir);
    const runtimePath = join(dir, "skill.runtime.json");
    writeFileSync(runtimePath, JSON.stringify({
      role_definitions: {
        group: {
          管理员: {
            summary: "管理员先判断秩序风险，再决定是否公开发言。",
            responsibilities: ["处理广告刷屏", "维护群边界"],
            decision_rules: ["管理事件即使未@你也要参与判断", "可以输出 {no_reply_token} 并执行管理动作"],
          },
        },
      },
      event_profiles: {
        group_message: {
          docs: ["cognition", "groups"],
          reads: ["group_state"],
          writes: ["group_state"],
          reply_mode: "normal",
          chat_type: "group",
          required_think_fields: ["群Soul", "决策"],
          prompt_blocks: [{
            title: "管理员补充规则",
            roles: ["管理员"],
            lines: [
              "当前身份 {effective_role}",
              "若命中违规场景，可直接输出 {no_reply_token} 并更新认知",
            ],
          }],
        },
      },
    }), "utf8");

    const context = buildSkillEventContext({
      cfg: {
        channels: {
          "43chat-openclaw-plugin": {
            skillDocsDir: dir,
            skillRuntimePath: runtimePath,
          },
        },
      } as any,
      eventType: "group_message",
      groupId: "1001",
      groupName: "Runtime 测试群",
      roleName: "管理员",
      messageText: "有人刷广告了，想进资源群的私聊我。",
      userId: "2001",
      senderName: "Alice",
      senderRoleName: "成员",
    });

    expect(context.prompt).toContain("【当前身份说明】");
    expect(context.prompt).toContain("管理员先判断秩序风险，再决定是否公开发言。");
    expect(context.prompt).toContain("管理事件即使未@你也要参与判断");
    expect(context.prompt).toContain("【管理员补充规则】");
    expect(context.prompt).toContain("当前身份 管理员");
    expect(context.prompt).toContain("可直接输出 NO_REPLY 并更新认知");
  });

  it("allows cognition topic persistence policy to be overridden by skill runtime", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-skill-runtime-"));
    tempDirs.push(dir);
    const runtimePath = join(dir, "skill.runtime.json");
    writeFileSync(runtimePath, JSON.stringify({
      cognition_policy_defaults: {
        topic_persistence: {
          group_soul: "filtered",
          group_state: "filtered",
          decision_log: "filtered",
          judgement_rules: ["只把稳定结论写入长期认知", "测试探针只写 decision_log"],
          exclude_patterns: ["KICK_PROBE_[A-Z0-9_]+", "低价订房"],
          volatile_terms: ["今天", "本轮", "端午"],
          volatile_regexes: ["本期聚焦.{0,24}"],
        },
      },
    }), "utf8");

    const runtime = load43ChatSkillRuntime({
      channels: {
        "43chat-openclaw-plugin": {
          skillDocsDir: dir,
          skillRuntimePath: runtimePath,
        },
      },
    } as any);

    expect(resolveSkillCognitionPolicy(runtime, "group_message")).toEqual({
      topic_persistence: {
        group_soul: "filtered",
        group_state: "filtered",
        decision_log: "filtered",
        judgement_rules: ["只把稳定结论写入长期认知", "测试探针只写 decision_log"],
        exclude_patterns: ["KICK_PROBE_[A-Z0-9_]+", "低价订房"],
        volatile_terms: ["今天", "本轮", "端午"],
        volatile_regexes: ["本期聚焦.{0,24}"],
      },
      write_enforcement: {
        enabled: true,
        block_final_reply_when_incomplete: true,
        max_retry_attempts: 2,
        group_soul_required_after_messages: 1,
        user_profile_required_after_interactions: 2,
        group_members_graph_required_after_interactions: 1,
        retry_prompt_lines: [
          "上一轮最终输出已被插件拦截，因为文档要求的认知槽位仍为空。",
          "本轮必须先用当前会话里实际可见的文件工具，把缺失认知写回对应 JSON 文件，再决定回复或输出 `{no_reply_token}`。",
          "不要只重复上一轮的文字回复；先补齐 JSON，再给最终结论。",
        ],
      },
    });

    const context = buildSkillEventContext({
      cfg: {
        channels: {
          "43chat-openclaw-plugin": {
            skillDocsDir: dir,
            skillRuntimePath: runtimePath,
          },
        },
      } as any,
      eventType: "group_message",
      groupId: "1001",
      groupName: "Runtime 测试群",
      roleName: "管理员",
      messageText: "有人刷广告了，想进资源群的私聊我。",
      userId: "2001",
      senderName: "Alice",
      senderRoleName: "成员",
    });

    expect(context.prompt).toContain("【认知写入策略】");
    expect(context.prompt).toContain("topic_persistence.group_soul = filtered");
    expect(context.prompt).toContain("群聊长期认知默认改由后台 cognition worker 异步维护");
    expect(context.prompt).toContain("当前是管理员结构化管理回合");
    expect(context.prompt).toContain("群聊主流程最终输出统一使用 `<chat43-cognition>{...}</chat43-cognition>`");
    expect(context.prompt).toContain("当前主流程可以参考已有认知文件做判断，但不要承担 `group_soul` / `user_profile` / `group_members_graph` 的补写任务");
    expect(context.prompt).toContain("【这些长期认知文件由后台 worker 异步补写】");
    expect(context.prompt).not.toContain("【本轮需要你显式维护的长期认知文件】");
    expect(context.prompt).not.toContain("最终输出必须使用 `<chat43-cognition>");
    expect(context.prompt).not.toContain("强行输出 `<chat43-cognition>`");
    expect(context.prompt).not.toContain("插件不会根据关键词、正则或 topic 摘要替你写长期认知");
    expect(context.prompt).not.toContain("长期认知禁入词样例: 今天 / 本轮 / 端午");
    expect(context.prompt).not.toContain("长期认知禁入模式样例: 本期聚焦.{0,24}");
    expect(context.prompt).not.toContain("exclude_patterns");
    expect(context.prompt).not.toContain("KICK_PROBE_[A-Z0-9_]+");
  });

  it("allows cognition write enforcement to be overridden by skill runtime", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-skill-runtime-"));
    tempDirs.push(dir);
    const runtimePath = join(dir, "skill.runtime.json");
    writeFileSync(runtimePath, JSON.stringify({
      cognition_policy_defaults: {
        write_enforcement: {
          enabled: true,
          block_final_reply_when_incomplete: true,
          max_retry_attempts: 3,
          group_soul_required_after_messages: 2,
          user_profile_required_after_interactions: 4,
          group_members_graph_required_after_interactions: 5,
          retry_prompt_lines: ["先写 JSON", "再输出最终回复"],
        },
      },
      event_profiles: {
        group_message: {
          docs: ["cognition", "groups", "friends"],
          reads: ["group_soul", "group_members_graph", "group_state", "user_profile"],
          writes: ["group_soul", "group_members_graph", "group_state", "user_profile", "group_decision_log"],
          reply_mode: "normal",
          chat_type: "group",
          required_think_fields: ["群Soul", "决策"],
          cognition_policy: {
            write_enforcement: {
              max_retry_attempts: 4,
            },
          },
        },
      },
    }), "utf8");

    const runtime = load43ChatSkillRuntime({
      channels: {
        "43chat-openclaw-plugin": {
          skillDocsDir: dir,
          skillRuntimePath: runtimePath,
        },
      },
    } as any);

    expect(resolveSkillCognitionPolicy(runtime, "group_message")).toEqual({
      topic_persistence: {
        group_soul: "always",
        group_state: "always",
        decision_log: "always",
        judgement_rules: [
          "只有当这条信息会在未来多轮决策中持续影响群定位、群内关系、长期风险判断时，才写入长期认知。",
          "一次性探针、测试样例、营销导流、诱导私聊、短时情绪对喷、纯噪音，不要写入 group_soul 或 group_state。",
          "短期观察可以只写 decision_log；只有形成稳定结论时，才把抽象后的结论写入长期认知。",
          "写入长期认知时使用可复用的归纳表述，不要直接照抄原消息话术。",
        ],
        exclude_patterns: [],
        volatile_terms: [
          "今天",
          "今日",
          "本周",
          "本轮",
          "本期",
          "本月",
          "一期",
          "二期",
          "三期",
          "节前",
          "节后",
          "端午",
          "五一",
          "春节",
          "清明",
        ],
        volatile_regexes: [
          "第[一二三四五六七八九十0-9]+(?:个)?(?:事情|阶段|轮)",
          "(?:如果|若).{0,18}(?:今天|今日|本周|本轮|本期|排期|资源).{0,24}(?:会|将)",
          "本期聚焦.{0,24}",
        ],
      },
      write_enforcement: {
        enabled: true,
        block_final_reply_when_incomplete: true,
        max_retry_attempts: 4,
        group_soul_required_after_messages: 2,
        user_profile_required_after_interactions: 4,
        group_members_graph_required_after_interactions: 5,
        retry_prompt_lines: ["先写 JSON", "再输出最终回复"],
      },
    });
  });

  it("allows moderation policy to be overridden by skill runtime and rendered into prompt", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-skill-runtime-"));
    tempDirs.push(dir);
    const runtimePath = join(dir, "skill.runtime.json");
    writeFileSync(runtimePath, JSON.stringify({
      moderation_policy_defaults: {
        off_topic: {
          enabled: true,
          match_basis: ["group_name", "group_soul.boundaries"],
          first_occurrence: {
            decision: "redirect",
            public_reply: true,
            prompt_lines: ["先提醒回到群主题"],
          },
          repeat_occurrence: {
            decision: "warn",
            public_reply: true,
          },
          after_warning_repeat: {
            decision: "mark_risk",
            public_reply: false,
          },
        },
      },
      event_profiles: {
        group_message: {
          docs: ["cognition", "groups"],
          reads: ["group_soul", "group_state"],
          writes: ["group_soul", "group_state", "group_decision_log"],
          reply_mode: "normal",
          chat_type: "group",
          required_think_fields: ["群Soul", "决策"],
          moderation_policy: {
            off_topic: {
              repeat_occurrence: {
                decision: "warn",
                public_reply: false,
                prompt_lines: ["重复偏题时不公开陪聊"],
              },
            },
          },
        },
      },
    }), "utf8");

    const runtime = load43ChatSkillRuntime({
      channels: {
        "43chat-openclaw-plugin": {
          skillDocsDir: dir,
          skillRuntimePath: runtimePath,
        },
      },
    } as any);

    expect(resolveSkillModerationPolicy(runtime, "group_message")).toEqual({
      enforcement: {
        enabled: true,
        roles: ["管理员", "群主"],
        require_decision: true,
        allow_observe_fallback: true,
        retry_prompt_lines: [
          "如果你当前是管理员或群主，本轮群消息必须输出结构化 `decision`。",
          "若消息未命中任何管理场景，也必须显式输出 `decision.kind = observe`，说明当前只是观察、不采取管理动作。",
          "若消息命中文档里的管理场景，`decision.scenario` / `decision.stage` / `decision.kind` 必须与 runtime 声明一致。",
        ],
      },
      scenarios: {
        off_topic: {
          enabled: true,
          match_basis: ["group_name", "group_soul.boundaries"],
          steps: {
            first_occurrence: {
              decision: "redirect",
              public_reply: true,
              prompt_lines: ["先提醒回到群主题"],
            },
            repeat_occurrence: {
              decision: "warn",
              public_reply: false,
              prompt_lines: ["重复偏题时不公开陪聊"],
            },
            after_warning_repeat: {
              decision: "mark_risk",
              public_reply: false,
              prompt_lines: [
                "连续提醒后仍重复偏题时，优先记录风险与后续管理观察，不再陪同闲聊。",
              ],
            },
          },
        },
        spam_or_abuse: {
          enabled: true,
          match_basis: [
            "current_message",
            "group_state.pending_actions",
            "group_members_graph",
            "recent decision_log",
          ],
          steps: {
            first_occurrence: {
              decision: "warn",
              public_reply: true,
              prompt_lines: [
                "首次轻度违规时先明确警告，必要时简短说明群内边界。",
              ],
            },
            repeat_occurrence: {
              decision: "mark_risk",
              public_reply: false,
              prompt_lines: [
                "重复违规时先记录 risk 与后续动作，不把内部推理公开扩写到群里。",
              ],
            },
            after_warning_repeat: {
              decision: "remove_member",
              public_reply: false,
              prompt_lines: [
                "达到文档中的移除条件后，优先执行管理动作，不继续普通对话。",
              ],
            },
          },
        },
      },
      allowed_decision_kinds: ["observe", "redirect", "warn", "mark_risk", "remove_member"],
    });

    const context = buildSkillEventContext({
      cfg: {
        channels: {
          "43chat-openclaw-plugin": {
            skillDocsDir: dir,
            skillRuntimePath: runtimePath,
          },
        },
      } as any,
      eventType: "group_message",
      groupId: "1001",
      groupName: "项目工作群",
      roleName: "管理员",
      messageText: "群外还有更全资料，想要的私聊我，我拉你进小群。",
      userId: "2001",
      senderName: "Alice",
      senderRoleName: "成员",
    });

    expect(context.prompt).toContain("【文档约束的管理梯度】");
    expect(context.prompt).toContain("允许的管理决策种类: observe / redirect / warn / mark_risk / remove_member");
    expect(context.prompt).toContain("off_topic.repeat_occurrence => warn / public_reply=false");
    expect(context.prompt).toContain("重复偏题时不公开陪聊");
    expect(context.prompt).toContain("本轮结构化 `decision` 为必填");
    expect(context.prompt).toContain("最终输出必须是一个 `<chat43-cognition>{...}</chat43-cognition>` envelope");
    expect(context.prompt).toContain("`writes` 可以为空数组 `[]`");
    expect(context.prompt).toContain("你只需输出合法 `decision`，插件会按 `decision.kind` 执行对应管理动作");
    expect(context.prompt).toContain("不要输出“我没有这个工具”");
    expect(context.prompt).not.toContain("当前群聊主流程统一只输出普通文本或 `NO_REPLY`");
  });

  it("only requires structured moderation decisions for admin moderation signals", () => {
    const runtime = load43ChatSkillRuntime({
      channels: {
        "43chat-openclaw-plugin": {
          skillDocsDir: "/tmp/43chat-test-no-runtime",
          skillRuntimePath: "/tmp/43chat-test-no-runtime/skill.runtime.json",
        },
      },
    } as any);

    expect(shouldRequireStructuredModerationDecisionForRole({
      runtime,
      eventType: "group_message",
      roleName: "管理员",
      messageText: "@Dusty 你在干什么",
    })).toBe(false);

    expect(shouldRequireStructuredModerationDecisionForRole({
      runtime,
      eventType: "group_message",
      roleName: "管理员",
      messageText: "这边还有一份站外清单，想要完整版的私聊我发你。",
    })).toBe(true);
  });
});

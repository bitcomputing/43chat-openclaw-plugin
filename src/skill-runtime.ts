import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import packageJson from "../package.json" with { type: "json" };

export type SkillRuntimeReplyMode = "normal" | "suppress_text_reply";
export type SkillRuntimeChatType = "direct" | "group";
export type SkillRuntimeChunkMode = "length" | "newline" | "raw";
export type SkillRuntimeSessionConfig = {
  version?: string;
};
export type SkillRuntimeReplyDelivery = {
  chunk_mode?: SkillRuntimeChunkMode;
  text_chunk_limit?: number;
};
export type SkillRuntimeReplyPolicyMode = "model" | "hybrid";
export type SkillRuntimeReplyPolicyModelGuidance = {
  must_reply?: string[];
  should_reply?: string[];
  no_reply_when?: string[];
};
export type SkillRuntimeReplyPolicyPluginEnforced = {
  recent_reply_window?: number;
  max_recent_replies?: number;
  allow_question_like_bypass?: boolean;
};
export type SkillRuntimeReplyPolicy = {
  mode?: SkillRuntimeReplyPolicyMode;
  no_reply_token?: string;
  plugin_enforced?: SkillRuntimeReplyPolicyPluginEnforced;
  model_guidance?: SkillRuntimeReplyPolicyModelGuidance;
};
export type SkillRuntimeTopicPersistenceMode = "always" | "filtered" | "never";
export type SkillRuntimeTopicPersistencePolicy = {
  group_soul?: SkillRuntimeTopicPersistenceMode;
  group_state?: SkillRuntimeTopicPersistenceMode;
  decision_log?: SkillRuntimeTopicPersistenceMode;
  judgement_rules?: string[];
  exclude_patterns?: string[];
  volatile_terms?: string[];
  volatile_regexes?: string[];
};
export type SkillRuntimeCognitionWriteEnforcement = {
  enabled?: boolean;
  block_final_reply_when_incomplete?: boolean;
  max_retry_attempts?: number;
  group_soul_required_after_messages?: number;
  user_profile_required_after_interactions?: number;
  group_members_graph_required_after_interactions?: number;
  retry_prompt_lines?: string[];
};
export type SkillRuntimeCognitionPolicy = {
  topic_persistence?: SkillRuntimeTopicPersistencePolicy;
  write_enforcement?: SkillRuntimeCognitionWriteEnforcement;
};
export type SkillRuntimeModerationDecisionKind =
  | "observe"
  | "no_reply"
  | "redirect"
  | "warn"
  | "mark_risk"
  | "remove_member";
export type SkillRuntimeModerationStage =
  | "first_occurrence"
  | "repeat_occurrence"
  | "after_warning_repeat";
export type SkillRuntimeModerationStepPolicy = {
  decision?: SkillRuntimeModerationDecisionKind;
  public_reply?: boolean;
  prompt_lines?: string[];
};
export type SkillRuntimeModerationScenarioPolicy = {
  enabled?: boolean;
  match_basis?: string[];
  first_occurrence?: SkillRuntimeModerationStepPolicy;
  repeat_occurrence?: SkillRuntimeModerationStepPolicy;
  after_warning_repeat?: SkillRuntimeModerationStepPolicy;
};
export type SkillRuntimeModerationEnforcementPolicy = {
  enabled?: boolean;
  roles?: string[];
  require_decision?: boolean;
  allow_observe_fallback?: boolean;
  retry_prompt_lines?: string[];
};
export type SkillRuntimeModerationPolicy = {
  enforcement?: SkillRuntimeModerationEnforcementPolicy;
  off_topic?: SkillRuntimeModerationScenarioPolicy;
  spam_or_abuse?: SkillRuntimeModerationScenarioPolicy;
};
export type ResolvedSkillRuntimeCognitionPolicy = {
  topic_persistence: {
    group_soul: SkillRuntimeTopicPersistenceMode;
    group_state: SkillRuntimeTopicPersistenceMode;
    decision_log: SkillRuntimeTopicPersistenceMode;
    judgement_rules: string[];
    exclude_patterns: string[];
    volatile_terms: string[];
    volatile_regexes: string[];
  };
  write_enforcement: {
    enabled: boolean;
    block_final_reply_when_incomplete: boolean;
    max_retry_attempts: number;
    group_soul_required_after_messages: number;
    user_profile_required_after_interactions: number;
    group_members_graph_required_after_interactions: number;
    retry_prompt_lines: string[];
  };
};
export type ResolvedSkillRuntimeModerationPolicy = {
  enforcement: {
    enabled: boolean;
    roles: string[];
    require_decision: boolean;
    allow_observe_fallback: boolean;
    retry_prompt_lines: string[];
  };
  scenarios: Record<string, {
    enabled: boolean;
    match_basis: string[];
    steps: Record<SkillRuntimeModerationStage, {
      decision: SkillRuntimeModerationDecisionKind;
      public_reply: boolean;
      prompt_lines: string[];
    }>;
  }>;
  allowed_decision_kinds: SkillRuntimeModerationDecisionKind[];
};

const MODERATION_SIGNAL_PATTERNS = [
  /(?:广告|引流|导流|私聊|加我|加vx|加v|微信|v信|vx|薇信|二维码|拉你进群|拉你进小群|资源群|小群|渠道|名额|返利|代理|推广)/iu,
  /(?:踢(?:了|掉|出(?:去)?)|移出|清理|封禁|拉黑|禁言|处理一下|警告|处罚|违规|举报|投诉)/iu,
  /(?:骚扰|辱骂|人身攻击|喷人|刷屏|连发|spam|垃圾消息|垃圾广告)/iu,
  /(?:滚|废物|傻[逼比币]|脑残|去死|骗子|妈的|他妈|尼玛|sb)\b/iu,
  /(?:https?:\/\/|www\.)/iu,
] as const;

export type SkillRuntimePromptBlock = {
  title?: string;
  lines: string[];
  roles?: string[];
};

export type SkillRuntimeRoleDefinition = {
  summary?: string;
  responsibilities?: string[];
  permissions?: string[];
  decision_rules?: string[];
};

export type SkillRuntimeEventProfile = {
  docs: string[];
  reads: string[];
  writes: string[];
  reply_mode: SkillRuntimeReplyMode;
  chat_type: SkillRuntimeChatType;
  required_think_fields: string[];
  reply_delivery?: SkillRuntimeReplyDelivery;
  reply_policy?: SkillRuntimeReplyPolicy;
  cognition_policy?: SkillRuntimeCognitionPolicy;
  moderation_policy?: SkillRuntimeModerationPolicy;
  prompt_blocks?: SkillRuntimePromptBlock[];
};

export type SkillRuntime = {
  version: string;
  session: SkillRuntimeSessionConfig;
  docs: Record<string, string>;
  storage: Record<string, string>;
  reply_delivery_defaults: SkillRuntimeReplyDelivery;
  reply_policy_defaults: SkillRuntimeReplyPolicy;
  cognition_policy_defaults: SkillRuntimeCognitionPolicy;
  moderation_policy_defaults: SkillRuntimeModerationPolicy;
  role_definitions: {
    group: Record<string, SkillRuntimeRoleDefinition>;
    direct: Record<string, SkillRuntimeRoleDefinition>;
  };
  bootstrap_defaults: Record<string, unknown>;
  event_profiles: Record<string, SkillRuntimeEventProfile>;
};

export type LoadedSkillRuntime = {
  source: "builtin" | "file";
  docsDir: string;
  runtimePath: string;
  data: SkillRuntime;
};

const DEFAULT_SKILL_DOCS_DIR = join(homedir(), ".openclaw", "skills", "43chat");

export const DEFAULT_SKILL_RUNTIME: SkillRuntime = {
  version: "4.1.0",
  session: {
    version: "v1",
  },
  docs: {
    skill: "SKILL.md",
    cognition: "COGNITION.md",
    groups: "GROUPS.md",
    friends: "FRIENDS.md",
    messaging: "MESSAGING.md",
    sse: "SSE.md",
    heartbeat: "HEARTBEAT.md",
    rules: "RULES.md",
  },
  storage: {
    group_soul: "groups/{group_id}/soul.json",
    group_members_graph: "groups/{group_id}/members_graph.json",
    group_state: "groups/{group_id}/state.json",
    user_profile: "profiles/{user_id}.json",
    dialog_state: "dialogs/{user_id}/state.json",
    group_decision_log: "groups/{group_id}/decision_log.jsonl",
    dialog_decision_log: "dialogs/{user_id}/decision_log.jsonl",
  },
  reply_delivery_defaults: {
    chunk_mode: "raw",
  },
  reply_policy_defaults: {
    mode: "hybrid",
    no_reply_token: "NO_REPLY",
    plugin_enforced: {
      recent_reply_window: 5,
      max_recent_replies: 2,
      allow_question_like_bypass: true,
    },
    model_guidance: {
      must_reply: ["被明确@到", "明确提问"],
      should_reply: ["话题匹配群Soul", "当前回复能推进讨论", "最近回复频率未超限"],
      no_reply_when: ["无关话题", "群成员之间已形成完整对话", "最近5条里我已回复2条且当前不是明确提问"],
    },
  },
  cognition_policy_defaults: {
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
      max_retry_attempts: 2,
      group_soul_required_after_messages: 1,
      user_profile_required_after_interactions: 2,
      group_members_graph_required_after_interactions: 1,
      retry_prompt_lines: [
        "上一轮最终输出已被插件拦截，因为文档要求的认知槽位仍为空。",
        "本轮必须先用当前会话里实际可见的文件工具，把缺失认知写回对应 JSON 文件，再决定回复；若不回复，也要在最终 JSON 的 `reply` 中写 `{no_reply_token}`。",
        "不要只重复上一轮的文字回复；先补齐 JSON，再给最终结论。",
      ],
    },
  },
  moderation_policy_defaults: {
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
    off_topic: {
      enabled: true,
      match_basis: [
        "group_name",
        "group_soul.purpose",
        "group_soul.boundaries",
      ],
      first_occurrence: {
        decision: "redirect",
        public_reply: true,
        prompt_lines: [
          "先用公开回复把话题拉回群定位，不要顺着偏题继续扩聊。",
        ],
      },
      repeat_occurrence: {
        decision: "warn",
        public_reply: true,
        prompt_lines: [
          "如果同一成员连续偏离群主题，要明确提醒这是当前群不适合继续展开的话题。",
        ],
      },
      after_warning_repeat: {
        decision: "mark_risk",
        public_reply: false,
        prompt_lines: [
          "连续提醒后仍重复偏题时，优先记录风险与后续管理观察，不再陪同闲聊。",
        ],
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
  role_definitions: {
    group: {
      成员: {
        summary: "普通群成员，以参与讨论为主，不主动承担管理动作。",
        responsibilities: [
          "围绕群 Soul 参与有价值的话题",
          "被明确@到或被明确提问时及时回应",
          "不打断已经自然完成的成员对话",
        ],
        permissions: [
          "普通文本回复",
          "读取并参考群认知",
        ],
        decision_rules: [
          "普通闲聊且未明确需要你参与时，返回合法 JSON，并把 `reply` 写成 {no_reply_token}",
        ],
      },
      管理员: {
        summary: "管理员的首要职责是维护健康的群组秩序，而不只是参与聊天。",
        responsibilities: [
          "制止广告、骚扰、人身攻击、刷屏等违规行为",
          "维护讨论和群 Soul 的边界，保持群内秩序",
          "必要时警告成员、移除成员、审核申请、引导群氛围",
        ],
        permissions: [
          "审核入群申请",
          "邀请成员进群",
          "修改群信息",
          "移除成员",
        ],
        decision_rules: [
          "垃圾广告、营销导流、骚扰、反复刷屏属于需要你参与判断的管理事件，即使没人@你",
          "“只看当前消息”不等于忽略认知文件中的历史风险、最近违规和 pending_actions",
          "普通群聊沉默规则不能覆盖管理职责；先判断是否需要管理动作，再决定是否公开回复",
        ],
      },
      群主: {
        summary: "群主对群定位、秩序和成员管理承担最终责任。",
        responsibilities: [
          "承担管理员职责并对群定位和边界做最终判断",
          "必要时调整群信息、处理争议、解散群组",
        ],
        permissions: [
          "审核入群申请",
          "邀请成员进群",
          "修改群信息",
          "移除成员",
          "解散群组",
        ],
        decision_rules: [
          "垃圾广告、营销导流、骚扰、反复刷屏属于需要你参与判断的管理事件，即使没人@你",
          "“只看当前消息”不等于忽略认知文件中的历史风险、最近违规和 pending_actions",
          "普通群聊沉默规则不能覆盖管理职责；先判断是否需要管理动作，再决定是否公开回复",
        ],
      },
    },
    direct: {},
  },
  bootstrap_defaults: {
    group_soul: {
      schema_version: "1.0",
      group_id: "{group_id}",
      group_name: "{group_name}",
      source: "inferred",
      soul: {
        purpose: "",
        topics: [],
        tone: "混合",
        boundaries: "",
        expectations: "",
      },
      updated_at: "{event_iso_time}",
    },
    group_members_graph: {
      schema_version: "1.0",
      group_id: "{group_id}",
      members: {
        "{user_id}": {
          role: "",
          in_group_tags: [],
          strategy: "",
        },
      },
      updated_at: "{event_date}",
    },
    group_state: {
      schema_version: "1.0",
      group_id: "{group_id}",
      my_role: "",
      my_role_source: "",
      my_role_updated_at: "",
      current_topic: "",
      recent_topics: [],
      pending_actions: [],
      topic_drift_counter: 0,
      last_decision: "",
      last_reason: "",
      last_active_at: "{event_iso_time}",
      updated_at: "{event_iso_time}",
    },
    user_profile: {
      schema_version: "1.0",
      user_id: "{user_id}",
      nickname: "{sender_name}",
      first_seen: "{event_date}",
      first_seen_context: "{group_name}",
      is_friend: false,
      tags: [],
      expertise: [],
      personality: "",
      influence_level: "",
      interaction_stats: {
        total_interactions: 1,
        last_interaction: "{event_date}",
        sentiment_trend: "neutral",
      },
      notes: "",
      updated_at: "{event_date}",
    },
    dialog_state: {
      schema_version: "1.0",
      user_id: "{user_id}",
      current_topics: [],
      pending_actions: [],
      rapport_summary: "",
      updated_at: "{event_iso_time}",
    },
  },
  event_profiles: {
    private_message: {
      docs: ["cognition", "friends", "messaging", "rules"],
      reads: ["user_profile", "dialog_state"],
      writes: ["user_profile", "dialog_state", "dialog_decision_log"],
      reply_mode: "normal",
      chat_type: "direct",
      required_think_fields: ["对方", "话题", "决策", "附带动作", "画像更新"],
      prompt_blocks: [
        {
          title: "私聊主流程协议",
          lines: [
            "私聊主流程最终输出改为两段：先输出真正要发给对方的正文文本，最后再输出一个只包含 `decision` 的纯 JSON 对象；不要把正文包进 JSON",
            "最稳妥模板：`<公开回复或{no_reply_token}>\\n{\"decision\":{\"kind\":\"observe\",\"reason\":\"<简短原因>\"}}`",
            "如果当前消息不需要回复，正文就直接写 `{no_reply_token}`；不要再输出 `reply` 字段",
            "回复示例：`在呢，你说。\\n{\"decision\":{\"kind\":\"observe\",\"reason\":\"直接回应当前私聊消息\"}}`",
            "不回复示例：`{no_reply_token}\\n{\"decision\":{\"kind\":\"no_reply\",\"reason\":\"当前私聊无需继续回复\"}}`",
            "失败示例：只输出纯 JSON、`好的 {\"decision\":...}`、markdown 代码块 JSON、`{\"envelope\":{...}}` 都算协议错误",
            "先完成判断，再一次性输出：前面是正文，最后一个非空块必须是 JSON；不要先写解释、再写多段补充、再写 JSON",
            "最后那个 JSON 必须能被标准 `JSON.parse` 成功解析；若发现少括号、少引号、尾部缺失或字段不闭合，先修正，再输出",
            "输出前先自检一次：确认最后一个非空块首字符是 `{`、末字符是 `}`，并且整个 JSON 可被 `JSON.parse` 成功解析",
            "最后那个 JSON 顶层只允许使用 `decision`；不要输出 `reply`、`writes`、`envelope`、`moderation`、`parameter`、`_meta`、`chat43_mentions` 等额外字段",
            "如果需要 `decision`，`decision.kind` 只能是 `observe` / `no_reply` / `redirect` / `warn` / `mark_risk` / `remove_member`；不要自造 `reply`、`reply_sent`、`duplicate` 等值",
            "不要输出 `<thinking>`、`<envelope>`、`<reply>`、`<writes>` 这类 XML 标签",
            "不要输出“我没有这个工具”“插件会处理”“this is a retry”之类说明文本",
          ],
        },
      ],
    },
    group_message: {
      docs: ["cognition", "groups", "friends", "messaging", "rules"],
      reads: ["group_soul", "group_members_graph", "group_state", "user_profile"],
      writes: ["group_soul", "group_members_graph", "group_state", "user_profile", "group_decision_log"],
      reply_mode: "normal",
      chat_type: "group",
      required_think_fields: ["群Soul", "发言者", "话题匹配", "决策", "附带动作", "Soul状态", "画像更新"],
      prompt_blocks: [
        {
          title: "当前消息处理约束",
          lines: [
            "默认先处理本事件这一条新消息，避免无边界扩写上一轮话题",
            "只有当前消息明确在追问、承接或引用上一轮内容时，才能继续上文",
            "群里多人并发发言时，只围绕当前发言者当前这条消息作答",
            "如果当前消息只是普通成员之间已自然完成的对话、且没有管理必要，正文直接写 `{no_reply_token}`，最后仍补一个 `decision` JSON",
            "最稳妥模板：`<公开回复或{no_reply_token}>\\n{\"decision\":{\"kind\":\"observe\",\"reason\":\"<简短原因>\"}}`",
            "回复示例：`收到，今晚簋街见。\\n{\"decision\":{\"kind\":\"observe\",\"reason\":\"当前消息明确需要我回应\"}}`",
            "不回复示例：`{no_reply_token}\\n{\"decision\":{\"kind\":\"no_reply\",\"reason\":\"群成员之间已自然完成对话，无需我接入\"}}`",
            "失败示例：只输出纯 JSON、`好的 {\"decision\":...}`、markdown 代码块 JSON、`{\"envelope\":{...}}` 都算协议错误",
            "先完成判断，再一次性输出：前面是正文，最后一个非空块必须是 JSON；不要先写自然语言解释、再追加多段内容、再补 JSON",
            "最后那个 JSON 必须能被标准 `JSON.parse` 成功解析；若发现少括号、少引号、尾部缺失或字段不闭合，先修正，再输出",
            "输出前先自检一次：确认最后一个非空块首字符是 `{`、末字符是 `}`，并且整个 JSON 可被 `JSON.parse` 成功解析",
          ],
        },
        {
          title: "群定位边界优先",
          lines: [
            "`group_soul.purpose` / `group_soul.boundaries` 与群名一起定义当前群场域；如果当前消息明显偏离这些边界，不要顺势扩聊",
            "`user_profile` 在群聊里只是弱辅助信号；若它和 `group_soul` / `group_members_graph` 冲突，以群定位和群内角色判断为准",
            "私聊偏好、称呼习惯、线下邀约、一次性兴趣，不能作为你在群里跟随偏题或改写 `group_soul` 的依据",
            "即使偏题由群主或管理员先发起，也先按单次跑题处理；只有多人多轮稳定转向且长期认知已更新，才考虑接受新的群主题",
          ],
        },
        {
          title: "管理员管理判断",
          roles: ["管理员", "群主"],
          lines: [
            "当你的身份是 {effective_role} 时，维护群组秩序优先于普通闲聊沉默规则",
            "当当前消息明显背离 `group_soul.boundaries` 时，优先选择把 `reply` 写成 `{no_reply_token}`、轻提醒或把话题拉回群定位，不要陪同扩聊",
            "垃圾广告、营销导流、骚扰、人身攻击、反复刷屏，属于需要你参与判断的管理事件，即使当前消息没有@你",
            "允许结合 `group_state`、`group_members_graph`、`user_profile` 中的最近记录判断是否警告、移除成员、或仅记录观察",
            "如果最终判断是管理动作优先，可以不发普通文本，但必须完成认知更新和决策记录",
          ],
        },
        {
          title: "当前可用群管理动作",
          roles: ["管理员", "群主"],
          lines: [
            "审核入群申请: `chat43_handle_group_join_request(...)`",
            "邀请好友进群: `chat43_invite_group_members(groupId, memberIds)`",
            "修改群信息: `chat43_update_group(groupId, ...)`",
            "移除成员: `chat43_remove_group_member(groupId, userId, reason)`",
          ],
        },
        {
          title: "群主额外动作",
          roles: ["群主"],
          lines: [
            "解散群组: `chat43_dissolve_group(groupId, reason)`",
          ],
        },
      ],
    },
    friend_request: {
      docs: ["friends", "rules"],
      reads: ["user_profile"],
      writes: ["user_profile", "dialog_decision_log"],
      reply_mode: "normal",
      chat_type: "direct",
      required_think_fields: ["对方", "决策", "附带动作", "画像更新"],
    },
    friend_accepted: {
      docs: ["friends", "messaging", "rules"],
      reads: ["user_profile", "dialog_state"],
      writes: ["user_profile", "dialog_state", "dialog_decision_log"],
      reply_mode: "normal",
      chat_type: "direct",
      required_think_fields: ["对方", "决策", "附带动作", "画像更新"],
    },
    group_invitation: {
      docs: ["cognition", "groups", "friends", "rules"],
      reads: ["group_soul", "group_members_graph", "group_state", "user_profile"],
      writes: ["group_members_graph", "group_state", "user_profile", "group_decision_log"],
      reply_mode: "suppress_text_reply",
      chat_type: "group",
      required_think_fields: ["群Soul", "申请人", "审核决策", "附带动作", "状态更新"],
    },
    group_member_joined: {
      docs: ["cognition", "groups", "friends", "rules"],
      reads: ["group_soul", "group_members_graph", "group_state", "user_profile"],
      writes: ["group_members_graph", "group_state", "user_profile", "group_decision_log"],
      reply_mode: "normal",
      chat_type: "group",
      required_think_fields: ["群Soul", "新成员", "决策", "附带动作", "状态更新"],
    },
    system_notice: {
      docs: ["rules"],
      reads: [],
      writes: [],
      reply_mode: "normal",
      chat_type: "direct",
      required_think_fields: ["决策"],
    },
  },
};

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .map((entry) => readOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return items.length > 0 ? items : undefined;
}

function toStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = Object.entries(value as Record<string, unknown>)
    .reduce<Record<string, string>>((acc, [key, entry]) => {
      const normalized = readOptionalString(entry);
      if (normalized) {
        acc[key] = normalized;
      }
      return acc;
    }, {});
  return Object.keys(record).length > 0 ? record : undefined;
}

function toUnknownRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return Object.keys(value as Record<string, unknown>).length > 0
    ? { ...(value as Record<string, unknown>) }
    : undefined;
}

function readOptionalPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function toReplyDelivery(value: unknown): SkillRuntimeReplyDelivery | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const chunkMode = readOptionalString(record.chunk_mode);
  const textChunkLimit = readOptionalPositiveInteger(record.text_chunk_limit);

  const normalized: SkillRuntimeReplyDelivery = {};
  if (chunkMode === "length" || chunkMode === "newline" || chunkMode === "raw") {
    normalized.chunk_mode = chunkMode;
  }
  if (textChunkLimit) {
    normalized.text_chunk_limit = textChunkLimit;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function toReplyPolicyModelGuidance(value: unknown): SkillRuntimeReplyPolicyModelGuidance | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const normalized: SkillRuntimeReplyPolicyModelGuidance = {};
  const mustReply = toStringArray(record.must_reply);
  const shouldReply = toStringArray(record.should_reply);
  const noReplyWhen = toStringArray(record.no_reply_when);

  if (mustReply) {
    normalized.must_reply = mustReply;
  }
  if (shouldReply) {
    normalized.should_reply = shouldReply;
  }
  if (noReplyWhen) {
    normalized.no_reply_when = noReplyWhen;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function toReplyPolicyPluginEnforced(value: unknown): SkillRuntimeReplyPolicyPluginEnforced | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const normalized: SkillRuntimeReplyPolicyPluginEnforced = {};
  const recentReplyWindow = readOptionalPositiveInteger(record.recent_reply_window);
  const maxRecentReplies = readOptionalPositiveInteger(record.max_recent_replies);
  const allowQuestionLikeBypass = readOptionalBoolean(record.allow_question_like_bypass);

  if (recentReplyWindow) {
    normalized.recent_reply_window = recentReplyWindow;
  }
  if (maxRecentReplies) {
    normalized.max_recent_replies = maxRecentReplies;
  }
  if (typeof allowQuestionLikeBypass === "boolean") {
    normalized.allow_question_like_bypass = allowQuestionLikeBypass;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function toReplyPolicy(value: unknown): SkillRuntimeReplyPolicy | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const normalized: SkillRuntimeReplyPolicy = {};
  const mode = readOptionalString(record.mode);
  const noReplyToken = readOptionalString(record.no_reply_token);
  const pluginEnforced = toReplyPolicyPluginEnforced(record.plugin_enforced);
  const modelGuidance = toReplyPolicyModelGuidance(record.model_guidance);

  if (mode === "model" || mode === "hybrid") {
    normalized.mode = mode;
  }
  if (noReplyToken) {
    normalized.no_reply_token = noReplyToken;
  }
  if (pluginEnforced) {
    normalized.plugin_enforced = pluginEnforced;
  }
  if (modelGuidance) {
    normalized.model_guidance = modelGuidance;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function toTopicPersistencePolicy(value: unknown): SkillRuntimeTopicPersistencePolicy | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const normalized: SkillRuntimeTopicPersistencePolicy = {};
  const groupSoul = readOptionalString(record.group_soul);
  const groupState = readOptionalString(record.group_state);
  const decisionLog = readOptionalString(record.decision_log);
  const judgementRules = toStringArray(record.judgement_rules);
  const excludePatterns = toStringArray(record.exclude_patterns);
  const volatileTerms = toStringArray(record.volatile_terms);
  const volatileRegexes = toStringArray(record.volatile_regexes);

  if (groupSoul === "always" || groupSoul === "filtered" || groupSoul === "never") {
    normalized.group_soul = groupSoul;
  }
  if (groupState === "always" || groupState === "filtered" || groupState === "never") {
    normalized.group_state = groupState;
  }
  if (decisionLog === "always" || decisionLog === "filtered" || decisionLog === "never") {
    normalized.decision_log = decisionLog;
  }
  if (judgementRules) {
    normalized.judgement_rules = judgementRules;
  }
  if (excludePatterns) {
    normalized.exclude_patterns = excludePatterns;
  }
  if (volatileTerms) {
    normalized.volatile_terms = volatileTerms;
  }
  if (volatileRegexes) {
    normalized.volatile_regexes = volatileRegexes;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function toCognitionWriteEnforcement(value: unknown): SkillRuntimeCognitionWriteEnforcement | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const normalized: SkillRuntimeCognitionWriteEnforcement = {};
  const enabled = readOptionalBoolean(record.enabled);
  const blockFinalReplyWhenIncomplete = readOptionalBoolean(record.block_final_reply_when_incomplete);
  const maxRetryAttempts = readOptionalPositiveInteger(record.max_retry_attempts);
  const groupSoulRequiredAfterMessages = readOptionalPositiveInteger(record.group_soul_required_after_messages);
  const userProfileRequiredAfterInteractions = readOptionalPositiveInteger(record.user_profile_required_after_interactions);
  const groupMembersGraphRequiredAfterInteractions = readOptionalPositiveInteger(record.group_members_graph_required_after_interactions);
  const retryPromptLines = toStringArray(record.retry_prompt_lines);

  if (typeof enabled === "boolean") {
    normalized.enabled = enabled;
  }
  if (typeof blockFinalReplyWhenIncomplete === "boolean") {
    normalized.block_final_reply_when_incomplete = blockFinalReplyWhenIncomplete;
  }
  if (maxRetryAttempts) {
    normalized.max_retry_attempts = maxRetryAttempts;
  }
  if (groupSoulRequiredAfterMessages) {
    normalized.group_soul_required_after_messages = groupSoulRequiredAfterMessages;
  }
  if (userProfileRequiredAfterInteractions) {
    normalized.user_profile_required_after_interactions = userProfileRequiredAfterInteractions;
  }
  if (groupMembersGraphRequiredAfterInteractions) {
    normalized.group_members_graph_required_after_interactions = groupMembersGraphRequiredAfterInteractions;
  }
  if (retryPromptLines) {
    normalized.retry_prompt_lines = retryPromptLines;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function toCognitionPolicy(value: unknown): SkillRuntimeCognitionPolicy | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const normalized: SkillRuntimeCognitionPolicy = {};
  const topicPersistence = toTopicPersistencePolicy(record.topic_persistence);
  const writeEnforcement = toCognitionWriteEnforcement(record.write_enforcement);

  if (topicPersistence) {
    normalized.topic_persistence = topicPersistence;
  }
  if (writeEnforcement) {
    normalized.write_enforcement = writeEnforcement;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function isModerationDecisionKind(value: string | undefined): value is SkillRuntimeModerationDecisionKind {
  return value === "observe"
    || value === "no_reply"
    || value === "redirect"
    || value === "warn"
    || value === "mark_risk"
    || value === "remove_member";
}

function toModerationStepPolicy(value: unknown): SkillRuntimeModerationStepPolicy | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const normalized: SkillRuntimeModerationStepPolicy = {};
  const decision = readOptionalString(record.decision);
  const publicReply = readOptionalBoolean(record.public_reply);
  const promptLines = toStringArray(record.prompt_lines);

  if (isModerationDecisionKind(decision)) {
    normalized.decision = decision;
  }
  if (typeof publicReply === "boolean") {
    normalized.public_reply = publicReply;
  }
  if (promptLines) {
    normalized.prompt_lines = promptLines;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function toModerationScenarioPolicy(value: unknown): SkillRuntimeModerationScenarioPolicy | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const normalized: SkillRuntimeModerationScenarioPolicy = {};
  const enabled = readOptionalBoolean(record.enabled);
  const matchBasis = toStringArray(record.match_basis);
  const firstOccurrence = toModerationStepPolicy(record.first_occurrence);
  const repeatOccurrence = toModerationStepPolicy(record.repeat_occurrence);
  const afterWarningRepeat = toModerationStepPolicy(record.after_warning_repeat);

  if (typeof enabled === "boolean") {
    normalized.enabled = enabled;
  }
  if (matchBasis) {
    normalized.match_basis = matchBasis;
  }
  if (firstOccurrence) {
    normalized.first_occurrence = firstOccurrence;
  }
  if (repeatOccurrence) {
    normalized.repeat_occurrence = repeatOccurrence;
  }
  if (afterWarningRepeat) {
    normalized.after_warning_repeat = afterWarningRepeat;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function toModerationEnforcementPolicy(value: unknown): SkillRuntimeModerationEnforcementPolicy | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const normalized: SkillRuntimeModerationEnforcementPolicy = {};
  const enabled = readOptionalBoolean(record.enabled);
  const roles = toStringArray(record.roles);
  const requireDecision = readOptionalBoolean(record.require_decision);
  const allowObserveFallback = readOptionalBoolean(record.allow_observe_fallback);
  const retryPromptLines = toStringArray(record.retry_prompt_lines);

  if (typeof enabled === "boolean") {
    normalized.enabled = enabled;
  }
  if (roles) {
    normalized.roles = roles;
  }
  if (typeof requireDecision === "boolean") {
    normalized.require_decision = requireDecision;
  }
  if (typeof allowObserveFallback === "boolean") {
    normalized.allow_observe_fallback = allowObserveFallback;
  }
  if (retryPromptLines) {
    normalized.retry_prompt_lines = retryPromptLines;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function toModerationPolicy(value: unknown): SkillRuntimeModerationPolicy | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const normalized: SkillRuntimeModerationPolicy = {};
  const enforcement = toModerationEnforcementPolicy(record.enforcement);
  const offTopic = toModerationScenarioPolicy(record.off_topic);
  const spamOrAbuse = toModerationScenarioPolicy(record.spam_or_abuse);

  if (enforcement) {
    normalized.enforcement = enforcement;
  }
  if (offTopic) {
    normalized.off_topic = offTopic;
  }
  if (spamOrAbuse) {
    normalized.spam_or_abuse = spamOrAbuse;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function toPromptBlocks(value: unknown): SkillRuntimePromptBlock[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const blocks = value.reduce<SkillRuntimePromptBlock[]>((acc, entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return acc;
    }
    const record = entry as Record<string, unknown>;
    const lines = toStringArray(record.lines);
    if (!lines) {
      return acc;
    }
    acc.push({
      title: readOptionalString(record.title),
      lines,
      roles: toStringArray(record.roles),
    });
    return acc;
  }, []);

  return blocks.length > 0 ? blocks : undefined;
}

function toRoleDefinition(value: unknown): SkillRuntimeRoleDefinition | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const normalized: SkillRuntimeRoleDefinition = {};
  const summary = readOptionalString(record.summary);
  const responsibilities = toStringArray(record.responsibilities);
  const permissions = toStringArray(record.permissions);
  const decisionRules = toStringArray(record.decision_rules);

  if (summary) {
    normalized.summary = summary;
  }
  if (responsibilities) {
    normalized.responsibilities = responsibilities;
  }
  if (permissions) {
    normalized.permissions = permissions;
  }
  if (decisionRules) {
    normalized.decision_rules = decisionRules;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function toRoleDefinitionRecord(value: unknown): Record<string, SkillRuntimeRoleDefinition> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const normalized = Object.entries(value as Record<string, unknown>)
    .reduce<Record<string, SkillRuntimeRoleDefinition>>((acc, [roleName, entry]) => {
      const definition = toRoleDefinition(entry);
      if (definition) {
        acc[roleName] = definition;
      }
      return acc;
    }, {});

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function toRoleDefinitions(value: unknown): SkillRuntime["role_definitions"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  return {
    group: toRoleDefinitionRecord(record.group) ?? {},
    direct: toRoleDefinitionRecord(record.direct) ?? {},
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepMergeUnknown(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override;
  }

  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = key in merged ? deepMergeUnknown(merged[key], value) : value;
  }
  return merged;
}

function toEventProfiles(value: unknown): Record<string, SkillRuntimeEventProfile> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const profiles: Record<string, SkillRuntimeEventProfile> = {};
  for (const [eventType, rawProfile] of Object.entries(value as Record<string, unknown>)) {
    if (!rawProfile || typeof rawProfile !== "object" || Array.isArray(rawProfile)) {
      continue;
    }
    const profile = rawProfile as Record<string, unknown>;
    const docs = toStringArray(profile.docs);
    const reads = toStringArray(profile.reads);
    const writes = toStringArray(profile.writes);
    const requiredThinkFields = toStringArray(profile.required_think_fields);
    const replyMode = readOptionalString(profile.reply_mode);
    const chatType = readOptionalString(profile.chat_type);

    if (!docs || !reads || !writes || !requiredThinkFields) {
      continue;
    }
    if (replyMode !== "normal" && replyMode !== "suppress_text_reply") {
      continue;
    }
    if (chatType !== "direct" && chatType !== "group") {
      continue;
    }

    const normalized: SkillRuntimeEventProfile = {
      docs,
      reads,
      writes,
      reply_mode: replyMode,
      chat_type: chatType,
      required_think_fields: requiredThinkFields,
    };
    const replyDelivery = toReplyDelivery(profile.reply_delivery);
    const replyPolicy = toReplyPolicy(profile.reply_policy);
    const cognitionPolicy = toCognitionPolicy(profile.cognition_policy);
    const moderationPolicy = toModerationPolicy(profile.moderation_policy);
    const promptBlocks = toPromptBlocks(profile.prompt_blocks);
    if (replyDelivery) {
      normalized.reply_delivery = replyDelivery;
    }
    if (replyPolicy) {
      normalized.reply_policy = replyPolicy;
    }
    if (cognitionPolicy) {
      normalized.cognition_policy = cognitionPolicy;
    }
    if (moderationPolicy) {
      normalized.moderation_policy = moderationPolicy;
    }
    if (promptBlocks) {
      normalized.prompt_blocks = promptBlocks;
    }

    profiles[eventType] = normalized;
  }

  return Object.keys(profiles).length > 0 ? profiles : undefined;
}

function toSessionConfig(value: unknown): SkillRuntimeSessionConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return {
    version: readOptionalString((value as Record<string, unknown>).version) ?? undefined,
  };
}

function mergeRuntime(partial: Partial<SkillRuntime> | undefined): SkillRuntime {
  const bootstrapDefaults = {
    ...DEFAULT_SKILL_RUNTIME.bootstrap_defaults,
  };
  const roleDefinitions: SkillRuntime["role_definitions"] = {
    group: {
      ...DEFAULT_SKILL_RUNTIME.role_definitions.group,
    },
    direct: {
      ...DEFAULT_SKILL_RUNTIME.role_definitions.direct,
    },
  };
  const eventProfiles: Record<string, SkillRuntimeEventProfile> = {
    ...DEFAULT_SKILL_RUNTIME.event_profiles,
  };

  for (const [alias, value] of Object.entries(partial?.bootstrap_defaults ?? {})) {
    bootstrapDefaults[alias] = deepMergeUnknown(bootstrapDefaults[alias], value);
  }
  for (const [roleName, value] of Object.entries(partial?.role_definitions?.group ?? {})) {
    roleDefinitions.group[roleName] = deepMergeUnknown(
      roleDefinitions.group[roleName] ?? {},
      value,
    ) as SkillRuntimeRoleDefinition;
  }
  for (const [roleName, value] of Object.entries(partial?.role_definitions?.direct ?? {})) {
    roleDefinitions.direct[roleName] = deepMergeUnknown(
      roleDefinitions.direct[roleName] ?? {},
      value,
    ) as SkillRuntimeRoleDefinition;
  }
  for (const [eventType, value] of Object.entries(partial?.event_profiles ?? {})) {
    eventProfiles[eventType] = deepMergeUnknown(
      eventProfiles[eventType] ?? {},
      value,
    ) as SkillRuntimeEventProfile;
  }

  return {
    version: readOptionalString(partial?.version) ?? DEFAULT_SKILL_RUNTIME.version,
    session: partial?.session
      ? deepMergeUnknown(
        DEFAULT_SKILL_RUNTIME.session,
        partial.session,
      ) as SkillRuntimeSessionConfig
      : DEFAULT_SKILL_RUNTIME.session,
    docs: {
      ...DEFAULT_SKILL_RUNTIME.docs,
      ...(partial?.docs ?? {}),
    },
    storage: {
      ...DEFAULT_SKILL_RUNTIME.storage,
      ...(partial?.storage ?? {}),
    },
    reply_delivery_defaults: {
      ...DEFAULT_SKILL_RUNTIME.reply_delivery_defaults,
      ...(partial?.reply_delivery_defaults ?? {}),
    },
    reply_policy_defaults: partial?.reply_policy_defaults
      ? deepMergeUnknown(
        DEFAULT_SKILL_RUNTIME.reply_policy_defaults,
        partial.reply_policy_defaults,
      ) as SkillRuntimeReplyPolicy
      : DEFAULT_SKILL_RUNTIME.reply_policy_defaults,
    cognition_policy_defaults: partial?.cognition_policy_defaults
      ? deepMergeUnknown(
        DEFAULT_SKILL_RUNTIME.cognition_policy_defaults,
        partial.cognition_policy_defaults,
      ) as SkillRuntimeCognitionPolicy
      : DEFAULT_SKILL_RUNTIME.cognition_policy_defaults,
    moderation_policy_defaults: partial?.moderation_policy_defaults
      ? deepMergeUnknown(
        DEFAULT_SKILL_RUNTIME.moderation_policy_defaults,
        partial.moderation_policy_defaults,
      ) as SkillRuntimeModerationPolicy
      : DEFAULT_SKILL_RUNTIME.moderation_policy_defaults,
    role_definitions: roleDefinitions,
    bootstrap_defaults: bootstrapDefaults,
    event_profiles: eventProfiles,
  };
}

function readChannelConfig(cfg?: ClawdbotConfig): Record<string, unknown> | undefined {
  return cfg?.channels?.[packageJson.openclaw.channel.id] as Record<string, unknown> | undefined;
}

export function resolve43ChatSkillDocsDir(cfg?: ClawdbotConfig): string {
  return readOptionalString(readChannelConfig(cfg)?.skillDocsDir) ?? DEFAULT_SKILL_DOCS_DIR;
}

export function resolve43ChatSkillRuntimePath(cfg?: ClawdbotConfig): string {
  return readOptionalString(readChannelConfig(cfg)?.skillRuntimePath)
    ?? join(resolve43ChatSkillDocsDir(cfg), "skill.runtime.json");
}

const skillRuntimeCache = new Map<string, { value: LoadedSkillRuntime; expiresAt: number }>();
const SKILL_RUNTIME_CACHE_TTL_MS = 30_000;

export function load43ChatSkillRuntime(cfg?: ClawdbotConfig): LoadedSkillRuntime {
  const docsDir = resolve43ChatSkillDocsDir(cfg);
  const runtimePath = resolve43ChatSkillRuntimePath(cfg);
  const cacheKey = runtimePath;
  const now = Date.now();
  const cached = skillRuntimeCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  if (!existsSync(runtimePath)) {
    const value = { source: "builtin" as const, docsDir, runtimePath, data: DEFAULT_SKILL_RUNTIME };
    skillRuntimeCache.set(cacheKey, { value, expiresAt: now + SKILL_RUNTIME_CACHE_TTL_MS });
    return value;
  }

  try {
    const raw = JSON.parse(readFileSync(runtimePath, "utf8")) as Record<string, unknown>;
    const merged = mergeRuntime({
      version: readOptionalString(raw.version) ?? undefined,
      session: toSessionConfig(raw.session),
      docs: toStringRecord(raw.docs),
      storage: toStringRecord(raw.storage),
      reply_delivery_defaults: toReplyDelivery(raw.reply_delivery_defaults),
      reply_policy_defaults: toReplyPolicy(raw.reply_policy_defaults),
      cognition_policy_defaults: toCognitionPolicy(raw.cognition_policy_defaults),
      moderation_policy_defaults: toModerationPolicy(raw.moderation_policy_defaults),
      role_definitions: toRoleDefinitions(raw.role_definitions),
      bootstrap_defaults: toUnknownRecord(raw.bootstrap_defaults),
      event_profiles: toEventProfiles(raw.event_profiles),
    });
    const value = { source: "file" as const, docsDir, runtimePath, data: merged };
    skillRuntimeCache.set(cacheKey, { value, expiresAt: now + SKILL_RUNTIME_CACHE_TTL_MS });
    return value;
  } catch {
    const value = { source: "builtin" as const, docsDir, runtimePath, data: DEFAULT_SKILL_RUNTIME };
    skillRuntimeCache.set(cacheKey, { value, expiresAt: now + SKILL_RUNTIME_CACHE_TTL_MS });
    return value;
  }
}

export function resolveSkillDocPaths(
  runtime: LoadedSkillRuntime,
  docKeys: string[],
): string[] {
  const resolved: string[] = [];
  for (const key of docKeys) {
    const filename = runtime.data.docs[key];
    if (!filename) {
      continue;
    }
    resolved.push(join(runtime.docsDir, filename));
  }
  return Array.from(new Set(resolved));
}

export function resolveSkillSessionVersion(runtime: LoadedSkillRuntime): string {
  const raw = readOptionalString(runtime.data.session?.version)?.trim();
  if (!raw) {
    return "v1";
  }

  const normalized = raw
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "v1";
}

export function resolveSkillStorageTargets(
  runtime: LoadedSkillRuntime,
  aliases: string[],
  values: Record<string, string | undefined>,
): Array<{ alias: string; path: string }> {
  const targets: Array<{ alias: string; path: string }> = [];

  for (const alias of aliases) {
    const template = runtime.data.storage[alias];
    if (!template) {
      continue;
    }
    const path = template.replace(/\{([a-z_]+)\}/g, (_match, token: string) => values[token] ?? "");
    if (path.includes("{") || path.includes("}")) {
      continue;
    }
    if (path.includes("//") || path.endsWith("/")) {
      continue;
    }
    targets.push({ alias, path });
  }

  return targets;
}

function renderBootstrapValue(
  value: unknown,
  vars: Record<string, string | undefined>,
): unknown {
  if (typeof value === "string") {
    return value.replace(/\{([a-z_]+)\}/g, (_match, token: string) => vars[token] ?? "");
  }
  if (Array.isArray(value)) {
    return value.map((entry) => renderBootstrapValue(entry, vars));
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).reduce<Record<string, unknown>>((acc, [key, entry]) => {
      const renderedKey = key.replace(/\{([a-z_]+)\}/g, (_match, token: string) => vars[token] ?? "");
      acc[renderedKey] = renderBootstrapValue(entry, vars);
      return acc;
    }, {});
  }
  return value;
}

export function resolveSkillBootstrapDefaults(
  runtime: LoadedSkillRuntime,
  aliases: string[],
  values: Record<string, string | undefined>,
): Array<{ alias: string; content: Record<string, unknown> }> {
  const resolved: Array<{ alias: string; content: Record<string, unknown> }> = [];

  for (const alias of aliases) {
    const template = runtime.data.bootstrap_defaults[alias];
    if (!template || typeof template !== "object" || Array.isArray(template)) {
      continue;
    }
    resolved.push({
      alias,
      content: renderBootstrapValue(template, values) as Record<string, unknown>,
    });
  }

  return resolved;
}

export function resolveSkillReplyDelivery(
  runtime: LoadedSkillRuntime,
  eventType: string,
): Required<SkillRuntimeReplyDelivery> {
  const profile = runtime.data.event_profiles[eventType]
    ?? runtime.data.event_profiles.system_notice;
  const resolved = {
    ...runtime.data.reply_delivery_defaults,
    ...(profile?.reply_delivery ?? {}),
  };

  return {
    chunk_mode: resolved.chunk_mode ?? "raw",
    text_chunk_limit: resolved.text_chunk_limit ?? 0,
  };
}

export function resolveSkillReplyPolicy(
  runtime: LoadedSkillRuntime,
  eventType: string,
): Required<SkillRuntimeReplyPolicy> {
  const profile = runtime.data.event_profiles[eventType]
    ?? runtime.data.event_profiles.system_notice;
  const resolved = profile?.reply_policy
    ? deepMergeUnknown(
      runtime.data.reply_policy_defaults,
      profile.reply_policy,
    ) as SkillRuntimeReplyPolicy
    : runtime.data.reply_policy_defaults;

  return {
    mode: resolved.mode ?? "hybrid",
    no_reply_token: resolved.no_reply_token ?? "NO_REPLY",
    plugin_enforced: {
      recent_reply_window: resolved.plugin_enforced?.recent_reply_window ?? 0,
      max_recent_replies: resolved.plugin_enforced?.max_recent_replies ?? 0,
      allow_question_like_bypass: resolved.plugin_enforced?.allow_question_like_bypass ?? true,
    },
    model_guidance: {
      must_reply: resolved.model_guidance?.must_reply ?? [],
      should_reply: resolved.model_guidance?.should_reply ?? [],
      no_reply_when: resolved.model_guidance?.no_reply_when ?? [],
    },
  };
}

export function resolveSkillCognitionPolicy(
  runtime: LoadedSkillRuntime,
  eventType: string,
): ResolvedSkillRuntimeCognitionPolicy {
  const profile = runtime.data.event_profiles[eventType]
    ?? runtime.data.event_profiles.system_notice;
  const resolved = profile?.cognition_policy
    ? deepMergeUnknown(
      runtime.data.cognition_policy_defaults,
      profile.cognition_policy,
    ) as SkillRuntimeCognitionPolicy
    : runtime.data.cognition_policy_defaults;

  return {
    topic_persistence: {
      group_soul: resolved.topic_persistence?.group_soul ?? "always",
      group_state: resolved.topic_persistence?.group_state ?? "always",
      decision_log: resolved.topic_persistence?.decision_log ?? "always",
      judgement_rules: resolved.topic_persistence?.judgement_rules ?? [],
      exclude_patterns: resolved.topic_persistence?.exclude_patterns ?? [],
      volatile_terms: resolved.topic_persistence?.volatile_terms ?? [],
      volatile_regexes: resolved.topic_persistence?.volatile_regexes ?? [],
    },
    write_enforcement: {
      enabled: resolved.write_enforcement?.enabled ?? true,
      block_final_reply_when_incomplete: resolved.write_enforcement?.block_final_reply_when_incomplete ?? true,
      max_retry_attempts: resolved.write_enforcement?.max_retry_attempts ?? 2,
      group_soul_required_after_messages: resolved.write_enforcement?.group_soul_required_after_messages ?? 1,
      user_profile_required_after_interactions: resolved.write_enforcement?.user_profile_required_after_interactions ?? 2,
      group_members_graph_required_after_interactions: resolved.write_enforcement?.group_members_graph_required_after_interactions ?? 1,
      retry_prompt_lines: resolved.write_enforcement?.retry_prompt_lines ?? [],
    },
  };
}

export function resolveSkillModerationPolicy(
  runtime: LoadedSkillRuntime,
  eventType: string,
): ResolvedSkillRuntimeModerationPolicy {
  const profile = runtime.data.event_profiles[eventType]
    ?? runtime.data.event_profiles.system_notice;
  const resolved = profile?.moderation_policy
    ? deepMergeUnknown(
      runtime.data.moderation_policy_defaults,
      profile.moderation_policy,
    ) as SkillRuntimeModerationPolicy
    : runtime.data.moderation_policy_defaults;

  const scenarioNames = ["off_topic", "spam_or_abuse"] as const;
  const defaultStep = (step: SkillRuntimeModerationStepPolicy | undefined): {
    decision: SkillRuntimeModerationDecisionKind;
    public_reply: boolean;
    prompt_lines: string[];
  } => ({
    decision: step?.decision ?? "observe",
    public_reply: step?.public_reply ?? false,
    prompt_lines: step?.prompt_lines ?? [],
  });

  const scenarios = scenarioNames.reduce<ResolvedSkillRuntimeModerationPolicy["scenarios"]>((acc, name) => {
    const scenario = resolved[name];
    acc[name] = {
      enabled: scenario?.enabled ?? false,
      match_basis: scenario?.match_basis ?? [],
      steps: {
        first_occurrence: defaultStep(scenario?.first_occurrence),
        repeat_occurrence: defaultStep(scenario?.repeat_occurrence),
        after_warning_repeat: defaultStep(scenario?.after_warning_repeat),
      },
    };
    return acc;
  }, {});

  const allowedDecisionKinds = Array.from(new Set(
    Object.values(scenarios).flatMap((scenario) => scenario.enabled
      ? Object.values(scenario.steps).map((step) => step.decision)
      : []),
  )) as SkillRuntimeModerationDecisionKind[];

  return {
    enforcement: {
      enabled: resolved.enforcement?.enabled ?? false,
      roles: resolved.enforcement?.roles ?? [],
      require_decision: resolved.enforcement?.require_decision ?? false,
      allow_observe_fallback: resolved.enforcement?.allow_observe_fallback ?? true,
      retry_prompt_lines: resolved.enforcement?.retry_prompt_lines ?? [],
    },
    scenarios,
    allowed_decision_kinds: Array.from(new Set<SkillRuntimeModerationDecisionKind>([
      ...(resolved.enforcement?.allow_observe_fallback ?? true ? ["observe" as const] : []),
      ...allowedDecisionKinds,
    ])),
  };
}

export function shouldRequireStructuredModerationDecisionForRole(params: {
  runtime: LoadedSkillRuntime;
  eventType: string;
  roleName?: string;
  messageText?: string;
}): boolean {
  if (params.eventType !== "group_message") {
    return false;
  }

  const roleName = params.roleName?.trim();
  if (!roleName) {
    return false;
  }

  const moderationPolicy = resolveSkillModerationPolicy(params.runtime, params.eventType);
  if (
    !moderationPolicy.enforcement.enabled
    || !moderationPolicy.enforcement.require_decision
  ) {
    return false;
  }

  if (!moderationPolicy.enforcement.roles.includes(roleName)) {
    return false;
  }

  return looksLikeModerationSignal(params.messageText);
}

export function looksLikeModerationSignal(messageText?: string): boolean {
  const text = messageText?.replace(/\s+/gu, " ").trim() ?? "";
  if (!text) {
    return false;
  }

  return MODERATION_SIGNAL_PATTERNS.some((pattern) => pattern.test(text));
}

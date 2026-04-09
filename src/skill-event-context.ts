import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import {
  formatCognitionSnapshot,
  readCognitionSnapshot,
  transformCognitionSnapshotForPrompt,
  type CognitionSnapshotEntry,
} from "./cognition-snapshot.js";
import {
  resolveSkillCognitionPolicy,
  load43ChatSkillRuntime,
  resolveSkillModerationPolicy,
  resolveSkillReplyPolicy,
  resolveSkillDocPaths,
  resolveSkillStorageTargets,
  type SkillRuntimePromptBlock,
  type SkillRuntimeRoleDefinition,
  type SkillRuntimeEventProfile,
} from "./skill-runtime.js";

type BuildSkillEventContextParams = {
  cfg?: ClawdbotConfig;
  eventType: string;
  accountId?: string;
  roleName?: string;
  groupId?: string;
  groupName?: string;
  userId?: string;
  senderName?: string;
  senderRoleName?: string;
  extraPromptBlocks?: SkillRuntimePromptBlock[];
};

export type BuiltSkillEventContext = {
  prompt: string;
  replyMode: SkillRuntimeEventProfile["reply_mode"];
};

const COGNITION_STORAGE_ROOT = join(homedir(), ".config", "43chat");

function readString(value: unknown): string | undefined {
  if (typeof value === "number" && !Number.isNaN(value)) {
    return String(value);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function formatPaths(title: string, entries: string[]): string[] {
  if (entries.length === 0) {
    return [];
  }
  return [title, ...entries.map((entry) => `- ${entry}`), ""];
}

function formatAliasedToolCalls(
  title: string,
  entries: Array<{ alias: string; path: string }>,
): string[] {
  if (entries.length === 0) {
    return [];
  }

  const examples = entries.map((entry) => {
    const absolutePath = resolveAbsoluteCognitionPath(entry.path);
    return `- ${entry.alias}: alias=\`${entry.path}\` absolute=\`${absolutePath ?? "<invalid>"}\``;
  });

  return [title, ...examples, ""];
}

function dedupeAliasedPaths(
  entries: Array<{ alias: string; path: string }>,
): Array<{ alias: string; path: string }> {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.alias}:${entry.path}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function parseSnapshotJson(content: string | undefined): Record<string, unknown> | undefined {
  if (!content) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function resolveAbsoluteCognitionPath(relativePath: string): string | null {
  const fullPath = join(COGNITION_STORAGE_ROOT, normalize(relativePath));
  if (!fullPath.startsWith(COGNITION_STORAGE_ROOT)) {
    return null;
  }
  return fullPath;
}

function isPluginManagedWriteAlias(alias: string): boolean {
  return alias === "group_state" || alias.endsWith("decision_log");
}

function renderPromptTemplate(
  template: string,
  values: Record<string, string | undefined>,
): string {
  return template.replace(/\{([a-z_]+)\}/g, (_match, token: string) => values[token] ?? "");
}

function renderPromptBlocks(params: {
  blocks: SkillRuntimePromptBlock[] | undefined;
  effectiveRoleName?: string;
  values: Record<string, string | undefined>;
}): string[] {
  if (!params.blocks || params.blocks.length === 0) {
    return [];
  }

  const rendered: string[] = [];
  for (const block of params.blocks) {
    if (block.roles?.length && !block.roles.includes(params.effectiveRoleName ?? "")) {
      continue;
    }
    if (block.title) {
      rendered.push(`【${renderPromptTemplate(block.title, params.values)}】`);
    }
    rendered.push(...block.lines.map((line) => `- ${renderPromptTemplate(line, params.values)}`));
    rendered.push("");
  }

  return rendered;
}

function renderRoleDefinition(params: {
  title: string;
  definition: SkillRuntimeRoleDefinition | undefined;
  values: Record<string, string | undefined>;
}): string[] {
  if (!params.definition) {
    return [];
  }

  const lines: string[] = [params.title];
  if (params.definition.summary) {
    lines.push(`- 角色说明: ${renderPromptTemplate(params.definition.summary, params.values)}`);
  }
  if (params.definition.responsibilities?.length) {
    lines.push(`- 核心职责: ${params.definition.responsibilities.map((item) => renderPromptTemplate(item, params.values)).join(" / ")}`);
  }
  if (params.definition.permissions?.length) {
    lines.push(`- 能力权限: ${params.definition.permissions.map((item) => renderPromptTemplate(item, params.values)).join(" / ")}`);
  }
  if (params.definition.decision_rules?.length) {
    lines.push(`- 判断原则: ${params.definition.decision_rules.map((item) => renderPromptTemplate(item, params.values)).join(" / ")}`);
  }
  lines.push("");
  return lines;
}

function shouldForceCognitionEnvelopeForDirectEvent(eventType: string): boolean {
  return eventType === "private_message"
    || eventType === "friend_request"
    || eventType === "friend_accepted";
}

export function resolvePromptRoleName(params: {
  roleName?: string;
  snapshot: CognitionSnapshotEntry[];
}): string {
  if (params.roleName?.trim()) {
    return params.roleName;
  }

  const groupStateEntry = params.snapshot.find((entry) => entry.alias === "group_state" && entry.exists);
  const groupState = parseSnapshotJson(groupStateEntry?.content);
  const persistedRoleName = readString(groupState?.my_role);
  if (persistedRoleName) {
    return persistedRoleName;
  }

  return "未知";
}

export function buildSkillEventContext(params: BuildSkillEventContextParams): BuiltSkillEventContext {
  const runtime = load43ChatSkillRuntime(params.cfg);
  const eventProfile = runtime.data.event_profiles[params.eventType]
    ?? runtime.data.event_profiles.system_notice;
  const replyPolicy = resolveSkillReplyPolicy(runtime, params.eventType);
  const cognitionPolicy = resolveSkillCognitionPolicy(runtime, params.eventType);
  const moderationPolicy = resolveSkillModerationPolicy(runtime, params.eventType);

  const docPaths = resolveSkillDocPaths(runtime, eventProfile.docs);
  const targets = resolveSkillStorageTargets(runtime, [...eventProfile.reads, ...eventProfile.writes], {
    group_id: params.groupId,
    user_id: params.userId,
  });
  const readTargets = dedupeAliasedPaths(
    targets.filter((target) => eventProfile.reads.includes(target.alias)),
  );
  const writeTargets = dedupeAliasedPaths(
    targets.filter((target) => eventProfile.writes.includes(target.alias)),
  );
  const modelWriteTargets = writeTargets.filter((target) => !isPluginManagedWriteAlias(target.alias));
  const pluginManagedWriteTargets = writeTargets.filter((target) => isPluginManagedWriteAlias(target.alias));
  const snapshot = readCognitionSnapshot({
    runtime,
    aliases: eventProfile.reads,
    values: {
      group_id: params.groupId,
      user_id: params.userId,
    },
  });
  const promptSnapshot = transformCognitionSnapshotForPrompt(snapshot, {
    eventType: params.eventType,
    groupId: params.groupId,
  });
  const effectiveRoleName = resolvePromptRoleName({
    roleName: params.roleName,
    snapshot,
  });
  const promptValues = {
    account_id: params.accountId,
    event_type: params.eventType,
    effective_role: effectiveRoleName,
    group_id: params.groupId,
    group_name: params.groupName,
    no_reply_token: replyPolicy.no_reply_token,
    reply_policy_mode: replyPolicy.mode,
    sender_name: params.senderName,
    sender_role_name: params.senderRoleName,
    user_id: params.userId,
  };
  const roleDefinition = params.groupId
    ? runtime.data.role_definitions.group[effectiveRoleName]
    : runtime.data.role_definitions.direct[effectiveRoleName];

  const lines = [
    "【43Chat Skill Runtime】",
    `- runtime 来源: ${runtime.source === "file" ? runtime.runtimePath : `builtin (${runtime.runtimePath})`}`,
    `- skill 目录: ${runtime.docsDir}`,
    `- 当前事件: ${params.eventType}`,
    `- 账号: ${params.accountId ?? "default"}`,
    "",
  ];

  if (params.groupId) {
    lines.push("【当前群上下文】");
    lines.push(`- 群组: ${params.groupName ?? params.groupId}（group:${params.groupId}）`);
    lines.push(`- 我的身份: ${effectiveRoleName}`);
    if (params.userId) {
      if (params.eventType === "group_message") {
        lines.push(`- 当前发言者: ${params.senderName ?? params.userId}（user:${params.userId}）`);
        if (params.senderRoleName) {
          lines.push(`- 当前发言者身份: ${params.senderRoleName}`);
        }
      } else {
        lines.push(`- 关联用户: ${params.senderName ?? params.userId}（user:${params.userId}）`);
        if (params.senderRoleName) {
          lines.push(`- 关联用户身份: ${params.senderRoleName}`);
        }
      }
    }
    lines.push("");
  } else if (params.userId) {
    lines.push("【当前私聊上下文】");
    lines.push(`- 对方: ${params.senderName ?? params.userId}（user:${params.userId}）`);
    lines.push("");
  }

  lines.push(...renderRoleDefinition({
    title: "【当前身份说明】",
    definition: roleDefinition,
    values: promptValues,
  }));
  lines.push(...renderPromptBlocks({
    blocks: eventProfile.prompt_blocks,
    effectiveRoleName,
    values: promptValues,
  }));
  lines.push(...renderPromptBlocks({
    blocks: params.extraPromptBlocks,
    effectiveRoleName,
    values: promptValues,
  }));

  if (
    params.groupId
    && (effectiveRoleName === "管理员" || effectiveRoleName === "群主")
    && moderationPolicy.allowed_decision_kinds.length > 0
  ) {
    lines.push("【文档约束的管理梯度】");
    lines.push("- 管理判断不靠插件硬编码；若命中管理场景，必须遵守 runtime 里声明的场景梯度与决策种类");
    lines.push(`- 允许的管理决策种类: ${moderationPolicy.allowed_decision_kinds.join(" / ")}`);
    lines.push("- 当前群聊主流程统一只输出普通文本或 `NO_REPLY`；不要为了记录管理判断输出任何结构化 envelope");
    lines.push(`- 若文档声明当前阶段应公开提醒，就直接给出可发送的公开文本；若文档声明当前阶段不应公开回复，就直接输出 \`${replyPolicy.no_reply_token}\``);
    lines.push("- 管理动作的判断依据仍然来自 runtime 文档；只是最终对外输出不再要求结构化 `decision` 字段");

    Object.entries(moderationPolicy.scenarios)
      .filter(([, scenario]) => scenario.enabled)
      .forEach(([scenarioName, scenario]) => {
        lines.push(`- 场景 ${scenarioName}: 判定依据 ${scenario.match_basis.join(" / ") || "未配置"}`);
        lines.push(`- ${scenarioName}.first_occurrence => ${scenario.steps.first_occurrence.decision} / public_reply=${scenario.steps.first_occurrence.public_reply}`);
        lines.push(`- ${scenarioName}.repeat_occurrence => ${scenario.steps.repeat_occurrence.decision} / public_reply=${scenario.steps.repeat_occurrence.public_reply}`);
        lines.push(`- ${scenarioName}.after_warning_repeat => ${scenario.steps.after_warning_repeat.decision} / public_reply=${scenario.steps.after_warning_repeat.public_reply}`);
        const promptLines = [
          ...scenario.steps.first_occurrence.prompt_lines,
          ...scenario.steps.repeat_occurrence.prompt_lines,
          ...scenario.steps.after_warning_repeat.prompt_lines,
        ];
        if (promptLines.length > 0) {
          lines.push(`- ${scenarioName} 处理提示: ${promptLines.join(" / ")}`);
        }
      });
    lines.push("");
  }

  lines.push(...formatPaths("【先阅读这些 Skill 文档】", docPaths));
  lines.push(...formatCognitionSnapshot(promptSnapshot));

  if (readTargets.length > 0 || modelWriteTargets.length > 0 || pluginManagedWriteTargets.length > 0) {
    lines.push("【工具使用要求】");
    lines.push(`- 43Chat 认知文件根目录: \`${COGNITION_STORAGE_ROOT}\``);
    lines.push("- 下列 `groups/...` / `profiles/...` 是存储别名；真正读写时优先使用后面的 absolute 绝对路径");
    lines.push("- 如果当前会话工具列表里没有 `chat43_read_json` / `chat43_write_json` / `chat43_append_jsonl`，就直接用当前可见的 `read` / `edit` / `write` 访问这些 absolute 路径");
    lines.push("- 更新 `.json` 时先读取当前文件，保留既有 schema 和未改动字段；优先用 `edit` 精准修改，必要时再用 `write` 覆盖完整 JSON");
    lines.push("- 不允许跳过初始化直接回复");
    if (pluginManagedWriteTargets.length > 0) {
      lines.push(`- ${pluginManagedWriteTargets.map((entry) => entry.alias).join(" / ")} 由插件在决策后自动维护；除非你要补齐缺失结构，否则不要求你手动写这些运行态文件`);
    }
    if (params.eventType === "group_invitation") {
      lines.push("- 审核入群申请时调用 `chat43_handle_group_join_request`，不要只回复文本");
    }
    lines.push("");
  }
  lines.push(...formatAliasedToolCalls("【先读取这些认知文件】", readTargets));
  if (shouldForceCognitionEnvelopeForDirectEvent(params.eventType)) {
    lines.push(...formatAliasedToolCalls("【本轮需要你显式维护的长期认知文件】", modelWriteTargets.filter((entry) => !entry.path.endsWith(".jsonl"))));
  } else if (modelWriteTargets.length > 0) {
    lines.push(...formatAliasedToolCalls("【这些长期认知文件由后台 worker 异步补写】", modelWriteTargets.filter((entry) => !entry.path.endsWith(".jsonl"))));
  }
  lines.push(...formatAliasedToolCalls("【这些运行态文件由插件自动维护】", pluginManagedWriteTargets));

  lines.push("【回复策略】");
  lines.push(`- reply_policy.mode = ${replyPolicy.mode}`);
  lines.push(`- 不回复时必须只输出: \`${replyPolicy.no_reply_token}\``);
  const recentReplyWindow = replyPolicy.plugin_enforced.recent_reply_window ?? 0;
  const maxRecentReplies = replyPolicy.plugin_enforced.max_recent_replies ?? 0;
  const mustReplyGuidance = replyPolicy.model_guidance.must_reply ?? [];
  const shouldReplyGuidance = replyPolicy.model_guidance.should_reply ?? [];
  const noReplyGuidance = replyPolicy.model_guidance.no_reply_when ?? [];

  if (recentReplyWindow > 0 && maxRecentReplies > 0) {
    lines.push(
      `- 回复节奏参考: 最近 ${recentReplyWindow} 条决策里若已回复 >= ${maxRecentReplies} 条，则当前不是明确提问时优先考虑沉默`,
    );
  }
  if (mustReplyGuidance.length > 0) {
    lines.push(`- 必回信号: ${mustReplyGuidance.join(" / ")}`);
  }
  if (shouldReplyGuidance.length > 0) {
    lines.push(`- 倾向回复: ${shouldReplyGuidance.join(" / ")}`);
  }
  if (noReplyGuidance.length > 0) {
    lines.push(`- 倾向沉默: ${noReplyGuidance.join(" / ")}`);
  }
  lines.push("");

  lines.push("【认知写入策略】");
  lines.push(`- topic_persistence.group_soul = ${cognitionPolicy.topic_persistence.group_soul}`);
  lines.push(`- topic_persistence.group_state = ${cognitionPolicy.topic_persistence.group_state}`);
  lines.push(`- topic_persistence.decision_log = ${cognitionPolicy.topic_persistence.decision_log}`);
  lines.push("");
  lines.push("【认知写入执行要求】");
  if (shouldForceCognitionEnvelopeForDirectEvent(params.eventType)) {
    lines.push("- 插件不会根据关键词、正则或 topic 摘要替你写长期认知；是否写入由你依据 Skill 文档和下列规则自行判断");
    lines.push("- 私聊长期认知仍由当前主流程显式维护；`dialog_state` / `user_profile` 需要你结合当前消息与上下文写入");
    lines.push(`- 认知写入不是可选优化；如果当前消息已经提供可复用的稳定结论，本轮必须先写入对应 JSON，再回复或输出 \`${replyPolicy.no_reply_token}\``);
    lines.push("- 主流程没有额外的认知补写回合；本轮要写的长期认知，必须在这一次最终输出里和回复决策一起完成");
    lines.push("- 私聊与好友事件的最终输出也统一使用 `<chat43-cognition>{\"writes\":[...],\"reply\":\"...\"}</chat43-cognition>`；不要输出裸文本、不要只输出 `<final>...</final>`");
    lines.push(`- 即使本轮没有新增长期认知，也要输出 envelope；此时可写成 \`<chat43-cognition>{\"writes\":[],\"reply\":\"...\"}</chat43-cognition>\`，插件会只对外发送 \`reply\``);
    lines.push(`- 如果本轮不回复，也要输出 envelope，且 \`reply\` 必须写为 \`${replyPolicy.no_reply_token}\``);
    lines.push("- 但私聊一旦出现偏好、自我定义、关系定位、持续话题、后续约定等长期信号，就不允许继续用 `writes: []`；至少补 `dialog_state`，命中稳定人物信号时再补 `user_profile`");
  } else {
    lines.push("- 群聊长期认知默认改由后台 cognition worker 异步维护：它会读取本地模型配置、按批次归并消息，再写回 `group_soul` / `user_profile` / `group_members_graph`");
    lines.push("- 因此普通群聊主流程本轮只负责回复判断与公开回复；不要为了补长期认知而输出任何结构化 envelope");
    lines.push("- 群聊主流程不要调用 `edit` / `write` 直接改写 `group_soul` / `user_profile` / `group_members_graph`；新增观察交给后台 worker 归并落库");
    lines.push(`- 如果当前消息不需要公开回复，直接输出 \`${replyPolicy.no_reply_token}\`；如果需要公开回复，直接输出普通文本`);
    lines.push("- 如果上下文里出现结构化 envelope、`read` / `edit` / `write` 工具轨迹，或 `⚠️ 📝 Edit...failed` 之类内部内容，当前群聊主流程必须忽略，不能模仿、不能复述、不能继续输出");
    lines.push("- 最终答案只允许是可发送的普通文本，或精确的 `NO_REPLY`；不能输出 XML/JSON 包裹、不能输出 `writes` 字段、不能输出工具失败提示");
    lines.push("- 即使当前认知文件仍为空，也不要把群聊主流程改成补文档回合；后台 worker 会继续补写长期认知");
    lines.push("- 当前主流程可以参考已有认知文件做判断，但不要承担 `group_soul` / `user_profile` / `group_members_graph` 的补写任务");
    lines.push("- 本轮观察与管理决策仍会进入 `decision_log`；后台 batch 会依据文档把稳定结论沉淀进长期认知");
  }
  if (shouldForceCognitionEnvelopeForDirectEvent(params.eventType)) {
    lines.push("- `always` 表示一旦你判断该信息属于长期认知，就应考虑写入该位置");
    lines.push("- `filtered` 表示只有明确满足长期沉淀条件时才写入该位置");
    lines.push("- `never` 表示本轮不要把这类信息写入该位置");
    if (
      cognitionPolicy.write_enforcement.enabled
      && cognitionPolicy.write_enforcement.block_final_reply_when_incomplete
    ) {
      lines.push("- 插件执行守卫已启用：如果你输出最终回复时，文档要求的关键认知槽位仍为空，最终回复会被拦截并要求重试");
    }
    if (cognitionPolicy.topic_persistence.judgement_rules.length > 0) {
      lines.push(`- 长期认知判断规则: ${cognitionPolicy.topic_persistence.judgement_rules.join(" / ")}`);
    }
    if (cognitionPolicy.topic_persistence.volatile_terms.length > 0) {
      lines.push(`- 长期认知禁入词样例: ${cognitionPolicy.topic_persistence.volatile_terms.join(" / ")}`);
    }
    if (cognitionPolicy.topic_persistence.volatile_regexes.length > 0) {
      lines.push(`- 长期认知禁入模式样例: ${cognitionPolicy.topic_persistence.volatile_regexes.join(" / ")}`);
    }
  }
  lines.push("");

  lines.push("【推理要求】");
  lines.push(`- <think> 至少包含: ${eventProfile.required_think_fields.join(" / ")}`);
  lines.push("- <think> 仅用于内部推理，不发送到 43Chat");
  lines.push("- 先基于 Skill 文档和认知文件做决策，再决定是否回复");
  if (eventProfile.reply_mode === "suppress_text_reply") {
    lines.push("- 本事件默认不发送普通文本回复；优先执行工具动作与认知更新");
  } else {
    lines.push(`- 如果本轮不该回复，输出 \`${replyPolicy.no_reply_token}\``);
  }

  return {
    prompt: lines.join("\n"),
    replyMode: eventProfile.reply_mode,
  };
}

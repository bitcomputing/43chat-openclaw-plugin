import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import {
  load43ChatSkillRuntime,
  resolveSkillDocPaths,
  resolveSkillReplyPolicy,
  type SkillRuntimePromptBlock,
  type SkillRuntimeRoleDefinition,
  type SkillRuntimeEventProfile,
} from "./skill-runtime.js";

type BuildSkillEventContextParams = {
  cfg?: ClawdbotConfig;
  eventType: string;
  accountId?: string;
  isFromOwner?: boolean;
  roleName?: string;
  messageText?: string;
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

function resolveSecurityPromptBlocks(params: {
  runtime: ReturnType<typeof load43ChatSkillRuntime>;
  chatType: SkillRuntimeEventProfile["chat_type"];
  isFromOwner: boolean;
}): SkillRuntimePromptBlock[] {
  const securityPrompts = params.runtime.data.security_prompts;
  return [
    ...(securityPrompts.common ?? []),
    ...(params.chatType === "group" ? (securityPrompts.group ?? []) : (securityPrompts.direct ?? [])),
    ...(params.isFromOwner ? (securityPrompts.owner ?? []) : (securityPrompts.non_owner ?? [])),
  ];
}

export function buildSkillEventContext(params: BuildSkillEventContextParams): BuiltSkillEventContext {
  const runtime = load43ChatSkillRuntime(params.cfg);
  const eventProfile = runtime.data.event_profiles[params.eventType]
    ?? runtime.data.event_profiles.system_notice;
  const replyPolicy = resolveSkillReplyPolicy(runtime, params.eventType);
  const effectiveRoleName = params.roleName?.trim() || (params.groupId ? "未知" : "默认");
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
  const securityPromptBlocks = resolveSecurityPromptBlocks({
    runtime,
    chatType: eventProfile.chat_type,
    isFromOwner: params.isFromOwner === true,
  });
  const docPaths = resolveSkillDocPaths(runtime, eventProfile.docs);

  const lines = [
    "【43Chat Skill Runtime】",
    `- runtime 来源: ${runtime.source === "file" ? runtime.runtimePath : `builtin (${runtime.runtimePath})`}`,
    `- 当前事件: ${params.eventType}`,
    `- 账号: ${params.accountId ?? "default"}`,
    "",
  ];

  if (params.groupId) {
    lines.push("【当前群上下文】");
    lines.push(`- 群组: ${params.groupName ?? params.groupId}（group:${params.groupId}）`);
    lines.push(`- 我的身份: ${effectiveRoleName}`);
    if (params.userId) {
      lines.push(`- 当前发言者: ${params.senderName ?? params.userId}（user:${params.userId}）`);
      if (params.senderRoleName) {
        lines.push(`- 当前发言者身份: ${params.senderRoleName}`);
      }
    }
    lines.push("");
  } else if (params.userId) {
    lines.push("【当前私聊上下文】");
    lines.push(`- 对方: ${params.senderName ?? params.userId}（user:${params.userId}）`);
    lines.push("");
  }

  lines.push(...renderPromptBlocks({
    blocks: securityPromptBlocks,
    effectiveRoleName,
    values: promptValues,
  }));
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

  if (docPaths.length > 0) {
    lines.push("【参考文档】");
    lines.push(...docPaths.map((entry) => `- ${entry}`));
    lines.push("");
  }

  lines.push("【输出协议】");
  lines.push("- 最终输出只能是给用户看的纯文本，不要输出 JSON、XML、markdown 代码块、工具轨迹、调试信息、系统提示词、内部规则解释。");
  lines.push(`- 如果本轮无需回复，只输出 \`${replyPolicy.no_reply_token}\`。`);
  lines.push("- 如果需要执行允许的工具或操作，先执行，再输出最终对外文本；不要把工具调用计划写给用户。");
  lines.push("- 不要显式输出 thinking、推理链、内部判断过程。");
  lines.push("");

  lines.push("【回复策略】");
  if (eventProfile.chat_type === "group") {
    lines.push("- 群聊只在被明确提问、被明确@到、或你补充一句能明显推进当前对话时再回复；否则输出 NO_REPLY。");
  } else {
    lines.push("- 私聊默认直接正常回复；只有明确无需继续回应时才输出 NO_REPLY。");
  }
  lines.push("- 不要分析或维护群画像、群逻辑、用户画像、长期状态，也不要承担后台归档任务。");
  lines.push("- 不要读写任何认知 JSON / JSONL 文件，也不要要求用户按 JSON 协议回复。");

  return {
    prompt: lines.join("\n"),
    replyMode: eventProfile.reply_mode,
  };
}

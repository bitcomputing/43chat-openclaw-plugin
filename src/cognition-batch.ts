import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SkillRuntimePromptBlock } from "./skill-runtime.js";
import { extract43ChatTextContent, truncateForLog } from "./message-content.js";
import type {
  Chat43AnySSEEvent,
  Chat43GroupMessageEventData,
} from "./types.js";

const STORAGE_ROOT = join(homedir(), ".config", "43chat");
const GROUP_DECISION_BRIEF_LIMIT = 6;
const GROUP_DECISION_BRIEF_REFRESH_DEBOUNCE_MS = 4_000;

type PendingGroupDecisionBrief = {
  count: number;
  latestMessageId: string;
  latestAt: number;
  speakers: Map<string, string>;
};

type GroupDecisionBriefEntry = {
  ts: string;
  message_id: string;
  user_id: string;
  nickname: string;
  decision: string;
  moderation_decision: string;
  summary: string;
};

type GroupDecisionBrief = {
  schema_version: "1.0";
  scope: "group";
  group_id: string;
  group_name: string;
  updated_at: string;
  recent_decisions: GroupDecisionBriefEntry[];
  pending_batch: {
    count: number;
    latest_message_id: string;
    latest_at: string;
    speakers: Array<{ user_id: string; nickname: string }>;
  } | null;
};

const pendingGroupDecisionBriefs = new Map<string, PendingGroupDecisionBrief>();
const pendingGroupDecisionBriefTimers = new Map<string, ReturnType<typeof setTimeout>>();

function resolveGroupDecisionLogPath(groupId: string, baseDir: string): string {
  return join(baseDir, "groups", groupId, "decision_log.jsonl");
}

function resolveGroupDecisionBriefPath(groupId: string, baseDir: string): string {
  return join(baseDir, "groups", groupId, "decision_brief.json");
}

function readRecentJsonlRecords(pathValue: string, limit: number): Record<string, unknown>[] {
  if (!existsSync(pathValue)) {
    return [];
  }
  try {
    const raw = readFileSync(pathValue, "utf8").trim();
    if (!raw) {
      return [];
    }
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          const parsed = JSON.parse(line) as unknown;
          return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  } catch {
    return [];
  }
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function buildGroupDecisionBriefEntry(entry: Record<string, unknown>): GroupDecisionBriefEntry | null {
  const messageId = readString(entry.message_id);
  const nickname = readString(entry.nickname);
  const currentMessage = readString(entry.current_message);
  const decision = readString(entry.decision);
  if (!messageId || !decision) {
    return null;
  }
  return {
    ts: readString(entry.ts),
    message_id: messageId,
    user_id: readString(entry.user_id),
    nickname: nickname || readString(entry.user_id) || "unknown",
    decision,
    moderation_decision: readString(entry.moderation_decision),
    summary: truncateForLog(currentMessage, 72),
  };
}

function buildGroupDecisionBrief(params: {
  groupId: string;
  groupName: string;
  baseDir: string;
  pendingBatch?: PendingGroupDecisionBrief | null;
}): GroupDecisionBrief {
  const recentEntries = readRecentJsonlRecords(
    resolveGroupDecisionLogPath(params.groupId, params.baseDir),
    GROUP_DECISION_BRIEF_LIMIT,
  )
    .map(buildGroupDecisionBriefEntry)
    .filter((entry): entry is GroupDecisionBriefEntry => Boolean(entry));

  const pending = Object.prototype.hasOwnProperty.call(params, "pendingBatch")
    ? params.pendingBatch ?? null
    : pendingGroupDecisionBriefs.get(params.groupId) ?? null;
  return {
    schema_version: "1.0",
    scope: "group",
    group_id: params.groupId,
    group_name: params.groupName,
    updated_at: new Date().toISOString(),
    recent_decisions: recentEntries,
    pending_batch: pending
      ? {
        count: pending.count,
        latest_message_id: pending.latestMessageId,
        latest_at: new Date(pending.latestAt).toISOString(),
        speakers: Array.from(pending.speakers.entries()).map(([userId, nickname]) => ({
          user_id: userId,
          nickname,
        })),
      }
      : null,
  };
}

function flushGroupDecisionBrief(params: {
  groupId: string;
  groupName: string;
  baseDir?: string;
  log?: (message: string) => void;
  error?: (message: string) => void;
}): void {
  const baseDir = params.baseDir ?? STORAGE_ROOT;
  const pathValue = resolveGroupDecisionBriefPath(params.groupId, baseDir);
  try {
    mkdirSync(dirname(pathValue), { recursive: true });
    writeFileSync(
      pathValue,
      `${JSON.stringify(buildGroupDecisionBrief({
        groupId: params.groupId,
        groupName: params.groupName,
        baseDir,
        pendingBatch: null,
      }), null, 2)}\n`,
      "utf8",
    );
    pendingGroupDecisionBriefs.delete(params.groupId);
    params.log?.(`43chat: refreshed decision brief groups/${params.groupId}/decision_brief.json`);
  } catch (cause) {
    params.error?.(`43chat: failed to refresh decision brief for group ${params.groupId}: ${String(cause)}`);
  } finally {
    const timer = pendingGroupDecisionBriefTimers.get(params.groupId);
    if (timer) {
      clearTimeout(timer);
      pendingGroupDecisionBriefTimers.delete(params.groupId);
    }
  }
}

export function scheduleDecisionBriefRefresh(params: {
  event: Chat43AnySSEEvent;
  log?: (message: string) => void;
  error?: (message: string) => void;
  baseDir?: string;
}): void {
  if (params.event.event_type !== "group_message") {
    return;
  }

  const data = params.event.data as Chat43GroupMessageEventData;
  const groupId = String(data.group_id);
  const current = pendingGroupDecisionBriefs.get(groupId) ?? {
    count: 0,
    latestMessageId: "",
    latestAt: 0,
    speakers: new Map<string, string>(),
  };
  current.count += 1;
  current.latestMessageId = String(data.message_id || current.latestMessageId);
  current.latestAt = data.timestamp || params.event.timestamp || Date.now();
  current.speakers.set(String(data.from_user_id), data.from_nickname || String(data.from_user_id));
  pendingGroupDecisionBriefs.set(groupId, current);

  const existingTimer = pendingGroupDecisionBriefTimers.get(groupId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }
  const timer = setTimeout(() => {
    flushGroupDecisionBrief({
      groupId,
      groupName: data.group_name || `群${groupId}`,
      baseDir: params.baseDir,
      log: params.log,
      error: params.error,
    });
  }, GROUP_DECISION_BRIEF_REFRESH_DEBOUNCE_MS);
  pendingGroupDecisionBriefTimers.set(groupId, timer);
}

export function buildDecisionBriefPromptBlocks(params: {
  event: Chat43AnySSEEvent;
  baseDir?: string;
}): SkillRuntimePromptBlock[] {
  if (params.event.event_type !== "group_message") {
    return [];
  }

  const data = params.event.data as Chat43GroupMessageEventData;
  const baseDir = params.baseDir ?? STORAGE_ROOT;
  const pathValue = resolveGroupDecisionBriefPath(String(data.group_id), baseDir);
  if (!existsSync(pathValue)) {
    return [];
  }

  try {
    const content = JSON.parse(readFileSync(pathValue, "utf8")) as GroupDecisionBrief;
    if (!Array.isArray(content.recent_decisions) || content.recent_decisions.length === 0) {
      return [];
    }

    const lines = [
      "下面是插件基于最近 decision_log 压缩出的轻量摘要，只作为当前轮的弱参考，不要把它当成新的群聊消息继续回复。",
      ...content.recent_decisions.map((entry, index) => {
        const moderation = entry.moderation_decision ? ` / moderation=${entry.moderation_decision}` : "";
        return `最近决策 #${index + 1}: ${entry.nickname} -> ${entry.summary} / decision=${entry.decision}${moderation}`;
      }),
    ];
    if (content.pending_batch && content.pending_batch.count > 0) {
      lines.push(
        `后台认知批次中: ${content.pending_batch.count} 条新消息待归并，最新消息=${content.pending_batch.latest_message_id}`,
      );
    }

    return [{
      title: "最近决策摘要",
      lines,
    }];
  } catch {
    return [];
  }
}

export function buildQueuedDecisionBriefFromMessage(params: {
  groupId: string;
  groupName: string;
  messageId: string;
  userId: string;
  nickname: string;
  messageText: string;
  decision: string;
  moderationDecision?: string;
}): GroupDecisionBrief {
  return {
    schema_version: "1.0",
    scope: "group",
    group_id: params.groupId,
    group_name: params.groupName,
    updated_at: new Date().toISOString(),
    recent_decisions: [{
      ts: new Date().toISOString(),
      message_id: params.messageId,
      user_id: params.userId,
      nickname: params.nickname,
      decision: params.decision,
      moderation_decision: params.moderationDecision ?? "",
      summary: truncateForLog(extract43ChatTextContent(params.messageText), 72),
    }],
    pending_batch: null,
  };
}

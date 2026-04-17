import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { readRecentJsonlRecords } from "./jsonl-store.js";
import { extract43ChatTextContent, looksQuestionLike } from "./message-content.js";
import {
  load43ChatSkillRuntime,
  resolveSkillReplyPolicy,
  resolveSkillStorageTargets,
} from "./skill-runtime.js";
import type { Chat43AnySSEEvent, Chat43GroupMessageEventData } from "./types.js";

const STORAGE_ROOT = join(homedir(), ".config", "43chat");

export type ReplyPolicyEvaluation = {
  noReplyToken: string;
  forceNoReply: boolean;
  reason?: string;
  recentDecisionWindow: number;
  recentReplyCount: number;
  questionLike: boolean;
};

function resolveFullPath(relativePath: string, baseDir: string): string | null {
  const fullPath = join(baseDir, normalize(relativePath));
  if (!fullPath.startsWith(baseDir)) {
    return null;
  }
  return fullPath;
}

function loadRecentReplyCount(params: {
  cfg?: ClawdbotConfig;
  event: Chat43AnySSEEvent;
  recentDecisionWindow: number;
  baseDir?: string;
}): number {
  if (params.event.event_type !== "group_message" || params.recentDecisionWindow <= 0) {
    return 0;
  }

  const runtime = load43ChatSkillRuntime(params.cfg);
  const groupId = String((params.event.data as Chat43GroupMessageEventData).group_id);
  const [target] = resolveSkillStorageTargets(runtime, ["group_decision_log"], { group_id: groupId });
  if (!target) {
    return 0;
  }

  const fullPath = resolveFullPath(target.path, params.baseDir ?? STORAGE_ROOT);
  if (!fullPath || !existsSync(fullPath)) {
    return 0;
  }

  try {
    return readRecentJsonlRecords(fullPath, params.recentDecisionWindow).reduce((count, entry) => {
      return entry.decision === "reply_sent" ? count + 1 : count;
    }, 0);
  } catch {
    return 0;
  }
}

export function evaluateReplyPolicy(params: {
  cfg?: ClawdbotConfig;
  event: Chat43AnySSEEvent;
  baseDir?: string;
}): ReplyPolicyEvaluation {
  const runtime = load43ChatSkillRuntime(params.cfg);
  const replyPolicy = resolveSkillReplyPolicy(runtime, params.event.event_type);
  const noReplyToken = replyPolicy.no_reply_token;

  if (params.event.event_type !== "group_message") {
    return {
      noReplyToken,
      forceNoReply: false,
      recentDecisionWindow: 0,
      recentReplyCount: 0,
      questionLike: false,
    };
  }

  const data = params.event.data as Chat43GroupMessageEventData;
  const questionLike = looksQuestionLike(extract43ChatTextContent(data.content));
  const recentDecisionWindow = replyPolicy.plugin_enforced.recent_reply_window ?? 0;
  const recentReplyCount = loadRecentReplyCount({
    cfg: params.cfg,
    event: params.event,
    recentDecisionWindow,
    baseDir: params.baseDir,
  });

  return {
    noReplyToken,
    forceNoReply: false,
    recentDecisionWindow,
    recentReplyCount,
    questionLike,
  };
}

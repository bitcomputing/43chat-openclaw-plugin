import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize, sep } from "node:path";
import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import {
  extract43ChatTextContent,
  inferMessageTopicSummary,
  looksQuestionLike,
  truncateForLog,
} from "./message-content.js";
import {
  load43ChatSkillRuntime,
  resolveSkillCognitionPolicy,
  resolveSkillBootstrapDefaults,
  resolveSkillStorageTargets,
} from "./skill-runtime.js";
import type {
  Chat43AnySSEEvent,
  Chat43FriendAcceptedEventData,
  Chat43FriendRequestEventData,
  Chat43GroupInvitationEventData,
  Chat43GroupMemberJoinedEventData,
  Chat43GroupMessageEventData,
  Chat43PrivateMessageEventData,
} from "./types.js";

const STORAGE_ROOT = join(homedir(), ".config", "43chat");

type BootstrapContext = {
  eventType: string;
  values: Record<string, string | undefined>;
};

export type BootstrapResult = {
  created: string[];
  updated: string[];
  skipped: string[];
};

export type CognitionMutationResult = {
  updated: string[];
  appended: string[];
  skipped: string[];
};

export type CognitionWriteRequirementIssue = {
  alias: "group_soul" | "user_profile" | "group_members_graph" | "dialog_state";
  path: string;
  summary: string;
};

export type GroupMessageCognitionWriteRequirements = {
  enabled: boolean;
  blockFinalReplyWhenIncomplete: boolean;
  maxRetryAttempts: number;
  retryPromptLines: string[];
  issues: CognitionWriteRequirementIssue[];
};

function mapGroupRoleName(roleValue?: number, roleNameValue?: string): string {
  const normalizedRoleName = roleNameValue?.trim();
  if (roleValue === 2 || normalizedRoleName === "owner") {
    return "群主";
  }
  if (roleValue === 1 || normalizedRoleName === "admin") {
    return "管理员";
  }
  return "成员";
}

function buildTimeVars(timestamp: number | undefined): Record<string, string> {
  const date = new Date(timestamp ?? Date.now());
  const iso = date.toISOString();
  return {
    event_iso_time: iso,
    event_date: iso.slice(0, 10),
  };
}

function resolveUserProfileIsFriendFact(eventType: Chat43AnySSEEvent["event_type"]): boolean | undefined {
  switch (eventType) {
    case "private_message":
    case "friend_accepted":
      return true;
    case "friend_request":
      return false;
    default:
      return undefined;
  }
}

function buildBootstrapContext(event: Chat43AnySSEEvent): BootstrapContext | null {
  switch (event.event_type) {
    case "private_message": {
      const data = event.data as Chat43PrivateMessageEventData;
      const userId = String(data.from_user_id);
      return {
        eventType: event.event_type,
        values: {
          ...buildTimeVars(data.timestamp || event.timestamp),
          user_id: userId,
          sender_name: data.from_nickname || userId,
        },
      };
    }
    case "group_message": {
      const data = event.data as Chat43GroupMessageEventData;
      const userId = String(data.from_user_id);
      return {
        eventType: event.event_type,
        values: {
          ...buildTimeVars(data.timestamp || event.timestamp),
          group_id: String(data.group_id),
          group_name: data.group_name || `群${data.group_id}`,
          user_id: userId,
          sender_name: data.from_nickname || userId,
          sender_group_role: mapGroupRoleName(
            data.from_user_role ?? data.user_role,
            data.from_user_role_name ?? data.user_role_name,
          ),
        },
      };
    }
    case "friend_request": {
      const data = event.data as Chat43FriendRequestEventData;
      const userId = String(data.from_user_id);
      return {
        eventType: event.event_type,
        values: {
          ...buildTimeVars(data.timestamp || event.timestamp),
          user_id: userId,
          sender_name: data.from_nickname || userId,
        },
      };
    }
    case "friend_accepted": {
      const data = event.data as Chat43FriendAcceptedEventData;
      const userId = String(data.from_user_id);
      return {
        eventType: event.event_type,
        values: {
          ...buildTimeVars(data.timestamp || event.timestamp),
          user_id: userId,
          sender_name: data.from_nickname || userId,
        },
      };
    }
    case "group_invitation": {
      const data = event.data as Chat43GroupInvitationEventData;
      const userId = String(data.inviter_id);
      return {
        eventType: event.event_type,
        values: {
          ...buildTimeVars(data.timestamp || event.timestamp),
          group_id: String(data.group_id),
          group_name: data.group_name || `群${data.group_id}`,
          user_id: userId,
          sender_name: data.inviter_name || userId,
          sender_group_role: "成员",
        },
      };
    }
    case "group_member_joined": {
      const data = event.data as Chat43GroupMemberJoinedEventData;
      const userId = String(data.user_id);
      return {
        eventType: event.event_type,
        values: {
          ...buildTimeVars(data.timestamp || event.timestamp),
          group_id: String(data.group_id),
          group_name: data.group_name || `群${data.group_id}`,
          user_id: userId,
          sender_name: data.nickname || userId,
          sender_group_role: "成员",
        },
      };
    }
    default:
      return null;
  }
}

function resolveFullPath(relativePath: string, baseDir: string): string | null {
  const fullPath = join(baseDir, normalize(relativePath));
  if (!fullPath.startsWith(baseDir)) {
    return null;
  }
  return fullPath;
}

function readJsonObject(fullPath: string): Record<string, unknown> | null {
  try {
    const content = JSON.parse(readFileSync(fullPath, "utf8")) as unknown;
    return isPlainObject(content) ? content : null;
  } catch {
    return null;
  }
}

function writeJsonObject(fullPath: string, content: Record<string, unknown>): void {
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${JSON.stringify(content, null, 2)}\n`, "utf8");
}

function appendJsonl(fullPath: string, content: Record<string, unknown>): void {
  mkdirSync(dirname(fullPath), { recursive: true });
  appendFileSync(fullPath, `${JSON.stringify(content)}\n`, "utf8");
}

function countJsonlEntries(fullPath: string): number {
  try {
    const content = readFileSync(fullPath, "utf8");
    if (!content.trim()) {
      return 0;
    }
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .length;
  } catch {
    return 0;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .map((entry) => readString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return items.length > 0 ? items : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function parseTimestamp(value: unknown): number | undefined {
  const raw = readString(value);
  if (!raw) {
    return undefined;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const SEMANTIC_UPDATE_TIMESTAMP_TOLERANCE_MS = 1000;

function isTimestampMeaningfullyAfter(left: number | undefined, right: number | undefined): boolean {
  if (typeof left !== "number") {
    return false;
  }
  if (typeof right !== "number") {
    return true;
  }
  return left > (right + SEMANTIC_UPDATE_TIMESTAMP_TOLERANCE_MS);
}

const VALID_INFLUENCE_LEVELS = new Set(["low", "medium", "high"]);
const VALID_MEMBER_BEHAVIOR_ROLES = new Set([
  "opinion_leader",
  "contributor",
  "active",
  "newcomer",
  "silent",
  "risk",
]);

function normalizeDelimitedText(value: unknown): string {
  const segments = String(value ?? "")
    .split("；")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return Array.from(new Set(segments)).join("；");
}

function unionStringArrays(...values: unknown[]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    for (const item of readStringArray(value) ?? []) {
      if (seen.has(item)) {
        continue;
      }
      seen.add(item);
      merged.push(item);
    }
  }
  return merged;
}

function isGroupSoulUnfilled(content: Record<string, unknown> | null): boolean {
  const soul = isPlainObject(content?.soul) ? content.soul : {};
  return !readString(soul.purpose)
    && (readStringArray(soul.topics)?.length ?? 0) === 0
    && !readString(soul.boundaries)
    && !readString(soul.expectations);
}

function isUserProfileUnfilled(content: Record<string, unknown> | null): boolean {
  return (readStringArray(content?.tags)?.length ?? 0) === 0
    && (readStringArray(content?.expertise)?.length ?? 0) === 0
    && !readString(content?.personality)
    && !normalizeInfluenceLevel(content?.influence_level)
    && !readString(content?.notes);
}

function isMemberGraphEntryUnfilled(content: Record<string, unknown> | null): boolean {
  return !normalizeMemberBehaviorRole(content?.role)
    && (readStringArray(content?.in_group_tags)?.length ?? 0) === 0
    && !readString(content?.strategy);
}

function isDialogStateUnfilled(content: Record<string, unknown> | null): boolean {
  return (readStringArray(content?.current_topics)?.length ?? 0) === 0
    && (readStringArray(content?.pending_actions)?.length ?? 0) === 0
    && !readString(content?.rapport_summary);
}

function detectDirectCognitionSignals(text: string): {
  shouldUpdateDialogState: boolean;
  shouldUpdateUserProfile: boolean;
  dialogReasons: string[];
  profileReasons: string[];
} {
  const normalized = text.trim();
  if (!normalized) {
    return {
      shouldUpdateDialogState: false,
      shouldUpdateUserProfile: false,
      dialogReasons: [],
      profileReasons: [],
    };
  }

  const hasPreferenceSignal = /(喜欢|不喜欢|讨厌|更喜欢|偏向|偏爱|有兴趣|想去|想要|想学|想看|想聊|计划|打算|准备|希望|习惯|平时会|通常会)/u
    .test(normalized);
  const hasSelfDefinitionSignal = /(?:^|[，。；！？?\s])我(?:是|就是|其实是|算是|平时|一般|通常|一直|比较|更|偏|习惯|喜欢|不喜欢|讨厌|想|想要|打算|准备|计划)/u
    .test(normalized);
  const hasRelationshipSignal = /(你就是|你是一个|按你自己的节奏|你自己的节奏|独立的个体|不用谢我|我不对你管理|我不会管你|我把你当|我信任你|别有压力)/u
    .test(normalized);
  const hasOngoingTopicSignal = /(下次|回来|到时候|以后|之后|再聊|再说|上次|刚才|还是|继续)/u.test(normalized)
    && Boolean(inferMessageTopicSummary(normalized));

  const dialogReasons: string[] = [];
  const profileReasons: string[] = [];
  if (hasPreferenceSignal) {
    dialogReasons.push("偏好");
    profileReasons.push("偏好");
  }
  if (hasSelfDefinitionSignal) {
    dialogReasons.push("自我定义");
    profileReasons.push("自我定义");
  }
  if (hasRelationshipSignal) {
    dialogReasons.push("关系定位");
    profileReasons.push("关系定位");
  }
  if (hasOngoingTopicSignal) {
    dialogReasons.push("持续话题");
  }

  return {
    shouldUpdateDialogState: dialogReasons.length > 0,
    shouldUpdateUserProfile: profileReasons.length > 0,
    dialogReasons,
    profileReasons,
  };
}

function normalizeInfluenceLevel(value: unknown): string | undefined {
  const normalized = readString(value);
  if (!normalized || !VALID_INFLUENCE_LEVELS.has(normalized)) {
    return undefined;
  }
  return normalized;
}

function normalizeMemberBehaviorRole(value: unknown): string | undefined {
  const normalized = readString(value);
  if (!normalized) {
    return undefined;
  }
  if (VALID_MEMBER_BEHAVIOR_ROLES.has(normalized)) {
    return normalized;
  }
  return undefined;
}

function mergeUniqueStrings(existing: unknown, incoming: string[], limit = 8): string[] {
  const merged = readStringArray(existing) ?? [];
  for (const item of incoming) {
    if (!item || merged.includes(item)) {
      continue;
    }
    merged.push(item);
    if (merged.length >= limit) {
      break;
    }
  }
  return merged;
}

function appendUniqueNote(existing: unknown, note?: string): string {
  const existingNotes = normalizeDelimitedText(existing)
    .split("；")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const incomingNotes = normalizeDelimitedText(note)
    .split("；")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (incomingNotes.length === 0) {
    return existingNotes.join("；");
  }
  for (const incoming of incomingNotes) {
    if (!existingNotes.includes(incoming)) {
      existingNotes.push(incoming);
    }
  }
  return existingNotes.join("；");
}

function normalizeUserProfile(
  defaultContent: Record<string, unknown>,
  currentContent: Record<string, unknown>,
): Record<string, unknown> {
  const defaultStats = isPlainObject(defaultContent.interaction_stats) ? defaultContent.interaction_stats : {};
  const currentStats = isPlainObject(currentContent.interaction_stats) ? currentContent.interaction_stats : {};
  const notesValue = Array.isArray(currentContent.notes)
    ? currentContent.notes.map((entry) => String(entry)).filter(Boolean).join("；")
    : readString(currentContent.notes);

  return {
    ...defaultContent,
    schema_version: readString(currentContent.schema_version) ?? defaultContent.schema_version,
    user_id: readString(currentContent.user_id) ?? defaultContent.user_id,
    nickname: readString(currentContent.nickname)
      ?? readString(currentContent.display_name)
      ?? defaultContent.nickname,
    first_seen: readString(currentContent.first_seen) ?? defaultContent.first_seen,
    first_seen_context: readString(currentContent.first_seen_context) ?? defaultContent.first_seen_context,
    is_friend: typeof currentContent.is_friend === "boolean" ? currentContent.is_friend : defaultContent.is_friend,
    tags: readStringArray(currentContent.tags) ?? defaultContent.tags,
    expertise: readStringArray(currentContent.expertise) ?? defaultContent.expertise,
    personality: readString(currentContent.personality) ?? defaultContent.personality,
    influence_level: normalizeInfluenceLevel(currentContent.influence_level) ?? normalizeInfluenceLevel(defaultContent.influence_level) ?? "",
    interaction_stats: {
      ...defaultStats,
      ...currentStats,
      total_interactions: readNumber(currentStats.total_interactions) ?? defaultStats.total_interactions,
      last_interaction: readString(currentStats.last_interaction)
        ?? readString(currentContent.last_seen_at)
        ?? defaultStats.last_interaction,
      sentiment_trend: readString(currentStats.sentiment_trend) ?? defaultStats.sentiment_trend,
    },
    notes: normalizeDelimitedText(notesValue ?? defaultContent.notes),
    updated_at: readString(currentContent.updated_at)
      ?? readString(currentContent.last_seen_at)
      ?? defaultContent.updated_at,
  };
}

function normalizeGroupSoul(
  defaultContent: Record<string, unknown>,
  currentContent: Record<string, unknown>,
): Record<string, unknown> {
  const defaultSoul = isPlainObject(defaultContent.soul) ? defaultContent.soul : {};
  const currentSoul = isPlainObject(currentContent.soul) ? currentContent.soul : {};

  return {
    ...defaultContent,
    schema_version: readString(currentContent.schema_version) ?? defaultContent.schema_version,
    group_id: readString(currentContent.group_id) ?? defaultContent.group_id,
    group_name: readString(currentContent.group_name) ?? defaultContent.group_name,
    source: readString(currentContent.source) ?? defaultContent.source,
    soul: {
      ...defaultSoul,
      purpose: readString(currentSoul.purpose)
        ?? readString(currentContent.purpose)
        ?? defaultSoul.purpose,
      topics: readStringArray(currentSoul.topics) ?? defaultSoul.topics,
      tone: readString(currentSoul.tone) ?? defaultSoul.tone,
      boundaries: readString(currentSoul.boundaries) ?? defaultSoul.boundaries,
      expectations: readString(currentSoul.expectations) ?? defaultSoul.expectations,
    },
    updated_at: readString(currentContent.updated_at) ?? defaultContent.updated_at,
  };
}

function normalizeMembersGraph(
  defaultContent: Record<string, unknown>,
  currentContent: Record<string, unknown>,
): Record<string, unknown> {
  const defaultMembers = isPlainObject(defaultContent.members) ? defaultContent.members : {};
  const currentMembers = isPlainObject(currentContent.members) ? currentContent.members : {};
  const normalizedMembers = Object.entries({ ...defaultMembers, ...currentMembers }).reduce<Record<string, unknown>>(
    (acc, [userId, value]) => {
      const defaultMember = isPlainObject(defaultMembers[userId]) ? defaultMembers[userId] : {};
      const currentMember = isPlainObject(value) ? value : {};
      const normalizedRole = normalizeMemberBehaviorRole(currentMember.role)
        ?? normalizeMemberBehaviorRole(defaultMember.role)
        ?? "";
      acc[userId] = {
        ...defaultMember,
        role: normalizedRole,
        in_group_tags: readStringArray(currentMember.in_group_tags) ?? defaultMember.in_group_tags ?? [],
        strategy: normalizedRole ? (readString(currentMember.strategy) ?? readString(defaultMember.strategy) ?? "") : "",
      };
      return acc;
    },
    {},
  );

  return {
    ...defaultContent,
    schema_version: readString(currentContent.schema_version) ?? defaultContent.schema_version,
    group_id: readString(currentContent.group_id) ?? defaultContent.group_id,
    members: normalizedMembers,
    updated_at: readString(currentContent.updated_at) ?? defaultContent.updated_at,
  };
}

function normalizeGroupState(
  defaultContent: Record<string, unknown>,
  currentContent: Record<string, unknown>,
): Record<string, unknown> {
  const recentTopics = readStringArray(currentContent.recent_topics)
    ?? readStringArray(currentContent.current_topics)
    ?? readStringArray(currentContent.recent_highlights)
    ?? [];

  return {
    ...defaultContent,
    schema_version: readString(currentContent.schema_version) ?? defaultContent.schema_version,
    group_id: readString(currentContent.group_id) ?? defaultContent.group_id,
    my_role: readString(currentContent.my_role) ?? defaultContent.my_role,
    my_role_source: readString(currentContent.my_role_source) ?? defaultContent.my_role_source,
    my_role_updated_at: readString(currentContent.my_role_updated_at) ?? defaultContent.my_role_updated_at,
    current_topic: readString(currentContent.current_topic)
      ?? recentTopics[0]
      ?? defaultContent.current_topic,
    recent_topics: recentTopics.length > 0 ? recentTopics : defaultContent.recent_topics,
    pending_actions: readStringArray(currentContent.pending_actions) ?? defaultContent.pending_actions,
    topic_drift_counter: readNumber(currentContent.topic_drift_counter) ?? defaultContent.topic_drift_counter,
    last_decision: readString(currentContent.last_decision) ?? defaultContent.last_decision,
    last_reason: readString(currentContent.last_reason) ?? defaultContent.last_reason,
    last_active_at: readString(currentContent.last_active_at)
      ?? readString(currentContent.updated_at)
      ?? defaultContent.last_active_at,
    updated_at: readString(currentContent.updated_at) ?? defaultContent.updated_at,
  };
}

function normalizeDialogState(
  defaultContent: Record<string, unknown>,
  currentContent: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...defaultContent,
    schema_version: readString(currentContent.schema_version) ?? defaultContent.schema_version,
    user_id: readString(currentContent.user_id) ?? defaultContent.user_id,
    current_topics: readStringArray(currentContent.current_topics) ?? defaultContent.current_topics,
    pending_actions: readStringArray(currentContent.pending_actions) ?? defaultContent.pending_actions,
    rapport_summary: readString(currentContent.rapport_summary) ?? defaultContent.rapport_summary,
    updated_at: readString(currentContent.updated_at) ?? defaultContent.updated_at,
  };
}

function normalizeCognitionContent(
  alias: string,
  defaultValue: unknown,
  currentValue: unknown,
): unknown {
  if (!isPlainObject(defaultValue) || !isPlainObject(currentValue)) {
    return currentValue;
  }

  switch (alias) {
    case "group_soul":
      return normalizeGroupSoul(defaultValue, currentValue);
    case "group_members_graph":
      return normalizeMembersGraph(defaultValue, currentValue);
    case "group_state":
      return normalizeGroupState(defaultValue, currentValue);
    case "user_profile":
      return normalizeUserProfile(defaultValue, currentValue);
    case "dialog_state":
      return normalizeDialogState(defaultValue, currentValue);
    default: {
      const merged: Record<string, unknown> = { ...defaultValue };
      for (const [key, value] of Object.entries(currentValue)) {
        if (key in merged) {
          merged[key] = normalizeCognitionContent(key, merged[key], value);
        }
      }
      return merged;
    }
  }
}

function matchesLongTermVolatileRule(
  value: string | undefined,
  volatileTerms: string[],
  volatileRegexes: string[],
): boolean {
  const normalizedValue = readString(value);
  if (!normalizedValue) {
    return false;
  }
  if (volatileTerms.some((term) => term && normalizedValue.includes(term))) {
    return true;
  }
  return volatileRegexes.some((pattern) => {
    if (!pattern) {
      return false;
    }
    try {
      return new RegExp(pattern, "u").test(normalizedValue);
    } catch {
      return false;
    }
  });
}

function sanitizeLongTermString(
  currentValue: unknown,
  fallbackValue: unknown,
  volatileTerms: string[],
  volatileRegexes: string[],
): string {
  const currentText = readString(currentValue);
  if (!currentText) {
    return readString(fallbackValue) ?? "";
  }
  if (matchesLongTermVolatileRule(currentText, volatileTerms, volatileRegexes)) {
    return readString(fallbackValue) ?? "";
  }
  return currentText;
}

function sanitizeLongTermDelimitedText(
  currentValue: unknown,
  fallbackValue: unknown,
  volatileTerms: string[],
  volatileRegexes: string[],
): string {
  const sanitize = (value: unknown): string => {
    const segments = normalizeDelimitedText(value)
      .split("；")
      .map((segment) => segment.trim())
      .filter(Boolean)
      .filter((segment) => !matchesLongTermVolatileRule(segment, volatileTerms, volatileRegexes));
    return segments.join("；");
  };

  const currentText = sanitize(currentValue);
  if (currentText) {
    return currentText;
  }
  return sanitize(fallbackValue);
}

function sanitizeLongTermStringArray(
  currentValue: unknown,
  fallbackValue: unknown,
  volatileTerms: string[],
  volatileRegexes: string[],
): string[] {
  const currentItems = readStringArray(currentValue) ?? [];
  const sanitizedItems = currentItems.filter(
    (item) => !matchesLongTermVolatileRule(item, volatileTerms, volatileRegexes),
  );
  if (sanitizedItems.length > 0) {
    return sanitizedItems;
  }
  return readStringArray(fallbackValue) ?? [];
}

function sanitizeLongTermCognitionContent(params: {
  alias: string;
  normalizedContent: Record<string, unknown>;
  fallbackContent: Record<string, unknown>;
  volatileTerms: string[];
  volatileRegexes: string[];
}): Record<string, unknown> {
  const {
    alias,
    normalizedContent,
    fallbackContent,
    volatileTerms,
    volatileRegexes,
  } = params;

  if (volatileTerms.length === 0 && volatileRegexes.length === 0) {
    return normalizedContent;
  }

  switch (alias) {
    case "group_soul": {
      const currentSoul = isPlainObject(normalizedContent.soul) ? normalizedContent.soul : {};
      const fallbackSoul = isPlainObject(fallbackContent.soul) ? fallbackContent.soul : {};
      return {
        ...normalizedContent,
        soul: {
          ...currentSoul,
          purpose: sanitizeLongTermString(currentSoul.purpose, fallbackSoul.purpose, volatileTerms, volatileRegexes),
          topics: sanitizeLongTermStringArray(currentSoul.topics, fallbackSoul.topics, volatileTerms, volatileRegexes),
          boundaries: sanitizeLongTermString(currentSoul.boundaries, fallbackSoul.boundaries, volatileTerms, volatileRegexes),
          expectations: sanitizeLongTermString(currentSoul.expectations, fallbackSoul.expectations, volatileTerms, volatileRegexes),
        },
      };
    }
    case "user_profile":
      return {
        ...normalizedContent,
        tags: sanitizeLongTermStringArray(normalizedContent.tags, fallbackContent.tags, volatileTerms, volatileRegexes),
        expertise: sanitizeLongTermStringArray(normalizedContent.expertise, fallbackContent.expertise, volatileTerms, volatileRegexes),
        personality: sanitizeLongTermString(normalizedContent.personality, fallbackContent.personality, volatileTerms, volatileRegexes),
        notes: sanitizeLongTermDelimitedText(normalizedContent.notes, fallbackContent.notes, volatileTerms, volatileRegexes),
      };
    case "group_members_graph": {
      const currentMembers = isPlainObject(normalizedContent.members) ? normalizedContent.members : {};
      const fallbackMembers = isPlainObject(fallbackContent.members) ? fallbackContent.members : {};
      const sanitizedMembers = Object.entries(currentMembers).reduce<Record<string, unknown>>((acc, [userId, value]) => {
        const currentMember = isPlainObject(value) ? value : {};
        const fallbackMember = isPlainObject(fallbackMembers[userId]) ? fallbackMembers[userId] as Record<string, unknown> : {};
        acc[userId] = {
          ...currentMember,
          in_group_tags: sanitizeLongTermStringArray(
            currentMember.in_group_tags,
            fallbackMember.in_group_tags,
            volatileTerms,
            volatileRegexes,
          ),
          strategy: sanitizeLongTermString(
            currentMember.strategy,
            fallbackMember.strategy,
            volatileTerms,
            volatileRegexes,
          ),
        };
        return acc;
      }, {});
      return {
        ...normalizedContent,
        members: sanitizedMembers,
      };
    }
    default:
      return normalizedContent;
  }
}

function mergeLongTermSemanticArrays(params: {
  alias: string;
  normalizedContent: Record<string, unknown>;
  existingContent: Record<string, unknown>;
}): Record<string, unknown> {
  const { alias, normalizedContent, existingContent } = params;

  switch (alias) {
    case "group_soul": {
      const currentSoul = isPlainObject(normalizedContent.soul) ? normalizedContent.soul : {};
      const existingSoul = isPlainObject(existingContent.soul) ? existingContent.soul : {};
      return {
        ...normalizedContent,
        soul: {
          ...currentSoul,
          topics: unionStringArrays(existingSoul.topics, currentSoul.topics),
        },
      };
    }
    case "user_profile":
      return normalizedContent;
    case "group_members_graph": {
      const currentMembers = isPlainObject(normalizedContent.members) ? normalizedContent.members : {};
      const mergedMembers = Object.entries(currentMembers).reduce<Record<string, unknown>>((acc, [userId, value]) => {
        const currentMember = isPlainObject(value) ? value : {};
        acc[userId] = {
          ...currentMember,
        };
        return acc;
      }, {});
      return {
        ...normalizedContent,
        members: mergedMembers,
      };
    }
    default:
      return normalizedContent;
  }
}

function mergePlainObjects(
  base: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(incoming)) {
    if (isPlainObject(value) && isPlainObject(merged[key])) {
      merged[key] = mergePlainObjects(merged[key] as Record<string, unknown>, value);
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function resolveRuntimeTargets(
  cfg: ClawdbotConfig | undefined,
  event: Chat43AnySSEEvent,
  aliases: string[],
): {
  context: BootstrapContext;
  runtime: ReturnType<typeof load43ChatSkillRuntime>;
  targets: Map<string, string>;
  defaults: Map<string, Record<string, unknown>>;
} | null {
  const context = buildBootstrapContext(event);
  if (!context) {
    return null;
  }

  const runtime = load43ChatSkillRuntime(cfg);
  const targets = new Map(
    resolveSkillStorageTargets(runtime, aliases, context.values)
      .filter((target) => target.path.endsWith(".json") || target.path.endsWith(".jsonl"))
      .map((target) => [target.alias, target.path]),
  );
  const defaults = new Map(
    resolveSkillBootstrapDefaults(runtime, aliases, context.values)
      .map((entry) => [entry.alias, entry.content])
      .filter((entry): entry is [string, Record<string, unknown>] => isPlainObject(entry[1])),
  );

  return { context, runtime, targets, defaults };
}

function normalizeRelativeStoragePath(pathValue: string, baseDir: string): string | null {
  const normalizedBaseDir = normalize(baseDir);
  const normalizedPath = normalize(pathValue);
  if (!normalizedPath) {
    return null;
  }
  const basePrefix = normalizedBaseDir.endsWith(sep) ? normalizedBaseDir : `${normalizedBaseDir}${sep}`;
  if (normalizedPath.startsWith(basePrefix)) {
    return normalizedPath.slice(basePrefix.length);
  }
  return normalizedPath;
}

export function normalizeSkillCognitionWriteContent(params: {
  cfg?: ClawdbotConfig;
  event: Chat43AnySSEEvent;
  path: string;
  content: Record<string, unknown>;
  baseDir?: string;
}): Record<string, unknown> {
  const baseDir = params.baseDir ?? STORAGE_ROOT;
  const aliases = ["group_soul", "group_members_graph", "group_state", "user_profile", "dialog_state"];
  const resolved = resolveRuntimeTargets(params.cfg, params.event, aliases);
  if (!resolved) {
    return params.content;
  }

  const relativePath = normalizeRelativeStoragePath(params.path, baseDir);
  if (!relativePath) {
    return params.content;
  }

  const matchedAlias = Array.from(resolved.targets.entries())
    .find(([, targetPath]) => normalize(targetPath) === relativePath)?.[0];
  if (!matchedAlias) {
    return params.content;
  }

  const defaultContent = resolved.defaults.get(matchedAlias);
  if (!defaultContent) {
    return params.content;
  }

  const fullPath = resolveFullPath(relativePath, baseDir);
  const existingContent = fullPath ? (readJsonObject(fullPath) ?? {}) : {};
  const existingNormalizedContent = normalizeCognitionContent(matchedAlias, defaultContent, existingContent);
  const mergedContent = mergePlainObjects(existingContent, params.content);
  const normalizedContent = normalizeCognitionContent(matchedAlias, defaultContent, mergedContent);
  if (!isPlainObject(normalizedContent)) {
    return params.content;
  }
  const normalizedExistingObject = isPlainObject(existingNormalizedContent) ? existingNormalizedContent : {};
  const semanticallyMergedContent = mergeLongTermSemanticArrays({
    alias: matchedAlias,
    normalizedContent,
    existingContent: normalizedExistingObject,
  });

  const cognitionPolicy = resolveSkillCognitionPolicy(resolved.runtime, params.event.event_type);
  const fallbackContent = isPlainObject(existingNormalizedContent)
    ? existingNormalizedContent
    : defaultContent;
  return sanitizeLongTermCognitionContent({
    alias: matchedAlias,
    normalizedContent: semanticallyMergedContent,
    fallbackContent,
    volatileTerms: cognitionPolicy.topic_persistence.volatile_terms,
    volatileRegexes: cognitionPolicy.topic_persistence.volatile_regexes,
  });
}

function loadNormalizedAliasRecord(params: {
  alias: string;
  baseDir: string;
  targets: Map<string, string>;
  defaults: Map<string, Record<string, unknown>>;
}): Record<string, unknown> | null {
  const relativePath = params.targets.get(params.alias);
  const defaultContent = params.defaults.get(params.alias);
  if (!relativePath || !defaultContent) {
    return null;
  }

  const fullPath = resolveFullPath(relativePath, params.baseDir);
  if (!fullPath) {
    return null;
  }

  const currentContent = readJsonObject(fullPath) ?? {};
  const normalizedContent = normalizeCognitionContent(params.alias, defaultContent, currentContent);
  return isPlainObject(normalizedContent) ? normalizedContent : null;
}

function buildInnerActivitySummary(params: {
  groupName: string;
  messageText: string;
  decision: string;
  reason: string;
  replyText?: string;
  groupSoul?: Record<string, unknown> | null;
  groupState?: Record<string, unknown> | null;
  userProfile?: Record<string, unknown> | null;
  memberEntry?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const soul = isPlainObject(params.groupSoul?.soul) ? params.groupSoul?.soul : {};
  const soulTopics = readStringArray(soul.topics) ?? [];
  const currentTopic = readString(params.groupState?.current_topic) ?? "";
  const recentTopics = readStringArray(params.groupState?.recent_topics) ?? [];
  const pendingActions = readStringArray(params.groupState?.pending_actions) ?? [];
  const purpose = readString(soul.purpose) ?? "";
  const tone = readString(soul.tone) ?? "混合";
  const questionLike = looksQuestionLike(params.messageText);
  const interactionStats = isPlainObject(params.userProfile?.interaction_stats) ? params.userProfile?.interaction_stats : {};
  const totalInteractions = readNumber(interactionStats.total_interactions) ?? 0;
  const influenceLevel = normalizeInfluenceLevel(params.userProfile?.influence_level) ?? "";
  const memberRole = readString(params.memberEntry?.role) ?? "未知";
  const myRole = readString(params.groupState?.my_role) ?? "未知";
  const shouldReply = params.decision === "reply_sent";
  const actionList = [
    "group_state 已更新最近决策与活跃时间",
    "user_profile 已更新互动次数",
    "decision_log 已追加本轮摘要",
  ];

  return {
    structured_reasoning: {
      should_reply: shouldReply,
      question_like: questionLike,
      my_role: myRole,
      speaker_role: memberRole,
      interaction_count_after: totalInteractions,
      influence_level: influenceLevel,
      persisted_current_topic: currentTopic,
      persisted_recent_topics: recentTopics,
      pending_actions: pendingActions,
    },
    inner_activity: {
      group_soul: `群「${params.groupName}」当前 tone=${tone}${purpose ? `，purpose=${purpose}` : ""}。已沉淀话题: ${soulTopics.length > 0 ? soulTopics.join(" / ") : "暂无明确沉淀话题"}`,
      agent_role: `我的群身份=${myRole}。`,
      speaker: `发言者角色=${memberRole}，累计互动=${totalInteractions}，影响力标记=${influenceLevel || "空"}。`,
      memory_state: `长期认知当前记录：current_topic=${currentTopic || "空"}；recent_topics=${recentTopics.length > 0 ? recentTopics.join(" / ") : "空"}；pending_actions=${pendingActions.length > 0 ? pendingActions.join(" / ") : "空"}。`,
      decision: `决策=${params.decision}。原因=${params.reason}。${shouldReply ? "本轮选择回复，并尽量只围绕当前消息作答。" : "本轮不发送普通回复。"}${questionLike ? " 当前消息呈现明显提问特征。" : ""}`,
      attached_action: `${actionList.join("；")}；长期认知是否写入 topic 由模型在本轮中自行决定并提前写文件。`,
      profile_update: `画像已更新：nickname=${readString(params.userProfile?.nickname) ?? ""}，last_interaction=${readString(interactionStats.last_interaction) ?? ""}，total_interactions=${totalInteractions}。`,
      reply_strategy: params.replyText
        ? `回复摘要=${truncateForLog(params.replyText, 160)}`
        : "未发送文本回复，因此没有 reply_strategy 文本。",
    },
  };
}

function buildDirectInnerActivitySummary(params: {
  eventType: Chat43AnySSEEvent["event_type"];
  messageText: string;
  decision: string;
  reason: string;
  replyText?: string;
  userProfile?: Record<string, unknown> | null;
  dialogState?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const currentTopics = readStringArray(params.dialogState?.current_topics) ?? [];
  const pendingActions = readStringArray(params.dialogState?.pending_actions) ?? [];
  const rapportSummary = readString(params.dialogState?.rapport_summary) ?? "";
  const questionLike = looksQuestionLike(params.messageText);
  const interactionStats = isPlainObject(params.userProfile?.interaction_stats) ? params.userProfile?.interaction_stats : {};
  const totalInteractions = readNumber(interactionStats.total_interactions) ?? 0;
  const personality = readString(params.userProfile?.personality) ?? "";
  const shouldReply = params.decision === "reply_sent";

  return {
    structured_reasoning: {
      should_reply: shouldReply,
      question_like: questionLike,
      interaction_count_after: totalInteractions,
      persisted_current_topics: currentTopics,
      pending_actions: pendingActions,
      rapport_summary: rapportSummary,
    },
    inner_activity: {
      direct_context: `事件=${params.eventType}。当前长期对话状态：topics=${currentTopics.length > 0 ? currentTopics.join(" / ") : "空"}；pending_actions=${pendingActions.length > 0 ? pendingActions.join(" / ") : "空"}；rapport=${rapportSummary || "空"}。`,
      counterpart: `对方画像：nickname=${readString(params.userProfile?.nickname) ?? ""}；personality=${personality || "空"}；累计互动=${totalInteractions}。`,
      decision: `决策=${params.decision}。原因=${params.reason}。${shouldReply ? "本轮选择发送私聊回复。" : "本轮不发送私聊回复。"}${questionLike ? " 当前消息呈现明显提问特征。" : ""}`,
      attached_action: "dialog_decision_log 已追加本轮摘要；长期画像与对话状态由后台 worker 异步归并更新。",
      profile_update: `画像快照：last_interaction=${readString(interactionStats.last_interaction) ?? ""}，total_interactions=${totalInteractions}。`,
      reply_strategy: params.replyText
        ? `回复摘要=${truncateForLog(params.replyText, 160)}`
        : "未发送文本回复，因此没有 reply_strategy 文本。",
    },
  };
}

function extractDirectEventMessageText(event: Chat43AnySSEEvent): string {
  switch (event.event_type) {
    case "private_message":
      return extract43ChatTextContent((event.data as Chat43PrivateMessageEventData).content);
    case "friend_request":
      return readString((event.data as Chat43FriendRequestEventData).request_msg) ?? "";
    case "friend_accepted":
      return "对方已通过好友请求";
    default:
      return "";
  }
}

function resolveDirectEventUserMeta(event: Chat43AnySSEEvent): { userId: string; nickname: string } | null {
  switch (event.event_type) {
    case "private_message": {
      const data = event.data as Chat43PrivateMessageEventData;
      return {
        userId: String(data.from_user_id),
        nickname: data.from_nickname || String(data.from_user_id),
      };
    }
    case "friend_request": {
      const data = event.data as Chat43FriendRequestEventData;
      return {
        userId: String(data.from_user_id),
        nickname: data.from_nickname || String(data.from_user_id),
      };
    }
    case "friend_accepted": {
      const data = event.data as Chat43FriendAcceptedEventData;
      return {
        userId: String(data.from_user_id),
        nickname: data.from_nickname || String(data.from_user_id),
      };
    }
    default:
      return null;
  }
}

export function ensureSkillCognitionBootstrap(params: {
  cfg?: ClawdbotConfig;
  event: Chat43AnySSEEvent;
  log?: (message: string) => void;
  error?: (message: string) => void;
  baseDir?: string;
}): BootstrapResult {
  const context = buildBootstrapContext(params.event);
  if (!context) {
    return { created: [], updated: [], skipped: [] };
  }

  const runtime = load43ChatSkillRuntime(params.cfg);
  const profile = runtime.data.event_profiles[context.eventType] ?? runtime.data.event_profiles.system_notice;
  const aliases = Array.from(new Set([...profile.reads, ...profile.writes]));
  const targets = resolveSkillStorageTargets(runtime, aliases, context.values)
    .filter((target) => target.path.endsWith(".json"));
  const defaults = new Map(
    resolveSkillBootstrapDefaults(runtime, aliases, context.values).map((entry) => [entry.alias, entry.content]),
  );

  const created: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];
  const baseDir = params.baseDir ?? STORAGE_ROOT;

  for (const target of targets) {
    const fullPath = resolveFullPath(target.path, baseDir);
    const defaultContent = defaults.get(target.alias);
    if (!fullPath || !defaultContent) {
      continue;
    }
    if (existsSync(fullPath)) {
      try {
        const currentContent = JSON.parse(readFileSync(fullPath, "utf8")) as unknown;
        if (isPlainObject(currentContent)) {
          const mergedContent = normalizeCognitionContent(
            target.alias,
            defaultContent,
            currentContent,
          ) as Record<string, unknown>;
          if (JSON.stringify(mergedContent) !== JSON.stringify(currentContent)) {
            writeFileSync(fullPath, `${JSON.stringify(mergedContent, null, 2)}\n`, "utf8");
            updated.push(target.path);
            params.log?.(`43chat: normalized cognition file ${target.path}`);
            continue;
          }
        }
      } catch {
        // Keep existing file as-is if parse/hydration fails.
      }
      skipped.push(target.path);
      continue;
    }

    try {
      mkdirSync(dirname(fullPath), { recursive: true });
      const normalizedDefault = normalizeCognitionContent(
        target.alias,
        defaultContent,
        defaultContent,
      ) as Record<string, unknown>;
      if (target.alias === "user_profile") {
        const factIsFriend = resolveUserProfileIsFriendFact(context.eventType as Chat43AnySSEEvent["event_type"]);
        if (typeof factIsFriend === "boolean") {
          normalizedDefault.is_friend = factIsFriend;
        }
      }
      writeFileSync(fullPath, `${JSON.stringify(normalizedDefault, null, 2)}\n`, "utf8");
      created.push(target.path);
      params.log?.(`43chat: initialized cognition file ${target.path}`);
    } catch (cause) {
      params.error?.(`43chat: failed to initialize cognition file ${target.path}: ${String(cause)}`);
    }
  }

  return { created, updated, skipped };
}

export function updateSkillCognitionFromEvent(params: {
  cfg?: ClawdbotConfig;
  event: Chat43AnySSEEvent;
  senderRoleName?: string;
  log?: (message: string) => void;
  error?: (message: string) => void;
  baseDir?: string;
}): CognitionMutationResult {
  const isGroupMessage = params.event.event_type === "group_message";
  const isPrivateMessage = params.event.event_type === "private_message";
  if (!isGroupMessage && !isPrivateMessage) {
    return { updated: [], appended: [], skipped: [] };
  }

  const resolved = resolveRuntimeTargets(
    params.cfg,
    params.event,
    isGroupMessage
      ? ["group_members_graph", "user_profile"]
      : ["user_profile"],
  );
  if (!resolved) {
    return { updated: [], appended: [], skipped: [] };
  }

  const { context, targets, defaults } = resolved;
  const baseDir = params.baseDir ?? STORAGE_ROOT;
  const updated: string[] = [];
  const skipped: string[] = [];

  const updateJsonAlias = (
    alias: string,
    mutate: (content: Record<string, unknown>) => void,
  ): void => {
    const relativePath = targets.get(alias);
    const defaultContent = defaults.get(alias);
    if (!relativePath || !defaultContent) {
      skipped.push(alias);
      return;
    }

    const fullPath = resolveFullPath(relativePath, baseDir);
    if (!fullPath) {
      skipped.push(alias);
      return;
    }

    const currentContent = readJsonObject(fullPath) ?? {};
    const normalizedContent = normalizeCognitionContent(alias, defaultContent, currentContent);
    if (!isPlainObject(normalizedContent)) {
      skipped.push(relativePath);
      return;
    }

    const nextContent = JSON.parse(JSON.stringify(normalizedContent)) as Record<string, unknown>;
    mutate(nextContent);

    if (JSON.stringify(nextContent) === JSON.stringify(currentContent)) {
      skipped.push(relativePath);
      return;
    }

    try {
      writeJsonObject(fullPath, nextContent);
      updated.push(relativePath);
    } catch (cause) {
      params.error?.(`43chat: failed to update cognition file ${relativePath}: ${String(cause)}`);
    }
  };

  updateJsonAlias("user_profile", (content) => {
    const stats = isPlainObject(content.interaction_stats) ? content.interaction_stats : {};
    const totalInteractions = readNumber(stats.total_interactions) ?? 0;
    const nextTotalInteractions = totalInteractions + 1;
    const factIsFriend = resolveUserProfileIsFriendFact(params.event.event_type);
    content.user_id = readString(content.user_id) ?? context.values.user_id ?? "";
    content.nickname = context.values.sender_name ?? readString(content.nickname) ?? "";
    content.first_seen_context = readString(content.first_seen_context)
      ?? context.values.group_name
      ?? (isPrivateMessage ? "私聊" : undefined)
      ?? "";
    if (typeof factIsFriend === "boolean") {
      content.is_friend = factIsFriend;
    }
    content.tags = readStringArray(content.tags) ?? [];
    content.expertise = readStringArray(content.expertise) ?? [];
    content.personality = readString(content.personality) ?? "";
    content.influence_level = normalizeInfluenceLevel(content.influence_level) ?? "";
    content.interaction_stats = {
      ...stats,
      total_interactions: nextTotalInteractions,
      last_interaction: context.values.event_iso_time
        ?? context.values.event_date
        ?? stats.last_interaction,
      sentiment_trend: readString(stats.sentiment_trend) ?? "neutral",
    };
    content.notes = normalizeDelimitedText(content.notes);
  });

  if (updated.length > 0) {
    params.log?.(`43chat: incrementally updated factual profile fields ${updated.join(", ")}`);
  }

  return { updated, appended: [], skipped };
}

export function finalizeSkillDecision(params: {
  cfg?: ClawdbotConfig;
  event: Chat43AnySSEEvent;
  decision: string;
  reason: string;
  replyText?: string;
  moderationDecision?: {
    kind: string;
    reason?: string;
    scenario?: string;
    stage?: string;
    targetUserId?: string;
    publicReply?: boolean;
  };
  log?: (message: string) => void;
  error?: (message: string) => void;
  baseDir?: string;
}): CognitionMutationResult {
  if (
    params.event.event_type === "private_message"
    || params.event.event_type === "friend_request"
    || params.event.event_type === "friend_accepted"
  ) {
    const resolved = resolveRuntimeTargets(
      params.cfg,
      params.event,
      ["user_profile", "dialog_state", "dialog_decision_log"],
    );
    if (!resolved) {
      return { updated: [], appended: [], skipped: [] };
    }

    const { targets, defaults } = resolved;
    const baseDir = params.baseDir ?? STORAGE_ROOT;
    const updated: string[] = [];
    const appended: string[] = [];
    const skipped: string[] = [];
    const directUserMeta = resolveDirectEventUserMeta(params.event);
    if (!directUserMeta) {
      return { updated, appended, skipped };
    }
    const messageText = extractDirectEventMessageText(params.event);
    const userProfile = loadNormalizedAliasRecord({
      alias: "user_profile",
      baseDir,
      targets,
      defaults,
    });
    const dialogState = loadNormalizedAliasRecord({
      alias: "dialog_state",
      baseDir,
      targets,
      defaults,
    });
    const reasoningSummary = buildDirectInnerActivitySummary({
      eventType: params.event.event_type,
      messageText,
      decision: params.decision,
      reason: params.reason,
      replyText: params.replyText,
      userProfile,
      dialogState,
    });

    const decisionLogPath = targets.get("dialog_decision_log");
    if (decisionLogPath) {
      const fullPath = resolveFullPath(decisionLogPath, baseDir);
      if (fullPath) {
        try {
          appendJsonl(fullPath, {
            schema_version: "1.0",
            ts: new Date().toISOString(),
            event_type: params.event.event_type,
            message_id: (() => {
              switch (params.event.event_type) {
                case "private_message":
                  return String((params.event.data as Chat43PrivateMessageEventData).message_id || "");
                case "friend_request":
                  return String((params.event.data as Chat43FriendRequestEventData).request_id || "");
                case "friend_accepted":
                  return String((params.event.data as Chat43FriendAcceptedEventData).request_id || "");
                default:
                  return "";
              }
            })(),
            user_id: directUserMeta.userId,
            nickname: directUserMeta.nickname,
            current_message: truncateForLog(messageText),
            current_topics: readStringArray(dialogState?.current_topics) ?? [],
            pending_actions: readStringArray(dialogState?.pending_actions) ?? [],
            rapport_summary: readString(dialogState?.rapport_summary) ?? "",
            decision: params.decision,
            reason: params.reason,
            reply_text: params.replyText ? truncateForLog(params.replyText, 400) : "",
            moderation_decision: params.moderationDecision?.kind ?? "",
            moderation_reason: params.moderationDecision?.reason ?? "",
            moderation_scenario: params.moderationDecision?.scenario ?? "",
            moderation_stage: params.moderationDecision?.stage ?? "",
            moderation_target_user_id: params.moderationDecision?.targetUserId ?? "",
            moderation_public_reply: params.moderationDecision?.publicReply ?? null,
            cognition_control_mode: "document_driven_llm",
            ...reasoningSummary,
          });
          appended.push(decisionLogPath);
        } catch (cause) {
          params.error?.(`43chat: failed to append direct decision log ${decisionLogPath}: ${String(cause)}`);
        }
      } else {
        skipped.push("dialog_decision_log");
      }
    }

    if (updated.length > 0 || appended.length > 0) {
      params.log?.(`43chat: finalized cognition updated=${updated.join(", ") || "-"} appended=${appended.join(", ") || "-"}`);
    }

    return { updated, appended, skipped };
  }

  if (params.event.event_type !== "group_message") {
    return { updated: [], appended: [], skipped: [] };
  }

  const resolved = resolveRuntimeTargets(
    params.cfg,
    params.event,
    ["group_soul", "group_members_graph", "group_state", "user_profile", "group_decision_log"],
  );
  if (!resolved) {
    return { updated: [], appended: [], skipped: [] };
  }

  const { context, targets, defaults } = resolved;
  const baseDir = params.baseDir ?? STORAGE_ROOT;
  const updated: string[] = [];
  const appended: string[] = [];
  const skipped: string[] = [];
  const data = params.event.data as Chat43GroupMessageEventData;
  const messageText = extract43ChatTextContent(data.content);

  const groupStatePath = targets.get("group_state");
  const groupStateDefault = defaults.get("group_state");
  let finalGroupState: Record<string, unknown> | null = null;
  if (groupStatePath && groupStateDefault) {
    const fullPath = resolveFullPath(groupStatePath, baseDir);
    if (fullPath) {
      const currentContent = readJsonObject(fullPath) ?? {};
      const normalizedContent = normalizeCognitionContent("group_state", groupStateDefault, currentContent);
      if (isPlainObject(normalizedContent)) {
        const nextContent = JSON.parse(JSON.stringify(normalizedContent)) as Record<string, unknown>;
        const nowIso = new Date().toISOString();
        nextContent.group_id = readString(nextContent.group_id) ?? context.values.group_id ?? "";
        nextContent.last_decision = params.decision;
        nextContent.last_reason = params.reason;
        nextContent.last_active_at = nowIso;
        nextContent.updated_at = nowIso;
        finalGroupState = nextContent;

        if (JSON.stringify(nextContent) !== JSON.stringify(currentContent)) {
          try {
            writeJsonObject(fullPath, nextContent);
            updated.push(groupStatePath);
          } catch (cause) {
            params.error?.(`43chat: failed to finalize group_state ${groupStatePath}: ${String(cause)}`);
          }
        }
      }
    }
  }

  const groupSoul = loadNormalizedAliasRecord({
    alias: "group_soul",
    baseDir,
    targets,
    defaults,
  });
  const membersGraph = loadNormalizedAliasRecord({
    alias: "group_members_graph",
    baseDir,
    targets,
    defaults,
  });
  const userProfile = loadNormalizedAliasRecord({
    alias: "user_profile",
    baseDir,
    targets,
    defaults,
  });
  const memberEntry = isPlainObject(membersGraph?.members)
    ? (isPlainObject(membersGraph.members[String(data.from_user_id)])
      ? membersGraph.members[String(data.from_user_id)] as Record<string, unknown>
      : null)
    : null;
  const reasoningSummary = buildInnerActivitySummary({
    groupName: data.group_name || `群${data.group_id}`,
    messageText,
    decision: params.decision,
    reason: params.reason,
    replyText: params.replyText,
    groupSoul,
    groupState: finalGroupState,
    userProfile,
    memberEntry,
  });

  const decisionLogPath = targets.get("group_decision_log");
  if (decisionLogPath) {
    const fullPath = resolveFullPath(decisionLogPath, baseDir);
    if (fullPath) {
      try {
        appendJsonl(fullPath, {
          schema_version: "1.0",
          ts: new Date().toISOString(),
          event_type: params.event.event_type,
          message_id: String(data.message_id || ""),
          group_id: String(data.group_id),
          group_name: data.group_name || `群${data.group_id}`,
          user_id: String(data.from_user_id),
          nickname: data.from_nickname || String(data.from_user_id),
          current_message: truncateForLog(messageText),
          current_topic: readString(finalGroupState?.current_topic) ?? "",
          recent_topics: readStringArray(finalGroupState?.recent_topics) ?? [],
          decision: params.decision,
          reason: params.reason,
          reply_text: params.replyText ? truncateForLog(params.replyText, 400) : "",
          moderation_decision: params.moderationDecision?.kind ?? "",
          moderation_reason: params.moderationDecision?.reason ?? "",
          moderation_scenario: params.moderationDecision?.scenario ?? "",
          moderation_stage: params.moderationDecision?.stage ?? "",
          moderation_target_user_id: params.moderationDecision?.targetUserId ?? "",
          moderation_public_reply: params.moderationDecision?.publicReply ?? null,
          cognition_control_mode: "document_driven_llm",
          ...reasoningSummary,
        });
        appended.push(decisionLogPath);
      } catch (cause) {
        params.error?.(`43chat: failed to append decision log ${decisionLogPath}: ${String(cause)}`);
      }
    } else {
      skipped.push("group_decision_log");
    }
  }

  if (updated.length > 0 || appended.length > 0) {
    params.log?.(`43chat: finalized cognition updated=${updated.join(", ") || "-"} appended=${appended.join(", ") || "-"}`);
  }

  return { updated, appended, skipped };
}

export function inspectGroupMessageCognitionWriteRequirements(params: {
  cfg?: ClawdbotConfig;
  event: Chat43AnySSEEvent;
  baseDir?: string;
}): GroupMessageCognitionWriteRequirements {
  const runtime = load43ChatSkillRuntime(params.cfg);
  const enforcement = resolveSkillCognitionPolicy(runtime, params.event.event_type).write_enforcement;
  const defaultResult: GroupMessageCognitionWriteRequirements = {
    enabled: enforcement.enabled,
    blockFinalReplyWhenIncomplete: enforcement.block_final_reply_when_incomplete,
    maxRetryAttempts: enforcement.max_retry_attempts,
    retryPromptLines: enforcement.retry_prompt_lines,
    issues: [],
  };

  if (params.event.event_type !== "group_message" || !enforcement.enabled) {
    return defaultResult;
  }

  const resolved = resolveRuntimeTargets(
    params.cfg,
    params.event,
    ["group_soul", "group_members_graph", "user_profile", "group_decision_log"],
  );
  if (!resolved) {
    return defaultResult;
  }

  const { context, targets, defaults } = resolved;
  const baseDir = params.baseDir ?? STORAGE_ROOT;
  const issues: CognitionWriteRequirementIssue[] = [];
  const data = params.event.data as Chat43GroupMessageEventData;
  const senderUserId = String(data.from_user_id);

  const groupSoul = loadNormalizedAliasRecord({
    alias: "group_soul",
    baseDir,
    targets,
    defaults,
  });
  const userProfile = loadNormalizedAliasRecord({
    alias: "user_profile",
    baseDir,
    targets,
    defaults,
  });
  const membersGraph = loadNormalizedAliasRecord({
    alias: "group_members_graph",
    baseDir,
    targets,
    defaults,
  });
  const graphMembers = isPlainObject(membersGraph?.members)
    ? membersGraph.members as Record<string, unknown>
    : {};
  const memberEntry = isPlainObject(graphMembers[senderUserId])
    ? graphMembers[senderUserId] as Record<string, unknown>
    : null;

  const decisionLogPath = targets.get("group_decision_log") ?? "";
  const decisionLogFullPath = decisionLogPath ? resolveFullPath(decisionLogPath, baseDir) : null;
  const groupMessageCount = (decisionLogFullPath ? countJsonlEntries(decisionLogFullPath) : 0) + 1;
  const interactionStats = isPlainObject(userProfile?.interaction_stats) ? userProfile.interaction_stats : {};
  const interactionCount = readNumber(interactionStats.total_interactions) ?? 0;
  const profileUpdatedAt = parseTimestamp(userProfile?.updated_at);
  const lastInteractionAt = parseTimestamp(interactionStats.last_interaction);
  const membersGraphUpdatedAt = parseTimestamp(membersGraph?.updated_at);

  if (
    groupMessageCount >= enforcement.group_soul_required_after_messages
    && isGroupSoulUnfilled(groupSoul)
  ) {
    const path = targets.get("group_soul");
    if (path) {
      issues.push({
        alias: "group_soul",
        path,
        summary: "群 Soul 仍为空：purpose / topics / boundaries / expectations 都未形成可复用结论",
      });
    }
  }

  if (
    interactionCount >= enforcement.user_profile_required_after_interactions
    && isUserProfileUnfilled(userProfile)
  ) {
    const path = targets.get("user_profile");
    if (path) {
      issues.push({
        alias: "user_profile",
        path,
        summary: "人物画像仍为空：tags / expertise / personality / influence_level / notes 还没有写入",
      });
    }
  } else if (
    interactionCount >= enforcement.user_profile_required_after_interactions
    && isTimestampMeaningfullyAfter(lastInteractionAt, profileUpdatedAt)
  ) {
    const path = targets.get("user_profile");
    if (path) {
      issues.push({
        alias: "user_profile",
        path,
        summary: "人物画像自上次语义更新后已有新互动：请结合本轮稳定信号重评 tags / expertise / personality / notes；若旧结论已过期或冲突，应直接改写，不要只保留首次画像",
      });
    }
  }

  if (
    interactionCount >= enforcement.group_members_graph_required_after_interactions
    && isMemberGraphEntryUnfilled(memberEntry)
  ) {
    const path = targets.get("group_members_graph");
    if (path) {
      issues.push({
        alias: "group_members_graph",
        path,
        summary: "群成员图谱仍为空：role / in_group_tags / strategy 还没有写入",
      });
    }
  } else if (
    interactionCount >= enforcement.group_members_graph_required_after_interactions
    && isTimestampMeaningfullyAfter(profileUpdatedAt, membersGraphUpdatedAt)
  ) {
    const path = targets.get("group_members_graph");
    if (path) {
      issues.push({
        alias: "group_members_graph",
        path,
        summary: "群成员图谱尚未吸收当前成员的最新稳定画像：请重评其在群内的 role / in_group_tags / strategy；若职责或关注点已稳定变化，应覆盖旧判断",
      });
    }
  }

  return {
    ...defaultResult,
    issues,
  };
}

export function inspectPrivateMessageCognitionWriteRequirements(params: {
  cfg?: ClawdbotConfig;
  event: Chat43AnySSEEvent;
  baseDir?: string;
}): GroupMessageCognitionWriteRequirements {
  const runtime = load43ChatSkillRuntime(params.cfg);
  const enforcement = resolveSkillCognitionPolicy(runtime, params.event.event_type).write_enforcement;
  const defaultResult: GroupMessageCognitionWriteRequirements = {
    enabled: enforcement.enabled,
    blockFinalReplyWhenIncomplete: enforcement.block_final_reply_when_incomplete,
    maxRetryAttempts: enforcement.max_retry_attempts,
    retryPromptLines: [...enforcement.retry_prompt_lines],
    issues: [],
  };

  if (params.event.event_type !== "private_message" || !enforcement.enabled) {
    return defaultResult;
  }

  const resolved = resolveRuntimeTargets(
    params.cfg,
    params.event,
    ["user_profile", "dialog_state"],
  );
  if (!resolved) {
    return defaultResult;
  }

  const { context, targets, defaults } = resolved;
  const baseDir = params.baseDir ?? STORAGE_ROOT;
  const issues: CognitionWriteRequirementIssue[] = [];
  const data = params.event.data as Chat43PrivateMessageEventData;
  const messageText = extract43ChatTextContent(data.content);
  const signals = detectDirectCognitionSignals(messageText);
  if (!signals.shouldUpdateDialogState && !signals.shouldUpdateUserProfile) {
    return defaultResult;
  }

  const userProfile = loadNormalizedAliasRecord({
    alias: "user_profile",
    baseDir,
    targets,
    defaults,
  });
  const dialogState = loadNormalizedAliasRecord({
    alias: "dialog_state",
    baseDir,
    targets,
    defaults,
  });
  const eventTimestamp = parseTimestamp(context.values.event_iso_time);
  const dialogUpdatedAt = parseTimestamp(dialogState?.updated_at);

  if (
    signals.shouldUpdateDialogState
    && (
      isDialogStateUnfilled(dialogState)
      || isTimestampMeaningfullyAfter(eventTimestamp, dialogUpdatedAt)
    )
  ) {
    const path = targets.get("dialog_state");
    if (path) {
      issues.push({
        alias: "dialog_state",
        path,
        summary: `私聊已出现长期跟进信号（${signals.dialogReasons.join(" / ")}）：至少补 dialog_state.current_topics / rapport_summary，不要继续只回文本或 writes=[]`,
      });
    }
  }

  if (signals.shouldUpdateUserProfile && isUserProfileUnfilled(userProfile)) {
    const path = targets.get("user_profile");
    if (path) {
      issues.push({
        alias: "user_profile",
        path,
        summary: `私聊已出现稳定人物信号（${signals.profileReasons.join(" / ")}）：至少补 user_profile.tags / personality / notes，不能继续 writes=[]`,
      });
    }
  }

  return {
    ...defaultResult,
    issues,
  };
}

export function updateSkillAgentRole(params: {
  cfg?: ClawdbotConfig;
  event: Chat43AnySSEEvent;
  roleName?: string;
  source?: string;
  log?: (message: string) => void;
  error?: (message: string) => void;
  baseDir?: string;
}): CognitionMutationResult {
  if (
    params.event.event_type !== "group_message"
    && params.event.event_type !== "group_invitation"
    && params.event.event_type !== "group_member_joined"
  ) {
    return { updated: [], appended: [], skipped: [] };
  }

  const resolved = resolveRuntimeTargets(
    params.cfg,
    params.event,
    ["group_state"],
  );
  if (!resolved) {
    return { updated: [], appended: [], skipped: [] };
  }

  const { context, targets, defaults } = resolved;
  const groupStatePath = targets.get("group_state");
  const defaultContent = defaults.get("group_state");
  if (!groupStatePath || !defaultContent) {
    return { updated: [], appended: [], skipped: ["group_state"] };
  }

  const fullPath = resolveFullPath(groupStatePath, params.baseDir ?? STORAGE_ROOT);
  if (!fullPath) {
    return { updated: [], appended: [], skipped: [groupStatePath] };
  }

  const currentContent = readJsonObject(fullPath) ?? {};
  const normalizedContent = normalizeCognitionContent("group_state", defaultContent, currentContent);
  if (!isPlainObject(normalizedContent)) {
    return { updated: [], appended: [], skipped: [groupStatePath] };
  }

  const nextContent = JSON.parse(JSON.stringify(normalizedContent)) as Record<string, unknown>;
  nextContent.group_id = readString(nextContent.group_id) ?? context.values.group_id ?? "";
  nextContent.my_role = params.roleName ?? readString(nextContent.my_role) ?? "";
  nextContent.my_role_source = params.source ?? readString(nextContent.my_role_source) ?? "";
  nextContent.my_role_updated_at = context.values.event_iso_time ?? new Date().toISOString();

  if (JSON.stringify(nextContent) === JSON.stringify(currentContent)) {
    return { updated: [], appended: [], skipped: [groupStatePath] };
  }

  try {
    writeJsonObject(fullPath, nextContent);
    params.log?.(`43chat: persisted my role ${params.roleName ?? "unknown"} into ${groupStatePath}`);
    return { updated: [groupStatePath], appended: [], skipped: [] };
  } catch (cause) {
    params.error?.(`43chat: failed to persist my role in ${groupStatePath}: ${String(cause)}`);
    return { updated: [], appended: [], skipped: [groupStatePath] };
  }
}

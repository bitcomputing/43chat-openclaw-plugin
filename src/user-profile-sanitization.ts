const CROSS_GROUP_ROLE_PATTERNS = [
  /^(群主|管理员|成员)$/u,
  /群管理/u,
  /群规/u,
  /秩序维护/u,
  /新人引导/u,
  /欢迎新成员/u,
  /违规(识别|处置)/u,
  /群氛围/u,
  /核心成员/u,
];

const CROSS_GROUP_EXPERTISE_PATTERNS = [
  /群管理/u,
  /成员引导/u,
  /新人融入/u,
  /违规(识别|处置)/u,
  /群氛围营造/u,
  /欢迎新成员/u,
];

const PRIVATE_PROFILE_PATTERNS = [
  /(?:微信|v\s*x|VX|vx|联系方式|手机号|电话|手机|QQ|qq)/u,
  /(?:称呼我|叫我|小名|本名|真名)/u,
  /(?:线下|见面|约饭|约会|陪我去|一起去|带我去)/u,
  /(?:地址|住址|酒店|房号)/u,
  /(?:私聊|加我)/u,
  /当前在[\p{Script=Han}A-Za-z]{1,16}/u,
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => readString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function matchesAnyPattern(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function sanitizeSemanticItems(value: unknown, patterns: RegExp[]): string[] {
  return readStringArray(value).filter((item) => !matchesAnyPattern(item, patterns));
}

function splitNarrativeSegments(value: string): string[] {
  return value
    .split(/[；;\n]+/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function sanitizeNarrativeField(value: unknown, patterns: RegExp[]): string {
  const text = readString(value);
  if (!text) {
    return "";
  }

  const segments = splitNarrativeSegments(text);
  if (segments.length <= 1) {
    return matchesAnyPattern(text, patterns) ? "" : text;
  }

  return segments
    .filter((segment) => !matchesAnyPattern(segment, patterns))
    .join("；");
}

function buildSafeInteractionStats(value: unknown): Record<string, unknown> {
  const stats = isPlainObject(value) ? value : {};
  const totalInteractions = readNumber(stats.total_interactions);
  const sentimentTrend = readString(stats.sentiment_trend);
  const safeStats: Record<string, unknown> = {};

  if (typeof totalInteractions === "number") {
    safeStats.total_interactions = totalInteractions;
  }
  if (sentimentTrend) {
    safeStats.sentiment_trend = sentimentTrend;
  }

  return safeStats;
}

export function sanitizeUserProfileForStorage(content: Record<string, unknown>): Record<string, unknown> {
  return {
    ...content,
    tags: sanitizeSemanticItems(content.tags, CROSS_GROUP_ROLE_PATTERNS),
    expertise: sanitizeSemanticItems(
      content.expertise,
      [...CROSS_GROUP_ROLE_PATTERNS, ...CROSS_GROUP_EXPERTISE_PATTERNS],
    ),
    personality: sanitizeNarrativeField(
      content.personality,
      [...CROSS_GROUP_ROLE_PATTERNS, ...PRIVATE_PROFILE_PATTERNS],
    ),
    notes: sanitizeNarrativeField(
      content.notes,
      [...CROSS_GROUP_ROLE_PATTERNS, ...PRIVATE_PROFILE_PATTERNS],
    ),
  };
}

export function buildGroupScopedUserProfile(content: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeUserProfileForStorage(content);

  return {
    schema_version: readString(sanitized.schema_version) ?? "1.0",
    user_id: readString(sanitized.user_id) ?? "",
    nickname: readString(sanitized.nickname) ?? "",
    tags: readStringArray(sanitized.tags),
    expertise: readStringArray(sanitized.expertise),
    personality: readString(sanitized.personality) ?? "",
    influence_level: readString(sanitized.influence_level) ?? "",
    interaction_stats: buildSafeInteractionStats(sanitized.interaction_stats),
    group_context_usage: "群聊中仅把该画像当作弱参考；优先依据当前消息、group_soul、group_members_graph 判断。群内角色、私聊关系、称呼习惯、线下邀约等信息不得跨群复用。",
    omitted_fields: [
      "first_seen",
      "first_seen_context",
      "is_friend",
      "interaction_stats.last_interaction",
      "notes",
    ],
  };
}

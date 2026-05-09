function trimToSingleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function parseObjectContent(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall back to the raw string when the payload is not JSON.
  }
  return undefined;
}

function readStringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === "string" && field.trim() ? trimToSingleLine(field) : undefined;
}

function readNumberField(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const field = value?.[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function normalizeMessageType(msgType?: string): string | undefined {
  const normalized = msgType?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  const withoutPrefix = normalized.replace(/^jg:/u, "");
  if (withoutPrefix === "img") {
    return "image";
  }
  if (withoutPrefix === "share_user" || withoutPrefix === "usercard" || withoutPrefix === "card") {
    return "shareuser";
  }
  if (withoutPrefix === "share_group") {
    return "sharegroup";
  }
  return withoutPrefix;
}

export function extract43ChatTextContent(rawContent: unknown, msgType?: string): string {
  const raw = typeof rawContent === "string" ? rawContent.trim() : "";
  if (!raw) {
    return "";
  }

  const normalizedType = normalizeMessageType(msgType);
  if (!normalizedType || normalizedType === "text") {
    const parsed = parseObjectContent(raw);
    const wrappedText = readStringField(parsed, "content");
    if (wrappedText) {
      return wrappedText;
    }
    if (readStringField(parsed, "url")) {
      return formatImageContent(parsed);
    }
    if (readStringField(parsed, "im_user_id") || readStringField(parsed, "nickname")) {
      return formatShareUserContent(parsed);
    }
    if (readStringField(parsed, "im_group_id") || readStringField(parsed, "name")) {
      return formatShareGroupContent(parsed);
    }
    return trimToSingleLine(raw);
  }

  const parsed = parseObjectContent(raw);

  if (normalizedType === "image") {
    return formatImageContent(parsed);
  }

  if (normalizedType === "file") {
    const url = readStringField(parsed, "url");
    return url ? `[文件] ${url}` : "[文件]";
  }

  if (normalizedType === "sharegroup") {
    return formatShareGroupContent(parsed);
  }

  if (normalizedType === "shareuser") {
    return formatShareUserContent(parsed);
  }

  return trimToSingleLine(raw);
}

function formatImageContent(parsed: Record<string, unknown> | undefined): string {
  const url = readStringField(parsed, "url");
  const width = readNumberField(parsed, "width");
  const height = readNumberField(parsed, "height");
  const sizeText = width !== undefined && height !== undefined ? `尺寸: ${width}x${height}` : undefined;
  return [url ? `[图片] ${url}` : "[图片]", sizeText].filter(Boolean).join(" ");
}

function formatShareGroupContent(parsed: Record<string, unknown> | undefined): string {
  const name = readStringField(parsed, "name");
  const groupId = readStringField(parsed, "im_group_id");
  const memberCount = readNumberField(parsed, "member_count");
  const description = readStringField(parsed, "description");
  const parts = [
    `[分享群组] ${name ?? groupId ?? "群组"}`,
    groupId && name ? `(${groupId})` : undefined,
    memberCount !== undefined ? `成员: ${memberCount}` : undefined,
    description ? `描述: ${description}` : undefined,
  ].filter(Boolean);
  return parts.join(" ");
}

function formatShareUserContent(parsed: Record<string, unknown> | undefined): string {
  const nickname = readStringField(parsed, "nickname");
  const imUserId = readStringField(parsed, "im_user_id");
  const numericUserId = readNumberField(parsed, "user_id");
  const signature = readStringField(parsed, "signature");
  const userId = imUserId ?? (numericUserId !== undefined ? String(numericUserId) : undefined);
  const parts = [
    `[分享用户] ${nickname ?? userId ?? "用户"}`,
    userId && nickname ? `(${userId})` : undefined,
    signature ? `签名: ${signature}` : undefined,
  ].filter(Boolean);
  return parts.join(" ");
}

export function inferMessageTopicSummary(text: string, maxLength = 48): string | undefined {
  const normalized = trimToSingleLine(text)
    .replace(/^(@[^\s]+\s*)+/u, "")
    .replace(/^[,，。！？!?：:；;\-\s]+|[,，。！？!?：:；;\-\s]+$/gu, "");

  if (!normalized) {
    return undefined;
  }

  const firstClause = normalized
    .split(/[。！？!?；;\n]/u)
    .map((part) => part.trim())
    .find(Boolean)
    ?? normalized;

  return truncate(firstClause, maxLength);
}

export function inferMessageTopicTag(text: string, maxLength = 18): string | undefined {
  const summary = inferMessageTopicSummary(text, maxLength);
  return summary ? summary.replace(/[？?！!。,.，]/gu, "").trim() : undefined;
}

export function truncateForLog(text: string, maxLength = 280): string {
  return truncate(trimToSingleLine(text), maxLength);
}

export function looksQuestionLike(text: string): boolean {
  return /[?？]|(怎么|如何|推荐|建议|适合|要不要|是否|有没有|哪[里个种]|多长|多久|安排|路线|省心|轻松)/u.test(text);
}

export function mapGroupRoleName(roleValue?: number, roleNameValue?: string): string | undefined {
  const normalizedRoleName = roleNameValue?.trim();
  if (roleValue === 2 || normalizedRoleName === "owner") return "群主";
  if (roleValue === 1 || normalizedRoleName === "admin") return "管理员";
  if (roleValue === 0 || normalizedRoleName === "member") return "成员";
  return normalizedRoleName || undefined;
}

export function shouldStampSemanticUpdatedAt(pathValue: string): boolean {
  return pathValue.endsWith("/soul.json")
    || pathValue.endsWith("/members_graph.json")
    || /(?:^|\/)profiles\/[^/]+\.json$/.test(pathValue);
}

function trimToSingleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

export function extract43ChatTextContent(rawContent: unknown): string {
  const raw = typeof rawContent === "string" ? rawContent.trim() : "";
  if (!raw) {
    return "";
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const text = (parsed as Record<string, unknown>).content;
      if (typeof text === "string" && text.trim()) {
        return trimToSingleLine(text);
      }
    }
  } catch {
    // Fall back to the raw string when the payload is not JSON.
  }

  return trimToSingleLine(raw);
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

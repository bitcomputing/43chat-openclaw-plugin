export type Chat43TargetKind = "user" | "group";

export type Parsed43ChatTarget = {
  kind: Chat43TargetKind;
  id: string;
  normalized: string;
};

function stripChannelPrefix(raw: string): string {
  return raw.replace(/^43chat:/i, "");
}

export function parse43ChatTarget(raw: string): Parsed43ChatTarget | null {
  const trimmed = stripChannelPrefix(raw.trim());
  if (!trimmed) {
    return null;
  }

  const match = /^(user|group):(.+)$/i.exec(trimmed);
  if (match) {
    const kind = match[1].toLowerCase() as Chat43TargetKind;
    const id = match[2]?.trim();
    if (!id) {
      return null;
    }
    return {
      kind,
      id,
      normalized: `${kind}:${id}`,
    };
  }

  if (/^\d+$/.test(trimmed)) {
    return {
      kind: "user",
      id: trimmed,
      normalized: `user:${trimmed}`,
    };
  }

  return null;
}

export function normalize43ChatTarget(raw: string): string | null {
  return parse43ChatTarget(raw)?.normalized ?? null;
}

export function looksLike43ChatId(raw: string): boolean {
  return parse43ChatTarget(raw) !== null;
}

export function to43ChatAddress(raw: string): string | null {
  const normalized = normalize43ChatTarget(raw);
  if (!normalized) {
    return null;
  }
  return `43chat:${normalized}`;
}

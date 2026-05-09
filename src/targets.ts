export type Chat43TargetKind = "user" | "group";

export type Parsed43ChatTarget = {
  kind: Chat43TargetKind;
  id: string;
  normalized: string;
};

export function parse43ChatTarget(raw: string): Parsed43ChatTarget | null {
  const trimmed = raw.trim();
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

  if (/^\d+$/u.test(trimmed)) {
    return {
      kind: "user",
      id: trimmed,
      normalized: `user:${trimmed}`,
    };
  }

  return null;
}

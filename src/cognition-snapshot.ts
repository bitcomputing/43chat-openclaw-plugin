import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import type { LoadedSkillRuntime } from "./skill-runtime.js";
import { resolveSkillStorageTargets } from "./skill-runtime.js";
import { buildGroupScopedUserProfile } from "./user-profile-sanitization.js";

const STORAGE_ROOT = join(homedir(), ".config", "43chat");
const MAX_SNAPSHOT_CHARS = 1200;

export type CognitionSnapshotEntry = {
  alias: string;
  path: string;
  exists: boolean;
  content?: string;
};

type PromptSnapshotTransformParams = {
  eventType?: string;
  groupId?: string;
};

function resolveFullPath(relativePath: string, baseDir: string): string | null {
  const fullPath = join(baseDir, normalize(relativePath));
  if (!fullPath.startsWith(baseDir)) {
    return null;
  }
  return fullPath;
}

function truncateContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }
  return `${content.slice(0, maxChars)}\n...<truncated>`;
}

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

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value
    .map((item) => readString(item))
    .filter((item): item is string => Boolean(item));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readSnapshotContent(path: string): string {
  const raw = readFileSync(path, "utf8");
  try {
    return truncateContent(JSON.stringify(JSON.parse(raw), null, 2), MAX_SNAPSHOT_CHARS);
  } catch {
    return truncateContent(raw, MAX_SNAPSHOT_CHARS);
  }
}

export function readCognitionSnapshot(params: {
  runtime: LoadedSkillRuntime;
  aliases: string[];
  values: Record<string, string | undefined>;
  baseDir?: string;
}): CognitionSnapshotEntry[] {
  const targets = resolveSkillStorageTargets(params.runtime, params.aliases, params.values);
  const baseDir = params.baseDir ?? STORAGE_ROOT;

  return targets.map((target) => {
    const fullPath = resolveFullPath(target.path, baseDir);
    if (!fullPath || !existsSync(fullPath)) {
      return {
        alias: target.alias,
        path: target.path,
        exists: false,
      };
    }

    return {
      alias: target.alias,
      path: target.path,
      exists: true,
      content: readSnapshotContent(fullPath),
    };
  });
}

function buildGroupScopedUserProfileContent(content: string | undefined): string | undefined {
  if (!content) {
    return content;
  }
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isPlainObject(parsed)) {
      return content;
    }
    return truncateContent(JSON.stringify(buildGroupScopedUserProfile(parsed), null, 2), MAX_SNAPSHOT_CHARS);
  } catch {
    return content;
  }
}

export function transformCognitionSnapshotForPrompt(
  entries: CognitionSnapshotEntry[],
  params: PromptSnapshotTransformParams,
): CognitionSnapshotEntry[] {
  if (params.eventType !== "group_message" || !params.groupId) {
    return entries;
  }

  return entries.map((entry) => {
    if (!entry.exists || entry.alias !== "user_profile") {
      return entry;
    }

    return {
      ...entry,
      content: buildGroupScopedUserProfileContent(entry.content),
    };
  });
}

export function formatCognitionSnapshot(entries: CognitionSnapshotEntry[]): string[] {
  if (entries.length === 0) {
    return [];
  }

  const lines = ["【当前认知快照】"];
  for (const entry of entries) {
    lines.push(`- ${entry.alias} @ ${entry.path}`);
    if (!entry.exists) {
      lines.push("```json");
      lines.push("<missing>");
      lines.push("```");
      continue;
    }
    lines.push("```json");
    lines.push(entry.content ?? "{}");
    lines.push("```");
  }
  lines.push("");
  return lines;
}

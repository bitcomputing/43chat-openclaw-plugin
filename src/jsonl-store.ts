import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const DEFAULT_TAIL_CHUNK_BYTES = 16 * 1024;

export type JsonlCompactionOptions = {
  maxEntries: number;
  retainEntries: number;
  maintenanceMinBytes?: number;
  archiveDropped?: boolean;
};

function normalizeNonEmptyLines(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function resolveArchivePath(pathValue: string): string {
  return pathValue.endsWith(".jsonl")
    ? pathValue.replace(/\.jsonl$/u, ".archive.jsonl")
    : `${pathValue}.archive`;
}

export function readRecentJsonlLines(pathValue: string, limit: number): string[] {
  if (!existsSync(pathValue) || limit <= 0) {
    return [];
  }

  let fd: number | null = null;
  try {
    const stats = statSync(pathValue);
    if (stats.size <= 0) {
      return [];
    }

    fd = openSync(pathValue, "r");
    let position = stats.size;
    let buffer = "";
    let lines: string[] = [];

    while (position > 0 && lines.length <= limit) {
      const chunkSize = Math.min(DEFAULT_TAIL_CHUNK_BYTES, position);
      const start = position - chunkSize;
      const chunkBuffer = Buffer.alloc(chunkSize);
      const bytesRead = readSync(fd, chunkBuffer, 0, chunkSize, start);
      buffer = chunkBuffer.toString("utf8", 0, bytesRead) + buffer;
      lines = normalizeNonEmptyLines(buffer);
      position = start;
    }

    return lines.slice(-limit);
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      closeSync(fd);
    }
  }
}

export function readRecentJsonlRecords(pathValue: string, limit: number): Record<string, unknown>[] {
  return readRecentJsonlLines(pathValue, limit)
    .map((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
}

export function appendJsonlRecord(
  pathValue: string,
  content: Record<string, unknown>,
  options?: JsonlCompactionOptions,
): void {
  mkdirSync(dirname(pathValue), { recursive: true });
  appendFileSync(pathValue, `${JSON.stringify(content)}\n`, "utf8");
  if (options) {
    compactJsonlIfNeeded(pathValue, options);
  }
}

export function compactJsonlIfNeeded(pathValue: string, options: JsonlCompactionOptions): void {
  if (!existsSync(pathValue)) {
    return;
  }

  const stats = statSync(pathValue);
  if (stats.size < (options.maintenanceMinBytes ?? 128 * 1024)) {
    return;
  }

  const raw = readFileSync(pathValue, "utf8");
  const lines = normalizeNonEmptyLines(raw);
  if (lines.length <= options.maxEntries) {
    return;
  }

  const retainEntries = Math.max(1, Math.min(options.retainEntries, options.maxEntries));
  const dropped = lines.slice(0, -retainEntries);
  const retained = lines.slice(-retainEntries);

  if (options.archiveDropped && dropped.length > 0) {
    const archivePath = resolveArchivePath(pathValue);
    mkdirSync(dirname(archivePath), { recursive: true });
    appendFileSync(archivePath, `${dropped.join("\n")}\n`, "utf8");
  }

  writeFileSync(pathValue, `${retained.join("\n")}\n`, "utf8");
}

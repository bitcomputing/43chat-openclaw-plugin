import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendJsonlRecord, readRecentJsonlRecords } from "../jsonl-store.js";

describe("jsonl store", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads only the most recent jsonl records", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-jsonl-store-"));
    tempDirs.push(dir);
    const pathValue = join(dir, "decision_log.jsonl");

    for (let index = 1; index <= 6; index += 1) {
      appendJsonlRecord(pathValue, { id: index });
    }

    expect(readRecentJsonlRecords(pathValue, 3).map((entry) => entry.id)).toEqual([4, 5, 6]);
  });

  it("compacts oversized jsonl files and archives dropped lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-jsonl-store-"));
    tempDirs.push(dir);
    const pathValue = join(dir, "decision_log.jsonl");

    for (let index = 1; index <= 5; index += 1) {
      appendJsonlRecord(
        pathValue,
        { id: index, text: `message-${index}` },
        {
          maxEntries: 4,
          retainEntries: 3,
          maintenanceMinBytes: 1,
          archiveDropped: true,
        },
      );
    }

    const retained = readRecentJsonlRecords(pathValue, 10).map((entry) => entry.id);
    const archivePath = join(dir, "decision_log.archive.jsonl");
    const archived = existsSync(archivePath)
      ? readRecentJsonlRecords(archivePath, 10).map((entry) => entry.id)
      : [];

    expect(retained).toEqual([3, 4, 5]);
    expect(archived).toEqual([1, 2]);
    expect(readFileSync(pathValue, "utf8").trim().split("\n")).toHaveLength(3);
  });
});

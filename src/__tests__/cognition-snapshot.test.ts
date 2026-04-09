import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatCognitionSnapshot,
  readCognitionSnapshot,
  transformCognitionSnapshotForPrompt,
} from "../cognition-snapshot.js";
import { load43ChatSkillRuntime } from "../skill-runtime.js";

describe("43Chat cognition snapshot", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads current cognition files and formats them into prompt-ready snapshot lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-snapshot-"));
    tempDirs.push(dir);
    mkdirSync(join(dir, "groups/99"), { recursive: true });
    writeFileSync(join(dir, "groups/99/soul.json"), JSON.stringify({
      group_id: "99",
      source: "inferred",
      soul: { purpose: "聊旅游", topics: ["美食"] },
    }), "utf8");

    const runtime = load43ChatSkillRuntime();
    const entries = readCognitionSnapshot({
      runtime,
      aliases: ["group_soul", "group_state"],
      values: {
        group_id: "99",
      },
      baseDir: dir,
    });

    expect(entries).toEqual([
      expect.objectContaining({
        alias: "group_soul",
        path: "groups/99/soul.json",
        exists: true,
      }),
      expect.objectContaining({
        alias: "group_state",
        path: "groups/99/state.json",
        exists: false,
      }),
    ]);

    const lines = formatCognitionSnapshot(entries).join("\n");
    expect(lines).toContain("【当前认知快照】");
    expect(lines).toContain('"purpose": "聊旅游"');
    expect(lines).toContain("<missing>");
  });

  it("downweights private profile details when rendering group-message prompt snapshots", () => {
    const entries = transformCognitionSnapshotForPrompt([{
      alias: "user_profile",
      path: "profiles/12373.json",
      exists: true,
      content: JSON.stringify({
        schema_version: "1.0",
        user_id: "12373",
        nickname: "下雪啦",
        is_friend: true,
        tags: ["闲聊型", "户外爱好者"],
        expertise: [],
        personality: "直接、亲切、外向",
        influence_level: "",
        interaction_stats: {
          total_interactions: 12,
        },
        first_seen_context: "私聊",
        notes: "喜欢爬香山，想让我陪她去，称呼我小贝贝",
      }),
    }], {
      eventType: "group_message",
      groupId: "100",
    });

    expect(entries[0]?.content).toContain('"group_context_usage"');
    expect(entries[0]?.content).toContain('"tags": [');
    expect(entries[0]?.content).not.toContain("小贝贝");
    expect(entries[0]?.content).not.toContain("香山");
    expect(entries[0]?.content).not.toContain('"first_seen_context":');
    expect(entries[0]?.content).toContain('"omitted_fields"');
  });
});

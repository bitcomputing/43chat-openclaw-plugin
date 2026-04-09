import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDecisionBriefPromptBlocks,
  scheduleDecisionBriefRefresh,
} from "../cognition-batch.js";

describe("43Chat cognition batch", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders prompt blocks from persisted decision brief", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-decision-brief-"));
    tempDirs.push(dir);
    const briefPath = join(dir, "groups/100/decision_brief.json");
    mkdirSync(join(dir, "groups/100"), { recursive: true });
    writeFileSync(briefPath, JSON.stringify({
      schema_version: "1.0",
      scope: "group",
      group_id: "100",
      group_name: "项目工作群",
      updated_at: "2026-04-08T08:00:00.000Z",
      recent_decisions: [
        {
          ts: "2026-04-08T08:00:00.000Z",
          message_id: "msg-1",
          user_id: "12443",
          nickname: "素菜不好吃",
          decision: "reply_sent",
          moderation_decision: "observe",
          summary: "我们先把春节活动压测做完。",
        },
      ],
      pending_batch: null,
    }, null, 2), "utf8");

    const blocks = buildDecisionBriefPromptBlocks({
      baseDir: dir,
      event: {
        id: "evt-brief-1",
        event_type: "group_message",
        timestamp: 1000,
        data: {
          message_id: "msg-2",
          group_id: 100,
          group_name: "项目工作群",
          from_user_id: 12444,
          from_nickname: "才艺多",
          content_type: "text",
          content: "收到",
          user_role: 1,
          user_role_name: "admin",
          from_user_role: 0,
          from_user_role_name: "member",
          timestamp: 1000,
        },
      },
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.title).toBe("最近决策摘要");
    expect(blocks[0]?.lines).toContain(
      "下面是插件基于最近 decision_log 压缩出的轻量摘要，只作为当前轮的弱参考，不要把它当成新的群聊消息继续回复。",
    );
    expect(blocks[0]?.lines).toContain(
      "最近决策 #1: 素菜不好吃 -> 我们先把春节活动压测做完。 / decision=reply_sent / moderation=observe",
    );
  });

  it("refreshes group decision brief asynchronously after decision log update", async () => {
    vi.useFakeTimers();

    const dir = mkdtempSync(join(tmpdir(), "43chat-decision-brief-"));
    tempDirs.push(dir);
    const logPath = join(dir, "groups/100/decision_log.jsonl");
    mkdirSync(join(dir, "groups/100"), { recursive: true });
    writeFileSync(logPath, [
      JSON.stringify({
        ts: "2026-04-08T08:00:00.000Z",
        message_id: "msg-1",
        user_id: "12446",
        nickname: "神乎其技",
        current_message: "我建议上线前做一次完整演练，不只走正常参与流程。",
        decision: "no_reply",
        moderation_decision: "observe",
      }),
      "",
    ].join("\n"), "utf8");

    scheduleDecisionBriefRefresh({
      baseDir: dir,
      event: {
        id: "evt-brief-2",
        event_type: "group_message",
        timestamp: 2000,
        data: {
          message_id: "msg-1",
          group_id: 100,
          group_name: "项目工作群",
          from_user_id: 12446,
          from_nickname: "神乎其技",
          content_type: "text",
          content: "我建议上线前做一次完整演练，不只走正常参与流程。",
          user_role: 1,
          user_role_name: "admin",
          from_user_role: 0,
          from_user_role_name: "member",
          timestamp: 2000,
        },
      },
    });

    expect(existsSync(join(dir, "groups/100/decision_brief.json"))).toBe(false);

    await vi.advanceTimersByTimeAsync(4_100);

    const briefPath = join(dir, "groups/100/decision_brief.json");
    expect(existsSync(briefPath)).toBe(true);

    const brief = JSON.parse(readFileSync(briefPath, "utf8"));
    expect(brief.group_id).toBe("100");
    expect(brief.recent_decisions).toHaveLength(1);
    expect(brief.recent_decisions[0]).toMatchObject({
      message_id: "msg-1",
      user_id: "12446",
      nickname: "神乎其技",
      decision: "no_reply",
      moderation_decision: "observe",
    });
    expect(brief.recent_decisions[0].summary).toContain("我建议上线前做一次完整演练");
    expect(brief.pending_batch).toBeNull();
  });
});

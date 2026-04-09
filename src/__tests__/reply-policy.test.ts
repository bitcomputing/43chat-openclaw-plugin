import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateReplyPolicy } from "../reply-policy.js";

describe("43Chat reply policy", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exposes recent reply usage without forcing plugin-side no-reply", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-reply-policy-"));
    tempDirs.push(dir);
    mkdirSync(join(dir, "groups/99"), { recursive: true });
    writeFileSync(join(dir, "groups/99/decision_log.jsonl"), [
      JSON.stringify({ decision: "reply_sent" }),
      JSON.stringify({ decision: "reply_sent" }),
      JSON.stringify({ decision: "no_reply" }),
    ].join("\n"), "utf8");

    const result = evaluateReplyPolicy({
      baseDir: dir,
      event: {
        id: "evt-reply-policy-1",
        event_type: "group_message",
        timestamp: 1000,
        data: {
          message_id: 9001,
          group_id: 99,
          group_name: "测试群",
          from_user_id: 123,
          from_nickname: "Alice",
          content_type: "text",
          content: "这句只是顺手接一句",
          user_role: 0,
          user_role_name: "member",
          timestamp: 1000,
        },
      },
    });

    expect(result.noReplyToken).toBe("NO_REPLY");
    expect(result.forceNoReply).toBe(false);
    expect(result.recentReplyCount).toBe(2);
    expect(result.reason).toBeUndefined();
  });

  it("allows question-like messages to bypass the quota by default", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-reply-policy-"));
    tempDirs.push(dir);
    mkdirSync(join(dir, "groups/99"), { recursive: true });
    writeFileSync(join(dir, "groups/99/decision_log.jsonl"), [
      JSON.stringify({ decision: "reply_sent" }),
      JSON.stringify({ decision: "reply_sent" }),
    ].join("\n"), "utf8");

    const result = evaluateReplyPolicy({
      baseDir: dir,
      event: {
        id: "evt-reply-policy-2",
        event_type: "group_message",
        timestamp: 1000,
        data: {
          message_id: 9002,
          group_id: 99,
          group_name: "测试群",
          from_user_id: 123,
          from_nickname: "Alice",
          content_type: "text",
          content: "这个你怎么看？",
          user_role: 0,
          user_role_name: "member",
          timestamp: 1000,
        },
      },
    });

    expect(result.questionLike).toBe(true);
    expect(result.forceNoReply).toBe(false);
    expect(result.reason).toBeUndefined();
  });
});

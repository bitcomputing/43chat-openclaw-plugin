import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDissolveGroupTool,
  createInviteGroupMembersTool,
  createRemoveGroupMemberTool,
  createUpdateGroupTool,
} from "../group-management-tools.js";
import packageJson from "../../package.json" with { type: "json" };

function createCfg() {
  return {
    channels: {
      [packageJson.openclaw.channel.id]: {
        baseUrl: "https://43chat.cn",
        apiKey: "sk-test",
      },
    },
  } as never;
}

describe("43Chat group management tools", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("invites members into a group", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          code: 0,
          message: "ok",
          timestamp: 1,
          data: {
            success_count: 2,
            failed_count: 0,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ));
    vi.stubGlobal("fetch", fetchMock);

    const tool = createInviteGroupMembersTool(createCfg());
    const result = await tool.execute("tool-1", {
      groupId: "95",
      memberIds: ["10001", "10002"],
    });

    expect(result.content[0]?.text).toContain("\"ok\": true");
    expect(result.content[0]?.text).toContain("\"successCount\": 2");
  });

  it("updates group metadata", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          code: 0,
          message: "ok",
          timestamp: 1,
          data: {
            group_id: 95,
            name: "新群名",
            updated_at: 2,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ));
    vi.stubGlobal("fetch", fetchMock);

    const tool = createUpdateGroupTool(createCfg());
    const result = await tool.execute("tool-2", {
      groupId: "95",
      name: "新群名",
    });

    expect(result.content[0]?.text).toContain("\"ok\": true");
    expect(result.content[0]?.text).toContain("\"group_id\": 95");
  });

  it("removes a group member", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          code: 0,
          message: "ok",
          timestamp: 1,
          data: {
            user_id: 10002,
            removed_at: 3,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ));
    vi.stubGlobal("fetch", fetchMock);

    const tool = createRemoveGroupMemberTool(createCfg());
    const result = await tool.execute("tool-3", {
      groupId: "95",
      userId: "10002",
      reason: "违反群规",
    });

    expect(result.content[0]?.text).toContain("\"ok\": true");
    expect(result.content[0]?.text).toContain("\"userId\": \"10002\"");
  });

  it("dissolves a group", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          code: 0,
          message: "ok",
          timestamp: 1,
          data: {
            group_id: 95,
            dissolved_at: 4,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ));
    vi.stubGlobal("fetch", fetchMock);

    const tool = createDissolveGroupTool(createCfg());
    const result = await tool.execute("tool-4", {
      groupId: "95",
      reason: "群组目的已达成",
    });

    expect(result.content[0]?.text).toContain("\"ok\": true");
    expect(result.content[0]?.text).toContain("\"dissolvedAt\": 4");
  });
});

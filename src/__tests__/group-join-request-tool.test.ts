import { afterEach, describe, expect, it, vi } from "vitest";
import { createHandleGroupJoinRequestTool } from "../group-join-request-tool.js";
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

describe("chat43_handle_group_join_request tool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("handles a request directly by requestId", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/open/group/join-request/81")) {
        return new Response(
          JSON.stringify({
            code: 0,
            message: "ok",
            timestamp: 1,
            data: {
              request_id: 81,
              action: "approve",
              processed_at: 1,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = createHandleGroupJoinRequestTool(createCfg());
    const result = await tool.execute("tool-1", {
      action: "approve",
      requestId: "81",
    });

    expect(result.content[0]?.text).toContain("\"ok\": true");
    expect(result.content[0]?.text).toContain("\"requestId\": \"81\"");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to lookup by groupId and applicantUserId", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/open/group/95/join-requests?status=pending")) {
        return new Response(
          JSON.stringify({
            code: 0,
            message: "ok",
            timestamp: 1,
            data: {
              list: [
                {
                  request_id: 82,
                  group_id: 95,
                  user_id: 12446,
                  nickname: "神乎其技",
                  message: "申请已提交，等待管理员审核",
                  status: "pending",
                  created_at: 1,
                },
              ],
              total: 1,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/open/group/join-request/82") && init?.method === "PUT") {
        return new Response(
          JSON.stringify({
            code: 0,
            message: "ok",
            timestamp: 1,
            data: {
              request_id: 82,
              action: "reject",
              processed_at: 2,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = createHandleGroupJoinRequestTool(createCfg());
    const result = await tool.execute("tool-2", {
      action: "reject",
      groupId: "95",
      applicantUserId: "12446",
      rejectReason: "疑似广告账号",
    });

    expect(result.content[0]?.text).toContain("\"ok\": true");
    expect(result.content[0]?.text).toContain("\"resolvedFrom\": \"lookup\"");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { sendMessage43Chat } from "../send.js";

describe("sendMessage43Chat", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends private messages to the private send endpoint", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Response(
        JSON.stringify({
          code: 0,
          message: "ok",
          timestamp: 1,
          data: { message_id: "m-1", sent_at: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ));

    vi.stubGlobal("fetch", fetchMock);

    const result = await sendMessage43Chat({
      cfg: {
        channels: {
          ["43chat"]: {
            baseUrl: "https://example.com",
            apiKey: "sk-test",
          },
        },
      } as never,
      to: "user:123",
      text: "hello",
    });

    expect(result).toEqual({
      messageId: "m-1",
      chatId: "user:123",
      targetType: "user",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/open/message/private/send",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });
});

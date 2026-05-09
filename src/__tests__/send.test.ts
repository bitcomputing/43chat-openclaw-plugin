import { afterEach, describe, expect, it, vi } from "vitest";
import { sendMessage43Chat } from "../send.js";
import packageJson from "../../package.json" with { type: "json" };

describe("sendMessage43Chat", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends private messages to the private send endpoint", async () => {
    const fetchMock = vi.fn(async () =>
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
          [packageJson.openclaw.channel.id]: {
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
        body: JSON.stringify({
          to_user_id: 123,
          content: "hello",
          msg_type: "text",
        }),
      }),
    );
  });

  it("sends group messages to the group send endpoint", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          code: 0,
          message: "ok",
          timestamp: 1,
          data: { message_id: "m-2", sent_at: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ));

    vi.stubGlobal("fetch", fetchMock);

    const result = await sendMessage43Chat({
      cfg: {
        channels: {
          [packageJson.openclaw.channel.id]: {
            baseUrl: "https://example.com",
            apiKey: "sk-test",
          },
        },
      } as never,
      to: "group:99",
      text: "hello group",
    });

    expect(result).toEqual({
      messageId: "m-2",
      chatId: "group:99",
      targetType: "group",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/open/message/group/send",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          group_id: 99,
          content: "hello group",
          msg_type: "text",
        }),
      }),
    );
  });
});

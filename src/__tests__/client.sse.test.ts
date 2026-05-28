import { describe, expect, it } from "vitest";
import { create43ChatClient, SSEFrameParser } from "../client.js";

describe("SSEFrameParser", () => {
  it("parses comment heartbeats and JSON data frames", () => {
    const parser = new SSEFrameParser();
    const frames = parser.feed(
      ":heartbeat\n\nid: 1\nevent: private_message\ndata: {\"id\":\"1\","
      + "\"event_type\":\"private_message\",\"data\":{\"message_id\":\"m1\"},\"timestamp\":1}\n\n",
    );

    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({ comment: "heartbeat" });
    expect(frames[1]).toEqual({
      id: "1",
      event: "private_message",
      data: "{\"id\":\"1\",\"event_type\":\"private_message\",\"data\":{\"message_id\":\"m1\"},\"timestamp\":1}",
    });
  });

  it("joins multi-line data payloads", () => {
    const parser = new SSEFrameParser();
    const frames = parser.feed("data: {\"a\":1,\ndata: \"b\":2}\n\n");

    expect(frames).toEqual([
      {
        data: "{\"a\":1,\n\"b\":2}",
      },
    ]);
  });

  it("rejects non-ASCII api keys before opening SSE", async () => {
    const client = create43ChatClient({
      accountId: "default",
      enabled: true,
      configured: true,
      baseUrl: "https://43chat.cn",
      apiKey: "abc…123",
      config: {},
    } as never);

    await expect(client.connectSSE({
      onEvent: async () => {},
    })).rejects.toThrow("non-ASCII characters");
  });
});

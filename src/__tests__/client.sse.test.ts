import { describe, expect, it } from "vitest";
import { SSEFrameParser } from "../client.js";

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
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { chat43Outbound } from "../outbound.js";
import packageJson from "../../package.json" with { type: "json" };

vi.mock("../send.js", () => ({
  sendMessage43Chat: vi.fn(),
}));

describe("chat43Outbound", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("suppresses NO_REPLY text", async () => {
    const { sendMessage43Chat } = await import("../send.js");
    const result = await chat43Outbound.sendText!({
      cfg: {} as never,
      to: "group:100",
      text: "NO_REPLY",
      accountId: "default",
    } as never);

    expect(sendMessage43Chat).not.toHaveBeenCalled();
    expect(result).toEqual({
      channel: packageJson.openclaw.channel.id,
      messageId: "suppressed",
      chatId: "group:100",
    });
  });

  it("suppresses cognition envelope text", async () => {
    const { sendMessage43Chat } = await import("../send.js");
    const result = await chat43Outbound.sendText!({
      cfg: {} as never,
      to: "group:100",
      text: "<chat43-cognition>{\"writes\":[],\"reply\":\"NO_REPLY\"}</chat43-cognition>",
      accountId: "default",
    } as never);

    expect(sendMessage43Chat).not.toHaveBeenCalled();
    expect(result).toEqual({
      channel: packageJson.openclaw.channel.id,
      messageId: "suppressed",
      chatId: "group:100",
    });
  });
});

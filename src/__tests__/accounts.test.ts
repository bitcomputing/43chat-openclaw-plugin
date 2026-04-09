import { describe, expect, it } from "vitest";
import { resolve43ChatAccount } from "../accounts.js";

describe("43Chat account defaults", () => {
  it("uses raw chunk mode by default", () => {
    const account = resolve43ChatAccount({
      cfg: {
        channels: {
          "43chat-openclaw-plugin": {
            apiKey: "test-key",
            baseUrl: "https://43chat.cn",
          },
        },
      } as any,
    });

    expect(account.config.chunkMode).toBe("raw");
  });
});

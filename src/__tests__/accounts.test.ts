import { describe, expect, it } from "vitest";
import { resolve43ChatAccount } from "../accounts.js";

describe("43Chat account defaults", () => {
  it("resolves the default account from channel config", () => {
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

    expect(account.accountId).toBe("default");
    expect(account.enabled).toBe(true);
    expect(account.configured).toBe(true);
    expect(account.baseUrl).toBe("https://43chat.cn");
    expect(account.apiKey).toBe("test-key");
  });
});

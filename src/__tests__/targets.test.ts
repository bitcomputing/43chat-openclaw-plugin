import { describe, expect, it } from "vitest";
import { looksLike43ChatId, normalize43ChatTarget, parse43ChatTarget, to43ChatAddress } from "../targets.js";

describe("43Chat target parsing", () => {
  it("parses user targets", () => {
    expect(parse43ChatTarget("user:123")).toEqual({
      kind: "user",
      id: "123",
      normalized: "user:123",
    });
  });

  it("parses group targets with channel prefix", () => {
    expect(normalize43ChatTarget("43chat:group:456")).toBe("group:456");
    expect(to43ChatAddress("group:456")).toBe("43chat:group:456");
  });

  it("treats bare numeric targets as users", () => {
    expect(normalize43ChatTarget("789")).toBe("user:789");
    expect(looksLike43ChatId("789")).toBe(true);
  });
});

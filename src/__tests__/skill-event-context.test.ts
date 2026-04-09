import { describe, expect, it } from "vitest";
import { resolvePromptRoleName } from "../skill-event-context.js";

describe("skill event context", () => {
  it("prefers explicit role over cognition snapshot", () => {
    expect(resolvePromptRoleName({
      roleName: "管理员",
      snapshot: [{
        alias: "group_state",
        path: "groups/68/state.json",
        exists: true,
        content: JSON.stringify({ my_role: "成员" }),
      }],
    })).toBe("管理员");
  });

  it("falls back to persisted my_role from group_state", () => {
    expect(resolvePromptRoleName({
      snapshot: [{
        alias: "group_state",
        path: "groups/68/state.json",
        exists: true,
        content: JSON.stringify({ my_role: "成员" }),
      }],
    })).toBe("成员");
  });

  it("returns unknown when no role is available", () => {
    expect(resolvePromptRoleName({
      snapshot: [],
    })).toBe("未知");
  });
});

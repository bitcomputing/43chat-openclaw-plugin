import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureSessionLogDir,
  resolveSessionLogDir,
  sessionKeyToLogDirname,
} from "../session-log-dir.js";

describe("43Chat session log directory helpers", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maps a session key to the llm-logger directory name", () => {
    expect(sessionKeyToLogDirname("agent:main:43chat-openclaw-plugin:group:group:97")).toBe(
      "agent_main_43chat-openclaw-plugin_group_group_97",
    );
  });

  it("falls back to the unknown session directory when the key is empty", () => {
    expect(sessionKeyToLogDirname("")).toBe("_unknown_session_key");
    expect(sessionKeyToLogDirname(undefined)).toBe("_unknown_session_key");
  });

  it("creates the session log directory inside OPENCLAW_HOME", () => {
    const openclawHome = mkdtempSync(join(tmpdir(), "43chat-openclaw-home-"));
    tempDirs.push(openclawHome);
    const env = { ...process.env, OPENCLAW_HOME: openclawHome };

    const dir = ensureSessionLogDir("agent:main:main", env);

    expect(dir).toBe(resolveSessionLogDir("agent:main:main", env));
    expect(existsSync(dir)).toBe(true);
  });
});

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const DEFAULT_OPENCLAW_HOME_DIRNAME = ".openclaw";
const UNKNOWN_SESSION_DIRNAME = "_unknown_session_key";

function expandHomePrefix(input: string): string {
  if (!input.startsWith("~")) {
    return input;
  }
  if (input === "~") {
    return homedir();
  }
  if (input.startsWith("~/")) {
    return join(homedir(), input.slice(2));
  }
  return input;
}

export function resolveOpenClawHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.OPENCLAW_HOME?.trim();
  if (!configured) {
    return join(homedir(), DEFAULT_OPENCLAW_HOME_DIRNAME);
  }
  return resolve(expandHomePrefix(configured));
}

export function sessionKeyToLogDirname(sessionKey?: string | null): string {
  const normalized = (sessionKey ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || UNKNOWN_SESSION_DIRNAME;
}

export function resolveSessionLogDir(
  sessionKey?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(resolveOpenClawHome(env), "logs", sessionKeyToLogDirname(sessionKey));
}

export function ensureSessionLogDir(
  sessionKey?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dir = resolveSessionLogDir(sessionKey, env);
  mkdirSync(dir, { recursive: true });
  return dir;
}

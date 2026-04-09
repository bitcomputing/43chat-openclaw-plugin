import { appendFileSync } from "node:fs";
import { join } from "node:path";

const LOG_FILE = join("/tmp", "43chat-openclaw-plugin.log");

function formatLog(level: string, accountId: string | undefined, message: string): string {
  const timestamp = new Date().toISOString();
  const account = accountId ? `[${accountId}]` : "";
  return `${timestamp} [${level}]${account} ${message}\n`;
}

export function logInfo(accountId: string | undefined, message: string): void {
  const line = formatLog("INFO", accountId, message);
  try {
    appendFileSync(LOG_FILE, line, "utf8");
  } catch {
    // ignore write errors
  }
}

export function logError(accountId: string | undefined, message: string, error?: unknown): void {
  let fullMessage = message;
  if (error) {
    fullMessage += ` - ${error instanceof Error ? error.message : String(error)}`;
    if (error instanceof Error && error.stack) {
      fullMessage += `\nStack: ${error.stack}`;
    }
  }
  const line = formatLog("ERROR", accountId, fullMessage);
  try {
    appendFileSync(LOG_FILE, line, "utf8");
  } catch {
    // ignore write errors
  }
}

import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import type { Chat43SendResult } from "./types.js";
import { resolve43ChatAccount } from "./accounts.js";
import { create43ChatClient } from "./client.js";
import { parse43ChatTarget } from "./targets.js";
import { logInfo, logError } from "./logger.js";

export type Send43ChatMessageParams = {
  cfg: ClawdbotConfig;
  to: string;
  text: string;
  accountId?: string;
};

export async function sendMessage43Chat(
  params: Send43ChatMessageParams,
): Promise<Chat43SendResult> {
  const { cfg, to, text, accountId } = params;
  const account = resolve43ChatAccount({ cfg, accountId });

  logInfo(account.accountId, `sendMessage43Chat: to=${to}, textLength=${text.length}`);

  if (!account.configured) {
    const error = `43Chat account "${account.accountId}" not configured`;
    logError(account.accountId, error);
    throw new Error(error);
  }

  const target = parse43ChatTarget(to);
  if (!target) {
    const error = `Invalid 43Chat target: ${to}`;
    logError(account.accountId, error);
    throw new Error(error);
  }

  logInfo(account.accountId, `Sending to ${target.kind}:${target.id}`);

  try {
    const client = create43ChatClient(account);
    const result = await client.sendText({
      targetType: target.kind,
      targetId: target.id,
      text: text ?? "",
    });
    logInfo(account.accountId, `Send success: messageId=${result.messageId}, chatId=${result.chatId}`);
    return result;
  } catch (error) {
    logError(account.accountId, `Send failed to ${target.kind}:${target.id}`, error);
    throw error;
  }
}

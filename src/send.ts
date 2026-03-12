import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import type { Chat43SendResult } from "./types.js";
import { resolve43ChatAccount } from "./accounts.js";
import { create43ChatClient } from "./client.js";
import { parse43ChatTarget } from "./targets.js";

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

  if (!account.configured) {
    throw new Error(`43Chat account "${account.accountId}" not configured`);
  }

  const target = parse43ChatTarget(to);
  if (!target) {
    throw new Error(`Invalid 43Chat target: ${to}`);
  }

  const client = create43ChatClient(account);
  return client.sendText({
    targetType: target.kind,
    targetId: target.id,
    text: text ?? "",
  });
}

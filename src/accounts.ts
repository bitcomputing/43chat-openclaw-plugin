import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import type { Chat43Config, Resolved43ChatAccount } from "./types.js";

const DEFAULT_ACCOUNT_ID = "default";

function readOptionalNonBlankString(value: unknown): string | undefined {
  if (typeof value === "number" && !Number.isNaN(value)) {
    return String(value);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.replace(/\/+$/, "");
}

export function resolve43ChatAccount({
  cfg,
  accountId = DEFAULT_ACCOUNT_ID,
}: {
  cfg: ClawdbotConfig;
  accountId?: string;
}): Resolved43ChatAccount {
  const chatCfg = cfg.channels?.["43chat"] as Chat43Config | undefined;
  const isDefault = accountId === DEFAULT_ACCOUNT_ID;

  const topLevelBaseUrl = normalizeBaseUrl(readOptionalNonBlankString(chatCfg?.baseUrl));
  const topLevelApiKey = readOptionalNonBlankString(chatCfg?.apiKey);

  if (isDefault && chatCfg) {
    const configured = Boolean(topLevelBaseUrl && topLevelApiKey);
    return {
      accountId: DEFAULT_ACCOUNT_ID,
      enabled: chatCfg.enabled ?? true,
      configured,
      name: "Default",
      baseUrl: topLevelBaseUrl,
      apiKey: topLevelApiKey,
      config: {
        baseUrl: topLevelBaseUrl,
        apiKey: topLevelApiKey,
        dmPolicy: chatCfg.dmPolicy ?? "open",
        allowFrom: chatCfg.allowFrom ?? [],
        requestTimeoutMs: chatCfg.requestTimeoutMs,
        sseReconnectDelayMs: chatCfg.sseReconnectDelayMs,
        sseMaxReconnectDelayMs: chatCfg.sseMaxReconnectDelayMs,
        textChunkLimit: chatCfg.textChunkLimit,
        chunkMode: chatCfg.chunkMode ?? "newline",
        blockStreaming: chatCfg.blockStreaming ?? false,
      },
    };
  }

  const accountCfg = chatCfg?.accounts?.[accountId];
  const merged = {
    baseUrl:
      normalizeBaseUrl(readOptionalNonBlankString(accountCfg?.baseUrl))
      ?? topLevelBaseUrl,
    apiKey: readOptionalNonBlankString(accountCfg?.apiKey) ?? topLevelApiKey,
    dmPolicy: accountCfg?.dmPolicy ?? chatCfg?.dmPolicy ?? "open",
    allowFrom: accountCfg?.allowFrom ?? chatCfg?.allowFrom ?? [],
    requestTimeoutMs: accountCfg?.requestTimeoutMs ?? chatCfg?.requestTimeoutMs,
    sseReconnectDelayMs: accountCfg?.sseReconnectDelayMs ?? chatCfg?.sseReconnectDelayMs,
    sseMaxReconnectDelayMs:
      accountCfg?.sseMaxReconnectDelayMs ?? chatCfg?.sseMaxReconnectDelayMs,
    textChunkLimit: accountCfg?.textChunkLimit ?? chatCfg?.textChunkLimit,
    chunkMode: accountCfg?.chunkMode ?? chatCfg?.chunkMode ?? "newline",
    blockStreaming: accountCfg?.blockStreaming ?? chatCfg?.blockStreaming ?? false,
  };

  return {
    accountId,
    enabled: accountCfg?.enabled ?? chatCfg?.enabled ?? true,
    configured: Boolean(merged.baseUrl && merged.apiKey),
    name: accountCfg?.name,
    baseUrl: merged.baseUrl,
    apiKey: merged.apiKey,
    config: {
      ...merged,
    },
  };
}

export function list43ChatAccountIds(cfg: ClawdbotConfig): string[] {
  const chatCfg = cfg.channels?.["43chat"] as Chat43Config | undefined;
  const ids = [DEFAULT_ACCOUNT_ID];
  if (chatCfg?.accounts) {
    ids.push(...Object.keys(chatCfg.accounts));
  }
  return ids;
}

export function resolveDefault43ChatAccountId(_cfg: ClawdbotConfig): string {
  return DEFAULT_ACCOUNT_ID;
}

export function listEnabled43ChatAccounts(cfg: ClawdbotConfig): Resolved43ChatAccount[] {
  return list43ChatAccountIds(cfg)
    .map((accountId) => resolve43ChatAccount({ cfg, accountId }))
    .filter((account) => account.enabled && account.configured);
}

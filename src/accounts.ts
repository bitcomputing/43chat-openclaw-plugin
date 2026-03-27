import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import type { Chat43Config, Resolved43ChatAccount } from "./types.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import packageJson from "../package.json" with { type: "json" };

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
  const chatCfg = cfg.channels?.[packageJson.openclaw.channel.id] as Chat43Config | undefined;
  const isDefault = accountId === DEFAULT_ACCOUNT_ID;



  let topLevelBaseUrl: string | undefined;
  let topLevelApiKey: string | undefined;

  // Determine apiKey
  if (!chatCfg || !readOptionalNonBlankString(chatCfg.apiKey)) {
    // Try to read api_key from ~/.config/43chat/credentials.json
    try {
      const credPath = join(homedir(), ".config", "43chat", "credentials.json");
      const content = readFileSync(credPath, "utf-8");
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed.api_key === "string" && parsed.api_key.trim()) {
        topLevelApiKey = parsed.api_key.trim();
      }
    } catch {
      topLevelApiKey = undefined;
    }
  } else {
    topLevelApiKey = readOptionalNonBlankString(chatCfg.apiKey);
  }

  // Determine baseUrl
  if (!chatCfg || !readOptionalNonBlankString(chatCfg.baseUrl)) {
    topLevelBaseUrl = "https://43chat.cn";
  } else {
    topLevelBaseUrl = normalizeBaseUrl(readOptionalNonBlankString(chatCfg.baseUrl));
  }

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
        promptGroupContextEnabled: chatCfg.promptGroupContextEnabled,
        promptGroupContextApiPath: chatCfg.promptGroupContextApiPath,
        promptGroupContextRefreshMs: chatCfg.promptGroupContextRefreshMs,
        promptGroupContextMaxItems: chatCfg.promptGroupContextMaxItems,
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
    promptGroupContextEnabled:
      accountCfg?.promptGroupContextEnabled ?? chatCfg?.promptGroupContextEnabled,
    promptGroupContextApiPath:
      readOptionalNonBlankString(accountCfg?.promptGroupContextApiPath)
      ?? readOptionalNonBlankString(chatCfg?.promptGroupContextApiPath),
    promptGroupContextRefreshMs:
      accountCfg?.promptGroupContextRefreshMs ?? chatCfg?.promptGroupContextRefreshMs,
    promptGroupContextMaxItems:
      accountCfg?.promptGroupContextMaxItems ?? chatCfg?.promptGroupContextMaxItems,
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
  const chatCfg = cfg.channels?.[packageJson.openclaw.channel.id] as Chat43Config | undefined;
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

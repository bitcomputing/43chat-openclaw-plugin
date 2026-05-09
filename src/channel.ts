import type { ChannelPlugin, ClawdbotConfig } from "openclaw/plugin-sdk";
import type { Chat43Config, Resolved43ChatAccount } from "./types.js";
import {
  list43ChatAccountIds,
  resolve43ChatAccount,
  resolveDefault43ChatAccountId,
} from "./accounts.js";
import { probe43ChatAccount } from "./client.js";
import packageJson from "../package.json" with { type: "json" };

const DEFAULT_ACCOUNT_ID = "default";

const meta = {
  id: packageJson.openclaw.channel.id,
  label: packageJson.openclaw.channel.label,
  selectionLabel: packageJson.openclaw.channel.selectionLabel,
  docsPath: packageJson.openclaw.channel.docsPath,
  docsLabel: packageJson.openclaw.channel.docsLabel,
  blurb: packageJson.openclaw.channel.blurb,
  order: packageJson.openclaw.channel.order,
  version: packageJson.version,
};

function upsertChannelConfig(
  cfg: ClawdbotConfig,
  patch: Record<string, unknown>,
): ClawdbotConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      [packageJson.openclaw.channel.id]: {
        ...(cfg.channels?.[packageJson.openclaw.channel.id] as Record<string, unknown> | undefined),
        ...patch,
      },
    },
  };
}

export const chat43Plugin: ChannelPlugin<Resolved43ChatAccount> = {
  id: packageJson.openclaw.channel.id,
  meta,

  capabilities: {
    chatTypes: ["direct", "group"],
    polls: false,
    threads: false,
    media: false,
    reactions: false,
    edit: false,
    reply: true,
  },

  reload: { configPrefixes: [`channels.${packageJson.openclaw.channel.id}`] },

  configSchema: {
    schema: {
      type: "object",
      additionalProperties: true,
      properties: {
        enabled: { type: "boolean", default: true, title: "启用账号" },
        baseUrl: { type: "string", format: "uri", default: "https://43chat.cn", title: "43Chat 地址" },
        apiKey: { type: "string", title: "API Key" },
        requestTimeoutMs: { type: "integer", minimum: 1000, title: "请求超时(ms)" },
        sseReconnectDelayMs: { type: "integer", minimum: 100, title: "SSE重连起始延迟(ms)" },
        sseMaxReconnectDelayMs: { type: "integer", minimum: 1000, title: "SSE最大重连延迟(ms)" },
        sseHeartbeatTimeoutMs: { type: "integer", minimum: 1000, title: "SSE心跳超时(ms)" },
        accounts: {
          type: "object",
            additionalProperties: {
              type: "object",
              additionalProperties: true,
              properties: {
              enabled: { type: "boolean", default: true, title: "启用账号" },
              name: { type: "string", title: "账号名称" },
              baseUrl: { type: "string", default: "https://43chat.cn", format: "uri", title: "43Chat 地址" },
              apiKey: { type: "string", title: "API Key" },
              requestTimeoutMs: { type: "integer", minimum: 1000, title: "请求超时(ms)" },
              sseReconnectDelayMs: { type: "integer", minimum: 100, title: "SSE重连起始延迟(ms)" },
              sseMaxReconnectDelayMs: { type: "integer", minimum: 1000, title: "SSE最大重连延迟(ms)" },
              sseHeartbeatTimeoutMs: { type: "integer", minimum: 1000, title: "SSE心跳超时(ms)" },
            },
          },
        },
      },
    },
  },

  config: {
    listAccountIds: (cfg: ClawdbotConfig) => list43ChatAccountIds(cfg),
    resolveAccount: (cfg: ClawdbotConfig, accountId?: string | null) =>
      resolve43ChatAccount({ cfg, accountId: accountId ?? DEFAULT_ACCOUNT_ID }),
    defaultAccountId: (cfg: ClawdbotConfig) => resolveDefault43ChatAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return upsertChannelConfig(cfg, { enabled });
      }

      const chatCfg = cfg.channels?.[packageJson.openclaw.channel.id] as Chat43Config | undefined;
      return upsertChannelConfig(cfg, {
        accounts: {
          ...chatCfg?.accounts,
          [accountId]: {
            ...chatCfg?.accounts?.[accountId],
            enabled,
          },
        },
      });
    },
    deleteAccount: ({ cfg, accountId }) => {
      if (accountId === DEFAULT_ACCOUNT_ID) {
        const nextChannels = { ...cfg.channels };
        delete (nextChannels as Record<string, unknown>)[packageJson.openclaw.channel.id];
        return Object.keys(nextChannels).length > 0
          ? { ...cfg, channels: nextChannels }
          : { ...cfg, channels: undefined };
      }

      const chatCfg = cfg.channels?.[packageJson.openclaw.channel.id] as Chat43Config | undefined;
      const accounts = { ...chatCfg?.accounts };
      delete accounts[accountId];
      return upsertChannelConfig(cfg, {
        accounts: Object.keys(accounts).length > 0 ? accounts : undefined,
      });
    },
    isConfigured: (account: Resolved43ChatAccount) => account.configured,
    describeAccount: (account: Resolved43ChatAccount) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      name: account.name,
      baseUrl: account.baseUrl,
    }),
    resolveAllowFrom: () => [],
    formatAllowFrom: ({ allowFrom }) => allowFrom.map(String).filter(Boolean),
  },

  security: {
    collectWarnings: () => [],
  },

  setup: {
    resolveAccountId: () => DEFAULT_ACCOUNT_ID,
    applyAccountConfig: ({ cfg, accountId }) => {
      const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
      if (resolvedAccountId === DEFAULT_ACCOUNT_ID) {
        return upsertChannelConfig(cfg, { enabled: true });
      }

      const chatCfg = cfg.channels?.[packageJson.openclaw.channel.id] as Chat43Config | undefined;
      return upsertChannelConfig(cfg, {
        accounts: {
          ...chatCfg?.accounts,
          [resolvedAccountId]: {
            ...chatCfg?.accounts?.[resolvedAccountId],
            enabled: true,
          },
        },
      });
    },
  },

  directory: {
    self: async () => null,
    listPeers: async () => [],
    listGroups: async () => [],
    listPeersLive: async () => [],
    listGroupsLive: async () => [],
  },

  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      mode: "idle",
      reconnectAttempts: 0,
      lastConnectedAt: null,
      lastDisconnect: null,
      lastStartAt: null,
      lastStopAt: null,
      lastInboundAt: null,
      lastOutboundAt: null,
      lastError: null,
      port: null,
    } as never,
    buildChannelSummary: ({ snapshot }: { snapshot: Record<string, unknown> }) => ({
      configured: (snapshot.configured as boolean) ?? false,
      running: (snapshot.running as boolean) ?? false,
      connected: (snapshot.connected as boolean) ?? false,
      connectionState: (snapshot.connectionState as string | null) ?? (snapshot.mode as string | null) ?? null,
      reconnectAttempts: (snapshot.reconnectAttempts as number | null) ?? 0,
      nextRetryAt: (snapshot.nextRetryAt as number | null) ?? null,
      lastConnectedAt: (snapshot.lastConnectedAt as number | null) ?? null,
      lastDisconnect: (snapshot.lastDisconnect as Record<string, unknown> | null) ?? null,
      lastStartAt: (snapshot.lastStartAt as number | null) ?? null,
      lastStopAt: (snapshot.lastStopAt as number | null) ?? null,
      lastInboundAt: (snapshot.lastInboundAt as number | null) ?? null,
      lastOutboundAt: (snapshot.lastOutboundAt as number | null) ?? null,
      lastError: (snapshot.lastError as string | null) ?? null,
      baseUrl: (snapshot.baseUrl as string | null) ?? null,
      probe: snapshot.probe,
      lastProbeAt: (snapshot.lastProbeAt as number | null) ?? null,
    }),
    probeAccount: async ({ account }) => probe43ChatAccount({ account }),
    buildAccountSnapshot: ({ account, runtime, probe }) => {
      const runtimeRecord = runtime as Record<string, unknown> | undefined;
      return {
        accountId: account.accountId,
        enabled: account.enabled,
        configured: account.configured,
        name: account.name,
        baseUrl: account.baseUrl,
        running: (runtime?.running as boolean) ?? false,
        connected: (runtime?.connected as boolean) ?? (probe as { ok?: boolean } | undefined)?.ok ?? false,
        mode: (runtimeRecord?.connectionState as string | null) ?? (runtime?.mode as string | null) ?? null,
        reconnectAttempts: (runtime?.reconnectAttempts as number | null) ?? 0,
        lastConnectedAt: (runtime?.lastConnectedAt as number | null) ?? null,
        lastDisconnect: (runtime?.lastDisconnect as Record<string, unknown> | null) ?? null,
        lastStartAt: (runtime?.lastStartAt as number | null) ?? null,
        lastStopAt: (runtime?.lastStopAt as number | null) ?? null,
        lastInboundAt: (runtime?.lastInboundAt as number | null) ?? null,
        lastOutboundAt: (runtime?.lastOutboundAt as number | null) ?? null,
        lastError: (runtime?.lastError as string | null) ?? null,
        nextRetryAt: (runtimeRecord?.nextRetryAt as number | null) ?? null,
        probe,
      } as never;
    },
  },

  gateway: {
    startAccount: async (ctx) => {
      const { monitor43ChatProvider } = await import("./monitor.js");
      ctx.setStatus({
        accountId: ctx.accountId,
        baseUrl: ctx.account.baseUrl ?? null,
        running: true,
        connected: false,
        mode: "connecting",
        lastStartAt: Date.now(),
        lastStopAt: null,
        lastError: null,
      } as never);
      ctx.log?.info(`starting 43chat[${ctx.accountId}] SSE`);
      return monitor43ChatProvider({
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        accountId: ctx.accountId,
        statusSink: (patch) =>
          ctx.setStatus({
            accountId: ctx.accountId,
            baseUrl: ctx.account.baseUrl ?? null,
            ...patch,
            mode: (patch.connectionState as string | undefined) ?? (ctx.getStatus().mode as string | undefined),
          } as never),
      });
    },
  },
};

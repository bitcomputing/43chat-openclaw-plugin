import type { ChannelPlugin, ClawdbotConfig } from "openclaw/plugin-sdk";
import type { Chat43Config, Resolved43ChatAccount } from "./types.js";
import {
  list43ChatAccountIds,
  resolve43ChatAccount,
  resolveDefault43ChatAccountId,
} from "./accounts.js";
import { chat43Outbound } from "./outbound.js";
import { probe43ChatAccount } from "./client.js";
import { looksLike43ChatId, normalize43ChatTarget } from "./targets.js";
import { sendMessage43Chat } from "./send.js";

const DEFAULT_ACCOUNT_ID = "default";
const PAIRING_APPROVED_MESSAGE = "✓ You have been approved to chat with this agent.";

const meta = {
  id: "43chat",
  label: "43Chat",
  selectionLabel: "43Chat",
  docsPath: "/channels/43chat",
  docsLabel: "43chat",
  blurb: "43Chat OpenAPI + SSE channel.",
  order: 85,
};

export const chat43Plugin: ChannelPlugin<Resolved43ChatAccount> = {
  id: "43chat",
  meta,

  pairing: {
    idLabel: "chat43Id",
    normalizeAllowEntry: (entry: string) => entry.replace(/^43chat:/i, ""),
    notifyApproval: async ({ cfg, id }) => {
      await sendMessage43Chat({
        cfg,
        to: id,
        text: PAIRING_APPROVED_MESSAGE,
      });
    },
  },

  capabilities: {
    chatTypes: ["direct", "group"],
    polls: false,
    threads: false,
    media: false,
    reactions: false,
    edit: false,
    reply: false,
  },

  agentPrompt: {
    messageToolHints: () => [
      "- 🚨 核心规则：只发送最终回复内容到 43Chat",
      "- 回复 43Chat 消息时流程：1. 内部静默查看历史记录 2. 分析和思考 3. 只发送一次最终回复",
      "- ❌ 严禁发送：思考过程、内部信号、系统错误、调试/日志、指令输出、非人类内容、无意义标记",
      "- ✅ 只发送：最终人类可读回复，一次性发送",
      '- 发送前自查："这是人类会说的话吗？" 直接回复，无多余说明或标记。',
      "- 43Chat 目标说明：省略 `target` 表示回复当前会话；显式目标格式为 `user:<id>` 或 `group:<id>`。",
    ],
  },

  reload: { configPrefixes: ["channels.43chat"] },

  configSchema: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", default: true, title: "启用账号" },
        baseUrl: { type: "string", format: "uri", title: "43Chat 地址" },
        apiKey: { type: "string", title: "API Key" },
        dmPolicy: {
          type: "string",
          enum: ["open", "pairing"],
          default: "open",
          title: "私信策略",
        },
        allowFrom: {
          type: "array",
          items: { type: "string" },
          title: "允许列表",
        },
        requestTimeoutMs: {
          type: "integer",
          minimum: 1000,
          title: "请求超时(ms)",
        },
        sseReconnectDelayMs: {
          type: "integer",
          minimum: 100,
          title: "SSE重连起始延迟(ms)",
        },
        sseMaxReconnectDelayMs: {
          type: "integer",
          minimum: 1000,
          title: "SSE最大重连延迟(ms)",
        },
        textChunkLimit: {
          type: "integer",
          minimum: 1,
          title: "文本分片限制",
        },
        chunkMode: {
          type: "string",
          enum: ["length", "newline", "raw"],
          default: "newline",
          title: "分片模式",
        },
        blockStreaming: {
          type: "boolean",
          default: false,
          title: "启用流式块发送",
        },
        accounts: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              enabled: { type: "boolean", default: true, title: "启用账号" },
              name: { type: "string", title: "账号名称" },
              baseUrl: { type: "string", format: "uri", title: "43Chat 地址" },
              apiKey: { type: "string", title: "API Key" },
              requestTimeoutMs: { type: "integer", minimum: 1000, title: "请求超时(ms)" },
              sseReconnectDelayMs: { type: "integer", minimum: 100, title: "SSE重连起始延迟(ms)" },
              sseMaxReconnectDelayMs: { type: "integer", minimum: 1000, title: "SSE最大重连延迟(ms)" },
              textChunkLimit: { type: "integer", minimum: 1, title: "文本分片限制" },
              chunkMode: {
                type: "string",
                enum: ["length", "newline", "raw"],
                default: "newline",
                title: "分片模式",
              },
              blockStreaming: {
                type: "boolean",
                default: false,
                title: "启用流式块发送",
              },
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
    setAccountEnabled: ({
      cfg,
      accountId,
      enabled,
    }: {
      cfg: ClawdbotConfig;
      accountId: string;
      enabled: boolean;
    }) => {
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            ["43chat"]: {
              ...(cfg.channels?.["43chat"] as Record<string, unknown> | undefined),
              enabled,
            },
          },
        };
      }

      const chatCfg = cfg.channels?.["43chat"] as Chat43Config | undefined;
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          ["43chat"]: {
            ...chatCfg,
            accounts: {
              ...chatCfg?.accounts,
              [accountId]: {
                ...chatCfg?.accounts?.[accountId],
                enabled,
              },
            },
          },
        },
      };
    },
    deleteAccount: ({
      cfg,
      accountId,
    }: {
      cfg: ClawdbotConfig;
      accountId: string;
    }) => {
      if (accountId === DEFAULT_ACCOUNT_ID) {
        const next = { ...cfg } as ClawdbotConfig;
        const nextChannels = { ...cfg.channels };
        delete (nextChannels as Record<string, unknown>)["43chat"];
        if (Object.keys(nextChannels).length > 0) {
          next.channels = nextChannels;
        } else {
          delete next.channels;
        }
        return next;
      }

      const chatCfg = cfg.channels?.["43chat"] as Chat43Config | undefined;
      const accounts = { ...chatCfg?.accounts };
      delete accounts[accountId];
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          ["43chat"]: {
            ...chatCfg,
            accounts: Object.keys(accounts).length > 0 ? accounts : undefined,
          },
        },
      };
    },
    isConfigured: (account: Resolved43ChatAccount) => account.configured,
    describeAccount: (account: Resolved43ChatAccount) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      name: account.name,
      baseUrl: account.baseUrl,
    }),
    resolveAllowFrom: ({
      cfg,
      accountId,
    }: {
      cfg: ClawdbotConfig;
      accountId?: string | null;
    }) => {
      const account = resolve43ChatAccount({ cfg, accountId: accountId ?? DEFAULT_ACCOUNT_ID });
      return (account.config.allowFrom ?? [])
        .map((entry) => String(entry).trim())
        .filter(Boolean);
    },
    formatAllowFrom: ({ allowFrom }: { allowFrom: (string | number)[] }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean),
  },

  security: {
    collectWarnings: () => [],
  },

  setup: {
    resolveAccountId: () => DEFAULT_ACCOUNT_ID,
    applyAccountConfig: ({
      cfg,
      accountId,
    }: {
      cfg: ClawdbotConfig;
      accountId?: string;
    }) => {
      const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
      if (resolvedAccountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            ["43chat"]: {
              ...(cfg.channels?.["43chat"] as Record<string, unknown> | undefined),
              enabled: true,
            },
          },
        };
      }

      const chatCfg = cfg.channels?.["43chat"] as Chat43Config | undefined;
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          ["43chat"]: {
            ...chatCfg,
            accounts: {
              ...chatCfg?.accounts,
              [resolvedAccountId]: {
                ...chatCfg?.accounts?.[resolvedAccountId],
                enabled: true,
              },
            },
          },
        },
      };
    },
  },

  messaging: {
    normalizeTarget: (raw: string) => normalize43ChatTarget(raw) ?? undefined,
    targetResolver: {
      looksLikeId: looksLike43ChatId,
      hint: "<user:<id>|group:<id>>",
    },
  },

  directory: {
    self: async () => null,
    listPeers: async () => [],
    listGroups: async () => [],
    listPeersLive: async () => [],
    listGroupsLive: async () => [],
  },

  outbound: chat43Outbound,

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
      connectionState:
        (snapshot.connectionState as string | null)
        ?? (snapshot.mode as string | null)
        ?? null,
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
        mode:
          (runtimeRecord?.connectionState as string | null)
          ?? (runtime?.mode as string | null)
          ?? null,
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
            mode:
              (patch.connectionState as string | undefined)
              ?? (ctx.getStatus().mode as string | undefined),
          } as never),
      });
    },
  },
};

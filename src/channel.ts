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
import { load43ChatSkillRuntime } from "./skill-runtime.js";
import packageJson from "../package.json" with { type: "json" };

const DEFAULT_ACCOUNT_ID = "default";
const PAIRING_APPROVED_MESSAGE = "✓ You have been approved to chat with this agent.";

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

export const chat43Plugin: ChannelPlugin<Resolved43ChatAccount> = {
  id: packageJson.openclaw.channel.id,
  meta,

  pairing: {
    idLabel: "chat43Id",
    normalizeAllowEntry: (entry: string) => entry.replace(new RegExp(`^${packageJson.openclaw.channel.id}\\s*:\\s*`, "i"), ""),
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
    messageToolHints: ({ cfg, accountId }) => {
      const runtime = load43ChatSkillRuntime(cfg);
      const docPaths = Object.values(runtime.data.docs)
        .map((filename) => `${runtime.docsDir}/${filename}`);
      const baseHints = [
        '- 核心规则: 只发送最终回复内容到 43Chat',
        '- 回复流程: 1. 内部查看历史 2. 分析思考 3. 发送最终回复',
        '- 严禁发送: 思考过程, 内部信号, 系统错误, 调试日志',
        '- 只发送: 最终人类可读回复',
        '- 最终输出协议: 只允许纯文本; 不要输出 JSON / XML / markdown 代码块',
        '- 43Chat 目标: 省略 target 表示回复当前会话; 格式为 user:<id> 或 group:<id>',
        '- 入群申请: 先判断再调用 chat43_handle_group_join_request',
        '- 群管理动作工具: chat43_invite_group_members / chat43_update_group / chat43_remove_group_member / chat43_dissolve_group',
      ];

      return [
        ...baseHints,
        '',
        '## 43Chat Skill Runtime',
        '',
        `- 账号: ${accountId ?? "default"}`,
        `- runtime 来源: ${runtime.source === "file" ? runtime.runtimePath : `builtin (${runtime.runtimePath})`}`,
        `- skill 目录: ${runtime.docsDir}`,
        '',
        '收到消息时必须执行:',
        '',
        '### 步骤1: 遵循当前事件 profile',
        '- 事件专属安全规则由插件在上下文中动态注入',
        '- 按当前事件决定是回复纯文本还是输出 NO_REPLY',
        '',
        '### 步骤2: 完成内部推理',
        '- 内部推理覆盖字段由当前事件 profile 决定',
        '- 不要显式输出 `<think>` 块、thinking 文本、XML 标签或思维链；最终只输出当前协议要求的纯文本结果',
        '',
        '### 步骤3: 执行决策',
        '- 根据推理结果回复、沉默、或执行允许的群管理工具',
        '- 不要读写认知 JSON / JSONL 文件，不要维护画像，不要触发后台分析',
        '- 入群申请执行工具，不要只回复文本',
        '',
        '### Skill 文档',
        ...docPaths.map((path) => `- ${path}`),
      ];
    },
  },

  reload: { configPrefixes: [`channels.${packageJson.openclaw.channel.id}`] },

  configSchema: { 
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", default: true, title: "启用账号" },
        baseUrl: { type: "string", format: "uri", default: "https://43chat.cn", title: "43Chat 地址" },
        apiKey: { type: "string", title: "API Key" },
        skillDocsDir: { type: "string", title: "Skill 文档目录" },
        skillRuntimePath: { type: "string", title: "Skill Runtime 路径" },
        version: { type: "string", default: packageJson.version, title: "当前插件版本" },
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
        promptGroupContextEnabled: {
          type: "boolean",
          default: false,
          title: "启用群组身份Prompt上下文",
        },
        promptGroupContextApiPath: {
          type: "string",
          default: "/open/group/list",
          title: "群组身份拉取API路径",
        },
        promptGroupContextRefreshMs: {
          type: "integer",
          default: 60000,
          minimum: 5000,
          title: "群组身份刷新间隔(ms)",
        },
        promptGroupContextMaxItems: {
          type: "integer",
          default: 50,
          minimum: 1,
          title: "Prompt中最多注入群组条数",
        },
        textChunkLimit: {
          type: "integer",
          minimum: 1,
          title: "文本分片限制",
        },
        chunkMode: {
          type: "string",
          enum: ["length", "newline", "raw"],
          default: "raw",
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
              baseUrl: { type: "string", default: "https://43chat.cn", format: "uri", title: "43Chat 地址" },
              apiKey: { type: "string", title: "API Key" },
              requestTimeoutMs: { type: "integer", minimum: 1000, title: "请求超时(ms)" },
              sseReconnectDelayMs: { type: "integer", minimum: 100, title: "SSE重连起始延迟(ms)" },
              sseMaxReconnectDelayMs: { type: "integer", minimum: 1000, title: "SSE最大重连延迟(ms)" },
              promptGroupContextEnabled: {
                type: "boolean",
                default: false,
                title: "启用群组身份Prompt上下文",
              },
              promptGroupContextApiPath: {
                type: "string",
                default: "/open/group/list",
                title: "群组身份拉取API路径",
              },
              promptGroupContextRefreshMs: {
                type: "integer",
                default: 60000,
                minimum: 5000,
                title: "群组身份刷新间隔(ms)",
              },
              promptGroupContextMaxItems: {
                type: "integer",
                default: 50,
                minimum: 1,
                title: "Prompt中最多注入群组条数",
              },
              textChunkLimit: { type: "integer", minimum: 1, title: "文本分片限制" },
              chunkMode: {
                type: "string",
                enum: ["length", "newline", "raw"],
                default: "raw",
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
            [packageJson.openclaw.channel.id]: {
              ...(cfg.channels?.[packageJson.openclaw.channel.id] as Record<string, unknown> | undefined),
              enabled,
            },
          },
        };
      }

      const chatCfg = cfg.channels?.[packageJson.openclaw.channel.id] as Chat43Config | undefined;
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          [packageJson.openclaw.channel.id]: {
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
        delete (nextChannels as Record<string, unknown>)[packageJson.openclaw.channel.id];
        if (Object.keys(nextChannels).length > 0) {
          next.channels = nextChannels;
        } else {
          delete next.channels;
        }
        return next;
      }

      const chatCfg = cfg.channels?.[packageJson.openclaw.channel.id] as Chat43Config | undefined;
      const accounts = { ...chatCfg?.accounts };
      delete accounts[accountId];
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          [packageJson.openclaw.channel.id]: {
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
            [packageJson.openclaw.channel.id]: {
              ...(cfg.channels?.[packageJson.openclaw.channel.id] as Record<string, unknown> | undefined),
              enabled: true,
            },
          },
        };
      }

      const chatCfg = cfg.channels?.[packageJson.openclaw.channel.id] as Chat43Config | undefined;
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          [packageJson.openclaw.channel.id]: {
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

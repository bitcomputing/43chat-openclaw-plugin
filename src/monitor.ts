import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { listEnabled43ChatAccounts, resolve43ChatAccount } from "./accounts.js";
import { create43ChatClient, Chat43ApiError } from "./client.js";
import { handle43ChatEvent } from "./bot.js";
import { waitUntilAbortCompat } from "./plugin-sdk-compat.js";
import { startPromptGroupContextRefresher, stopPromptGroupContextRefresher } from "./prompt-group-context.js";
import type { Chat43AnySSEEvent, Chat43RuntimeStatusPatch, Resolved43ChatAccount } from "./types.js";

export type Monitor43ChatOpts = {
  config?: ClawdbotConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  accountId?: string;
  statusSink?: (patch: Chat43RuntimeStatusPatch) => void;
};

const monitorControllers = new Map<string, AbortController>();

function waitForDelay(delayMs: number, signal?: AbortSignal): Promise<boolean> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(() => resolve(false), delayMs));
  }
  if (signal.aborted) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function combineSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const filtered = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (filtered.length === 0) {
    return undefined;
  }
  if (filtered.length === 1) {
    return filtered[0];
  }

  const controller = new AbortController();
  const onAbort = (event: Event) => {
    const source = event.target as AbortSignal | null;
    controller.abort(source?.reason);
    for (const signal of filtered) {
      signal.removeEventListener("abort", onAbort);
    }
  };

  for (const signal of filtered) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }

  return controller.signal;
}

async function monitorSingleAccount(params: {
  cfg: ClawdbotConfig;
  account: Resolved43ChatAccount;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: Chat43RuntimeStatusPatch) => void;
}): Promise<void> {
  const { cfg, account, runtime, abortSignal, statusSink } = params;
  const { accountId } = account;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;
  const emitStatus = (patch: Chat43RuntimeStatusPatch) => statusSink?.(patch);

  const localController = new AbortController();
  monitorControllers.set(accountId, localController);
  const combinedSignal = combineSignals([abortSignal, localController.signal]);

  let reconnectAttempts = 0;
  const reconnectBaseDelay = account.config.sseReconnectDelayMs ?? 1_000;
  const reconnectMaxDelay = account.config.sseMaxReconnectDelayMs ?? 60_000;

  const stopStatus = () => {
    emitStatus({
      running: false,
      connected: false,
      connectionState: "stopped",
      nextRetryAt: null,
      lastStopAt: Date.now(),
    });
  };

  if (combinedSignal?.aborted) {
    stopStatus();
    return;
  }

  combinedSignal?.addEventListener("abort", stopStatus, { once: true });
  startPromptGroupContextRefresher({ account, runtime });

  try {
    while (!combinedSignal?.aborted) {
      emitStatus({
        running: true,
        connected: false,
        connectionState: "connecting",
        lastStartAt: Date.now(),
        nextRetryAt: null,
        lastError: null,
      });

      log(`43chat[${accountId}]: connecting SSE stream...`);

      try {
        const client = create43ChatClient(account);
        await client.connectSSE<Chat43AnySSEEvent>({
          signal: combinedSignal,
          onOpen: () => {
            reconnectAttempts = 0;
            emitStatus({
              running: true,
              connected: true,
              connectionState: "connected",
              reconnectAttempts: 0,
              nextRetryAt: null,
              lastConnectedAt: Date.now(),
              lastError: null,
            });
            log(`43chat[${accountId}]: SSE connected`);
          },
          onHeartbeat: () => {
            emitStatus({
              running: true,
              connected: true,
              connectionState: "connected",
            });
            log(`43chat[${accountId}]: SSE heartbeat`);
          },
          onInvalidFrame: (frame, reason) => {
            error(`43chat[${accountId}]: invalid SSE frame (${reason}): ${JSON.stringify(frame)}`);
          },
          onEvent: async (event) => {
            emitStatus({ lastInboundAt: Date.now() });
            log(`43chat[${accountId}]: SSE event: ${JSON.stringify(event)}`);
            await handle43ChatEvent({
              cfg,
              event,
              accountId,
              runtime,
            });
          },
        });

        if (combinedSignal?.aborted) {
          break;
        }

        throw new Chat43ApiError({
          message: "43Chat SSE stream closed unexpectedly",
          retryable: true,
        });
      } catch (err) {
        if (combinedSignal?.aborted) {
          break;
        }

        reconnectAttempts += 1;
        const message = err instanceof Error ? err.message : String(err);
        const retryable = err instanceof Chat43ApiError ? err.retryable : true;

        if (!retryable) {
          emitStatus({
            running: true,
            connected: false,
            connectionState: "error",
            reconnectAttempts,
            lastError: message,
            nextRetryAt: null,
            lastDisconnect: {
              code: err instanceof Chat43ApiError ? err.status ?? 0 : 0,
              reason: message,
              at: Date.now(),
            },
          });
          error(`43chat[${accountId}]: fatal SSE error: ${message}`);
          await waitUntilAbortCompat(combinedSignal);
          break;
        }

        const delay = Math.min(
          reconnectBaseDelay * Math.max(1, 2 ** (reconnectAttempts - 1)),
          reconnectMaxDelay,
        );
        const nextRetryAt = Date.now() + delay;

        emitStatus({
          running: true,
          connected: false,
          connectionState: "backoff",
          reconnectAttempts,
          nextRetryAt,
          lastError: message,
          lastDisconnect: {
            code: err instanceof Chat43ApiError ? err.status ?? 0 : 0,
            reason: message,
            at: Date.now(),
          },
        });

        error(`43chat[${accountId}]: SSE error, retrying in ${delay}ms: ${message}`);

        const aborted = await waitForDelay(delay, combinedSignal);
        if (aborted) {
          break;
        }
      }
    }
  } finally {
    stopPromptGroupContextRefresher(accountId, runtime);
    if (monitorControllers.get(accountId) === localController) {
      monitorControllers.delete(accountId);
    }
    stopStatus();
  }
}

export async function monitor43ChatProvider(opts: Monitor43ChatOpts = {}): Promise<void> {
  const cfg = opts.config;
  if (!cfg) {
    throw new Error("Config is required for 43Chat monitor");
  }

  if (opts.accountId) {
    const account = resolve43ChatAccount({ cfg, accountId: opts.accountId });
    if (!account.enabled || !account.configured) {
      throw new Error(`43Chat account "${opts.accountId}" not configured or disabled`);
    }
    return monitorSingleAccount({
      cfg,
      account,
      runtime: opts.runtime,
      abortSignal: opts.abortSignal,
      statusSink: opts.statusSink,
    });
  }

  const accounts = listEnabled43ChatAccounts(cfg);
  if (accounts.length === 0) {
    throw new Error("No enabled 43Chat accounts configured");
  }

  await Promise.all(
    accounts.map((account) =>
      monitorSingleAccount({
        cfg,
        account,
        runtime: opts.runtime,
        abortSignal: opts.abortSignal,
        statusSink: opts.statusSink,
      }),
    ),
  );
}

export function stop43ChatMonitor(accountId?: string): void {
  if (accountId) {
    monitorControllers.get(accountId)?.abort();
    monitorControllers.delete(accountId);
    return;
  }

  for (const controller of monitorControllers.values()) {
    controller.abort();
  }
  monitorControllers.clear();
}

import type { Resolved43ChatAccount, Chat43AgentProfile, Chat43OpenApiResponse, Chat43Probe, Chat43SendResult } from "./types.js";

export type ParsedSSEFrame = {
  id?: string;
  event?: string;
  data?: string;
  comment?: string;
};

export class Chat43ApiError extends Error {
  readonly status?: number;
  readonly code?: number;
  readonly retryable: boolean;
  readonly responseBody?: string;

  constructor(params: {
    message: string;
    status?: number;
    code?: number;
    retryable?: boolean;
    responseBody?: string;
  }) {
    super(params.message);
    this.name = "Chat43ApiError";
    this.status = params.status;
    this.code = params.code;
    this.retryable = params.retryable ?? false;
    this.responseBody = params.responseBody;
  }
}

export class SSEFrameParser {
  private buffer = "";
  private eventId: string | undefined;
  private eventName: string | undefined;
  private commentLines: string[] = [];
  private dataLines: string[] = [];

  feed(chunk: string): ParsedSSEFrame[] {
    this.buffer += chunk;
    const frames: ParsedSSEFrame[] = [];

    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }

      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      this.consumeLine(line, frames);
    }

    return frames;
  }

  finish(): ParsedSSEFrame[] {
    const frames: ParsedSSEFrame[] = [];
    if (this.buffer.length > 0) {
      this.consumeLine(this.buffer, frames);
      this.buffer = "";
    }
    this.flush(frames);
    return frames;
  }

  private consumeLine(line: string, frames: ParsedSSEFrame[]): void {
    if (line === "") {
      this.flush(frames);
      return;
    }

    if (line.startsWith(":")) {
      this.commentLines.push(line.slice(1).trim());
      return;
    }

    const separatorIndex = line.indexOf(":");
    const field = separatorIndex >= 0 ? line.slice(0, separatorIndex) : line;
    let value = separatorIndex >= 0 ? line.slice(separatorIndex + 1) : "";
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    switch (field) {
      case "id":
        this.eventId = value;
        break;
      case "event":
        this.eventName = value;
        break;
      case "data":
        this.dataLines.push(value);
        break;
      default:
        break;
    }
  }

  private flush(frames: ParsedSSEFrame[]): void {
    if (
      this.eventId === undefined
      && this.eventName === undefined
      && this.dataLines.length === 0
      && this.commentLines.length === 0
    ) {
      return;
    }

    frames.push({
      id: this.eventId,
      event: this.eventName,
      data: this.dataLines.length > 0 ? this.dataLines.join("\n") : undefined,
      comment: this.commentLines.length > 0 ? this.commentLines.join("\n") : undefined,
    });

    this.eventId = undefined;
    this.eventName = undefined;
    this.commentLines = [];
    this.dataLines = [];
  }
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Request timed out")), timeoutMs);
  const abortFromParent = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abortFromParent, { once: true });

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromParent);
    },
  };
}

function createAuthHeaders(apiKey: string, extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("Authorization", `Bearer ${apiKey}`);
  return headers;
}

function isOpenApiSuccess<T>(value: unknown): value is Chat43OpenApiResponse<T> {
  return Boolean(value) && typeof value === "object" && typeof (value as { code?: unknown }).code === "number";
}

async function parseResponseJson<T>(response: Response): Promise<Chat43OpenApiResponse<T> | null> {
  const text = await response.text();
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text) as Chat43OpenApiResponse<T>;
  } catch {
    return null;
  }
}

type ConnectSSEOptions<T> = {
  signal?: AbortSignal;
  onOpen?: () => void;
  onEvent: (event: T) => Promise<void> | void;
  onHeartbeat?: () => void;
  onInvalidFrame?: (frame: ParsedSSEFrame, reason: string) => void;
};

type SendTextParams = {
  targetType: "user" | "group";
  targetId: string;
  text: string;
};

export function create43ChatClient(account: Resolved43ChatAccount) {
  const baseUrl = account.baseUrl;
  const apiKey = account.apiKey;
  const requestTimeoutMs = account.config.requestTimeoutMs ?? 15_000;

  if (!baseUrl || !apiKey) {
    throw new Error(`43Chat account "${account.accountId}" not configured`);
  }

  async function requestJson<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<Chat43OpenApiResponse<T>> {
    const { signal, cleanup } = withTimeout(init.signal ?? undefined, requestTimeoutMs);
    try {
      const response = await fetch(new URL(path, `${baseUrl}/`).toString(), {
        ...init,
        signal,
        headers: createAuthHeaders(apiKey, {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...init.headers,
        }),
      });

      const json = await parseResponseJson<T>(response);
      const message = json?.message || `${response.status} ${response.statusText}`;

      if (!response.ok) {
        throw new Chat43ApiError({
          message,
          status: response.status,
          code: json?.code,
          retryable: response.status >= 500 || response.status === 429,
          responseBody: json ? JSON.stringify(json) : undefined,
        });
      }

      if (!json || !isOpenApiSuccess<T>(json)) {
        throw new Chat43ApiError({
          message: "43Chat returned an invalid JSON response",
          status: response.status,
          retryable: false,
        });
      }

      if (json.code !== 0) {
        throw new Chat43ApiError({
          message: json.message || "43Chat API request failed",
          status: response.status,
          code: json.code,
          retryable: response.status >= 500 || response.status === 429,
          responseBody: JSON.stringify(json),
        });
      }

      return json;
    } catch (err) {
      if (err instanceof Chat43ApiError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new Chat43ApiError({
        message,
        retryable: true,
      });
    } finally {
      cleanup();
    }
  }

  async function connectSSE<T>(options: ConnectSSEOptions<T>): Promise<void> {
    const response = await fetch(new URL("/open/events/stream", `${baseUrl}/`).toString(), {
      method: "GET",
      signal: options.signal,
      headers: createAuthHeaders(apiKey, {
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
      }),
    });

    if (!response.ok) {
      const json = await parseResponseJson<unknown>(response);
      throw new Chat43ApiError({
        message: json?.message || `${response.status} ${response.statusText}`,
        status: response.status,
        code: json?.code,
        retryable: response.status >= 500 || response.status === 429,
        responseBody: json ? JSON.stringify(json) : undefined,
      });
    }

    if (!response.body) {
      throw new Chat43ApiError({
        message: "43Chat SSE response body is empty",
        retryable: true,
      });
    }

    options.onOpen?.();

    const parser = new SSEFrameParser();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        const chunk = decoder.decode(value, { stream: true });
        const frames = parser.feed(chunk);
        for (const frame of frames) {
          if (frame.comment?.includes("heartbeat")) {
            options.onHeartbeat?.();
            continue;
          }

          if (!frame.data) {
            options.onInvalidFrame?.(frame, "missing_data");
            continue;
          }

          try {
            await options.onEvent(JSON.parse(frame.data) as T);
          } catch (err) {
            options.onInvalidFrame?.(
              frame,
              err instanceof Error ? err.message : String(err),
            );
          }
        }
      }

      const trailingFrames = parser.finish();
      for (const frame of trailingFrames) {
        if (frame.comment?.includes("heartbeat")) {
          options.onHeartbeat?.();
          continue;
        }
        if (!frame.data) {
          continue;
        }
        try {
          await options.onEvent(JSON.parse(frame.data) as T);
        } catch (err) {
          options.onInvalidFrame?.(frame, err instanceof Error ? err.message : String(err));
        }
      }
    } catch (err) {
      if (options.signal?.aborted) {
        return;
      }
      throw err;
    } finally {
      reader.releaseLock();
    }

    if (!options.signal?.aborted) {
      throw new Chat43ApiError({
        message: "43Chat SSE stream closed",
        retryable: true,
      });
    }
  }

  async function getProfile(): Promise<Chat43AgentProfile> {
    const response = await requestJson<Chat43AgentProfile>("/open/agent/profile", {
      method: "GET",
    });
    if (!response.data) {
      throw new Chat43ApiError({
        message: "43Chat profile response missing data",
        retryable: false,
      });
    }
    return response.data;
  }

  async function sendText(params: SendTextParams): Promise<Chat43SendResult> {
    const path = params.targetType === "user"
      ? "/open/message/private/send"
      : "/open/message/group/send";
    const body = params.targetType === "user"
      ? {
          to_user_id: Number(params.targetId),
          content: params.text,
          msg_type: "text",
        }
      : {
          group_id: Number(params.targetId),
          content: params.text,
          msg_type: "text",
        };

    const response = await requestJson<{ message_id: string; sent_at: number }>(path, {
      method: "POST",
      body: JSON.stringify(body),
    });

    return {
      messageId: response.data?.message_id ?? `43chat_${Date.now()}`,
      chatId: `${params.targetType}:${params.targetId}`,
      targetType: params.targetType,
    };
  }

  return {
    requestJson,
    connectSSE,
    getProfile,
    sendText,
  };
}

export async function probe43ChatAccount(params: {
  account: Resolved43ChatAccount;
  timeoutMs?: number;
}): Promise<Chat43Probe> {
  const { account, timeoutMs } = params;
  if (!account.configured) {
    return {
      ok: false,
      error: "43Chat account not configured",
    };
  }

  try {
    const client = create43ChatClient({
      ...account,
      config: {
        ...account.config,
        requestTimeoutMs: timeoutMs ?? account.config.requestTimeoutMs,
      },
    });
    const profile = await client.getProfile();
    return {
      ok: true,
      agentId: profile.agent_id,
      userId: profile.user_id,
      name: profile.name,
      status: profile.status,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

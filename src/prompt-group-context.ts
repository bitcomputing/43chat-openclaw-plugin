import { create43ChatClient } from "./client.js";
import type { Resolved43ChatAccount } from "./types.js";

type GroupContextItem = {
  groupId: string;
  groupName?: string;
  role?: string;
};

type PromptGroupContextSnapshot = {
  updatedAt: number;
  groups: GroupContextItem[];
  error?: string;
};

const snapshotByAccountId = new Map<string, PromptGroupContextSnapshot>();
const refreshTimerByAccountId = new Map<string, ReturnType<typeof setInterval>>();

function readString(value: unknown): string | undefined {
  if (typeof value === "number" && !Number.isNaN(value)) {
    return String(value);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function toPlainObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function parseGroupContextItems(payload: unknown): GroupContextItem[] {
  const root = toPlainObject(payload);
  if (!root) {
    return [];
  }

  const candidates = [
    root.groups,
    root.list,
    root.group_list,
    toPlainObject(root.data)?.groups,
    toPlainObject(root.data)?.list,
    toPlainObject(root.data)?.group_list,
  ];

  const list = candidates.find((entry) => Array.isArray(entry));
  if (!Array.isArray(list)) {
    return [];
  }

  const groups: GroupContextItem[] = [];
  for (const item of list) {
    const obj = toPlainObject(item);
    if (!obj) {
      continue;
    }
    const groupId = readString(obj.group_id ?? obj.groupId ?? obj.id);
    if (!groupId) {
      continue;
    }
    let role = readString(obj.group_role ?? obj.role ?? obj.member_role );
    if (!role) {
      // user_role 当前用户在群中的角色: 2-群主, 1-管理员, 0-普通成员
      const userRole = readString(obj.user_role);
      if (userRole) {
        role = userRole === "2" ? "群主" : userRole === "1" ? "管理员" : "成员";
      }
    }
    groups.push({
      groupId,
      groupName: readString(obj.group_name ?? obj.groupName ?? obj.name),
      role:  role,
    });
  }
  return groups;
}

export function getPromptGroupContextHints(accountId: string, maxItems = 8): string[] {
  const snapshot = snapshotByAccountId.get(accountId);
  if (!snapshot) {
    return [];
  }
  if (snapshot.error) {
    return [`- 43Chat 群组上下文状态：拉取失败（${snapshot.error}）`];
  }
  if (snapshot.groups.length === 0) {
    return ["- 43Chat 群组上下文状态：暂无可用群组身份信息。"];
  }

  const hints: string[] = [
    `- 43Chat 群组上下文（最近刷新：${new Date(snapshot.updatedAt).toISOString()}）：`,
  ];
  for (const group of snapshot.groups.slice(0, Math.max(1, maxItems))) {
    hints.push(
      `  - group:${group.groupId}${group.groupName ? `（${group.groupName}）` : ""}${group.role ? `，在群内身份为：${group.role}` : ""}`,
    );
  }
  return hints;
}

export async function refreshPromptGroupContext(params: {
  account: Resolved43ChatAccount;
  apiPath: string;
}): Promise<void> {
  const { account, apiPath } = params;
  const client = create43ChatClient(account);
  const response = await client.requestJson<unknown>(apiPath, {
    method: "GET",
  });

  const groups = parseGroupContextItems(response);
  snapshotByAccountId.set(account.accountId, {
    updatedAt: Date.now(),
    groups,
  });
}

export function startPromptGroupContextRefresher(params: {
  account: Resolved43ChatAccount;
  runtime?: { log?: (msg: string) => void; error?: (msg: string) => void };
}): void {
  const { account, runtime } = params;
  const apiPath = account.config.promptGroupContextApiPath;
  const enabled = account.config.promptGroupContextEnabled ?? false;
  const refreshMs = account.config.promptGroupContextRefreshMs ?? 60_000;

  stopPromptGroupContextRefresher(account.accountId, runtime);

  if (!enabled || !apiPath) {
    runtime?.log?.(
      `43chat[${account.accountId}]: prompt group context refresher not enabled (${apiPath}, enabled: ${enabled})`,
    );
    return;
  }

  const refreshOnce = async () => {
    try {
      await refreshPromptGroupContext({ account, apiPath });
      runtime?.log?.(
        `43chat[${account.accountId}]: prompt group context refreshed (${apiPath}), groups: ${JSON.stringify(snapshotByAccountId.get(account.accountId)?.groups)}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      snapshotByAccountId.set(account.accountId, {
        updatedAt: Date.now(),
        groups: [],
        error: message,
      });
      runtime?.error?.(
        `43chat[${account.accountId}]: failed to refresh prompt group context: ${message}`,
      );
    }
  };

  void refreshOnce();
  const timer = setInterval(() => {
    void refreshOnce();
  }, Math.max(5_000, refreshMs));
  refreshTimerByAccountId.set(account.accountId, timer);
  runtime?.log?.(
    `43chat[${account.accountId}]: prompt group context refresher started (${apiPath})`,
  );
}

export function stopPromptGroupContextRefresher(accountId: string, runtime?: { log?: (msg: string) => void }): void {
  const timer = refreshTimerByAccountId.get(accountId);
  if (timer) {
    clearInterval(timer);
    refreshTimerByAccountId.delete(accountId);
  }
  runtime?.log?.(
    `43chat[${accountId}]: prompt group context refresher stopped`,
  );
}


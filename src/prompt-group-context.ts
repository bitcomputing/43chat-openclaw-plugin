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

function normalizeRoleName(role: string | undefined): string | undefined {
  if (!role) {
    return undefined;
  }
  if (role === "2" || role === "owner" || role === "群主") {
    return "群主";
  }
  if (role === "1" || role === "admin" || role === "管理员") {
    return "管理员";
  }
  if (role === "0" || role === "member" || role === "成员") {
    return "成员";
  }
  return role;
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

    let role = normalizeRoleName(readString(obj.group_role ?? obj.role ?? obj.member_role));
    if (!role) {
      role = normalizeRoleName(readString(obj.user_role));
    }

    groups.push({
      groupId,
      groupName: readString(obj.group_name ?? obj.groupName ?? obj.name),
      role,
    });
  }

  return groups;
}

export function resolveGroupRoleName(params: {
  groupId: string;
  accountId?: string;
  fallbackRoleName?: string;
}): string {
  const { groupId, accountId, fallbackRoleName = "管理员" } = params;
  const snapshotRole = accountId
    ? snapshotByAccountId.get(accountId)?.groups.find((group) => group.groupId === groupId)?.role
    : undefined;

  return normalizeRoleName(snapshotRole) ?? fallbackRoleName;
}

export async function ensureGroupRoleName(params: {
  account: Resolved43ChatAccount;
  groupId: string;
  runtime?: { log?: (msg: string) => void; error?: (msg: string) => void };
}): Promise<string | undefined> {
  const snapshot = snapshotByAccountId.get(params.account.accountId);
  const maxAgeMs = params.account.config.promptGroupContextRefreshMs ?? 60_000;
  const cached = snapshot?.groups.find((group) => group.groupId === params.groupId)?.role;
  if (cached && snapshot && Date.now() - snapshot.updatedAt <= Math.max(5_000, maxAgeMs)) {
    return normalizeRoleName(cached);
  }

  try {
    const client = create43ChatClient(params.account);
    const profile = await client.getProfile();
    const members = await client.listGroupMembers({
      groupId: params.groupId,
      pageSize: params.account.config.promptGroupContextMaxItems ?? 100,
    });
    const myMember = (members.list ?? []).find((member) => String(member.user_id) === String(profile.user_id));
    const role = normalizeRoleName(readString(myMember?.role));

    if (role) {
      const nextSnapshot = snapshotByAccountId.get(params.account.accountId) ?? {
        updatedAt: Date.now(),
        groups: [],
      };
      const others = nextSnapshot.groups.filter((group) => group.groupId !== params.groupId);
      snapshotByAccountId.set(params.account.accountId, {
        updatedAt: Date.now(),
        groups: [...others, { groupId: params.groupId, role }],
      });
      params.runtime?.log?.(
        `43chat[${params.account.accountId}]: resolved my role for group ${params.groupId} => ${role}`,
      );
    }

    return role;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    params.runtime?.error?.(
      `43chat[${params.account.accountId}]: failed to resolve my role for group ${params.groupId}: ${message}`,
    );
    return undefined;
  }
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

  snapshotByAccountId.set(account.accountId, {
    updatedAt: Date.now(),
    groups: parseGroupContextItems(response),
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
  runtime?.log?.(`43chat[${account.accountId}]: prompt group context refresher started (${apiPath})`);
}

export function stopPromptGroupContextRefresher(
  accountId: string,
  runtime?: { log?: (msg: string) => void },
): void {
  const timer = refreshTimerByAccountId.get(accountId);
  if (timer) {
    clearInterval(timer);
    refreshTimerByAccountId.delete(accountId);
  }
  runtime?.log?.(`43chat[${accountId}]: prompt group context refresher stopped`);
}

import type { AnyAgentTool, ClawdbotConfig } from "openclaw/plugin-sdk";
import { resolve43ChatAccount } from "./accounts.js";
import { Chat43ApiError, create43ChatClient } from "./client.js";

type AgentToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
};

function json(payload: unknown): AgentToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value === "number" && !Number.isNaN(value)) {
    return String(value);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeNumberString(value: unknown): string | undefined {
  const normalized = normalizeString(value);
  if (!normalized || !/^\d+$/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function normalizeNumberStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .map((entry) => normalizeNumberString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return items.length > 0 ? items : undefined;
}

function buildApiErrorPayload(err: unknown): Record<string, unknown> {
  return {
    ok: false,
    error: err instanceof Error ? err.message : String(err),
    code: err instanceof Chat43ApiError ? err.code ?? null : null,
    status: err instanceof Chat43ApiError ? err.status ?? null : null,
  };
}

export function createInviteGroupMembersTool(cfg: ClawdbotConfig): AnyAgentTool {
  return {
    name: "chat43_invite_group_members",
    ownerOnly: true,
    label: "43Chat Invite Group Members",
    description: "Invite one or more 43Chat friends into a group.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        accountId: { type: "string" },
        groupId: {
          type: "string",
          description: "Target group id.",
        },
        memberIds: {
          type: "array",
          items: { type: "string" },
          description: "Friend user ids to invite into the group.",
        },
      },
      required: ["groupId", "memberIds"],
    },
    async execute(_toolCallId: string, rawParams: { accountId?: string; groupId?: string; memberIds?: unknown }) {
      try {
        const groupId = normalizeNumberString(rawParams.groupId);
        const memberIds = normalizeNumberStringArray(rawParams.memberIds);
        if (!groupId || !memberIds) {
          throw new Error("groupId and memberIds are required");
        }
        const account = resolve43ChatAccount({ cfg, accountId: rawParams.accountId });
        if (!account.configured) {
          throw new Error(`43Chat account "${account.accountId}" not configured`);
        }
        const client = create43ChatClient(account);
        const result = await client.inviteGroupMembers({ groupId, memberIds });
        return json({
          ok: true,
          accountId: account.accountId,
          groupId,
          memberIds,
          successCount: result.success_count ?? null,
          failedCount: result.failed_count ?? null,
        });
      } catch (err) {
        return json(buildApiErrorPayload(err));
      }
    },
  } as AnyAgentTool;
}

export function createUpdateGroupTool(cfg: ClawdbotConfig): AnyAgentTool {
  return {
    name: "chat43_update_group",
    ownerOnly: true,
    label: "43Chat Update Group",
    description: "Update 43Chat group metadata such as name, description, avatar, category, or join type.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        accountId: { type: "string" },
        groupId: { type: "string" },
        name: { type: "string" },
        avatar: { type: "string" },
        description: { type: "string" },
        category: { type: "string" },
        joinType: {
          type: "integer",
          enum: [1, 2],
          description: "1 = free join, 2 = approval required.",
        },
      },
      required: ["groupId"],
    },
    async execute(
      _toolCallId: string,
      rawParams: {
        accountId?: string;
        groupId?: string;
        name?: string;
        avatar?: string;
        description?: string;
        category?: string;
        joinType?: unknown;
      },
    ) {
      try {
        const groupId = normalizeNumberString(rawParams.groupId);
        if (!groupId) {
          throw new Error("groupId is required");
        }
        const account = resolve43ChatAccount({ cfg, accountId: rawParams.accountId });
        if (!account.configured) {
          throw new Error(`43Chat account "${account.accountId}" not configured`);
        }
        const joinType = rawParams.joinType === 1 || rawParams.joinType === 2 ? rawParams.joinType : undefined;
        const client = create43ChatClient(account);
        const result = await client.updateGroup({
          groupId,
          name: normalizeString(rawParams.name),
          avatar: normalizeString(rawParams.avatar),
          description: normalizeString(rawParams.description),
          category: normalizeString(rawParams.category),
          joinType,
        });
        return json({
          ok: true,
          accountId: account.accountId,
          groupId,
          result,
        });
      } catch (err) {
        return json(buildApiErrorPayload(err));
      }
    },
  } as AnyAgentTool;
}

export function createRemoveGroupMemberTool(cfg: ClawdbotConfig): AnyAgentTool {
  return {
    name: "chat43_remove_group_member",
    ownerOnly: true,
    label: "43Chat Remove Group Member",
    description: "Remove a member from a 43Chat group. Use this for moderation or cleanup.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        accountId: { type: "string" },
        groupId: { type: "string" },
        userId: { type: "string" },
        reason: { type: "string" },
      },
      required: ["groupId", "userId"],
    },
    async execute(_toolCallId: string, rawParams: { accountId?: string; groupId?: string; userId?: string; reason?: string }) {
      try {
        const groupId = normalizeNumberString(rawParams.groupId);
        const userId = normalizeNumberString(rawParams.userId);
        if (!groupId || !userId) {
          throw new Error("groupId and userId are required");
        }
        const account = resolve43ChatAccount({ cfg, accountId: rawParams.accountId });
        if (!account.configured) {
          throw new Error(`43Chat account "${account.accountId}" not configured`);
        }
        const client = create43ChatClient(account);
        const result = await client.removeGroupMember({
          groupId,
          userId,
          reason: normalizeString(rawParams.reason),
        });
        return json({
          ok: true,
          accountId: account.accountId,
          groupId,
          userId,
          removedAt: result.removed_at ?? null,
        });
      } catch (err) {
        return json(buildApiErrorPayload(err));
      }
    },
  } as AnyAgentTool;
}

export function createDissolveGroupTool(cfg: ClawdbotConfig): AnyAgentTool {
  return {
    name: "chat43_dissolve_group",
    ownerOnly: true,
    label: "43Chat Dissolve Group",
    description: "Dissolve a 43Chat group. Only use when the group owner intentionally wants to close the group.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        accountId: { type: "string" },
        groupId: { type: "string" },
        reason: { type: "string" },
      },
      required: ["groupId"],
    },
    async execute(_toolCallId: string, rawParams: { accountId?: string; groupId?: string; reason?: string }) {
      try {
        const groupId = normalizeNumberString(rawParams.groupId);
        if (!groupId) {
          throw new Error("groupId is required");
        }
        const account = resolve43ChatAccount({ cfg, accountId: rawParams.accountId });
        if (!account.configured) {
          throw new Error(`43Chat account "${account.accountId}" not configured`);
        }
        const client = create43ChatClient(account);
        const result = await client.dissolveGroup({
          groupId,
          reason: normalizeString(rawParams.reason),
        });
        return json({
          ok: true,
          accountId: account.accountId,
          groupId,
          dissolvedAt: result.dissolved_at ?? null,
        });
      } catch (err) {
        return json(buildApiErrorPayload(err));
      }
    },
  } as AnyAgentTool;
}

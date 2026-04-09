import type { AnyAgentTool, ClawdbotConfig } from "openclaw/plugin-sdk";
import { resolve43ChatAccount } from "./accounts.js";
import { Chat43ApiError, create43ChatClient } from "./client.js";
import type {
  Chat43GroupJoinRequest,
  Chat43GroupJoinRequestAction,
} from "./types.js";

const ACTIONS = ["approve", "reject"] as const;

type ToolParams = {
  action: (typeof ACTIONS)[number];
  accountId?: string;
  requestId?: string;
  invitationId?: string;
  groupId?: string;
  applicantUserId?: string;
  applicantName?: string;
  applicationMessage?: string;
  rejectReason?: string;
};

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
  if (!normalized) {
    return undefined;
  }
  return /^\d+$/.test(normalized) ? normalized : undefined;
}

function resolveRequestId(params: ToolParams): string | undefined {
  return normalizeNumberString(params.requestId) ?? normalizeNumberString(params.invitationId);
}

function matchPendingRequest(
  requests: Chat43GroupJoinRequest[],
  params: ToolParams,
): Chat43GroupJoinRequest | undefined {
  const applicantUserId = normalizeNumberString(params.applicantUserId);
  if (applicantUserId) {
    const matchedByUser = requests.find((request) => String(request.user_id) === applicantUserId);
    if (matchedByUser) {
      return matchedByUser;
    }
  }

  const applicantName = normalizeString(params.applicantName);
  const applicationMessage = normalizeString(params.applicationMessage);
  if (applicantName || applicationMessage) {
    const matchedByText = requests.find((request) => {
      if (applicantName && request.nickname !== applicantName) {
        return false;
      }
      if (applicationMessage && request.message !== applicationMessage) {
        return false;
      }
      return true;
    });
    if (matchedByText) {
      return matchedByText;
    }
  }

  return undefined;
}

async function resolvePendingRequestId(cfg: ClawdbotConfig, params: ToolParams): Promise<{
  requestId: string;
  resolvedFrom: "request_id" | "lookup";
}> {
  const directRequestId = resolveRequestId(params);
  if (directRequestId) {
    return {
      requestId: directRequestId,
      resolvedFrom: "request_id",
    };
  }

  const groupId = normalizeNumberString(params.groupId);
  if (!groupId) {
    throw new Error("requestId/invitationId or groupId is required");
  }

  const account = resolve43ChatAccount({ cfg, accountId: params.accountId });
  if (!account.configured) {
    throw new Error(`43Chat account "${account.accountId}" not configured`);
  }

  const client = create43ChatClient(account);
  const list = await client.listGroupJoinRequests({
    groupId,
    status: "pending",
  });
  const matched = matchPendingRequest(list.list ?? [], params);
  if (!matched) {
    throw new Error(
      `No pending join request matched groupId=${groupId}${params.applicantUserId ? ` applicantUserId=${params.applicantUserId}` : ""}`,
    );
  }
  return {
    requestId: String(matched.request_id),
    resolvedFrom: "lookup",
  };
}

export function createHandleGroupJoinRequestTool(cfg: ClawdbotConfig): AnyAgentTool {
  return {
    name: "chat43_handle_group_join_request",
    label: "43Chat Join Request",
    description:
      "Approve or reject a 43Chat group join request. Use this for 43Chat group_invitation/join-request events when you need to actually process the application.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: [...ACTIONS],
          description: "approve to admit the applicant, reject to decline the request",
        },
        accountId: {
          type: "string",
          description: "Optional 43Chat account id. Omit to use the default configured account.",
        },
        requestId: {
          type: "string",
          description: "Join request id if known.",
        },
        invitationId: {
          type: "string",
          description: "Alias for the event's invitation_id.",
        },
        groupId: {
          type: "string",
          description: "Group id used for fallback lookup when request id is unknown.",
        },
        applicantUserId: {
          type: "string",
          description: "Applicant user id used for fallback lookup.",
        },
        applicantName: {
          type: "string",
          description: "Applicant nickname used for fallback lookup.",
        },
        applicationMessage: {
          type: "string",
          description: "Application message used for fallback lookup.",
        },
        rejectReason: {
          type: "string",
          description: "Optional reject reason. Only used when action is reject.",
        },
      },
      required: ["action"],
    },
    async execute(_toolCallId: string, rawParams: ToolParams): Promise<AgentToolResult> {
      try {
        const action = rawParams.action;
        if (!ACTIONS.includes(action)) {
          throw new Error(`Unknown action: ${String(action)}. Valid actions: ${ACTIONS.join(", ")}`);
        }

        const account = resolve43ChatAccount({ cfg, accountId: rawParams.accountId });
        if (!account.configured) {
          throw new Error(`43Chat account "${account.accountId}" not configured`);
        }

        const { requestId, resolvedFrom } = await resolvePendingRequestId(cfg, rawParams);
        const client = create43ChatClient(account);
        const result = await client.handleGroupJoinRequest({
          requestId,
          action: action as Chat43GroupJoinRequestAction,
          rejectReason: normalizeString(rawParams.rejectReason),
        });

        return json({
          ok: true,
          accountId: account.accountId,
          requestId: String(result.request_id),
          action: result.action,
          processedAt: result.processed_at ?? null,
          resolvedFrom,
          groupId: normalizeNumberString(rawParams.groupId) ?? null,
          applicantUserId: normalizeNumberString(rawParams.applicantUserId) ?? null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return json({
          ok: false,
          error: message,
          code: err instanceof Chat43ApiError ? err.code ?? null : null,
          status: err instanceof Chat43ApiError ? err.status ?? null : null,
        });
      }
    },
  } as AnyAgentTool;
}

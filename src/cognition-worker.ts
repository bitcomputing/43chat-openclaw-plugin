import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize } from "node:path";
import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { normalizeSkillCognitionWriteContent } from "./cognition-bootstrap.js";
import { extract43ChatTextContent, truncateForLog } from "./message-content.js";
import {
  load43ChatSkillRuntime,
  resolveSkillDocPaths,
  resolveSkillStorageTargets,
} from "./skill-runtime.js";
import type {
  Chat43AnySSEEvent,
  Chat43GroupMessageEventData,
  Chat43PrivateMessageEventData,
  Chat43SSEEventEnvelope,
} from "./types.js";

const STORAGE_ROOT = join(homedir(), ".config", "43chat");
const OPENCLAW_HOME = join(homedir(), ".openclaw");
const GROUP_COGNITION_BATCH_DEBOUNCE_MS = 8_000;
const GROUP_COGNITION_BATCH_MAX_MESSAGES = 8;
const DIRECT_COGNITION_BATCH_DEBOUNCE_MS = 8_000;
const DIRECT_COGNITION_BATCH_MAX_MESSAGES = 8;
const GROUP_COGNITION_DOC_MAX_CHARS = 3_200;
const GROUP_COGNITION_RECENT_DECISIONS = 12;
const DIRECT_COGNITION_RECENT_DECISIONS = 12;
const ANTHROPIC_VERSION = "2023-06-01";

type GroupMessageEvent = Chat43SSEEventEnvelope<Chat43GroupMessageEventData>;
type PrivateMessageEvent = Chat43SSEEventEnvelope<Chat43PrivateMessageEventData>;

export type LocalModelConfig = {
  providerId: string;
  modelId: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  maxTokens: number;
};

type BackgroundCognitionWrite = {
  path: string;
  content: Record<string, unknown>;
};

type BackgroundCognitionParseStatus =
  | "ok"
  | "explicit_empty"
  | "invalid_write_shape"
  | "missing_writes_array"
  | "unparseable";

type BackgroundCognitionParseResult = {
  writes: BackgroundCognitionWrite[];
  status: BackgroundCognitionParseStatus;
  rawExcerpt: string;
  detail: string;
};

type PendingGroupCognitionBatch = {
  cfg?: ClawdbotConfig;
  groupId: string;
  groupName: string;
  events: GroupMessageEvent[];
  running: boolean;
  needsRerun: boolean;
  timer?: ReturnType<typeof setTimeout>;
  log?: (message: string) => void;
  error?: (message: string) => void;
};

type PendingDirectCognitionBatch = {
  cfg?: ClawdbotConfig;
  userId: string;
  nickname: string;
  events: PrivateMessageEvent[];
  running: boolean;
  needsRerun: boolean;
  timer?: ReturnType<typeof setTimeout>;
  log?: (message: string) => void;
  error?: (message: string) => void;
};

const pendingGroupCognitionBatches = new Map<string, PendingGroupCognitionBatch>();
const pendingDirectCognitionBatches = new Map<string, PendingDirectCognitionBatch>();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function resolveStorageFullPath(pathValue: string, baseDir: string): string | null {
  const trimmedPath = pathValue.trim();
  if (!trimmedPath) {
    return null;
  }

  const rootPath = normalize(baseDir);
  const fullPath = normalize(
    trimmedPath.startsWith(rootPath)
      ? trimmedPath
      : join(baseDir, trimmedPath),
  );

  if (fullPath === rootPath) {
    return fullPath;
  }

  const rootPrefix = rootPath.endsWith("/") ? rootPath : `${rootPath}/`;
  return fullPath.startsWith(rootPrefix) ? fullPath : null;
}

function truncateContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }
  return `${content.slice(0, maxChars)}\n...<truncated>`;
}

function readOptionalJson(pathValue: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(pathValue, "utf8")) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readOptionalText(pathValue: string, maxChars: number): string {
  try {
    const content = readFileSync(pathValue, "utf8");
    return truncateContent(content, maxChars);
  } catch {
    return "";
  }
}

function readDocExcerpt(pathValue: string): string {
  if (!existsSync(pathValue)) {
    return "<missing>";
  }
  return readOptionalText(pathValue, GROUP_COGNITION_DOC_MAX_CHARS) || "<empty>";
}

function readRecentJsonlRecords(pathValue: string, limit: number): Record<string, unknown>[] {
  if (!existsSync(pathValue)) {
    return [];
  }
  try {
    const raw = readFileSync(pathValue, "utf8").trim();
    if (!raw) {
      return [];
    }
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          const parsed = JSON.parse(line) as unknown;
          return isPlainObject(parsed) ? parsed : null;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  } catch {
    return [];
  }
}

function mapGroupRoleName(roleValue?: number, roleNameValue?: string): string {
  const normalizedRoleName = roleNameValue?.trim();
  if (roleValue === 2 || normalizedRoleName === "owner") {
    return "群主";
  }
  if (roleValue === 1 || normalizedRoleName === "admin") {
    return "管理员";
  }
  return "成员";
}

function readLocalJson(pathValue: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(pathValue, "utf8")) as unknown;
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function resolvePrimaryModelRef(openclawHome: string): string {
  const configPath = join(openclawHome, "openclaw.json");
  const config = readLocalJson(configPath);
  const agents = isPlainObject(config.agents) ? config.agents : {};
  const defaults = isPlainObject(agents.defaults) ? agents.defaults : {};
  const model = isPlainObject(defaults.model) ? defaults.model : {};
  return readString(model.primary);
}

export function resolveLocalModelConfig(params?: {
  openclawHome?: string;
}): LocalModelConfig {
  const openclawHome = params?.openclawHome ?? OPENCLAW_HOME;
  const modelsPath = join(openclawHome, "agents", "main", "agent", "models.json");
  const authProfilesPath = join(openclawHome, "agents", "main", "agent", "auth-profiles.json");
  const modelsJson = readLocalJson(modelsPath);
  const authProfilesJson = readLocalJson(authProfilesPath);
  const providers = isPlainObject(modelsJson.providers) ? modelsJson.providers : {};
  const providerEntries = Object.entries(providers).filter(([, value]) => isPlainObject(value));
  if (providerEntries.length === 0) {
    throw new Error(`43chat cognition worker: no providers found in ${modelsPath}`);
  }

  const primaryModelRef = resolvePrimaryModelRef(openclawHome);
  const [primaryProviderId, primaryModelId] = primaryModelRef.includes("/")
    ? primaryModelRef.split("/", 2)
    : ["", ""];
  const selectedProviderId = providerEntries.some(([providerId]) => providerId === primaryProviderId)
    ? primaryProviderId
    : providerEntries[0]?.[0] ?? "";
  if (!selectedProviderId) {
    throw new Error("43chat cognition worker: failed to select provider");
  }

  const provider = providers[selectedProviderId] as Record<string, unknown>;
  const providerModels = Array.isArray(provider.models)
    ? provider.models.filter((entry): entry is Record<string, unknown> => isPlainObject(entry))
    : [];
  if (providerModels.length === 0) {
    throw new Error(`43chat cognition worker: provider ${selectedProviderId} has no models`);
  }

  const selectedModel = providerModels.find((entry) => readString(entry.id) === primaryModelId)
    ?? providerModels[0];
  const selectedModelId = readString(selectedModel.id);
  if (!selectedModelId) {
    throw new Error(`43chat cognition worker: provider ${selectedProviderId} selected model has empty id`);
  }

  const authProfiles = isPlainObject(authProfilesJson.profiles) ? authProfilesJson.profiles : {};
  const lastGood = isPlainObject(authProfilesJson.lastGood) ? authProfilesJson.lastGood : {};
  const lastGoodProfileId = readString(lastGood[selectedProviderId]);
  const profile = lastGoodProfileId && isPlainObject(authProfiles[lastGoodProfileId])
    ? authProfiles[lastGoodProfileId] as Record<string, unknown>
    : null;
  const apiKey = readString(provider.apiKey)
    || readString(profile?.key);
  if (!apiKey) {
    throw new Error(`43chat cognition worker: missing api key for provider ${selectedProviderId}`);
  }

  return {
    providerId: selectedProviderId,
    modelId: selectedModelId,
    baseUrl: readString(provider.baseUrl) || "https://api.anthropic.com",
    api: readString(selectedModel.api) || readString(provider.api) || "anthropic-messages",
    apiKey,
    maxTokens: Number.isFinite(selectedModel.maxTokens) ? Number(selectedModel.maxTokens) : 8_192,
  };
}

function extractAnthropicTextResponse(response: unknown): string {
  if (!isPlainObject(response) || !Array.isArray(response.content)) {
    return "";
  }
  return response.content
    .map((entry) => {
      if (!isPlainObject(entry) || entry.type !== "text") {
        return "";
      }
      return readString(entry.text);
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractOpenAiCompletionTextResponse(response: unknown): string {
  if (!isPlainObject(response) || !Array.isArray(response.choices)) {
    return "";
  }
  return response.choices
    .map((entry) => {
      if (!isPlainObject(entry)) {
        return "";
      }
      return readString(entry.text)
        || (isPlainObject(entry.message) ? readString(entry.message.content) : "");
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function buildModelApiUrl(baseUrl: string, endpoint: "messages" | "completions"): string {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  if (normalizedBase.endsWith(`/${endpoint}`)) {
    return normalizedBase;
  }
  if (normalizedBase.endsWith("/v1")) {
    return `${normalizedBase}/${endpoint}`;
  }
  return `${normalizedBase}/v1/${endpoint}`;
}

export async function requestBackgroundCognitionWrites(params: {
  prompt: string;
  modelConfig: LocalModelConfig;
}): Promise<string> {
  const abortController = new AbortController();
  const abortTimer = setTimeout(() => abortController.abort(), 60_000);
  try {
    let response: Response;
    if (params.modelConfig.api === "anthropic-messages") {
      response = await fetch(buildModelApiUrl(params.modelConfig.baseUrl, "messages"), {
        method: "POST",
        signal: abortController.signal,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": params.modelConfig.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: params.modelConfig.modelId,
          max_tokens: Math.min(Math.max(params.modelConfig.maxTokens, 1024), 8_192),
          messages: [{
            role: "user",
            content: [{
              type: "text",
              text: params.prompt,
            }],
          }],
        }),
      });
    } else if (params.modelConfig.api === "openai-completions") {
      response = await fetch(buildModelApiUrl(params.modelConfig.baseUrl, "completions"), {
        method: "POST",
        signal: abortController.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.modelConfig.apiKey}`,
        },
        body: JSON.stringify({
          model: params.modelConfig.modelId,
          prompt: params.prompt,
          max_tokens: Math.min(Math.max(params.modelConfig.maxTokens, 1024), 8_192),
          temperature: 0,
          stream: false,
        }),
      });
    } else {
      throw new Error(`43chat cognition worker: unsupported model api ${params.modelConfig.api}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `43chat cognition worker: model request failed (${response.status} ${response.statusText})${body ? `: ${body.slice(0, 400)}` : ""}`,
      );
    }

    const json = await response.json().catch(() => null);
    const text = params.modelConfig.api === "anthropic-messages"
      ? extractAnthropicTextResponse(json)
      : extractOpenAiCompletionTextResponse(json);
    if (!text) {
      throw new Error("43chat cognition worker: model returned empty text");
    }
    return text;
  } finally {
    clearTimeout(abortTimer);
  }
}

function stripFences(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    return trimmed
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
  }
  return trimmed;
}

function stripTrailingCommas(text: string): string {
  return text.replace(/,\s*([}\]])/g, "$1").replace(/,\s*$/g, "");
}

function stripInvalidJsonControlChars(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function repairJsonCandidate(text: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let output = "";

  for (const char of text) {
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      output += char;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char);
      output += char;
      continue;
    }
    if (char === "}" || char === "]") {
      const expected = char === "}" ? "{" : "[";
      if (stack.at(-1) === expected) {
        stack.pop();
        output += char;
      }
      continue;
    }
    output += char;
  }

  if (inString) {
    return output;
  }

  return `${output}${stack.reverse().map((entry) => (entry === "{" ? "}" : "]")).join("")}`;
}

function balanceJsonCandidate(text: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (const char of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }
    if (char === "}" || char === "]") {
      const expected = char === "}" ? "{" : "[";
      if (stack.at(-1) === expected) {
        stack.pop();
      }
    }
  }

  if (inString) {
    return text;
  }

  if (stack.length === 0) {
    return text;
  }

  return `${text}${stack.reverse().map((entry) => (entry === "{" ? "}" : "]")).join("")}`;
}

function extractWritesArraySegment(text: string): string {
  const writesMatch = /"writes"\s*:/.exec(text);
  if (!writesMatch) {
    return "";
  }

  const arrayStart = text.indexOf("[", writesMatch.index + writesMatch[0].length);
  if (arrayStart < 0) {
    return "";
  }

  const stack: string[] = ["["];
  let inString = false;
  let escaped = false;

  for (let index = arrayStart + 1; index < text.length; index += 1) {
    const char = text[index];
    if (!char) {
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }
    if (char === "}" || char === "]") {
      const expected = char === "}" ? "{" : "[";
      if (stack.at(-1) === expected) {
        stack.pop();
        if (stack.length === 0) {
          return text.slice(arrayStart, index + 1);
        }
      }
    }
  }

  return balanceJsonCandidate(text.slice(arrayStart));
}

function extractTopLevelObjectsFromArray(arraySegment: string): string[] {
  const trimmed = arraySegment.trim();
  if (!trimmed.startsWith("[")) {
    return [];
  }

  const objects: string[] = [];
  const stack: string[] = ["["];
  let inString = false;
  let escaped = false;
  let objectStart = -1;

  for (let index = 1; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (!char) {
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      if (stack.length === 1 && char === "{" && objectStart < 0) {
        objectStart = index;
      }
      stack.push(char);
      continue;
    }
    if (char === "}" || char === "]") {
      const expected = char === "}" ? "{" : "[";
      if (stack.at(-1) === expected) {
        stack.pop();
        if (objectStart >= 0 && stack.length === 1) {
          objects.push(trimmed.slice(objectStart, index + 1));
          objectStart = -1;
        }
      }
    }
  }

  if (objectStart >= 0) {
    objects.push(balanceJsonCandidate(trimmed.slice(objectStart)));
  }

  return objects;
}

function parseBackgroundWriteEntry(candidate: string): BackgroundCognitionWrite | null {
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (!isPlainObject(parsed)) {
      return null;
    }
    const path = readString(parsed.path);
    if (!path || !path.endsWith(".json") || !isPlainObject(parsed.content)) {
      return null;
    }
    return {
      path,
      content: parsed.content as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}

function salvageWritesFromMalformedCandidate(candidate: string): {
  writes: BackgroundCognitionWrite[];
  invalidCount: number;
  attempted: boolean;
} {
  const arraySegment = extractWritesArraySegment(candidate);
  if (!arraySegment) {
    return {
      writes: [],
      invalidCount: 0,
      attempted: false,
    };
  }

  const entryCandidates = extractTopLevelObjectsFromArray(arraySegment);
  if (entryCandidates.length === 0) {
    return {
      writes: [],
      invalidCount: 0,
      attempted: true,
    };
  }

  let invalidCount = 0;
  const writes = entryCandidates
    .map((entry) => parseBackgroundWriteEntry(entry) ?? parseBackgroundWriteEntry(repairJsonCandidate(entry)))
    .filter((entry): entry is BackgroundCognitionWrite => {
      if (entry) {
        return true;
      }
      invalidCount += 1;
      return false;
    });

  return {
    writes,
    invalidCount,
    attempted: true,
  };
}

function buildCandidateVariants(candidate: string): string[] {
  const variants = new Set<string>();
  const trimmed = stripInvalidJsonControlChars(candidate.trim().replace(/^\uFEFF/, ""));
  if (!trimmed) {
    return [];
  }

  variants.add(trimmed);

  const noTrailingCommas = stripTrailingCommas(trimmed);
  if (noTrailingCommas) {
    variants.add(noTrailingCommas);
  }

  const balanced = balanceJsonCandidate(noTrailingCommas || trimmed);
  if (balanced) {
    variants.add(balanced);
    variants.add(stripTrailingCommas(balanced));
  }
  const repaired = repairJsonCandidate(noTrailingCommas || trimmed);
  if (repaired) {
    variants.add(repaired);
    variants.add(stripTrailingCommas(repaired));
  }

  const writesArray = extractWritesArraySegment(trimmed);
  if (writesArray) {
    const wrappedWrites = `{"writes":${writesArray}}`;
    variants.add(wrappedWrites);
    const writesBalanced = balanceJsonCandidate(stripTrailingCommas(wrappedWrites));
    if (writesBalanced) {
      variants.add(writesBalanced);
      variants.add(stripTrailingCommas(writesBalanced));
    }
    const writesRepaired = repairJsonCandidate(stripTrailingCommas(wrappedWrites));
    if (writesRepaired) {
      variants.add(writesRepaired);
      variants.add(stripTrailingCommas(writesRepaired));
    }
  }

  return Array.from(variants).filter(Boolean);
}

function summarizeCandidate(candidate: string): string {
  return truncateForLog(candidate.replace(/\s+/g, " ").trim(), 240);
}

export function analyzeBackgroundCognitionWrites(text: string): BackgroundCognitionParseResult {
  const trimmed = stripInvalidJsonControlChars(stripFences(text));
  const rawCandidates = [
    trimmed,
    (() => {
      const start = trimmed.indexOf("{");
      const end = trimmed.lastIndexOf("}");
      return start >= 0 && end > start ? trimmed.slice(start, end + 1) : "";
    })(),
  ].filter(Boolean);
  const candidates = rawCandidates.flatMap((candidate) => buildCandidateVariants(candidate));

  let sawMissingWritesArray = false;
  let invalidWriteShapeCount = 0;

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!isPlainObject(parsed) || !Array.isArray(parsed.writes)) {
        sawMissingWritesArray = true;
        continue;
      }
      const writes = parsed.writes
        .map((entry) => {
          if (!isPlainObject(entry)) {
            return null;
          }
          const path = readString(entry.path);
          if (!path || !path.endsWith(".json") || !isPlainObject(entry.content)) {
            return null;
          }
          return {
            path,
            content: entry.content as Record<string, unknown>,
          };
        })
        .filter((entry): entry is BackgroundCognitionWrite => Boolean(entry));

      if (writes.length > 0) {
        return {
          writes,
          status: "ok",
          rawExcerpt: truncateForLog(trimmed, 600),
          detail: `parsed ${writes.length} writes from ${summarizeCandidate(candidate)}`,
        };
      }

      if (parsed.writes.length === 0) {
        return {
          writes: [],
          status: "explicit_empty",
          rawExcerpt: truncateForLog(trimmed, 600),
          detail: `model returned explicit writes=[] from ${summarizeCandidate(candidate)}`,
        };
      }

      invalidWriteShapeCount += 1;
    } catch {
      continue;
    }
  }

  for (const candidate of candidates) {
    const salvaged = salvageWritesFromMalformedCandidate(candidate);
    if (!salvaged.attempted) {
      continue;
    }
    if (salvaged.writes.length > 0) {
      return {
        writes: salvaged.writes,
        status: "ok",
        rawExcerpt: truncateForLog(trimmed, 600),
        detail: `salvaged ${salvaged.writes.length} writes from malformed candidate ${summarizeCandidate(candidate)}`,
      };
    }
    invalidWriteShapeCount += salvaged.invalidCount;
  }

  if (invalidWriteShapeCount > 0) {
    return {
      writes: [],
      status: "invalid_write_shape",
      rawExcerpt: truncateForLog(trimmed, 600),
      detail: `parsed candidate JSON but all writes were invalid (${invalidWriteShapeCount} candidate(s))`,
    };
  }

  if (sawMissingWritesArray) {
    return {
      writes: [],
      status: "missing_writes_array",
      rawExcerpt: truncateForLog(trimmed, 600),
      detail: "response contained JSON candidate(s) but no usable writes array",
    };
  }

  return {
    writes: [],
    status: "unparseable",
    rawExcerpt: truncateForLog(trimmed, 600),
    detail: "response text could not be parsed into a cognition payload",
  };
}

export function parseBackgroundCognitionWrites(text: string): BackgroundCognitionWrite[] {
  return analyzeBackgroundCognitionWrites(text).writes;
}

function summarizeMissingLongTermSlots(params: {
  cfg?: ClawdbotConfig;
  groupId: string;
  senderIds: string[];
  baseDir: string;
}): string[] {
  const runtime = load43ChatSkillRuntime(params.cfg);
  const summaries: string[] = [];

  const soulTarget = resolveSkillStorageTargets(runtime, ["group_soul"], { group_id: params.groupId })[0];
  if (soulTarget) {
    const fullPath = resolveStorageFullPath(soulTarget.path, params.baseDir);
    const soul = fullPath ? readOptionalJson(fullPath) : null;
    const soulRecord = isPlainObject(soul?.soul) ? soul.soul : {};
    const purpose = readString(soulRecord.purpose);
    const boundaries = readString(soulRecord.boundaries);
    const expectations = readString(soulRecord.expectations);
    const topics = Array.isArray(soulRecord.topics) ? soulRecord.topics.filter((entry) => readString(entry)).length : 0;
    const missingSoulFields: string[] = [];
    if (!purpose) {
      missingSoulFields.push("purpose");
    }
    if (topics === 0) {
      missingSoulFields.push("topics");
    }
    if (!boundaries) {
      missingSoulFields.push("boundaries");
    }
    if (!expectations) {
      missingSoulFields.push("expectations");
    }
    if (missingSoulFields.length > 0) {
      summaries.push(`group_soul(${soulTarget.path}) 缺少 ${missingSoulFields.join(" / ")}`);
    }
  }

  const membersTarget = resolveSkillStorageTargets(runtime, ["group_members_graph"], { group_id: params.groupId })[0];
  if (membersTarget) {
    const fullPath = resolveStorageFullPath(membersTarget.path, params.baseDir);
    const graph = fullPath ? readOptionalJson(fullPath) : null;
    const members = isPlainObject(graph?.members) ? graph.members : {};
    for (const userId of params.senderIds) {
      const member = isPlainObject(members[userId]) ? members[userId] : {};
      const role = readString(member.role);
      const inGroupTags = Array.isArray(member.in_group_tags)
        ? member.in_group_tags.filter((entry) => readString(entry)).length
        : 0;
      const strategy = readString(member.strategy);
      if (!role || inGroupTags === 0 || !strategy) {
        summaries.push(`group_members_graph(${membersTarget.path}) 中 user:${userId} 仍缺 role/in_group_tags/strategy`);
      }
    }
  }

  for (const userId of params.senderIds) {
    const profileTarget = resolveSkillStorageTargets(runtime, ["user_profile"], { user_id: userId })[0];
    if (!profileTarget) {
      continue;
    }
    const fullPath = resolveStorageFullPath(profileTarget.path, params.baseDir);
    const profile = fullPath ? readOptionalJson(fullPath) : null;
    const tags = Array.isArray(profile?.tags) ? profile.tags.filter((entry) => readString(entry)).length : 0;
    const expertise = Array.isArray(profile?.expertise) ? profile.expertise.filter((entry) => readString(entry)).length : 0;
    const personality = readString(profile?.personality);
    const notes = readString(profile?.notes);
    const updatedAt = Date.parse(readString(profile?.updated_at) || "");
    const interactionStats = isPlainObject(profile?.interaction_stats) ? profile.interaction_stats : {};
    const lastInteractionAt = Date.parse(readString(interactionStats.last_interaction) || "");
    if (tags === 0 || expertise === 0 || !personality || !notes) {
      summaries.push(`user_profile(${profileTarget.path}) 中 user:${userId} 仍缺稳定画像字段`);
      continue;
    }
    if (Number.isFinite(lastInteractionAt) && (!Number.isFinite(updatedAt) || lastInteractionAt > updatedAt)) {
      summaries.push(`user_profile(${profileTarget.path}) 中 user:${userId} 需要基于最新互动重评 tags / expertise / personality / notes，并输出紧凑版完整画像`);
    }
  }

  return summaries;
}

function buildBackgroundRetryPrompt(params: {
  basePrompt: string;
  parseResult: BackgroundCognitionParseResult;
  missingSummaries: string[];
}): string {
  const missingLines = params.missingSummaries.length > 0
    ? params.missingSummaries.map((summary) => `- ${summary}`).join("\n")
    : "- 当前没有检测到明显空白槽位，但上次输出不可用";

  return [
    params.basePrompt,
    "",
    "【上轮输出不可用，请立刻修正】",
    `- 上轮状态: ${params.parseResult.status}`,
    `- 上轮问题: ${params.parseResult.detail}`,
    `- 上轮原始输出摘要: ${params.parseResult.rawExcerpt || "<empty>"}`,
    "- 如果当前批次已经出现稳定、可复用的群定位或人物信号，不要再返回 `{\"writes\":[]}`；至少输出能确定的那部分增量写入。",
    "- 即使暂时还不足以补完整个 `group_soul`，也应优先补当前发言者 `user_profile` 或 `group_members_graph` 中已经有证据的部分。",
    "- 仍然只允许输出纯 JSON，且顶层必须是 `{\"writes\":[...]}`。",
    "- 最终输出必须能被标准 `JSON.parse` 成功解析；若发现少括号、少引号、尾部缺失或字段不闭合，先修正，再输出。",
    "- 输出前先自检一次：确认首字符是 `{`、末字符是 `}`，并且整个文本可被 `JSON.parse` 成功解析。",
    "【当前仍待补的长期认知槽位】",
    missingLines,
    "",
    "现在重新输出 JSON。",
  ].join("\n");
}

function formatSnapshotBlock(title: string, content: string): string {
  return [
    `【${title}】`,
    "```json",
    content || "<missing>",
    "```",
    "",
  ].join("\n");
}

function buildAllowedWritePaths(params: {
  groupId: string;
  senderIds: string[];
  cfg?: ClawdbotConfig;
}): string[] {
  const runtime = load43ChatSkillRuntime(params.cfg);
  const groupTargets = resolveSkillStorageTargets(
    runtime,
    ["group_soul", "group_members_graph"],
    { group_id: params.groupId },
  ).map((entry) => entry.path);
  const profileTargets = params.senderIds.map((userId) => resolveSkillStorageTargets(
    runtime,
    ["user_profile"],
    { user_id: userId },
  )[0]?.path ?? `profiles/${userId}.json`);
  return Array.from(new Set([...groupTargets, ...profileTargets].filter(Boolean)));
}

function buildGroupSnapshotSections(params: {
  cfg?: ClawdbotConfig;
  groupId: string;
  groupName: string;
  senderIds: string[];
  baseDir: string;
}): string {
  const runtime = load43ChatSkillRuntime(params.cfg);
  const groupTargets = resolveSkillStorageTargets(
    runtime,
    ["group_soul", "group_members_graph", "group_state"],
    { group_id: params.groupId },
  );

  const sections: string[] = [];
  for (const target of groupTargets) {
    const fullPath = resolveStorageFullPath(target.path, params.baseDir);
    const snapshot = fullPath && existsSync(fullPath)
      ? truncateContent(JSON.stringify(readOptionalJson(fullPath) ?? {}, null, 2), GROUP_COGNITION_DOC_MAX_CHARS)
      : "<missing>";
    sections.push(formatSnapshotBlock(`${target.alias} @ ${target.path}`, snapshot));
  }

  for (const userId of params.senderIds) {
    const target = resolveSkillStorageTargets(runtime, ["user_profile"], { user_id: userId })[0];
    if (!target) {
      continue;
    }
    const fullPath = resolveStorageFullPath(target.path, params.baseDir);
    const snapshot = fullPath && existsSync(fullPath)
      ? truncateContent(JSON.stringify(readOptionalJson(fullPath) ?? {}, null, 2), GROUP_COGNITION_DOC_MAX_CHARS)
      : "<missing>";
    sections.push(formatSnapshotBlock(`${target.alias} @ ${target.path}`, snapshot));
  }

  return sections.join("\n");
}

function buildRecentDecisionSection(params: {
  cfg?: ClawdbotConfig;
  groupId: string;
  baseDir: string;
}): string {
  const runtime = load43ChatSkillRuntime(params.cfg);
  const target = resolveSkillStorageTargets(runtime, ["group_decision_log"], { group_id: params.groupId })[0];
  if (!target) {
    return "【最近 decision_log】\n<missing>\n";
  }
  const fullPath = resolveStorageFullPath(target.path, params.baseDir);
  if (!fullPath) {
    return "【最近 decision_log】\n<invalid>\n";
  }
  const records = readRecentJsonlRecords(fullPath, GROUP_COGNITION_RECENT_DECISIONS)
    .map((entry, index) => {
      const nickname = readString(entry.nickname) || readString(entry.user_id) || "unknown";
      const currentMessage = readString(entry.current_message);
      const decision = readString(entry.decision);
      const moderation = readString(entry.moderation_decision);
      return `- #${index + 1} ${nickname}: ${truncateForLog(currentMessage, 120)} / decision=${decision || "<empty>"}${moderation ? ` / moderation=${moderation}` : ""}`;
    });
  return [
    "【最近 decision_log】",
    ...(records.length > 0 ? records : ["<empty>"]),
    "",
  ].join("\n");
}

function buildDocSections(cfg: ClawdbotConfig | undefined, eventType: Chat43AnySSEEvent["event_type"]): string {
  const runtime = load43ChatSkillRuntime(cfg);
  const profile = runtime.data.event_profiles[eventType];
  const paths = resolveSkillDocPaths(runtime, profile?.docs ?? []);
  if (paths.length === 0) {
    return "";
  }

  return paths
    .map((pathValue) => [
      `【文档 ${pathValue.split("/").pop() ?? pathValue}】`,
      readDocExcerpt(pathValue),
      "",
    ].join("\n"))
    .join("\n");
}

export function buildGroupCognitionBatchPrompt(params: {
  cfg?: ClawdbotConfig;
  events: GroupMessageEvent[];
  baseDir?: string;
}): string {
  if (params.events.length === 0) {
    return "";
  }

  const baseDir = params.baseDir ?? STORAGE_ROOT;
  const latestEvent = params.events[params.events.length - 1];
  const latestData = latestEvent.data;
  const senderIds = Array.from(new Set(params.events.map((event) => String(event.data.from_user_id))));
  const allowedPaths = buildAllowedWritePaths({
    cfg: params.cfg,
    groupId: String(latestData.group_id),
    senderIds,
  });
  const runtime = load43ChatSkillRuntime(params.cfg);
  const cognitionPolicy = runtime.data.cognition_policy_defaults;
  const missingSummaries = summarizeMissingLongTermSlots({
    cfg: params.cfg,
    groupId: String(latestData.group_id),
    senderIds,
    baseDir,
  });

  return [
    "你是 43Chat 的后台长期认知 worker。",
    "本轮不是对外聊天，也不是管理回复；你只负责把一批群聊消息归纳成长期认知写入。",
    "你必须只输出纯 JSON，不要输出 markdown、解释、前后缀、`<chat43-cognition>` 标签。",
    "输出格式固定为：{\"writes\":[{\"path\":\"...json\",\"content\":{...}}]}",
    "如果当前批次还不足以形成稳定、可复用的长期认知，就输出：{\"writes\":[]}",
    "最终输出必须能被标准 `JSON.parse` 成功解析；若发现少括号、少引号、尾部缺失或字段不闭合，先修正，再输出。",
    "输出前先自检一次：确认首字符是 `{`、末字符是 `}`，并且整个文本可被 `JSON.parse` 成功解析。",
    "最终输出首字符必须是 `{`，末字符必须是 `}`；顶层只允许 `writes` 字段，不要输出 `reply`、`decision`、`envelope`、`_meta` 等额外字段。",
    "",
    "【硬性约束】",
    "- 只允许写入本轮允许的路径；不要写 group_state、decision_log、dialog_state，也不要写其它群或其它用户的文件。",
    "- `content` 可以是局部 patch；插件会和现有 JSON 合并并做规范化。",
    "- `group_soul` 只写稳定的群定位、长期话题边界和可复用预期；不要把一次性项目名、节日活动、短期排期直接钉死为长期 Soul。",
    "- 如果 `group_soul` 当前只剩 `expectations` 为空，就直接补 `soul.expectations`，不要继续返回 `writes: []`。",
    "- `user_profile` 只写稳定的人物结论，如 tags / expertise / personality / notes；如果旧画像已过期或冲突，要覆盖旧判断。",
    "- 只要决定写 `user_profile`，优先一次性给出紧凑版完整画像：同时重写 tags / expertise / personality / notes，而不是只补一个局部字段。",
    "- 群内身份与治理标签（如群主 / 管理员 / 成员 / 秩序维护 / 新人引导 / 违规处置）只能写入 `group_members_graph`，禁止写进全局 `user_profile`。",
    "- 私聊关系、称呼习惯、联系方式、当前位置、线下邀约等私人信息禁止写进全局 `user_profile`；这些信息不能跨群复用。",
    "- `group_members_graph.members.{user_id}` 只写该成员在群内的稳定 role / in_group_tags / strategy；`role` 只能是 opinion_leader / contributor / active / newcomer / silent / risk。",
    "- 只要决定写 `group_members_graph.members.{user_id}`，优先给出该成员的紧凑版完整判断，不要把历史阶段性标签越堆越多。",
    "- 输出要收敛：`tags` 建议 <= 6，`expertise` 建议 <= 8，`in_group_tags` 建议 <= 6，`notes` 控制在 1-3 条分号短句内。",
    "- 禁止为了凑字段而写空洞套话、营销腔或与文档冲突的内容。",
    "- 如果证据只够短期观察，就不要写长期认知，本轮留空即可。",
    "",
    "【当前优先补位】",
    ...(missingSummaries.length > 0
      ? missingSummaries.map((summary) => `- ${summary}`)
      : ["- 当前长期认知没有明显空槽位；若本批次没有稳定新结论，可以返回 `{\"writes\":[]}`"]),
    "",
    "【允许写入路径】",
    ...allowedPaths.map((pathValue) => `- ${pathValue}`),
    "",
    "【运行时长期认知规则】",
    `- topic_persistence.group_soul = ${cognitionPolicy.topic_persistence?.group_soul ?? "always"}`,
    `- topic_persistence.group_state = ${cognitionPolicy.topic_persistence?.group_state ?? "always"}`,
    `- topic_persistence.decision_log = ${cognitionPolicy.topic_persistence?.decision_log ?? "always"}`,
    `- judgement_rules: ${(cognitionPolicy.topic_persistence?.judgement_rules ?? []).join(" / ") || "<none>"}`,
    `- volatile_terms: ${(cognitionPolicy.topic_persistence?.volatile_terms ?? []).join(" / ") || "<none>"}`,
    `- volatile_regexes: ${(cognitionPolicy.topic_persistence?.volatile_regexes ?? []).join(" / ") || "<none>"}`,
    "",
    "【输出示例】",
    "{\"writes\":[{\"path\":\"groups/100/soul.json\",\"content\":{\"soul\":{\"purpose\":\"...\",\"topics\":[\"...\"],\"boundaries\":\"...\",\"expectations\":\"...\"}}},{\"path\":\"profiles/12443.json\",\"content\":{\"tags\":[\"...\"],\"expertise\":[\"...\"],\"personality\":\"...\",\"notes\":\"...\"}},{\"path\":\"groups/100/members_graph.json\",\"content\":{\"members\":{\"12443\":{\"role\":\"contributor\",\"in_group_tags\":[\"...\"],\"strategy\":\"...\"}}}}]}",
    "",
    "【当前群】",
    `- group_id=${String(latestData.group_id)}`,
    `- group_name=${latestData.group_name || `群${latestData.group_id}`}`,
    "",
    buildDocSections(params.cfg, "group_message"),
    buildGroupSnapshotSections({
      cfg: params.cfg,
      groupId: String(latestData.group_id),
      groupName: latestData.group_name || `群${latestData.group_id}`,
      senderIds,
      baseDir,
    }),
    buildRecentDecisionSection({
      cfg: params.cfg,
      groupId: String(latestData.group_id),
      baseDir,
    }),
    "【当前批次消息】",
    ...params.events.map((event, index) => {
      const data = event.data;
      return `- #${index + 1} ${new Date(data.timestamp || event.timestamp || Date.now()).toISOString()} ${data.from_nickname || data.from_user_id}（user:${String(data.from_user_id)} / ${mapGroupRoleName(data.from_user_role, data.from_user_role_name)}）: ${truncateForLog(extract43ChatTextContent(data.content), 240)}`;
    }),
    "",
    "现在只输出 JSON。",
  ].join("\n");
}

function summarizeMissingDirectLongTermSlots(params: {
  cfg?: ClawdbotConfig;
  userId: string;
  baseDir: string;
  latestTimestamp?: number;
}): string[] {
  const runtime = load43ChatSkillRuntime(params.cfg);
  const summaries: string[] = [];
  const latestTimestamp = Number.isFinite(params.latestTimestamp) ? Number(params.latestTimestamp) : Number.NaN;

  const profileTarget = resolveSkillStorageTargets(runtime, ["user_profile"], { user_id: params.userId })[0];
  if (profileTarget) {
    const fullPath = resolveStorageFullPath(profileTarget.path, params.baseDir);
    const profile = fullPath ? readOptionalJson(fullPath) : null;
    const tags = Array.isArray(profile?.tags) ? profile.tags.filter((entry) => readString(entry)).length : 0;
    const expertise = Array.isArray(profile?.expertise) ? profile.expertise.filter((entry) => readString(entry)).length : 0;
    const personality = readString(profile?.personality);
    const notes = readString(profile?.notes);
    const updatedAt = Date.parse(readString(profile?.updated_at) || "");
    if (tags === 0 || expertise === 0 || !personality || !notes) {
      summaries.push(`user_profile(${profileTarget.path}) 中 user:${params.userId} 仍缺稳定画像字段`);
    } else if (Number.isFinite(latestTimestamp) && (!Number.isFinite(updatedAt) || latestTimestamp > updatedAt)) {
      summaries.push(`user_profile(${profileTarget.path}) 中 user:${params.userId} 需要基于最新私聊重评 tags / expertise / personality / notes，并输出紧凑版完整画像`);
    }
  }

  const dialogTarget = resolveSkillStorageTargets(runtime, ["dialog_state"], { user_id: params.userId })[0];
  if (dialogTarget) {
    const fullPath = resolveStorageFullPath(dialogTarget.path, params.baseDir);
    const dialogState = fullPath ? readOptionalJson(fullPath) : null;
    const currentTopics = Array.isArray(dialogState?.current_topics)
      ? dialogState.current_topics.filter((entry) => readString(entry)).length
      : 0;
    const rapportSummary = readString(dialogState?.rapport_summary);
    const updatedAt = Date.parse(readString(dialogState?.updated_at) || "");
    if (currentTopics === 0 || !rapportSummary) {
      summaries.push(`dialog_state(${dialogTarget.path}) 中 user:${params.userId} 仍缺 current_topics / rapport_summary`);
    } else if (Number.isFinite(latestTimestamp) && (!Number.isFinite(updatedAt) || latestTimestamp > updatedAt)) {
      summaries.push(`dialog_state(${dialogTarget.path}) 中 user:${params.userId} 需要基于最新私聊补 current_topics / rapport_summary`);
    }
  }

  return summaries;
}

function buildAllowedDirectWritePaths(params: {
  userId: string;
  cfg?: ClawdbotConfig;
}): string[] {
  const runtime = load43ChatSkillRuntime(params.cfg);
  return Array.from(new Set(resolveSkillStorageTargets(
    runtime,
    ["user_profile", "dialog_state"],
    { user_id: params.userId },
  ).map((entry) => entry.path).filter(Boolean)));
}

function buildDirectSnapshotSections(params: {
  cfg?: ClawdbotConfig;
  userId: string;
  baseDir: string;
}): string {
  const runtime = load43ChatSkillRuntime(params.cfg);
  const sections: string[] = [];
  const targets = resolveSkillStorageTargets(runtime, ["user_profile", "dialog_state"], { user_id: params.userId });

  for (const target of targets) {
    const fullPath = resolveStorageFullPath(target.path, params.baseDir);
    const snapshot = fullPath && existsSync(fullPath)
      ? truncateContent(JSON.stringify(readOptionalJson(fullPath) ?? {}, null, 2), GROUP_COGNITION_DOC_MAX_CHARS)
      : "<missing>";
    sections.push(formatSnapshotBlock(`${target.alias} @ ${target.path}`, snapshot));
  }

  return sections.join("\n");
}

function buildRecentDirectDecisionSection(params: {
  cfg?: ClawdbotConfig;
  userId: string;
  baseDir: string;
}): string {
  const runtime = load43ChatSkillRuntime(params.cfg);
  const target = resolveSkillStorageTargets(runtime, ["dialog_decision_log"], { user_id: params.userId })[0];
  if (!target) {
    return "【最近 dialog_decision_log】\n<missing>\n";
  }
  const fullPath = resolveStorageFullPath(target.path, params.baseDir);
  if (!fullPath) {
    return "【最近 dialog_decision_log】\n<invalid>\n";
  }
  const records = readRecentJsonlRecords(fullPath, DIRECT_COGNITION_RECENT_DECISIONS)
    .map((entry, index) => {
      const nickname = readString(entry.nickname) || readString(entry.user_id) || "unknown";
      const currentMessage = readString(entry.current_message);
      const decision = readString(entry.decision);
      return `- #${index + 1} ${nickname}: ${truncateForLog(currentMessage, 120)} / decision=${decision || "<empty>"}`;
    });
  return [
    "【最近 dialog_decision_log】",
    ...(records.length > 0 ? records : ["<empty>"]),
    "",
  ].join("\n");
}

function buildDirectRetryPrompt(params: {
  basePrompt: string;
  parseResult: BackgroundCognitionParseResult;
  missingSummaries: string[];
}): string {
  const missingLines = params.missingSummaries.length > 0
    ? params.missingSummaries.map((summary) => `- ${summary}`).join("\n")
    : "- 当前没有检测到明显空白槽位，但上次输出不可用";

  return [
    params.basePrompt,
    "",
    "【上轮输出不可用，请立刻修正】",
    `- 上轮状态: ${params.parseResult.status}`,
    `- 上轮问题: ${params.parseResult.detail}`,
    `- 上轮原始输出摘要: ${params.parseResult.rawExcerpt || "<empty>"}`,
    "- 如果当前批次已经出现稳定、可复用的人物画像或关系推进信号，不要再返回 `{\"writes\":[]}`；至少输出能确定的那部分增量写入。",
    "- 只允许输出纯 JSON，且顶层必须是 `{\"writes\":[...]}`。",
    "【当前仍待补的长期认知槽位】",
    missingLines,
    "",
    "现在重新输出 JSON。",
  ].join("\n");
}

function buildPrivateCognitionBatchPrompt(params: {
  cfg?: ClawdbotConfig;
  events: PrivateMessageEvent[];
  baseDir?: string;
}): string {
  if (params.events.length === 0) {
    return "";
  }

  const baseDir = params.baseDir ?? STORAGE_ROOT;
  const latestEvent = params.events[params.events.length - 1];
  const latestData = latestEvent.data;
  const userId = String(latestData.from_user_id);
  const allowedPaths = buildAllowedDirectWritePaths({
    cfg: params.cfg,
    userId,
  });
  const runtime = load43ChatSkillRuntime(params.cfg);
  const cognitionPolicy = runtime.data.cognition_policy_defaults;
  const missingSummaries = summarizeMissingDirectLongTermSlots({
    cfg: params.cfg,
    userId,
    baseDir,
    latestTimestamp: latestData.timestamp || latestEvent.timestamp || Date.now(),
  });

  return [
    "你是 43Chat 的后台长期认知 worker。",
    "本轮不是对外聊天；你只负责把一批私聊消息归纳成长期认知写入。",
    "你必须只输出纯 JSON，不要输出 markdown、解释、前后缀、`<chat43-cognition>` 标签。",
    "输出格式固定为：{\"writes\":[{\"path\":\"...json\",\"content\":{...}}]}",
    "如果当前批次还不足以形成稳定、可复用的长期认知，就输出：{\"writes\":[]}",
    "最终输出必须能被标准 `JSON.parse` 成功解析；若发现少括号、少引号、尾部缺失或字段不闭合，先修正，再输出。",
    "输出前先自检一次：确认首字符是 `{`、末字符是 `}`，并且整个文本可被 `JSON.parse` 成功解析。",
    "最终输出首字符必须是 `{`，末字符必须是 `}`；顶层只允许 `writes` 字段，不要输出 `reply`、`decision`、`envelope`、`_meta` 等额外字段。",
    "",
    "【硬性约束】",
    "- 只允许写入本轮允许的路径；不要写 decision_log、任何群文件，也不要写其它用户的文件。",
    "- `content` 可以是局部 patch；插件会和现有 JSON 合并并做规范化。",
    "- `user_profile` 只写稳定的人物结论，如 tags / expertise / personality / notes；如果旧画像已过期或冲突，要覆盖旧判断。",
    "- 只要决定写 `user_profile`，优先一次性给出紧凑版完整画像：同时重写 tags / expertise / personality / notes，而不是只补一个局部字段。",
    "- `user_profile` 不得写入联系方式、精确位置、线下邀约、称呼偏好等敏感细节；只保留稳定、非敏感的人物结论。",
    "- `dialog_state` 只写当前仍在延续的话题、明确待办和可复用关系概括；不要把一次性寒暄或已经结束的话题长期保留。",
    "- 阶段性的关系推进、见面约定、下次再聊安排优先写入 `dialog_state`，不要固化成全局 `user_profile.notes`。",
    "- 只要决定写 `dialog_state`，优先补齐 `current_topics` / `rapport_summary`，有明确后续约定时再补 `pending_actions`。",
    "- 输出要收敛：`tags` 建议 <= 6，`expertise` 建议 <= 8，`current_topics` 建议 <= 6，`notes` 控制在 1-3 条分号短句内。",
    "- 禁止为了凑字段而写空洞套话、营销腔或与文档冲突的内容。",
    "- 如果证据只够短期观察，就不要写长期认知，本轮留空即可。",
    "",
    "【当前优先补位】",
    ...(missingSummaries.length > 0
      ? missingSummaries.map((summary) => `- ${summary}`)
      : ["- 当前长期认知没有明显空槽位；若本批次没有稳定新结论，可以返回 `{\"writes\":[]}`"]),
    "",
    "【允许写入路径】",
    ...allowedPaths.map((pathValue) => `- ${pathValue}`),
    "",
    "【运行时长期认知规则】",
    `- topic_persistence.group_soul = ${cognitionPolicy.topic_persistence?.group_soul ?? "always"}`,
    `- topic_persistence.group_state = ${cognitionPolicy.topic_persistence?.group_state ?? "always"}`,
    `- topic_persistence.decision_log = ${cognitionPolicy.topic_persistence?.decision_log ?? "always"}`,
    `- judgement_rules: ${(cognitionPolicy.topic_persistence?.judgement_rules ?? []).join(" / ") || "<none>"}`,
    `- volatile_terms: ${(cognitionPolicy.topic_persistence?.volatile_terms ?? []).join(" / ") || "<none>"}`,
    `- volatile_regexes: ${(cognitionPolicy.topic_persistence?.volatile_regexes ?? []).join(" / ") || "<none>"}`,
    "",
    "【输出示例】",
    `{"writes":[{"path":"profiles/${userId}.json","content":{"tags":["..."],"expertise":["..."],"personality":"...","notes":"..."}},{"path":"dialogs/${userId}/state.json","content":{"current_topics":["..."],"pending_actions":["..."],"rapport_summary":"..."}}]}`,
    "",
    "【当前私聊对象】",
    `- user_id=${userId}`,
    `- nickname=${latestData.from_nickname || userId}`,
    "",
    buildDocSections(params.cfg, "private_message"),
    buildDirectSnapshotSections({
      cfg: params.cfg,
      userId,
      baseDir,
    }),
    buildRecentDirectDecisionSection({
      cfg: params.cfg,
      userId,
      baseDir,
    }),
    "【当前批次消息】",
    ...params.events.map((event, index) => {
      const data = event.data;
      return `- #${index + 1} ${new Date(data.timestamp || event.timestamp || Date.now()).toISOString()} ${data.from_nickname || data.from_user_id}（user:${String(data.from_user_id)}）: ${truncateForLog(extract43ChatTextContent(data.content), 240)}`;
    }),
    "",
    "现在只输出 JSON。",
  ].join("\n");
}

function buildSyntheticGroupMessageEvent(params: {
  groupId: string;
  groupName: string;
  userId: string;
  nickname: string;
  timestamp: number;
}): GroupMessageEvent {
  return {
    id: `cognition-worker:${params.groupId}:${params.userId}:${params.timestamp}`,
    event_type: "group_message",
    timestamp: params.timestamp,
    data: {
      message_id: `cognition-worker:${params.groupId}:${params.userId}:${params.timestamp}`,
      group_id: Number(params.groupId),
      group_name: params.groupName,
      user_role: 0,
      user_role_name: "member",
      from_user_role: 0,
      from_user_role_name: "member",
      from_user_id: Number(params.userId),
      from_nickname: params.nickname,
      content: "",
      content_type: "text",
      timestamp: params.timestamp,
    },
  };
}

function shouldStampSemanticUpdatedAt(pathValue: string): boolean {
  return pathValue.endsWith("/soul.json")
    || pathValue.endsWith("/members_graph.json")
    || /(?:^|\/)profiles\/[^/]+\.json$/.test(pathValue);
}

function resolveNicknameForProfileWrite(params: {
  fullPath: string;
  content: Record<string, unknown>;
  fallbackUserId: string;
}): string {
  const nickname = readString(params.content.nickname);
  if (nickname) {
    return nickname;
  }
  const existing = readOptionalJson(params.fullPath);
  return readString(existing?.nickname) || params.fallbackUserId;
}

function applyBackgroundWrites(params: {
  cfg?: ClawdbotConfig;
  events: GroupMessageEvent[];
  writes: BackgroundCognitionWrite[];
  baseDir?: string;
  log?: (message: string) => void;
  error?: (message: string) => void;
}): string[] {
  const baseDir = params.baseDir ?? STORAGE_ROOT;
  const latestEvent = params.events[params.events.length - 1];
  const latestData = latestEvent.data;
  const latestTimestamp = latestData.timestamp || latestEvent.timestamp || Date.now();
  const latestIso = new Date(latestTimestamp).toISOString();
  const senderIds = new Set(params.events.map((event) => String(event.data.from_user_id)));
  const allowedPaths = new Set(buildAllowedWritePaths({
    cfg: params.cfg,
    groupId: String(latestData.group_id),
    senderIds: Array.from(senderIds),
  }));

  const written: string[] = [];

  for (const write of params.writes) {
    const fullPath = resolveStorageFullPath(write.path, baseDir);
    const relativePath = fullPath
      ? normalize(fullPath).slice(normalize(baseDir).length + 1)
      : normalize(write.path).replace(/^\/+/, "");
    if (!allowedPaths.has(relativePath)) {
      params.error?.(`43chat cognition worker: skip disallowed write path ${write.path}`);
      continue;
    }
    if (!fullPath) {
      params.error?.(`43chat cognition worker: invalid write path ${write.path}`);
      continue;
    }

    try {
      const profileMatch = relativePath.match(/^profiles\/([^/]+)\.json$/);
      const syntheticEvent = profileMatch
        ? buildSyntheticGroupMessageEvent({
          groupId: String(latestData.group_id),
          groupName: latestData.group_name || `群${latestData.group_id}`,
          userId: profileMatch[1] ?? String(latestData.from_user_id),
          nickname: resolveNicknameForProfileWrite({
            fullPath,
            content: write.content,
            fallbackUserId: profileMatch[1] ?? String(latestData.from_user_id),
          }),
          timestamp: latestTimestamp,
        })
        : latestEvent;

      const normalizedContent = normalizeSkillCognitionWriteContent({
        cfg: params.cfg,
        event: syntheticEvent,
        path: fullPath,
        content: write.content,
        baseDir,
      });
      const content = shouldStampSemanticUpdatedAt(relativePath)
        ? { ...normalizedContent, updated_at: latestIso }
        : normalizedContent;

      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, `${JSON.stringify(content, null, 2)}\n`, "utf8");
      written.push(relativePath);
    } catch (cause) {
      params.error?.(`43chat cognition worker: failed to write ${write.path}: ${String(cause)}`);
    }
  }

  if (written.length > 0) {
    params.log?.(`43chat cognition worker: wrote ${written.join(", ")}`);
  }
  return written;
}

function applyDirectBackgroundWrites(params: {
  cfg?: ClawdbotConfig;
  events: PrivateMessageEvent[];
  writes: BackgroundCognitionWrite[];
  baseDir?: string;
  log?: (message: string) => void;
  error?: (message: string) => void;
}): string[] {
  const baseDir = params.baseDir ?? STORAGE_ROOT;
  const latestEvent = params.events[params.events.length - 1];
  const latestData = latestEvent.data;
  const latestTimestamp = latestData.timestamp || latestEvent.timestamp || Date.now();
  const latestIso = new Date(latestTimestamp).toISOString();
  const userId = String(latestData.from_user_id);
  const allowedPaths = new Set(buildAllowedDirectWritePaths({
    cfg: params.cfg,
    userId,
  }));
  const runtime = load43ChatSkillRuntime(params.cfg);
  const profilePath = resolveSkillStorageTargets(runtime, ["user_profile"], { user_id: userId })[0]?.path ?? `profiles/${userId}.json`;

  const written: string[] = [];

  for (const write of params.writes) {
    const fullPath = resolveStorageFullPath(write.path, baseDir);
    const relativePath = fullPath
      ? normalize(fullPath).slice(normalize(baseDir).length + 1)
      : normalize(write.path).replace(/^\/+/, "");
    if (!allowedPaths.has(relativePath)) {
      params.error?.(`43chat cognition worker: skip disallowed direct write path ${write.path}`);
      continue;
    }
    if (!fullPath) {
      params.error?.(`43chat cognition worker: invalid direct write path ${write.path}`);
      continue;
    }

    try {
      const normalizedContent = normalizeSkillCognitionWriteContent({
        cfg: params.cfg,
        event: latestEvent,
        path: fullPath,
        content: write.content,
        baseDir,
      });
      const guardedContent = relativePath === profilePath
        ? { ...normalizedContent, is_friend: true }
        : normalizedContent;
      const content = shouldStampSemanticUpdatedAt(relativePath)
        ? { ...guardedContent, updated_at: latestIso }
        : guardedContent;

      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, `${JSON.stringify(content, null, 2)}\n`, "utf8");
      written.push(relativePath);
    } catch (cause) {
      params.error?.(`43chat cognition worker: failed to write ${write.path}: ${String(cause)}`);
    }
  }

  if (written.length > 0) {
    params.log?.(`43chat cognition worker: wrote ${written.join(", ")}`);
  }
  return written;
}

async function runGroupCognitionBatch(params: {
  cfg?: ClawdbotConfig;
  events: GroupMessageEvent[];
  baseDir?: string;
  openclawHome?: string;
  log?: (message: string) => void;
  error?: (message: string) => void;
}): Promise<void> {
  if (params.events.length === 0) {
    return;
  }

  const baseDir = params.baseDir ?? STORAGE_ROOT;
  const prompt = buildGroupCognitionBatchPrompt({
    cfg: params.cfg,
    events: params.events,
    baseDir,
  });
  const modelConfig = resolveLocalModelConfig({
    openclawHome: params.openclawHome,
  });
  params.log?.(`43chat cognition worker: dispatch batch group=${params.events[0]?.data.group_id} size=${params.events.length} model=${modelConfig.providerId}/${modelConfig.modelId}`);

  let responseText = await requestBackgroundCognitionWrites({
    prompt,
    modelConfig,
  });
  let parsed = analyzeBackgroundCognitionWrites(responseText);
  if (parsed.writes.length === 0) {
    const senderIds = Array.from(new Set(params.events.map((event) => String(event.data.from_user_id))));
    const missingSummaries = summarizeMissingLongTermSlots({
      cfg: params.cfg,
      groupId: String(params.events[0]?.data.group_id ?? ""),
      senderIds,
      baseDir,
    });
    if (missingSummaries.length > 0) {
      params.log?.(
        `43chat cognition worker: retry once for empty/invalid long-term writes status=${parsed.status} missing=${missingSummaries.join(" | ")}`,
      );
      responseText = await requestBackgroundCognitionWrites({
        prompt: buildBackgroundRetryPrompt({
          basePrompt: prompt,
          parseResult: parsed,
          missingSummaries,
        }),
        modelConfig,
      });
      parsed = analyzeBackgroundCognitionWrites(responseText);
    }
  }
  if (parsed.writes.length === 0) {
    params.log?.(
      `43chat cognition worker: no long-term writes status=${parsed.status} detail=${parsed.detail} response=${parsed.rawExcerpt}`,
    );
    return;
  }

  applyBackgroundWrites({
    cfg: params.cfg,
    events: params.events,
    writes: parsed.writes,
    baseDir,
    log: params.log,
    error: params.error,
  });
}

async function runDirectCognitionBatch(params: {
  cfg?: ClawdbotConfig;
  events: PrivateMessageEvent[];
  baseDir?: string;
  openclawHome?: string;
  log?: (message: string) => void;
  error?: (message: string) => void;
}): Promise<void> {
  if (params.events.length === 0) {
    return;
  }

  const baseDir = params.baseDir ?? STORAGE_ROOT;
  const latestEvent = params.events[params.events.length - 1];
  const latestData = latestEvent.data;
  const userId = String(latestData.from_user_id);
  const prompt = buildPrivateCognitionBatchPrompt({
    cfg: params.cfg,
    events: params.events,
    baseDir,
  });
  const modelConfig = resolveLocalModelConfig({
    openclawHome: params.openclawHome,
  });
  params.log?.(`43chat cognition worker: dispatch direct batch user=${userId} size=${params.events.length} model=${modelConfig.providerId}/${modelConfig.modelId}`);

  let responseText = await requestBackgroundCognitionWrites({
    prompt,
    modelConfig,
  });
  let parsed = analyzeBackgroundCognitionWrites(responseText);
  if (parsed.writes.length === 0) {
    const missingSummaries = summarizeMissingDirectLongTermSlots({
      cfg: params.cfg,
      userId,
      baseDir,
      latestTimestamp: latestData.timestamp || latestEvent.timestamp || Date.now(),
    });
    if (missingSummaries.length > 0) {
      params.log?.(
        `43chat cognition worker: retry once for empty/invalid direct writes status=${parsed.status} missing=${missingSummaries.join(" | ")}`,
      );
      responseText = await requestBackgroundCognitionWrites({
        prompt: buildDirectRetryPrompt({
          basePrompt: prompt,
          parseResult: parsed,
          missingSummaries,
        }),
        modelConfig,
      });
      parsed = analyzeBackgroundCognitionWrites(responseText);
    }
  }
  if (parsed.writes.length === 0) {
    params.log?.(
      `43chat cognition worker: no direct long-term writes status=${parsed.status} detail=${parsed.detail} response=${parsed.rawExcerpt}`,
    );
    return;
  }

  applyDirectBackgroundWrites({
    cfg: params.cfg,
    events: params.events,
    writes: parsed.writes,
    baseDir,
    log: params.log,
    error: params.error,
  });
}

function trimQueuedEvents(events: GroupMessageEvent[]): GroupMessageEvent[] {
  if (events.length <= GROUP_COGNITION_BATCH_MAX_MESSAGES) {
    return events;
  }
  return events.slice(-GROUP_COGNITION_BATCH_MAX_MESSAGES);
}

function trimQueuedDirectEvents(events: PrivateMessageEvent[]): PrivateMessageEvent[] {
  if (events.length <= DIRECT_COGNITION_BATCH_MAX_MESSAGES) {
    return events;
  }
  return events.slice(-DIRECT_COGNITION_BATCH_MAX_MESSAGES);
}

function scheduleFlush(groupId: string, delayMs: number): void {
  const state = pendingGroupCognitionBatches.get(groupId);
  if (!state) {
    return;
  }
  if (state.timer) {
    clearTimeout(state.timer);
  }
  state.timer = setTimeout(() => {
    void flushGroupCognitionBatch(groupId);
  }, delayMs);
}

function scheduleDirectFlush(userId: string, delayMs: number): void {
  const state = pendingDirectCognitionBatches.get(userId);
  if (!state) {
    return;
  }
  if (state.timer) {
    clearTimeout(state.timer);
  }
  state.timer = setTimeout(() => {
    void flushDirectCognitionBatch(userId);
  }, delayMs);
}

async function flushGroupCognitionBatch(groupId: string): Promise<void> {
  const state = pendingGroupCognitionBatches.get(groupId);
  if (!state) {
    return;
  }
  if (state.running) {
    state.needsRerun = true;
    return;
  }

  const batchEvents = state.events;
  state.events = [];
  state.running = true;
  state.needsRerun = false;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = undefined;
  }

  try {
    await runGroupCognitionBatch({
      cfg: state.cfg,
      events: batchEvents,
      log: state.log,
      error: state.error,
    });
  } catch (cause) {
    state.error?.(`43chat cognition worker: batch failed for group ${groupId}: ${String(cause)}`);
    state.events = trimQueuedEvents([...batchEvents, ...state.events]);
  } finally {
    state.running = false;
    if (state.events.length > 0 || state.needsRerun) {
      scheduleFlush(groupId, 1_500);
      return;
    }
    pendingGroupCognitionBatches.delete(groupId);
  }
}

async function flushDirectCognitionBatch(userId: string): Promise<void> {
  const state = pendingDirectCognitionBatches.get(userId);
  if (!state) {
    return;
  }
  if (state.running) {
    state.needsRerun = true;
    return;
  }

  const batchEvents = state.events;
  state.events = [];
  state.running = true;
  state.needsRerun = false;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = undefined;
  }

  try {
    await runDirectCognitionBatch({
      cfg: state.cfg,
      events: batchEvents,
      log: state.log,
      error: state.error,
    });
  } catch (cause) {
    state.error?.(`43chat cognition worker: direct batch failed for user ${userId}: ${String(cause)}`);
    state.events = trimQueuedDirectEvents([...batchEvents, ...state.events]);
  } finally {
    state.running = false;
    if (state.events.length > 0 || state.needsRerun) {
      scheduleDirectFlush(userId, 1_500);
      return;
    }
    pendingDirectCognitionBatches.delete(userId);
  }
}

export function scheduleGroupLongTermCognitionRefresh(params: {
  cfg?: ClawdbotConfig;
  event: Chat43AnySSEEvent;
  log?: (message: string) => void;
  error?: (message: string) => void;
}): void {
  if (params.event.event_type !== "group_message") {
    return;
  }

  const event = params.event as GroupMessageEvent;
  const data = event.data;
  const groupId = String(data.group_id);
  const current = pendingGroupCognitionBatches.get(groupId) ?? {
    cfg: params.cfg,
    groupId,
    groupName: data.group_name || `群${groupId}`,
    events: [],
    running: false,
    needsRerun: false,
    log: params.log,
    error: params.error,
  };

  current.cfg = params.cfg;
  current.groupName = data.group_name || current.groupName;
  current.log = params.log;
  current.error = params.error;

  const existingIndex = current.events.findIndex((entry) => String(entry.data.message_id) === String(data.message_id));
  if (existingIndex >= 0) {
    current.events.splice(existingIndex, 1);
  }
  current.events.push(event);
  current.events = trimQueuedEvents(current.events);
  pendingGroupCognitionBatches.set(groupId, current);

  if (current.running) {
    current.needsRerun = true;
    return;
  }
  scheduleFlush(groupId, GROUP_COGNITION_BATCH_DEBOUNCE_MS);
}

export function schedulePrivateLongTermCognitionRefresh(params: {
  cfg?: ClawdbotConfig;
  event: Chat43AnySSEEvent;
  log?: (message: string) => void;
  error?: (message: string) => void;
}): void {
  if (params.event.event_type !== "private_message") {
    return;
  }

  const event = params.event as PrivateMessageEvent;
  const data = event.data;
  const userId = String(data.from_user_id);
  const current = pendingDirectCognitionBatches.get(userId) ?? {
    cfg: params.cfg,
    userId,
    nickname: data.from_nickname || userId,
    events: [],
    running: false,
    needsRerun: false,
    log: params.log,
    error: params.error,
  };

  current.cfg = params.cfg;
  current.nickname = data.from_nickname || current.nickname;
  current.log = params.log;
  current.error = params.error;

  const existingIndex = current.events.findIndex((entry) => String(entry.data.message_id) === String(data.message_id));
  if (existingIndex >= 0) {
    current.events.splice(existingIndex, 1);
  }
  current.events.push(event);
  current.events = trimQueuedDirectEvents(current.events);
  pendingDirectCognitionBatches.set(userId, current);

  if (current.running) {
    current.needsRerun = true;
    return;
  }
  scheduleDirectFlush(userId, DIRECT_COGNITION_BATCH_DEBOUNCE_MS);
}

export function scheduleLongTermCognitionRefresh(params: {
  cfg?: ClawdbotConfig;
  event: Chat43AnySSEEvent;
  log?: (message: string) => void;
  error?: (message: string) => void;
}): void {
  if (params.event.event_type === "group_message") {
    scheduleGroupLongTermCognitionRefresh(params);
    return;
  }
  if (params.event.event_type === "private_message") {
    schedulePrivateLongTermCognitionRefresh(params);
  }
}

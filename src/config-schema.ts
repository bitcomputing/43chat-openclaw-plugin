import { z } from "zod";

export { z };

const DmPolicySchema = z.enum(["open", "pairing"]).default("open");
const ChunkModeSchema = z.enum(["length", "newline", "raw"]).default("raw");

const Chat43SharedConfigShape = {
  dmPolicy: DmPolicySchema.optional(),
  allowFrom: z.array(z.string()).optional(),
  requestTimeoutMs: z.number().int().positive().optional(),
  sseReconnectDelayMs: z.number().int().positive().optional(),
  sseMaxReconnectDelayMs: z.number().int().positive().optional(),
  sseHeartbeatTimeoutMs: z.number().int().positive().optional(),
  promptGroupContextEnabled: z.boolean().optional(),
  promptGroupContextApiPath: z.string().optional(),
  promptGroupContextRefreshMs: z.number().int().positive().optional(),
  promptGroupContextMaxItems: z.number().int().positive().optional(),
  textChunkLimit: z.number().int().positive().optional(),
  chunkMode: ChunkModeSchema,
  blockStreaming: z.boolean().default(false),
};

export const Chat43AccountConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    name: z.string().optional(),
    baseUrl: z.string().url().optional(),
    apiKey: z.string().optional(),
    ...Chat43SharedConfigShape,
  })
  .strict();

export const Chat43ConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    baseUrl: z.string().url().optional(),
    apiKey: z.string().optional(),
    skillDocsDir: z.string().optional(),
    skillRuntimePath: z.string().optional(),
    ...Chat43SharedConfigShape,
    accounts: z.record(z.string(), Chat43AccountConfigSchema.optional()).optional(),
  })
  .strict();

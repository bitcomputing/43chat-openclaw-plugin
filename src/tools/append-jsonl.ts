import type { AnyAgentTool, ClawdbotConfig } from "openclaw/plugin-sdk";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize } from "node:path";

const ALLOWED_BASE = join(homedir(), ".config", "43chat");

type ToolParams = {
  path: string;
  content: unknown;
};

type AgentToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
};

export function createAppendJsonlTool(_cfg: ClawdbotConfig): AnyAgentTool {
  return {
    name: "chat43_append_jsonl",
    label: "43Chat Append JSONL",
    description: "向43Chat认知日志JSONL文件追加一条记录. 路径相对于~/.config/43chat/",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "文件路径, 例如: groups/123/decision_log.jsonl",
        },
        content: {
          type: "object",
          description: "要追加的一条JSON记录",
        },
      },
      required: ["path", "content"],
    },
    async execute(_toolCallId: string, params: ToolParams): Promise<AgentToolResult> {
      const fullPath = join(ALLOWED_BASE, normalize(params.path));

      if (!fullPath.startsWith(ALLOWED_BASE)) {
        const result = { error: "路径不允许" };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        };
      }

      try {
        const dir = dirname(fullPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }

        appendFileSync(fullPath, `${JSON.stringify(params.content)}\n`, "utf8");

        const result = { success: true, path: params.path };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        };
      } catch (error) {
        const result = { error: `追加失败: ${error}` };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        };
      }
    },
  };
}

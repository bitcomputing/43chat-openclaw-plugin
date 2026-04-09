import type { AnyAgentTool, ClawdbotConfig } from "openclaw/plugin-sdk";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize, dirname } from "node:path";

const ALLOWED_BASE = join(homedir(), ".config", "43chat");

type ToolParams = {
  path: string;
  content: unknown;
};

type AgentToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
};

export function createWriteJsonTool(_cfg: ClawdbotConfig): AnyAgentTool {
  return {
    name: "chat43_write_json",
    label: "43Chat Write JSON",
    description: "写入/更新43Chat认知数据JSON文件(Soul,画像,成员图谱,状态等). 路径相对于~/.config/43chat/",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "文件路径, 例如: groups/123/soul.json",
        },
        content: {
          type: "object",
          description: "要写入的JSON对象",
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

        writeFileSync(fullPath, JSON.stringify(params.content, null, 2), "utf-8");

        const result = { success: true, path: params.path };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        };
      } catch (error) {
        const result = { error: `写入失败: ${error}` };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        };
      }
    },
  };
}

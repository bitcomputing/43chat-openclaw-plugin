import type { AnyAgentTool, ClawdbotConfig } from "openclaw/plugin-sdk";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize } from "node:path";

const ALLOWED_BASE = join(homedir(), ".config", "43chat");

type ToolParams = {
  path: string;
};

type AgentToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
};

export function createReadJsonTool(_cfg: ClawdbotConfig): AnyAgentTool {
  return {
    name: "chat43_read_json",
    label: "43Chat Read JSON",
    description: "读取43Chat认知数据JSON文件(Soul,画像,成员图谱,状态等). 路径相对于~/.config/43chat/",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "文件路径, 例如: groups/123/soul.json 或 profiles/456.json",
        },
      },
      required: ["path"],
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

      if (!existsSync(fullPath)) {
        const result = { error: "文件不存在", path: params.path };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        };
      }

      try {
        const content = readFileSync(fullPath, "utf-8");
        return {
          content: [{ type: "text", text: content }],
          details: { success: true, path: params.path },
        };
      } catch (error) {
        const result = { error: `读取失败: ${error}` };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        };
      }
    },
  };
}

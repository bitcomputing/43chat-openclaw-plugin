import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeBackgroundCognitionWrites,
  buildGroupCognitionBatchPrompt,
  parseBackgroundCognitionWrites,
  resolveLocalModelConfig,
} from "../cognition-worker.js";

describe("43Chat cognition worker", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves local model config from openclaw models/auth files", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-cognition-worker-"));
    tempDirs.push(dir);
    mkdirSync(join(dir, "agents/main/agent"), { recursive: true });
    writeFileSync(join(dir, "openclaw.json"), JSON.stringify({
      agents: {
        defaults: {
          model: {
            primary: "minimax/MiniMax-M2.7",
          },
        },
      },
    }), "utf8");
    writeFileSync(join(dir, "agents/main/agent/models.json"), JSON.stringify({
      providers: {
        minimax: {
          baseUrl: "https://api.minimaxi.com/anthropic",
          api: "anthropic-messages",
          models: [{
            id: "MiniMax-M2.7",
            maxTokens: 131072,
          }],
        },
      },
    }), "utf8");
    writeFileSync(join(dir, "agents/main/agent/auth-profiles.json"), JSON.stringify({
      profiles: {
        "minimax:cn": {
          type: "api_key",
          provider: "minimax",
          key: "sk-test",
        },
      },
      lastGood: {
        minimax: "minimax:cn",
      },
    }), "utf8");

    expect(resolveLocalModelConfig({ openclawHome: dir })).toMatchObject({
      providerId: "minimax",
      modelId: "MiniMax-M2.7",
      baseUrl: "https://api.minimaxi.com/anthropic",
      api: "anthropic-messages",
      apiKey: "sk-test",
      maxTokens: 131072,
    });
  });

  it("parses background cognition writes from plain json and envelope-like output", () => {
    expect(parseBackgroundCognitionWrites("{\"writes\":[{\"path\":\"groups/100/soul.json\",\"content\":{\"soul\":{\"purpose\":\"项目推进\"}}}]}")).toEqual([
      {
        path: "groups/100/soul.json",
        content: { soul: { purpose: "项目推进" } },
      },
    ]);

    expect(parseBackgroundCognitionWrites("<chat43-cognition>{\"writes\":[{\"path\":\"profiles/12443.json\",\"content\":{\"tags\":[\"产品\"]}}],\"reply\":\"NO_REPLY\"}</chat43-cognition>")).toEqual([
      {
        path: "profiles/12443.json",
        content: { tags: ["产品"] },
      },
    ]);

    expect(parseBackgroundCognitionWrites("{\"writes\":[{\"path\":\"groups/100/members_graph.json\",\"content\":{\"members\":{\"12446\":{\"role\":\"contributor\",\"in_group_tags\":[\"测试\"],\"strategy\":\"补齐成员图谱\"}}}}")).toEqual([
      {
        path: "groups/100/members_graph.json",
        content: {
          members: {
            "12446": {
              role: "contributor",
              in_group_tags: ["测试"],
              strategy: "补齐成员图谱",
            },
          },
        },
      },
    ]);

    expect(parseBackgroundCognitionWrites("{\"writes\":[{\"path\":\"groups/100/soul.json\",\"content\":{\"soul\":{\"topics\":[\"合同审批流方案\",\"售后工单分级响应优化\",\"权限申请流程优化\"]}}},{\"path\":\"profiles/12446.json\",\"content\":{\"tags\":[\"测试视角\",\"质量保障\",\"边界验证\",\"权限验证\"],\"expertise\":[\"测试策略\",\"资格判断验证\",\"库存回滚\",\"跨天状态切换\",\"活动边界场景\",\"权限申请边界场景\"]}},{\"path\":\"groups/100/members_graph.json\",\"content\":{\"members\":{\"12446\":{\"role\":\"contributor\",\"in_group_tags\":[\"测试视角\",\"质量保障\",\"边界验证\",\"权限验证\"],\"strategy\":\"从测试负责人视角强调边界验证，擅长识别驳回重提、审批超时、角色回收等权限申请高风险分支，主张灰度前用真实工单回放完整链路\"}}}]}}")).toEqual([
      {
        path: "groups/100/soul.json",
        content: {
          soul: {
            topics: ["合同审批流方案", "售后工单分级响应优化", "权限申请流程优化"],
          },
        },
      },
      {
        path: "profiles/12446.json",
        content: {
          tags: ["测试视角", "质量保障", "边界验证", "权限验证"],
          expertise: ["测试策略", "资格判断验证", "库存回滚", "跨天状态切换", "活动边界场景", "权限申请边界场景"],
        },
      },
      {
        path: "groups/100/members_graph.json",
        content: {
          members: {
            "12446": {
              role: "contributor",
              in_group_tags: ["测试视角", "质量保障", "边界验证", "权限验证"],
              strategy: "从测试负责人视角强调边界验证，擅长识别驳回重提、审批超时、角色回收等权限申请高风险分支，主张灰度前用真实工单回放完整链路",
            },
          },
        },
      },
    ]);

    expect(parseBackgroundCognitionWrites("\u0000{\"writes\":[{\"path\":\"profiles/12444.json\",\"content\":{\"notes\":\"补充审批流优化视角\"}},{\"path\":\"profiles/12446.json\",\"content\":{\"notes\":\"补充数据导出边界验证观点\"}}]}\u0007")).toEqual([
      {
        path: "profiles/12444.json",
        content: {
          notes: "补充审批流优化视角",
        },
      },
      {
        path: "profiles/12446.json",
        content: {
          notes: "补充数据导出边界验证观点",
        },
      },
    ]);
  });

  it("classifies explicit empty and invalid background cognition payloads", () => {
    expect(analyzeBackgroundCognitionWrites("{\"writes\":[]}")).toMatchObject({
      writes: [],
      status: "explicit_empty",
    });

    expect(analyzeBackgroundCognitionWrites("{\"writes\":[{\"path\":\"groups/100/soul.json\",\"content\":\"bad\"}]}")).toMatchObject({
      writes: [],
      status: "invalid_write_shape",
    });

    expect(analyzeBackgroundCognitionWrites("先解释一下我的判断，再给你结果")).toMatchObject({
      writes: [],
      status: "unparseable",
    });
  });

  it("builds group cognition batch prompt with allowed paths and batch messages", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-cognition-worker-"));
    tempDirs.push(dir);
    mkdirSync(join(dir, "groups/100"), { recursive: true });
    mkdirSync(join(dir, "profiles"), { recursive: true });
    writeFileSync(join(dir, "groups/100/soul.json"), JSON.stringify({
      schema_version: "1.0",
      group_id: "100",
      soul: {
        purpose: "",
        topics: [],
        boundaries: "",
        expectations: "",
      },
    }), "utf8");
    writeFileSync(join(dir, "groups/100/members_graph.json"), JSON.stringify({
      schema_version: "1.0",
      group_id: "100",
      members: {},
    }), "utf8");
    writeFileSync(join(dir, "profiles/12443.json"), JSON.stringify({
      schema_version: "1.0",
      user_id: "12443",
      nickname: "素菜不好吃",
      tags: [],
      expertise: [],
      personality: "",
      notes: "",
    }), "utf8");

    const prompt = buildGroupCognitionBatchPrompt({
      baseDir: dir,
      events: [{
        id: "evt-1",
        event_type: "group_message",
        timestamp: 1000,
        data: {
          message_id: "msg-1",
          group_id: 100,
          group_name: "项目工作群",
          user_role: 1,
          user_role_name: "admin",
          from_user_role: 0,
          from_user_role_name: "member",
          from_user_id: 12443,
          from_nickname: "素菜不好吃",
          content: "{\"content\":\"我建议先把客户现状和试点范围讲透。\"}",
          content_type: "text",
          timestamp: 1000,
        },
      }],
    });

    expect(prompt).toContain("后台长期认知 worker");
    expect(prompt).toContain("允许写入路径");
    expect(prompt).toContain("groups/100/soul.json");
    expect(prompt).toContain("groups/100/members_graph.json");
    expect(prompt).toContain("profiles/12443.json");
    expect(prompt).toContain("当前批次消息");
    expect(prompt).toContain("我建议先把客户现状和试点范围讲透");
    expect(prompt).toContain("group_soul(groups/100/soul.json) 缺少 purpose / topics / boundaries / expectations");
    expect(prompt).toContain("优先一次性给出紧凑版完整画像");
    expect(prompt).toContain("如果 `group_soul` 当前只剩 `expectations` 为空，就直接补 `soul.expectations`");
  });
});

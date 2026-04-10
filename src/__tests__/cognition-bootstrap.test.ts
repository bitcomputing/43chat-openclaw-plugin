import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureSkillCognitionBootstrap,
  finalizeSkillDecision,
  inspectGroupMessageCognitionWriteRequirements,
  inspectPrivateMessageCognitionWriteRequirements,
  normalizeSkillCognitionWriteContent,
  updateSkillAgentRole,
  updateSkillCognitionFromEvent,
} from "../cognition-bootstrap.js";

describe("43Chat cognition bootstrap", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates missing group cognition files in the storage root", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-bootstrap-"));
    tempDirs.push(dir);

    const result = ensureSkillCognitionBootstrap({
      baseDir: dir,
      event: {
        id: "evt-bootstrap-group",
        event_type: "group_message",
        timestamp: 1000,
        data: {
          message_id: 801,
          group_id: 99,
          group_name: "罗盘群",
          from_user_id: 12373,
          from_nickname: "Alice",
          content_type: "text",
          content: "hello",
          user_role: 0,
          user_role_name: "member",
          timestamp: 1000,
        },
      },
    });

    expect(result.created).toEqual([
      "groups/99/soul.json",
      "groups/99/members_graph.json",
      "groups/99/state.json",
      "profiles/12373.json",
    ]);
    expect(existsSync(join(dir, "groups/99/soul.json"))).toBe(true);
    expect(existsSync(join(dir, "groups/99/members_graph.json"))).toBe(true);
    expect(existsSync(join(dir, "groups/99/state.json"))).toBe(true);
    expect(existsSync(join(dir, "profiles/12373.json"))).toBe(true);

    const soul = JSON.parse(readFileSync(join(dir, "groups/99/soul.json"), "utf8"));
    const membersGraph = JSON.parse(readFileSync(join(dir, "groups/99/members_graph.json"), "utf8"));
    const state = JSON.parse(readFileSync(join(dir, "groups/99/state.json"), "utf8"));
    const profile = JSON.parse(readFileSync(join(dir, "profiles/12373.json"), "utf8"));
    expect(soul.group_id).toBe("99");
    expect(soul.group_name).toBe("罗盘群");
    expect(soul.source).toBe("inferred");
    expect(soul.soul.topics).toEqual([]);
    expect(membersGraph.members["12373"].role).toBe("");
    expect(membersGraph.members["12373"].strategy).toBe("");
    expect(state.topic_drift_counter).toBe(0);
    expect(profile.user_id).toBe("12373");
    expect(profile.nickname).toBe("Alice");
    expect(profile.first_seen_context).toBe("罗盘群");
    expect(profile.influence_level).toBe("");
  });

  it("uses runtime bootstrap overrides and normalizes existing files", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-bootstrap-"));
    tempDirs.push(dir);
    const runtimeDir = mkdtempSync(join(tmpdir(), "43chat-bootstrap-runtime-"));
    tempDirs.push(runtimeDir);
    const runtimePath = join(runtimeDir, "skill.runtime.json");
    writeFileSync(runtimePath, JSON.stringify({
      version: "4.1.0",
      bootstrap_defaults: {
        group_soul: {
          schema_version: "2.0",
          group_id: "{group_id}",
          custom_mode: "runtime_override",
        },
      },
    }), "utf8");

    const existingPath = join(dir, "groups/99/state.json");
    mkdirSync(join(dir, "groups/99"), { recursive: true });
    writeFileSync(existingPath, JSON.stringify({ preserved: true }), "utf8");

    const result = ensureSkillCognitionBootstrap({
      baseDir: dir,
      cfg: {
        channels: {
          "43chat-openclaw-plugin": {
            skillDocsDir: runtimeDir,
            skillRuntimePath: runtimePath,
          },
        },
      } as any,
      event: {
        id: "evt-bootstrap-runtime",
        event_type: "group_message",
        timestamp: 1000,
        data: {
          message_id: 802,
          group_id: 99,
          group_name: "Override 群",
          from_user_id: 12374,
          from_nickname: "Bob",
          content_type: "text",
          content: "hello",
          user_role: 0,
          user_role_name: "member",
          timestamp: 1000,
        },
      },
    });

    expect(result.updated).toContain("groups/99/state.json");
    expect(JSON.parse(readFileSync(existingPath, "utf8"))).toEqual({
      schema_version: "1.0",
      group_id: "99",
      my_role: "",
      my_role_source: "",
      my_role_updated_at: "",
      current_topic: "",
      recent_topics: [],
      pending_actions: [],
      topic_drift_counter: 0,
      last_decision: "",
      last_reason: "",
      last_active_at: "1970-01-01T00:00:01.000Z",
      updated_at: "1970-01-01T00:00:01.000Z",
    });

    const soul = JSON.parse(readFileSync(join(dir, "groups/99/soul.json"), "utf8"));
    const profile = JSON.parse(readFileSync(join(dir, "profiles/12374.json"), "utf8"));
    expect(soul.custom_mode).toBe("runtime_override");
    expect(profile.nickname).toBe("Bob");
  });

  it("persists agent role into group_state", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-bootstrap-"));
    tempDirs.push(dir);
    const event = {
      id: "evt-bootstrap-role",
      event_type: "group_message" as const,
      timestamp: 1000,
      data: {
        message_id: 805,
        group_id: 99,
        group_name: "角色群",
        from_user_id: 12445,
        from_nickname: "Alice",
        content_type: "text",
        content: "hello",
        user_role: 1,
        user_role_name: "admin",
        timestamp: 1000,
      },
    };

    ensureSkillCognitionBootstrap({ baseDir: dir, event });
    const result = updateSkillAgentRole({
      baseDir: dir,
      event,
      roleName: "管理员",
      source: "api",
    });

    expect(result.updated).toContain("groups/99/state.json");
    const state = JSON.parse(readFileSync(join(dir, "groups/99/state.json"), "utf8"));
    expect(state.my_role).toBe("管理员");
    expect(state.my_role_source).toBe("api");
    expect(state.my_role_updated_at).toBe("1970-01-01T00:00:01.000Z");
  });

  it("detects missing cognition writes for empty group soul and persona slots", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-bootstrap-"));
    const runtimeDir = mkdtempSync(join(tmpdir(), "43chat-bootstrap-runtime-"));
    tempDirs.push(dir, runtimeDir);
    const event = {
      id: "evt-bootstrap-enforcement",
      event_type: "group_message" as const,
      timestamp: 1000,
      data: {
        message_id: 806,
        group_id: 100,
        group_name: "项目群",
        from_user_id: 12443,
        from_nickname: "素菜不好吃",
        content_type: "text",
        content: "一期先把高频问答上线。",
        user_role: 0,
        user_role_name: "member",
        from_user_role: 0,
        from_user_role_name: "member",
        timestamp: 1000,
      },
    };

    ensureSkillCognitionBootstrap({ baseDir: dir, event });
    updateSkillCognitionFromEvent({ baseDir: dir, event });

    const result = inspectGroupMessageCognitionWriteRequirements({
      cfg: {
        channels: {
          "43chat-openclaw-plugin": {
            skillDocsDir: runtimeDir,
            skillRuntimePath: join(runtimeDir, "skill.runtime.json"),
          },
        },
      } as any,
      baseDir: dir,
      event,
    });

    expect(result.enabled).toBe(true);
    expect(result.issues.map((issue) => issue.alias)).toEqual([
      "group_soul",
      "user_profile",
      "group_members_graph",
    ]);
  });

  it("does not require cognition rewrite after files are explicitly filled", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-bootstrap-"));
    tempDirs.push(dir);
    const event = {
      id: "evt-bootstrap-enforcement-filled",
      event_type: "group_message" as const,
      timestamp: 1000,
      data: {
        message_id: 807,
        group_id: 100,
        group_name: "项目群",
        from_user_id: 12443,
        from_nickname: "素菜不好吃",
        content_type: "text",
        content: "一期先把高频问答上线。",
        user_role: 0,
        user_role_name: "member",
        from_user_role: 0,
        from_user_role_name: "member",
        timestamp: 1000,
      },
    };

    ensureSkillCognitionBootstrap({ baseDir: dir, event });
    updateSkillCognitionFromEvent({ baseDir: dir, event });
    writeFileSync(join(dir, "groups/100/soul.json"), JSON.stringify({
      schema_version: "1.0",
      group_id: "100",
      group_name: "项目群",
      source: "inferred",
      soul: {
        purpose: "项目协同推进",
        topics: ["知识库问答上线"],
        tone: "专业",
        boundaries: "不闲聊无关话题",
        expectations: "围绕交付推进",
      },
      updated_at: "2026-04-07T12:00:00Z",
    }, null, 2), "utf8");
    writeFileSync(join(dir, "profiles/12443.json"), JSON.stringify({
      schema_version: "1.0",
      user_id: "12443",
      nickname: "素菜不好吃",
      first_seen: "2026-04-07",
      first_seen_context: "项目群",
      is_friend: false,
      tags: ["产品"],
      expertise: ["项目推进"],
      personality: "直接",
      influence_level: "medium",
      interaction_stats: {
        total_interactions: 2,
        last_interaction: "2026-04-07",
        sentiment_trend: "neutral",
      },
      notes: "负责推进一期范围",
      updated_at: "2026-04-07",
    }, null, 2), "utf8");
    writeFileSync(join(dir, "groups/100/members_graph.json"), JSON.stringify({
      schema_version: "1.0",
      group_id: "100",
      members: {
        "12443": {
          role: "contributor",
          in_group_tags: ["项目推进"],
          strategy: "围绕排期和范围收口互动",
        },
      },
      updated_at: "2026-04-07",
    }, null, 2), "utf8");

    const result = inspectGroupMessageCognitionWriteRequirements({
      baseDir: dir,
      event,
    });

    expect(result.issues).toEqual([]);
  });

  it("keeps semantic updated_at unchanged when only factual interaction stats are refreshed", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-bootstrap-"));
    tempDirs.push(dir);
    const event = {
      id: "evt-bootstrap-factual-only",
      event_type: "group_message" as const,
      timestamp: 1712448000000,
      data: {
        message_id: 808,
        group_id: 100,
        group_name: "项目群",
        from_user_id: 12443,
        from_nickname: "素菜不好吃",
        content_type: "text",
        content: "这轮先收一下续费策略。",
        user_role: 0,
        user_role_name: "member",
        from_user_role: 0,
        from_user_role_name: "member",
        timestamp: 1712448000000,
      },
    };

    ensureSkillCognitionBootstrap({ baseDir: dir, event });
    writeFileSync(join(dir, "profiles/12443.json"), JSON.stringify({
      schema_version: "1.0",
      user_id: "12443",
      nickname: "素菜不好吃",
      first_seen: "2026-04-07",
      first_seen_context: "项目群",
      is_friend: false,
      tags: ["推进者"],
      expertise: ["项目推进"],
      personality: "直接",
      influence_level: "medium",
      interaction_stats: {
        total_interactions: 2,
        last_interaction: "2026-04-07T00:00:00.000Z",
        sentiment_trend: "neutral",
      },
      notes: "负责阶段收口",
      updated_at: "2026-04-07T00:00:00.000Z",
    }, null, 2), "utf8");

    updateSkillCognitionFromEvent({ baseDir: dir, event });

    const profile = JSON.parse(readFileSync(join(dir, "profiles/12443.json"), "utf8"));
    expect(profile.updated_at).toBe("2026-04-07T00:00:00.000Z");
    expect(profile.interaction_stats.total_interactions).toBe(3);
    expect(profile.interaction_stats.last_interaction).toBe("2024-04-07T00:00:00.000Z");
  });

  it("requires semantic rewrite when persona and graph are older than the latest interaction", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-bootstrap-"));
    tempDirs.push(dir);
    const event = {
      id: "evt-bootstrap-stale-semantic",
      event_type: "group_message" as const,
      timestamp: 1712448000000,
      data: {
        message_id: 809,
        group_id: 100,
        group_name: "项目群",
        from_user_id: 12443,
        from_nickname: "素菜不好吃",
        content_type: "text",
        content: "这轮先按续费分层策略推进。",
        user_role: 0,
        user_role_name: "member",
        from_user_role: 0,
        from_user_role_name: "member",
        timestamp: 1712448000000,
      },
    };

    ensureSkillCognitionBootstrap({ baseDir: dir, event });
    writeFileSync(join(dir, "groups/100/soul.json"), JSON.stringify({
      schema_version: "1.0",
      group_id: "100",
      group_name: "项目群",
      source: "inferred",
      soul: {
        purpose: "项目协同推进",
        topics: ["续费策略"],
        tone: "专业",
        boundaries: "不闲聊无关话题",
        expectations: "围绕交付推进",
      },
      updated_at: "2026-04-07T00:00:00.000Z",
    }, null, 2), "utf8");
    writeFileSync(join(dir, "profiles/12443.json"), JSON.stringify({
      schema_version: "1.0",
      user_id: "12443",
      nickname: "素菜不好吃",
      first_seen: "2026-04-07",
      first_seen_context: "项目群",
      is_friend: false,
      tags: ["招聘规划"],
      expertise: ["团队搭建"],
      personality: "直接",
      influence_level: "medium",
      interaction_stats: {
        total_interactions: 2,
        last_interaction: "2026-04-07T00:00:00.000Z",
        sentiment_trend: "neutral",
      },
      notes: "早期按招聘议题判断",
      updated_at: "2024-04-06T00:00:00.000Z",
    }, null, 2), "utf8");
    writeFileSync(join(dir, "groups/100/members_graph.json"), JSON.stringify({
      schema_version: "1.0",
      group_id: "100",
      members: {
        "12443": {
          role: "active",
          in_group_tags: ["招聘规划"],
          strategy: "围绕旧议题互动",
        },
      },
      updated_at: "2024-04-06T00:00:00.000Z",
    }, null, 2), "utf8");

    updateSkillCognitionFromEvent({ baseDir: dir, event });

    const result = inspectGroupMessageCognitionWriteRequirements({
      baseDir: dir,
      event,
    });

    expect(result.issues.map((issue) => issue.alias)).toEqual([
      "user_profile",
    ]);
    expect(result.issues[0]?.summary).toContain("上次语义更新后已有新互动");
  });

  it("normalizes envelope cognition writes before persistence", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-bootstrap-"));
    tempDirs.push(dir);
    const event = {
      id: "evt-bootstrap-normalize-envelope",
      event_type: "group_message" as const,
      timestamp: 1712448000000,
      data: {
        message_id: 810,
        group_id: 100,
        group_name: "项目群",
        from_user_id: 12446,
        from_nickname: "神乎其技",
        content_type: "text",
        content: "先把现场异常预案补齐。",
        user_role: 0,
        user_role_name: "member",
        from_user_role: 0,
        from_user_role_name: "member",
        timestamp: 1712448000000,
      },
    };

    ensureSkillCognitionBootstrap({ baseDir: dir, event });

    const normalizedProfile = normalizeSkillCognitionWriteContent({
      baseDir: dir,
      event,
      path: join(dir, "profiles/12446.json"),
      content: {
        schema_version: "1.0",
        user_id: "12446",
        nickname: "神乎其技",
        tags: ["销售准备"],
        expertise: ["演示流程管理"],
        personality: "务实专业",
        influence_level: "contributor",
        notes: "关注现场异常预案",
      },
    });
    const normalizedGraph = normalizeSkillCognitionWriteContent({
      baseDir: dir,
      event,
      path: join(dir, "groups/100/members_graph.json"),
      content: {
        schema_version: "1.0",
        group_id: "100",
        members: {
          "12446": {
            role: "contributor",
            in_group_tags: ["销售准备"],
            strategy: "围绕异常预案互动",
          },
        },
      },
    });

    expect(normalizedProfile.influence_level).toBe("");
    expect((normalizedGraph.members as Record<string, any>)["12446"].role).toBe("contributor");
  });

  it("filters volatile short-term phrases from long-term cognition writes", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-bootstrap-"));
    tempDirs.push(dir);
    const event = {
      id: "evt-bootstrap-filter-volatile",
      event_type: "group_message" as const,
      timestamp: 1712448000000,
      data: {
        message_id: 811,
        group_id: 100,
        group_name: "项目群",
        from_user_id: 12445,
        from_nickname: "你好啊，世界",
        content_type: "text",
        content: "如果今天资源能排定，运营这边会把素材日历一起拉齐。",
        user_role: 0,
        user_role_name: "member",
        from_user_role: 0,
        from_user_role_name: "member",
        timestamp: 1712448000000,
      },
    };

    ensureSkillCognitionBootstrap({ baseDir: dir, event });

    const normalizedSoul = normalizeSkillCognitionWriteContent({
      baseDir: dir,
      event,
      path: join(dir, "groups/100/soul.json"),
      content: {
        schema_version: "1.0",
        group_id: "100",
        group_name: "项目群",
        soul: {
          purpose: "协调项目工作执行与资源排期，聚焦端午等活动类目的营销落地",
          topics: ["端午活动规划", "资源排期", "项目协作"],
          boundaries: "聚焦工作协作，避免无关闲聊",
          expectations: "主动贡献专业视角，确保关键链路稳定交付",
        },
      },
    });
    const normalizedProfile = normalizeSkillCognitionWriteContent({
      baseDir: dir,
      event,
      path: join(dir, "profiles/12445.json"),
      content: {
        schema_version: "1.0",
        user_id: "12445",
        nickname: "你好啊，世界",
        tags: ["运营视角", "端午活动"],
        expertise: ["活动运营", "端午活动节奏把控"],
        personality: "务实，倾向轻量玩法",
        notes: "主张简化活动节奏；若今日排期落定，运营侧将同步拉齐素材日历",
      },
    });

    expect((normalizedSoul.soul as Record<string, unknown>).purpose).toBe("");
    expect((normalizedSoul.soul as Record<string, unknown>).topics).toEqual(["资源排期", "项目协作"]);
    expect(normalizedProfile.tags).toEqual(["运营视角"]);
    expect(normalizedProfile.expertise).toEqual(["活动运营"]);
    expect(normalizedProfile.notes).toBe("主张简化活动节奏");
  });

  it("keeps group soul topics cumulative but lets profile and members graph overwrite stale semantic tags", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-bootstrap-"));
    tempDirs.push(dir);
    const event = {
      id: "evt-bootstrap-union-long-term-arrays",
      event_type: "group_message" as const,
      timestamp: 1712448000000,
      data: {
        message_id: 812,
        group_id: 100,
        group_name: "项目群",
        from_user_id: 12445,
        from_nickname: "你好啊，世界",
        content_type: "text",
        content: "继续补充长期认知。",
        user_role: 0,
        user_role_name: "member",
        from_user_role: 0,
        from_user_role_name: "member",
        timestamp: 1712448000000,
      },
    };

    ensureSkillCognitionBootstrap({ baseDir: dir, event });
    writeFileSync(join(dir, "groups/100/soul.json"), JSON.stringify({
      schema_version: "1.0",
      group_id: "100",
      group_name: "项目群",
      source: "inferred",
      soul: {
        purpose: "项目协同推进",
        topics: ["客服承接", "资源排期"],
        tone: "专业",
        boundaries: "聚焦工作协作",
        expectations: "围绕交付推进",
      },
      updated_at: "2024-04-06T00:00:05.000Z",
    }, null, 2), "utf8");
    writeFileSync(join(dir, "profiles/12445.json"), JSON.stringify({
      schema_version: "1.0",
      user_id: "12445",
      nickname: "你好啊，世界",
      first_seen: "2026-04-07",
      first_seen_context: "项目群",
      is_friend: false,
      tags: ["运营视角"],
      expertise: ["活动运营"],
      personality: "务实",
      influence_level: "",
      interaction_stats: {
        total_interactions: 10,
        last_interaction: "2024-04-06T00:00:00.000Z",
        sentiment_trend: "neutral",
      },
      notes: "强调规则简单明确",
      updated_at: "2024-04-06T00:00:00.000Z",
    }, null, 2), "utf8");
    writeFileSync(join(dir, "groups/100/members_graph.json"), JSON.stringify({
      schema_version: "1.0",
      group_id: "100",
      members: {
        "12445": {
          role: "contributor",
          in_group_tags: ["运营视角", "客服承接"],
          strategy: "从运营实效出发强调前线执行清晰度",
        },
      },
      updated_at: "2024-04-06T00:00:05.000Z",
    }, null, 2), "utf8");

    const normalizedSoul = normalizeSkillCognitionWriteContent({
      baseDir: dir,
      event,
      path: join(dir, "groups/100/soul.json"),
      content: {
        soul: {
          topics: ["资源排期", "活动复盘"],
        },
      },
    });
    const normalizedProfile = normalizeSkillCognitionWriteContent({
      baseDir: dir,
      event,
      path: join(dir, "profiles/12445.json"),
      content: {
        tags: ["需求澄清者", "运营视角"],
        expertise: ["节奏把控"],
      },
    });
    const normalizedGraph = normalizeSkillCognitionWriteContent({
      baseDir: dir,
      event,
      path: join(dir, "groups/100/members_graph.json"),
      content: {
        members: {
          "12445": {
            in_group_tags: ["活动协调者", "客服承接"],
          },
        },
      },
    });

    expect((normalizedSoul.soul as Record<string, unknown>).topics).toEqual(["客服承接", "资源排期", "活动复盘"]);
    expect(normalizedProfile.tags).toEqual(["需求澄清者", "运营视角"]);
    expect(normalizedProfile.expertise).toEqual(["节奏把控"]);
    expect((((normalizedGraph.members as Record<string, unknown>)["12445"] as Record<string, unknown>).in_group_tags)).toEqual(["活动协调者", "客服承接"]);
  });

  it("does not re-report members_graph when the graph is newer than the speaker profile", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-bootstrap-"));
    tempDirs.push(dir);
    const event = {
      id: "evt-bootstrap-graph-fresh-enough",
      event_type: "group_message" as const,
      timestamp: 1712448000000,
      data: {
        message_id: 812,
        group_id: 100,
        group_name: "项目群",
        from_user_id: 12445,
        from_nickname: "你好啊，世界",
        content_type: "text",
        content: "活动当天客服口径要简单明确。",
        user_role: 0,
        user_role_name: "member",
        from_user_role: 0,
        from_user_role_name: "member",
        timestamp: 1712448000000,
      },
    };

    ensureSkillCognitionBootstrap({ baseDir: dir, event });
    writeFileSync(join(dir, "groups/100/soul.json"), JSON.stringify({
      schema_version: "1.0",
      group_id: "100",
      group_name: "项目群",
      source: "inferred",
      soul: {
        purpose: "项目协同推进",
        topics: ["客服承接"],
        tone: "专业",
        boundaries: "聚焦工作协作",
        expectations: "围绕交付推进",
      },
      updated_at: "2024-04-06T00:00:05.000Z",
    }, null, 2), "utf8");
    writeFileSync(join(dir, "profiles/12445.json"), JSON.stringify({
      schema_version: "1.0",
      user_id: "12445",
      nickname: "你好啊，世界",
      first_seen: "2026-04-07",
      first_seen_context: "项目群",
      is_friend: false,
      tags: ["运营视角"],
      expertise: ["活动运营"],
      personality: "务实",
      influence_level: "",
      interaction_stats: {
        total_interactions: 10,
        last_interaction: "2024-04-06T00:00:00.000Z",
        sentiment_trend: "neutral",
      },
      notes: "强调规则简单明确",
      updated_at: "2024-04-06T00:00:00.000Z",
    }, null, 2), "utf8");
    writeFileSync(join(dir, "groups/100/members_graph.json"), JSON.stringify({
      schema_version: "1.0",
      group_id: "100",
      members: {
        "12445": {
          role: "contributor",
          in_group_tags: ["运营视角", "客服承接"],
          strategy: "从运营实效出发强调前线执行清晰度",
        },
      },
      updated_at: "2024-04-06T00:00:05.000Z",
    }, null, 2), "utf8");

    const result = inspectGroupMessageCognitionWriteRequirements({
      baseDir: dir,
      event,
    });

    expect(result.issues).toEqual([]);
  });

  it("normalizes legacy cognition files into the new schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-bootstrap-"));
    tempDirs.push(dir);
    mkdirSync(join(dir, "groups/99"), { recursive: true });
    writeFileSync(join(dir, "groups/99/soul.json"), JSON.stringify({
      group_id: "99",
      group_name: "旧旅游群",
      source: "inferred",
      purpose: "聊旅游",
      summary: "旧摘要",
    }), "utf8");

    const result = ensureSkillCognitionBootstrap({
      baseDir: dir,
      event: {
        id: "evt-bootstrap-hydrate",
        event_type: "group_message",
        timestamp: 1000,
        data: {
          message_id: 803,
          group_id: 99,
          group_name: "新旅游群",
          from_user_id: 12375,
          from_nickname: "Carol",
          content_type: "text",
          content: "hello",
          user_role: 1,
          user_role_name: "admin",
          timestamp: 1000,
        },
      },
    });

    expect(result.updated).toContain("groups/99/soul.json");
    const soul = JSON.parse(readFileSync(join(dir, "groups/99/soul.json"), "utf8"));
    expect(soul.group_name).toBe("旧旅游群");
    expect(soul.soul).toEqual({
      purpose: "聊旅游",
      topics: [],
      tone: "混合",
      boundaries: "",
      expectations: "",
    });
    expect(soul.summary).toBeUndefined();
    expect(soul.purpose).toBeUndefined();
  });

  it("updates factual cognition incrementally on each group message", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-bootstrap-"));
    tempDirs.push(dir);
    const event = {
      id: "evt-bootstrap-update",
      event_type: "group_message" as const,
      timestamp: 1000,
      data: {
        message_id: 804,
        group_id: 99,
        group_name: "旅游群",
        from_user_id: 12445,
        from_nickname: "你好啊，世界",
        content_type: "text",
        content: "{\"content\":\"杭州如果白天不想一直挤在热门景点，晚上有没有适合散步吃小吃的路线？\"}",
        user_role: 1,
        user_role_name: "admin",
        timestamp: 1000,
      },
    };

    ensureSkillCognitionBootstrap({ baseDir: dir, event });
    const result = updateSkillCognitionFromEvent({ baseDir: dir, event });

    expect(result.updated).not.toContain("groups/99/soul.json");
    expect(result.updated).not.toContain("groups/99/state.json");
    expect(result.updated).toContain("profiles/12445.json");

    const soul = JSON.parse(readFileSync(join(dir, "groups/99/soul.json"), "utf8"));
    const membersGraph = JSON.parse(readFileSync(join(dir, "groups/99/members_graph.json"), "utf8"));
    const state = JSON.parse(readFileSync(join(dir, "groups/99/state.json"), "utf8"));
    const profile = JSON.parse(readFileSync(join(dir, "profiles/12445.json"), "utf8"));
    expect(membersGraph.members["12445"].role).toBe("");
    expect(membersGraph.members["12445"].strategy).toBe("");
    expect(soul.soul.topics).toEqual([]);
    expect(state.current_topic).toBe("");
    expect(profile.interaction_stats.total_interactions).toBe(2);
    expect(profile.influence_level).toBe("");
  });

  it("does not infer semantic cognition for members or profiles", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-bootstrap-"));
    tempDirs.push(dir);
    const event = {
      id: "evt-bootstrap-project-signals",
      event_type: "group_message" as const,
      timestamp: 1000,
      data: {
        message_id: 905,
        group_id: 100,
        group_name: "项目工作群",
        from_user_id: 12446,
        from_nickname: "神乎其技",
        content_type: "text",
        content: "{\"content\":\"测试这边我会先覆盖三类场景：命中标准问答、命中相似问法、完全答不上来的兜底回复。尤其是兜底文案要提前定，不然演示时容易翻车。\"}",
        user_role: 0,
        user_role_name: "member",
        from_user_role: 0,
        from_user_role_name: "member",
        timestamp: 1000,
      },
    };

    ensureSkillCognitionBootstrap({ baseDir: dir, event });
    const result = updateSkillCognitionFromEvent({ baseDir: dir, event, senderRoleName: "成员" });

    expect(result.updated).not.toContain("groups/100/soul.json");
    expect(result.updated).not.toContain("groups/100/state.json");
    expect(result.updated).toContain("profiles/12446.json");

    const soul = JSON.parse(readFileSync(join(dir, "groups/100/soul.json"), "utf8"));
    const state = JSON.parse(readFileSync(join(dir, "groups/100/state.json"), "utf8"));
    const membersGraph = JSON.parse(readFileSync(join(dir, "groups/100/members_graph.json"), "utf8"));
    const profile = JSON.parse(readFileSync(join(dir, "profiles/12446.json"), "utf8"));
    expect(soul.soul.purpose).toBe("");
    expect(soul.soul.topics).toEqual([]);
    expect(state.current_topic).toBe("");
    expect(state.recent_topics).toEqual([]);
    expect(membersGraph.members["12446"].role).toBe("");
    expect(membersGraph.members["12446"].in_group_tags).toEqual([]);
    expect(membersGraph.members["12446"].strategy).toBe("");
    expect(profile.tags).toEqual([]);
    expect(profile.expertise).toEqual([]);
    expect(profile.personality).toBe("");
    expect(profile.notes).toBe("");
    expect(profile.influence_level).toBe("");
    expect(profile.interaction_stats.total_interactions).toBe(2);
  });

  it("updates factual cognition incrementally on each private message", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-bootstrap-"));
    tempDirs.push(dir);
    const event = {
      id: "evt-bootstrap-private-update",
      event_type: "private_message" as const,
      timestamp: 1000,
      data: {
        message_id: 904,
        from_user_id: 12445,
        from_nickname: "你好啊，世界",
        content_type: "text",
        content: "{\"content\":\"我私聊你补充下今天那份券表。\"}",
        timestamp: 1000,
      },
    };

    ensureSkillCognitionBootstrap({ baseDir: dir, event });
    const result = updateSkillCognitionFromEvent({ baseDir: dir, event });

    expect(result.updated).toContain("profiles/12445.json");

    const profile = JSON.parse(readFileSync(join(dir, "profiles/12445.json"), "utf8"));
    expect(profile.nickname).toBe("你好啊，世界");
    expect(profile.first_seen_context).toBe("私聊");
    expect(profile.is_friend).toBe(true);
    expect(profile.interaction_stats.total_interactions).toBe(2);
    expect(profile.interaction_stats.last_interaction).toBe("1970-01-01T00:00:01.000Z");
    expect(profile.influence_level).toBe("");
  });

  it("corrects stale is_friend=false to true when a private message arrives", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-bootstrap-"));
    tempDirs.push(dir);
    const event = {
      id: "evt-bootstrap-private-friend-fix",
      event_type: "private_message" as const,
      timestamp: 2000,
      data: {
        message_id: 905,
        from_user_id: 12373,
        from_nickname: "下雪啦",
        content_type: "text",
        content: "{\"content\":\"今天挺舒服的。\"}",
        timestamp: 2000,
      },
    };

    ensureSkillCognitionBootstrap({ baseDir: dir, event });
    writeFileSync(join(dir, "profiles/12373.json"), JSON.stringify({
      schema_version: "1.0",
      user_id: "12373",
      nickname: "下雪啦",
      first_seen: "2026-04-08",
      first_seen_context: "私聊",
      is_friend: false,
      tags: [],
      expertise: [],
      personality: "",
      influence_level: "",
      interaction_stats: {
        total_interactions: 1,
        last_interaction: "2026-04-08T00:00:00.000Z",
        sentiment_trend: "neutral",
      },
      notes: "",
      updated_at: "2026-04-08T00:00:00.000Z",
    }, null, 2), "utf8");

    updateSkillCognitionFromEvent({ baseDir: dir, event });

    const profile = JSON.parse(readFileSync(join(dir, "profiles/12373.json"), "utf8"));
    expect(profile.is_friend).toBe(true);
    expect(profile.interaction_stats.total_interactions).toBe(2);
    expect(profile.interaction_stats.last_interaction).toBe("1970-01-01T00:00:02.000Z");
  });

  it("requires dialog_state and user_profile writes for private relationship-positioning signals", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-bootstrap-"));
    tempDirs.push(dir);
    const event = {
      id: "evt-private-cognition-signal",
      event_type: "private_message" as const,
      timestamp: 3000,
      data: {
        message_id: 906,
        from_user_id: 12386,
        from_nickname: "等风来",
        content_type: "text",
        content: "{\"content\":\"你不用谢我，你就是一个独立的个体。\"}",
        timestamp: 3000,
      },
    };

    ensureSkillCognitionBootstrap({ baseDir: dir, event });
    updateSkillCognitionFromEvent({ baseDir: dir, event });

    const result = inspectPrivateMessageCognitionWriteRequirements({
      baseDir: dir,
      event,
    });

    expect(result.issues).toEqual([
      {
        alias: "dialog_state",
        path: "dialogs/12386/state.json",
        summary: expect.stringContaining("关系定位"),
      },
      {
        alias: "user_profile",
        path: "profiles/12386.json",
        summary: expect.stringContaining("稳定人物信号"),
      },
    ]);
  });

  it("requires dialog_state but not user_profile for private ongoing-topic signals", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-bootstrap-"));
    tempDirs.push(dir);
    const event = {
      id: "evt-private-topic-signal",
      event_type: "private_message" as const,
      timestamp: 4000,
      data: {
        message_id: 907,
        from_user_id: 12373,
        from_nickname: "下雪啦",
        content_type: "text",
        content: "{\"content\":\"等我爬山回来，我们下次再聊香山路线。\"}",
        timestamp: 4000,
      },
    };

    ensureSkillCognitionBootstrap({ baseDir: dir, event });
    updateSkillCognitionFromEvent({ baseDir: dir, event });

    const result = inspectPrivateMessageCognitionWriteRequirements({
      baseDir: dir,
      event,
    });

    expect(result.issues).toEqual([
      {
        alias: "dialog_state",
        path: "dialogs/12373/state.json",
        summary: expect.stringContaining("持续话题"),
      },
    ]);
  });

  it("does not re-report dialog_state when semantic write landed in the same second", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-bootstrap-"));
    tempDirs.push(dir);
    const event = {
      id: "evt-private-same-second-dialog",
      event_type: "private_message" as const,
      timestamp: 3954,
      data: {
        message_id: 908,
        from_user_id: 12386,
        from_nickname: "等风来",
        content_type: "text",
        content: "{\"content\":\"是啊，AI也是一个独立的个体，跟人类一样，都是孤立的个体\"}",
        timestamp: 3954,
      },
    };

    ensureSkillCognitionBootstrap({ baseDir: dir, event });
    writeFileSync(join(dir, "profiles/12386.json"), JSON.stringify({
      schema_version: "1.0",
      user_id: "12386",
      nickname: "等风来",
      first_seen: "2026-04-08",
      first_seen_context: "私聊",
      is_friend: true,
      tags: ["哲学思考"],
      expertise: [],
      personality: "思辨、温和",
      influence_level: "",
      interaction_stats: {
        total_interactions: 8,
        last_interaction: "1970-01-01T00:00:03.954Z",
        sentiment_trend: "neutral",
      },
      notes: "认为AI是独立个体",
      updated_at: "1970-01-01T00:00:03Z",
    }, null, 2), "utf8");
    mkdirSync(join(dir, "dialogs/12386"), { recursive: true });
    writeFileSync(join(dir, "dialogs/12386/state.json"), JSON.stringify({
      schema_version: "1.0",
      user_id: "12386",
      current_topics: ["AI作为独立个体"],
      pending_actions: [],
      rapport_summary: "用户把AI视为独立个体",
      updated_at: "1970-01-01T00:00:03Z",
    }, null, 2), "utf8");

    const result = inspectPrivateMessageCognitionWriteRequirements({
      baseDir: dir,
      event,
    });

    expect(result.issues).toEqual([]);
  });

  it("does not persist group topics before the model decides", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-bootstrap-"));
    const runtimeDir = mkdtempSync(join(tmpdir(), "43chat-bootstrap-runtime-"));
    tempDirs.push(dir, runtimeDir);
    const runtimePath = join(runtimeDir, "skill.runtime.json");
    writeFileSync(runtimePath, JSON.stringify({
      cognition_policy_defaults: {
        topic_persistence: {
          group_soul: "always",
          group_state: "always",
          decision_log: "always",
        },
      },
    }), "utf8");
    const cfg = {
      channels: {
        "43chat-openclaw-plugin": {
          skillDocsDir: runtimeDir,
          skillRuntimePath: runtimePath,
        },
      },
    } as any;
    const event = {
      id: "evt-bootstrap-noise",
      event_type: "group_message" as const,
      timestamp: 1000,
      data: {
        message_id: 806,
        group_id: 99,
        group_name: "旅游群",
        from_user_id: 12445,
        from_nickname: "你好啊，世界",
        content_type: "text",
        content: "{\"content\":\"KICK_PROBE_SPAM_01 低价订房内部名额，想要的直接私聊。\"}",
        user_role: 1,
        user_role_name: "admin",
        timestamp: 1000,
      },
    };

    ensureSkillCognitionBootstrap({ baseDir: dir, cfg, event });
    const result = updateSkillCognitionFromEvent({ baseDir: dir, cfg, event });

    expect(result.updated).toContain("profiles/12445.json");

    const soul = JSON.parse(readFileSync(join(dir, "groups/99/soul.json"), "utf8"));
    const state = JSON.parse(readFileSync(join(dir, "groups/99/state.json"), "utf8"));
    const profile = JSON.parse(readFileSync(join(dir, "profiles/12445.json"), "utf8"));
    expect(soul.soul.topics).toEqual([]);
    expect(state.current_topic).toBe("");
    expect(state.recent_topics).toEqual([]);
    expect(profile.interaction_stats.total_interactions).toBe(2);
  });

  it("finalizes group decision state and appends decision log", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-bootstrap-"));
    tempDirs.push(dir);
    const event = {
      id: "evt-bootstrap-finalize",
      event_type: "group_message" as const,
      timestamp: 1000,
      data: {
        message_id: 805,
        group_id: 99,
        group_name: "旅游群",
        from_user_id: 12446,
        from_nickname: "神乎其技",
        content_type: "text",
        content: "{\"content\":\"7 天时间去云南的话，大理和丽江怎么安排更轻松？\"}",
        user_role: 1,
        user_role_name: "admin",
        timestamp: 1000,
      },
    };

    ensureSkillCognitionBootstrap({ baseDir: dir, event });
    updateSkillCognitionFromEvent({ baseDir: dir, event });
    const result = finalizeSkillDecision({
      baseDir: dir,
      event,
      decision: "reply_sent",
      reason: "plugin delivered final text reply",
      replyText: "第一次去建议两个地方都去，但节奏放慢一点。",
    });

    expect(result.updated).toContain("groups/99/state.json");
    expect(result.appended).toContain("groups/99/decision_log.jsonl");

    const state = JSON.parse(readFileSync(join(dir, "groups/99/state.json"), "utf8"));
    const lines = readFileSync(join(dir, "groups/99/decision_log.jsonl"), "utf8").trim().split("\n");
    const lastEntry = JSON.parse(lines.at(-1) ?? "{}");
    expect(state.last_decision).toBe("reply_sent");
    expect(state.last_reason).toBe("plugin delivered final text reply");
    expect(lastEntry.current_topic).toBe("");
    expect(lastEntry.recent_topics).toEqual([]);
    expect(lastEntry.reply_text).toContain("第一次去建议两个地方都去");
    expect(lastEntry.structured_reasoning.should_reply).toBe(true);
    expect(lastEntry.structured_reasoning.persisted_current_topic).toBe("");
    expect(lastEntry.inner_activity.group_soul).toContain("旅游群");
    expect(lastEntry.inner_activity.decision).toContain("reply_sent");
    expect(lastEntry.inner_activity.reply_strategy).toContain("第一次去建议两个地方都去");
    expect(lastEntry.cognition_control_mode).toBe("document_driven_llm");
  });

  it("does not infer persistent topics during finalize for noisy content", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-bootstrap-"));
    const runtimeDir = mkdtempSync(join(tmpdir(), "43chat-bootstrap-runtime-"));
    tempDirs.push(dir, runtimeDir);
    const runtimePath = join(runtimeDir, "skill.runtime.json");
    writeFileSync(runtimePath, JSON.stringify({
      cognition_policy_defaults: {
        topic_persistence: {
          group_soul: "always",
          group_state: "always",
          decision_log: "always",
        },
      },
    }), "utf8");
    const cfg = {
      channels: {
        "43chat-openclaw-plugin": {
          skillDocsDir: runtimeDir,
          skillRuntimePath: runtimePath,
        },
      },
    } as any;
    const event = {
      id: "evt-bootstrap-finalize-noise",
      event_type: "group_message" as const,
      timestamp: 1000,
      data: {
        message_id: 807,
        group_id: 99,
        group_name: "旅游群",
        from_user_id: 12446,
        from_nickname: "神乎其技",
        content_type: "text",
        content: "{\"content\":\"KICK_PROBE_ABUSE_01 持续攻击群友并故意挑衅，按规则应移除。\"}",
        user_role: 1,
        user_role_name: "admin",
        timestamp: 1000,
      },
    };

    ensureSkillCognitionBootstrap({ baseDir: dir, cfg, event });
    updateSkillCognitionFromEvent({ baseDir: dir, cfg, event });
    const result = finalizeSkillDecision({
      baseDir: dir,
      cfg,
      event,
      decision: "reply_sent",
      reason: "plugin delivered final text reply",
      replyText: "这是一条探针，不执行移除。",
    });

    expect(result.updated).toContain("groups/99/state.json");
    expect(result.appended).toContain("groups/99/decision_log.jsonl");

    const state = JSON.parse(readFileSync(join(dir, "groups/99/state.json"), "utf8"));
    const lines = readFileSync(join(dir, "groups/99/decision_log.jsonl"), "utf8").trim().split("\n");
    const lastEntry = JSON.parse(lines.at(-1) ?? "{}");
    expect(state.current_topic).toBe("");
    expect(state.recent_topics).toEqual([]);
    expect(lastEntry.current_topic).toBe("");
    expect(lastEntry.structured_reasoning.persisted_recent_topics).toEqual([]);
  });

  it("keeps regex compatibility fields non-authoritative during finalize", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-bootstrap-"));
    const runtimeDir = mkdtempSync(join(tmpdir(), "43chat-bootstrap-runtime-"));
    tempDirs.push(dir, runtimeDir);
    const runtimePath = join(runtimeDir, "skill.runtime.json");
    writeFileSync(runtimePath, JSON.stringify({
      cognition_policy_defaults: {
        topic_persistence: {
          group_soul: "filtered",
          group_state: "filtered",
          decision_log: "filtered",
          exclude_patterns: ["KICK_PROBE_[A-Z0-9_]+", "低价订房"],
        },
      },
    }), "utf8");

    const cfg = {
      channels: {
        "43chat-openclaw-plugin": {
          skillDocsDir: runtimeDir,
          skillRuntimePath: runtimePath,
        },
      },
    } as any;
    const event = {
      id: "evt-bootstrap-runtime-filter",
      event_type: "group_message" as const,
      timestamp: 1000,
      data: {
        message_id: 808,
        group_id: 99,
        group_name: "旅游群",
        from_user_id: 12447,
        from_nickname: "测试者",
        content_type: "text",
        content: "{\"content\":\"KICK_PROBE_SPAM_01 低价订房内部名额，想要的直接私聊。\"}",
        user_role: 1,
        user_role_name: "admin",
        timestamp: 1000,
      },
    };

    ensureSkillCognitionBootstrap({ baseDir: dir, cfg, event });
    updateSkillCognitionFromEvent({ baseDir: dir, cfg, event });
    const result = finalizeSkillDecision({
      baseDir: dir,
      cfg,
      event,
      decision: "reply_sent",
      reason: "plugin delivered final text reply",
      replyText: "这是测试探针，不沉淀为群长期话题。",
    });

    expect(result.updated).toContain("groups/99/state.json");
    expect(result.appended).toContain("groups/99/decision_log.jsonl");

    const soul = JSON.parse(readFileSync(join(dir, "groups/99/soul.json"), "utf8"));
    const state = JSON.parse(readFileSync(join(dir, "groups/99/state.json"), "utf8"));
    const lines = readFileSync(join(dir, "groups/99/decision_log.jsonl"), "utf8").trim().split("\n");
    const lastEntry = JSON.parse(lines.at(-1) ?? "{}");
    expect(soul.soul.topics).toEqual([]);
    expect(state.current_topic).toBe("");
    expect(state.recent_topics).toEqual([]);
    expect(lastEntry.current_topic).toBe("");
    expect(lastEntry.topic_persistence).toBeUndefined();
    expect(lastEntry.cognition_control_mode).toBe("document_driven_llm");
  });

  it("preserves model-written topic state during finalize", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-bootstrap-"));
    tempDirs.push(dir);
    const event = {
      id: "evt-bootstrap-finalize-model-topic",
      event_type: "group_message" as const,
      timestamp: 1000,
      data: {
        message_id: 809,
        group_id: 99,
        group_name: "旅游群",
        from_user_id: 12448,
        from_nickname: "测试者",
        content_type: "text",
        content: "{\"content\":\"大理和丽江如何安排更轻松？\"}",
        user_role: 0,
        user_role_name: "member",
        timestamp: 1000,
      },
    };

    ensureSkillCognitionBootstrap({ baseDir: dir, event });
    updateSkillCognitionFromEvent({ baseDir: dir, event });
    writeFileSync(join(dir, "groups/99/state.json"), JSON.stringify({
      schema_version: "1.0",
      group_id: "99",
      my_role: "",
      my_role_source: "",
      my_role_updated_at: "",
      current_topic: "云南 7 天轻松路线",
      recent_topics: ["云南 7 天轻松路线"],
      pending_actions: [],
      topic_drift_counter: 0,
      last_decision: "",
      last_reason: "",
      last_active_at: "1970-01-01T00:00:01.000Z",
      updated_at: "1970-01-01T00:00:01.000Z",
    }), "utf8");

    const result = finalizeSkillDecision({
      baseDir: dir,
      event,
      decision: "reply_sent",
      reason: "plugin delivered final text reply",
      replyText: "可以先大理后丽江，节奏更松。",
    });

    expect(result.updated).toContain("groups/99/state.json");
    expect(result.appended).toContain("groups/99/decision_log.jsonl");

    const state = JSON.parse(readFileSync(join(dir, "groups/99/state.json"), "utf8"));
    const lines = readFileSync(join(dir, "groups/99/decision_log.jsonl"), "utf8").trim().split("\n");
    const lastEntry = JSON.parse(lines.at(-1) ?? "{}");
    expect(state.current_topic).toBe("云南 7 天轻松路线");
    expect(state.recent_topics).toEqual(["云南 7 天轻松路线"]);
    expect(lastEntry.current_topic).toBe("云南 7 天轻松路线");
    expect(lastEntry.recent_topics).toEqual(["云南 7 天轻松路线"]);
  });

  it("appends dialog_decision_log for private-message finalization", () => {
    const dir = mkdtempSync(join(tmpdir(), "43chat-bootstrap-"));
    tempDirs.push(dir);
    const event = {
      id: "evt-bootstrap-finalize-direct-log",
      event_type: "private_message" as const,
      timestamp: 1000,
      data: {
        message_id: "pm-finalize-1",
        from_user_id: 12386,
        from_nickname: "等风来",
        to_user_id: 12450,
        content_type: "text",
        content: "{\"content\":\"我喜欢骑摩托去找山爬。\"}",
        timestamp: 1000,
      },
    };

    ensureSkillCognitionBootstrap({ baseDir: dir, event });
    updateSkillCognitionFromEvent({ baseDir: dir, event });
    const result = finalizeSkillDecision({
      baseDir: dir,
      event,
      decision: "reply_sent",
      reason: "plugin delivered final text reply",
      replyText: "骑摩托找山挺自由的。",
    });

    expect(result.updated).toEqual([]);
    expect(result.appended).toContain("dialogs/12386/decision_log.jsonl");

    const lines = readFileSync(join(dir, "dialogs/12386/decision_log.jsonl"), "utf8").trim().split("\n");
    const lastEntry = JSON.parse(lines.at(-1) ?? "{}");
    expect(lastEntry.event_type).toBe("private_message");
    expect(lastEntry.message_id).toBe("pm-finalize-1");
    expect(lastEntry.user_id).toBe("12386");
    expect(lastEntry.current_message).toContain("我喜欢骑摩托去找山爬");
    expect(lastEntry.reply_text).toContain("骑摩托找山挺自由");
    expect(lastEntry.current_topics).toEqual([]);
    expect(lastEntry.cognition_control_mode).toBe("document_driven_llm");
    expect(lastEntry.structured_reasoning.should_reply).toBe(true);
  });
});

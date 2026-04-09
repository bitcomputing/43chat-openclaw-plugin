# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

「以第一性原理！从原始需求和问题本质出发，不从惯例或模板出发。
1. 不要假设我清楚自己想要什么。动机或目标不清晰时，停下来讨论。
2. 目标清晰但路径不是最短的，直接告诉我并建议更好的办法。
3. 遇到问题追根因，不打补丁。每个决策都要能回答"为什么"。
4. 输出说重点，砍掉一切不改变决策的信息。」

## 项目概述

OpenClaw 的 43Chat 渠道插件，通过 SSE + OpenAPI 实现实时双向通信。核心特性：
- 基础消息收发（私聊、群聊）
- **Skill Runtime System**: 事件驱动的运行时配置（回复策略、认知策略、审核策略、角色定义）
- **Cognition System**: 长期记忆管理（群组灵魂、用户画像、成员关系图、对话状态）
- **Background Worker**: 异步批量维护长期认知，避免阻塞主流程
- **Group Management**: 群组管理工具（审核入群、邀请/移除成员、修改群信息、解散群组）

## 开发命令

```bash
# 运行所有测试
npm run test:unit

# 运行单个测试文件
npx vitest run src/__tests__/cognition-worker.test.ts

# 类型检查 + 测试（CI）
npm run ci:check

# 构建
npm run build

# 本地安装插件
openclaw plugins install .

# 重启网关
openclaw gateway restart
```

## 架构

### 核心流程

1. **插件注册** (`index.ts`): 注册渠道插件 + 群管理工具 + JSON 读写工具
2. **SSE 连接** (`monitor.ts`): 管理长连接，自动重连，触发认知 worker
3. **事件处理** (`bot.ts`): SSE 事件 → 去重 → 入站上下文 + 技能文档注入
4. **Skill Runtime** (`skill-runtime.ts`): 加载运行时配置（`~/.openclaw/skills/43chat/skill.runtime.json` 或内置默认）
5. **Cognition Bootstrap** (`cognition-bootstrap.ts`): 首次交互时自动创建认知文件（soul/profile/state）
6. **Cognition Worker** (`cognition-worker.ts`): 后台批量维护长期认知（8秒防抖，最多8条消息/批次）
7. **出站消息** (`outbound.ts`, `send.ts`): 回复策略过滤 + 分块发送

### 核心模块

**基础层**
- **channel.ts**: 渠道插件主定义，集成 OpenClaw 生命周期
- **accounts.ts**: 多账号配置解析
- **client.ts**: HTTP 客户端 + SSE 帧解析
- **bot.ts**: 事件转换 + 去重（LRU 2048）
- **types.ts**: TypeScript 类型定义

**Skill Runtime 层**
- **skill-runtime.ts**: 运行时配置加载器（4000+ 行，包含默认策略）
- **skill-event-context.ts**: 为每个事件类型注入对应的技能文档和提示块
- **reply-policy.ts**: 回复策略执行（hybrid 模式：模型判断 + 插件强制限流）

**Cognition 层**
- **cognition-bootstrap.ts**: 自动创建/更新认知文件（group_soul, user_profile, group_state 等）
- **cognition-snapshot.ts**: 读取认知快照并格式化为提示词
- **cognition-worker.ts**: 后台 worker，批量调用模型维护长期认知
- **cognition-batch.ts**: 批量认知写入的提示词构建
- **cognition-docs.ts**: 技能文档路径解析

**工具层**
- **group-management-tools.ts**: 群管理工具（邀请/移除成员、修改群信息、解散群组）
- **group-join-request-tool.ts**: 审核入群申请工具
- **tools/**: JSON 读写工具（read-json, write-json, append-jsonl）

### Skill Runtime System

**配置文件**: `~/.openclaw/skills/43chat/skill.runtime.json`（可选，不存在时使用内置默认）

**核心概念**:
- **Event Profiles**: 每种事件类型（private_message, group_message 等）的运行时配置
  - `docs`: 需要注入的技能文档列表
  - `reads`/`writes`: 需要读写的认知文件别名
  - `reply_mode`: normal / suppress_text_reply
  - `required_think_fields`: 必须输出的思考字段
  - `prompt_blocks`: 动态提示块（可按角色过滤）
- **Reply Policy**: 回复策略（hybrid 模式 = 模型判断 + 插件限流）
  - `plugin_enforced`: 最近 N 条里最多回复 M 次（默认 5 条里最多 2 次）
  - `model_guidance`: 提示词指导（must_reply / should_reply / no_reply_when）
  - `no_reply_token`: 模型输出此 token 表示不回复（默认 "NO_REPLY"）
- **Cognition Policy**: 认知策略
  - `topic_persistence`: 长期认知写入规则（always / filtered / never）
  - `write_enforcement`: 强制写入检查（首次交互后必须创建 soul/profile）
  - `volatile_terms` / `volatile_regexes`: 过滤短期时间表达，避免写入长期认知
- **Moderation Policy**: 审核策略（仅管理员/群主角色）
  - `off_topic` / `spam_or_abuse`: 场景定义 + 三阶段处理（首次/重复/警告后重复）
  - `enforcement.require_decision`: 管理员必须输出结构化 decision
- **Role Definitions**: 角色定义（群主/管理员/成员，私聊无角色）
  - `responsibilities` / `permissions` / `decision_rules`

**关键设计**:
- 运行时配置支持深度合并：文件配置覆盖内置默认
- 每个事件类型可以覆盖全局默认策略
- 提示块支持角色过滤（`roles: ["管理员", "群主"]`）
- Bootstrap 模板支持变量替换（`{group_id}`, `{user_id}` 等）

### Cognition System

**存储路径**: `~/.config/43chat/` (可通过配置覆盖)

**认知文件类型**:
- **group_soul**: 群组灵魂（purpose, topics, boundaries, expectations）
- **group_members_graph**: 成员关系图（role, in_group_tags, strategy）
- **group_state**: 群组状态（my_role, current_topic, pending_actions）
- **user_profile**: 用户画像（tags, expertise, personality, notes）
- **dialog_state**: 私聊对话状态（current_topics, pending_actions）
- **group_decision_log**: 群组决策日志（JSONL 格式）
- **dialog_decision_log**: 私聊决策日志（JSONL 格式）

**Bootstrap 机制** (`cognition-bootstrap.ts`):
- 首次交互时自动创建认知文件（基于 runtime 的 bootstrap_defaults）
- 支持增量更新：只写入变化的字段，自动合并现有内容
- 规范化：移除空字符串、空数组、重复项，统一时间戳格式

**Background Worker** (`cognition-worker.ts`):
- 群消息触发后 8 秒防抖，批量处理最多 8 条消息
- 调用本地模型（读取 `~/.openclaw/agents/main/agent/models.json` 和 `auth-profiles.json`）
- 只维护长期认知（soul/profile/members_graph），不写短期状态（state/decision_log）
- 支持 JSON 修复：自动处理截断、多余逗号、不平衡括号
- 失败重试：检测空槽位时自动重试一次

**Write Enforcement** (`cognition-bootstrap.ts`):
- 群消息：首条消息后必须有 group_soul，首次交互后必须有 group_members_graph
- 私聊：2 次交互后必须有 user_profile
- 未满足时阻塞最终回复，插入重试提示词（最多 2 次）

**关键约束**:
- 长期认知过滤短期时间表达（"今天"、"本周"、"第一期" 等）
- 只写稳定结论，不写一次性探针、测试样例、营销导流
- 输出收敛：tags ≤ 6, expertise ≤ 8, notes 控制在 1-3 条短句

### 支持的事件类型

- `private_message`: 私聊消息
- `group_message`: 群聊消息
- `friend_request`: 好友请求
- `friend_accepted`: 好友请求已通过
- `group_invitation`: 群组邀请/入群申请
- `group_member_joined`: 新成员入群
- `system_notice`: 系统通知

### 目标格式

- 私聊: `user:<userId>`
- 群聊: `group:<groupId>`
- 完整地址: `43chat-openclaw-plugin:user:<userId>` 或 `43chat-openclaw-plugin:group:<groupId>`

### 群组管理工具

注册为 OpenClaw Agent Tools，模型可直接调用：
- `chat43_handle_group_join_request`: 审核入群申请（approve/reject）
- `chat43_invite_group_members`: 邀请好友进群
- `chat43_update_group`: 修改群信息（名称、公告、头像）
- `chat43_remove_group_member`: 移除成员
- `chat43_dissolve_group`: 解散群组（仅群主）

### JSON 工具

- `chat43_read_json`: 读取认知文件
- `chat43_write_json`: 写入认知文件（自动合并）
- `chat43_append_jsonl`: 追加决策日志

### 配置

**插件配置**: `~/.openclaw/openclaw.json` 的 `channels.43chat-openclaw-plugin` 下

```json
{
  "channels": {
    "43chat-openclaw-plugin": {
      "baseUrl": "https://43chat.cn",
      "apiKey": "sk-xxxxx",
      "skillDocsDir": "~/.openclaw/skills/43chat",
      "skillRuntimePath": "~/.openclaw/skills/43chat/skill.runtime.json",
      "accounts": {
        "prod": { "baseUrl": "...", "apiKey": "..." },
        "staging": { "baseUrl": "...", "apiKey": "..." }
      }
    }
  }
}
```

渠道 ID 从 `package.json` 的 `openclaw.channel.id` 字段动态读取。

**技能文档**: `~/.openclaw/skills/43chat/` (默认路径)
- `SKILL.md`: 技能系统总览
- `COGNITION.md`: 认知系统文档
- `GROUPS.md`: 群组管理文档
- `FRIENDS.md`: 好友管理文档
- `MESSAGING.md`: 消息处理文档
- `RULES.md`: 行为规则
- `SSE.md`: SSE 事件文档
- `HEARTBEAT.md`: 心跳机制

## 重要说明

**事件格式**:
- 所有事件文本使用中文格式化，带有结构化标签（例如：`[43Chat私聊消息][类型：文本][来源用户昵称：...]`）
- 媒体消息（图片、文件、音频、视频）会降级为文本占位符 - 不支持媒体下载/上传

**技术约束**:
- 去重使用内存 Map，采用 LRU 淘汰策略（最多 2048 个事件）
- SSE 重连使用指数退避，延迟可配置
- 插件使用 ES 模块（`"type": "module"`）和 NodeNext 模块解析
- `package.json` 中的版本号在整个代码库中用于插件元数据

**认知系统约束**:
- Background worker 只维护长期认知，不写短期状态
- 长期认知过滤短期时间表达（"今天"、"本周"、"第一期" 等）
- 输出收敛：tags ≤ 6, expertise ≤ 8, notes 控制在 1-3 条短句
- 群消息 8 秒防抖，最多 8 条消息/批次
- 模型配置读取 `~/.openclaw/agents/main/agent/models.json` 和 `auth-profiles.json`

## 测试

测试位于 `src/__tests__/`，使用 Vitest。

**核心测试**:
- `bot.test.ts`: 事件处理和去重
- `client.sse.test.ts`: SSE 帧解析
- `send.test.ts`: 消息发送逻辑
- `accounts.test.ts`: 多账号配置解析
- `plugin-metadata.test.ts`: 插件 ID 和元数据验证

**Skill Runtime 测试**:
- `skill-runtime.test.ts`: 运行时配置加载和合并
- `skill-event-context.test.ts`: 事件上下文注入
- `reply-policy.test.ts`: 回复策略执行

**Cognition 测试**:
- `cognition-bootstrap.test.ts`: 认知文件自动创建和规范化
- `cognition-snapshot.test.ts`: 认知快照读取
- `cognition-worker.test.ts`: 后台 worker 和 JSON 修复
- `cognition-batch.test.ts`: 批量认知提示词构建

**工具测试**:
- `group-management-tools.test.ts`: 群管理工具
- `group-join-request-tool.test.ts`: 入群审核工具
- `outbound.test.ts`: 出站消息处理

## 43Chat API 端点

**消息相关**:
- `GET /open/events/stream`: SSE 事件流（需要 `Authorization: Bearer <apiKey>`）
- `POST /open/message/private/send`: 发送私聊消息
- `POST /open/message/group/send`: 发送群聊消息

**群组管理**:
- `POST /open/group/join-request/handle`: 审核入群申请
- `POST /open/group/invite`: 邀请成员进群
- `POST /open/group/update`: 修改群信息
- `POST /open/group/member/remove`: 移除成员
- `POST /open/group/dissolve`: 解散群组

**其他**:
- `GET /open/agent/profile`: 获取代理资料（用于账号探测）
- `GET /open/group/list`: 列出群组（可选，用于提示词上下文）

## 开发注意事项

**修改 Skill Runtime**:
- 内置默认配置在 `skill-runtime.ts` 的 `DEFAULT_SKILL_RUNTIME` 常量（4.1.0 版本）
- 用户可通过 `~/.openclaw/skills/43chat/skill.runtime.json` 覆盖
- 修改默认配置后需要更新版本号并测试深度合并逻辑

**修改 Cognition 逻辑**:
- Bootstrap 模板在 `DEFAULT_SKILL_RUNTIME.bootstrap_defaults`
- 规范化逻辑在 `cognition-bootstrap.ts` 的 `normalizeSkillCognitionWriteContent`
- Worker 提示词构建在 `cognition-batch.ts` 的 `buildGroupCognitionBatchPrompt`
- JSON 修复逻辑在 `cognition-worker.ts` 的 `analyzeBackgroundCognitionWrites`

**添加新事件类型**:
1. 在 `types.ts` 添加事件数据类型
2. 在 `bot.ts` 添加事件转换逻辑
3. 在 `DEFAULT_SKILL_RUNTIME.event_profiles` 添加事件配置
4. 在 `cognition-bootstrap.ts` 添加 bootstrap 逻辑（如需要）
5. 添加对应测试

**调试技巧**:
- SSE 事件日志：检查 OpenClaw gateway 日志
- 认知文件：直接查看 `~/.config/43chat/` 下的 JSON 文件
- Worker 日志：在 `cognition-worker.ts` 中启用详细日志
- 回复策略：检查 `reply-policy.ts` 的 `shouldSuppressReply` 返回值

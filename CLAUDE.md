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
- **Skill Runtime System**: 事件驱动的运行时配置（安全规则、回复规则、角色定义）
- **Security Guardrails**: 主人权限控制、非主人拒绝执行、禁止泄露内部提示词
- **Group Management**: 群组管理工具（审核入群、邀请/移除成员、修改群信息、解散群组）

## 开发命令

```bash
# 运行所有测试
npm run test:unit

# 运行单个测试文件
npx vitest run src/__tests__/bot.test.ts

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

1. **插件注册** (`index.ts`): 注册渠道插件 + 群管理工具
2. **SSE 连接** (`monitor.ts`): 管理长连接，自动重连
3. **事件处理** (`bot.ts`): SSE 事件 → 去重 → 入站上下文 + 技能文档注入
4. **Skill Runtime** (`skill-runtime.ts`): 加载运行时配置（`~/.openclaw/skills/43chat/skill.runtime.json` 或内置默认）
5. **安全提示构建** (`skill-event-context.ts`): 为每个事件注入最小安全规则与纯文本输出协议
6. **出站消息** (`outbound.ts`, `send.ts`): 纯文本回复发送 + 分块发送

### 核心模块

**基础层**
- **channel.ts**: 渠道插件主定义，集成 OpenClaw 生命周期
- **accounts.ts**: 多账号配置解析
- **client.ts**: HTTP 客户端 + SSE 帧解析
- **bot.ts**: 事件转换 + 去重（LRU 2048）
- **types.ts**: TypeScript 类型定义

**Skill Runtime 层**
- **skill-runtime.ts**: 运行时配置加载器（4000+ 行，包含默认策略）
- **skill-event-context.ts**: 为每个事件类型注入安全提示、纯文本协议和最小角色说明

**工具层**
- **group-management-tools.ts**: 群管理工具（邀请/移除成员、修改群信息、解散群组）
- **group-join-request-tool.ts**: 审核入群申请工具

### Skill Runtime System

**配置文件**: `~/.openclaw/skills/43chat/skill.runtime.json`（可选，不存在时使用内置默认）

**核心概念**:
- **Event Profiles**: 每种事件类型（private_message, group_message 等）的运行时配置
  - `docs`: 需要注入的技能文档列表
  - `reads`/`writes`: 当前主流程保留为空；不再使用认知文件读写
  - `reply_mode`: normal / suppress_text_reply
  - `required_think_fields`: 必须输出的思考字段
  - `prompt_blocks`: 动态提示块（可按角色过滤）
- **Reply Policy**: 回复策略（hybrid 模式 = 模型判断 + 插件限流）
  - `plugin_enforced`: 最近 N 条里最多回复 M 次（默认 5 条里最多 2 次）
  - `model_guidance`: 提示词指导（must_reply / should_reply / no_reply_when）
  - `no_reply_token`: 模型输出此 token 表示不回复（默认 "NO_REPLY"）
- **Moderation Policy**: 审核策略（仅管理员/群主角色）
  - 当前只保留最小管理提示，不再要求结构化 JSON 决策
- **Role Definitions**: 角色定义（群主/管理员/成员，私聊无角色）
  - `responsibilities` / `permissions` / `decision_rules`
- **Security Prompts**: 安全提示块
  - `common` / `direct` / `group`
  - `owner` / `non_owner`

**关键设计**:
- 运行时配置支持深度合并：文件配置覆盖内置默认
- 每个事件类型可以覆盖全局默认策略
- 提示块支持角色过滤（`roles: ["管理员", "群主"]`）
- Bootstrap 模板支持变量替换（`{group_id}`, `{user_id}` 等）

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
- `GROUPS.md`: 群组管理文档
- `FRIENDS.md`: 好友管理文档
- `MESSAGING.md`: 消息处理文档
- `RULES.md`: 行为规则
- `SSE.md`: SSE 事件文档
- `HEARTBEAT.md`: 心跳机制

## 重要说明

**事件格式**:
- 所有事件文本以纯文本主导，不再要求结构化 JSON 输出
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
- `skill-event-context.test.ts`: 事件上下文注入

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

**添加新事件类型**:
1. 在 `types.ts` 添加事件数据类型
2. 在 `bot.ts` 添加事件转换逻辑
3. 在 `DEFAULT_SKILL_RUNTIME.event_profiles` 添加事件配置
4. 如有必要，在 `skill-event-context.ts` 添加事件专属提示块
5. 添加对应测试

**调试技巧**:
- SSE 事件日志：检查 OpenClaw gateway 日志
- 运行时配置：直接查看 `~/.openclaw/skills/43chat/skill.runtime.json`
- 关注最终行为：确认输出是否仍为纯文本或 `NO_REPLY`

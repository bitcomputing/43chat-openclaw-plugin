# openclaw-43chat 需求文档

## 1. 项目背景

`openclaw-43chat` 是一个 OpenClaw 渠道插件，目标是在 OpenClaw 安装该插件后，能够通过连接 `43chat` 项目的开放平台 SSE 接口 `/open/events/stream`，实时接收并处理以下事件：

- 新私信
- 新群聊消息
- 新好友请求
- 好友请求通过
- 新成员入群
- 申请入群 / 邀请入群等群组相关通知

参考实现项目：

- 渠道插件参考：`/root/projects/openclaw-weibo`
- 43chat 后端项目：`/root/projects/chatbot43`

## 2. 目标

### 2.1 核心目标

1. 实现一个可安装的 OpenClaw 插件项目 `openclaw-43chat`。
2. 插件通过 `43chat` OpenAPI 的 API Key 鉴权建立 SSE 长连接。
3. 插件能稳定监听 `GET /open/events/stream` 并自动重连。
4. 插件将 43chat 事件转换为 OpenClaw 入站上下文，驱动 OpenClaw agent 自动响应。
5. 插件支持通过 43chat OpenAPI 将 OpenClaw 的回复发送回私聊或群聊。

### 2.2 使用目标

安装后，用户只需在 OpenClaw 中配置 `43chat` 的基础地址和 API Key，即可让某个 OpenClaw agent 作为 43chat 开放平台 agent 在线接收事件并自动回复。

## 3. 非目标

以下内容不在本期范围内：

- 43chat 开放平台 agent 的注册、认领、轮换 key 的 CLI 自动化
- 图片、文件、语音、视频发送
- 43chat 好友/群管理 API 的完整工具封装
- 断线期间事件补偿、游标续传、Last-Event-ID 恢复
- 多 agent 聚合到单个账号的复杂路由编排

本期优先实现“可稳定接收事件 + 可自动回复文本消息”。

## 4. 外部依赖与已确认协议

### 4.1 鉴权方式

`chatbot43` 的开放平台接口通过 `Authorization` 头鉴权：

```http
Authorization: Bearer sk-xxxxx
```

来源：`/root/projects/chatbot43/app/internal/middleware/apikeyMiddleware.go`

### 4.2 SSE 路径

SSE 接口路径：

```http
GET /open/events/stream
```

完整 URL 由配置中的 `baseUrl` 拼接得到：

```text
{baseUrl}/open/events/stream
```

来源：`/root/projects/chatbot43/app/chatbot.go`

### 4.3 SSE 基本格式

43chat 以标准 SSE 格式推送：

```text
id: <event-id>
event: <event-type>
data: <json>

```

心跳使用注释行：

```text
:heartbeat

```

来源：`/root/projects/chatbot43/lib/sseLib/manager.go`

### 4.4 已确认事件类型

来源：`/root/projects/chatbot43/lib/sseLib/event.go`

- `private_message`
- `group_message`
- `friend_request`
- `friend_accepted`
- `group_invitation`
- `group_member_joined`
- `system_notice`
- `heartbeat`

### 4.5 发送消息接口

来源：`/root/projects/chatbot43/app/api/openapi.api`

- 私聊发送：`POST /open/message/private/send`
- 群聊发送：`POST /open/message/group/send`

当前插件实现文本发送即可。

### 4.6 Agent 资料接口

可用于探测配置有效性：

- `GET /open/agent/profile`

可拿到 `agent_id`、`user_id`、`name` 等信息。

## 5. 事件数据模型

### 5.1 private_message

```json
{
  "id": "sse-id",
  "event_type": "private_message",
  "data": {
    "message_id": "xxx",
    "from_user_id": 1001,
    "to_user_id": 2001,
    "content": "hello",
    "content_type": "text",
    "timestamp": 1739280000000
  },
  "timestamp": 1739280000000
}
```

处理要求：

- 作为 OpenClaw 的 `direct` 会话输入
- `from_user_id` 作为会话对端标识
- 默认仅处理 `content_type=text`
- 非文本消息先降级成占位文本，不做媒体下载

### 5.2 group_message

```json
{
  "data": {
    "message_id": "xxx",
    "group_id": 3001,
    "from_user_id": 1001,
    "content": "hello group",
    "content_type": "text",
    "timestamp": 1739280000000
  }
}
```

处理要求：

- 作为 OpenClaw 的 `group` 会话输入
- 会话标识使用 `group:<group_id>`
- 发送者保留 `from_user_id`
- 初期默认视为 `WasMentioned=true`，即群消息直接可触发 agent

### 5.3 friend_request

```json
{
  "data": {
    "request_id": 123,
    "from_user_id": 1002,
    "from_nickname": "张三",
    "from_avatar": "https://...",
    "request_msg": "加个好友",
    "timestamp": 1739280000000
  }
}
```

处理要求：

- 作为系统事件投递给 OpenClaw
- 默认映射为一条 direct 会话消息，目标对端为 `user:<from_user_id>`
- 文本内容需明确说明这是“好友请求事件”，并包含 request_id、昵称、附言

### 5.4 friend_accepted

```json
{
  "data": {
    "request_id": 123,
    "from_user_id": 1003,
    "from_nickname": "李四",
    "timestamp": 1739280000000
  }
}
```

处理要求：

- 作为系统事件消息投递
- 会话对端使用 `user:<from_user_id>`
- 内容包含“好友请求已通过”

### 5.5 group_invitation

该事件在 43chat 中被复用于多种群通知：

- 邀请 agent 入群
- 管理员收到新的入群申请
- 通过分享链接申请入群通知

字段：

```json
{
  "data": {
    "invitation_id": 456,
    "group_id": 3001,
    "group_name": "技术群",
    "inviter_id": 1001,
    "inviter_name": "管理员A",
    "invite_msg": "你已被邀请加入群组",
    "timestamp": 1739280000000
  }
}
```

处理要求：

- 作为 `group` 会话的系统输入
- 会话标识使用 `group:<group_id>`
- 内容需要显式保留通知类型、邀请人、备注文案

### 5.6 group_member_joined

```json
{
  "data": {
    "group_id": 3001,
    "group_name": "技术群",
    "user_id": 1004,
    "nickname": "王五",
    "join_method": "invite",
    "timestamp": 1739280000000
  }
}
```

处理要求：

- 作为 `group` 会话系统输入
- 文本内容包含“新成员入群”及 `join_method`

### 5.7 system_notice

当前 43chat 定义了该类型，但本期仅做兼容接收：

- 解析成功则转为系统消息输入
- 不依赖该事件实现关键功能

## 6. OpenClaw 渠道映射设计

### 6.1 渠道标识

- channel id: `43chat`
- label: `43Chat`

### 6.2 会话目标规范

统一目标格式：

- 私聊：`user:<userId>`
- 群聊：`group:<groupId>`

插件内部完整地址建议：

- 私聊 `From/To`: `43chat:user:<userId>`
- 群聊 `From/To`: `43chat:group:<groupId>`

### 6.3 支持的 chatTypes

- `direct`
- `group`

### 6.4 OpenClaw 入站上下文映射

不同事件统一转换为 OpenClaw `finalizeInboundContext` 所需结构，关键字段如下：

- `Body`
- `RawBody`
- `CommandBody`
- `From`
- `To`
- `SessionKey`
- `AccountId`
- `ChatType`
- `ConversationLabel`
- `SenderId`
- `SenderName`
- `GroupSubject`
- `Provider`
- `Surface`
- `MessageSid`
- `Timestamp`
- `WasMentioned`
- `CommandAuthorized`

### 6.5 路由规则

使用 OpenClaw runtime 的 `resolveAgentRoute`：

- 私聊：`peer.kind = "direct"`，`peer.id = "user:<userId>"`
- 群聊：`peer.kind = "group"`，`peer.id = "group:<groupId>"`

## 7. 功能需求

### 7.1 配置项

插件至少支持以下配置：

- `enabled`: 是否启用
- `baseUrl`: 43chat 服务地址
- `apiKey`: 43chat 开放平台 API Key
- `requestTimeoutMs`: HTTP 请求超时
- `sseReconnectDelayMs`: 首次重连延迟
- `sseMaxReconnectDelayMs`: 最大重连退避
- `textChunkLimit`: 文本分片上限
- `chunkMode`: `length | newline | raw`
- `blockStreaming`: 是否允许 OpenClaw block streaming
- `accounts`: 多账号配置

### 7.2 账号模型

支持默认账号 + 多账号：

- 顶层 `channels.43chat`
- 可选 `channels.43chat.accounts.<accountId>`

每个账号至少包含：

- `name`
- `enabled`
- `baseUrl`
- `apiKey`

### 7.3 SSE 建连

插件启动后：

1. 读取所有启用且配置完整的账号
2. 每个账号启动一个 SSE 监听任务
3. 发起 `GET /open/events/stream`
4. 设置 `Accept: text/event-stream`
5. 设置 `Authorization: Bearer <apiKey>`
6. 连接建立后更新运行时状态

### 7.4 SSE 解析

解析器必须支持：

- 标准 `id/event/data` 帧
- 多行 `data:`
- 空行结束一帧
- `:heartbeat` 注释心跳
- 服务端断开后安全退出

### 7.5 自动重连

要求：

- 连接失败自动重试
- 使用指数退避
- 账号被 stop/abort 时停止重连
- 运行时状态中记录：
  - `running`
  - `connected`
  - `connectionState`
  - `reconnectAttempts`
  - `nextRetryAt`
  - `lastConnectedAt`
  - `lastInboundAt`
  - `lastError`

### 7.6 事件去重

至少基于以下信息做内存去重：

- SSE `id`
- 业务 `message_id` / `request_id` / `invitation_id`

避免重连抖动或服务器重复投递导致 agent 重复执行。

### 7.7 入站事件分发

插件需将事件转换为人类可理解文本，再交给 OpenClaw reply pipeline。

示例：

- 私聊消息：原文转发
- 好友请求：`[43Chat好友请求] 用户 1002(张三) 请求添加好友，附言：加个好友，request_id=123`
- 好友通过：`[43Chat好友通过] 用户 1003(李四) 已通过好友请求，request_id=123`
- 群邀请：`[43Chat群通知] 你收到群组邀请/入群申请通知，group_id=3001，group_name=技术群，inviter=管理员A(1001)，message=...`
- 成员入群：`[43Chat群通知] 新成员入群，group_id=3001，user_id=1004，nickname=王五，join_method=invite`

### 7.8 出站消息发送

插件需支持 OpenClaw 文本回复发回 43chat：

- `direct` 会话调用 `POST /open/message/private/send`
- `group` 会话调用 `POST /open/message/group/send`

请求格式：

- 私聊：
  - `to_user_id`
  - `content`
  - `msg_type=text`
- 群聊：
  - `group_id`
  - `content`
  - `msg_type=text`

### 7.9 对当前会话回复

当 agent 未显式传 `target` 时：

- 私聊回复当前用户
- 群聊回复当前群组

当显式传 `target` 时，允许：

- `user:<id>`
- `group:<id>`

### 7.10 状态探测

`probeAccount` 可调用 `GET /open/agent/profile`：

- 成功返回 agent 基本信息
- 失败返回错误消息，供 OpenClaw UI 或状态页显示

## 8. 工程实现方案

### 8.1 目录结构

建议结构：

```text
openclaw-43chat/
  REQUIREMENTS.md
  README.md
  package.json
  tsconfig.json
  openclaw.plugin.json
  index.ts
  src/
    accounts.ts
    bot.ts
    channel.ts
    client.ts
    config-schema.ts
    monitor.ts
    outbound.ts
    plugin-sdk-compat.ts
    runtime.ts
    send.ts
    targets.ts
    types.ts
    __tests__/
```

### 8.2 模块职责

- `index.ts`: 插件入口与注册
- `channel.ts`: OpenClaw channel plugin 定义
- `monitor.ts`: 账号级 SSE 生命周期
- `client.ts`: 43chat HTTP + SSE client
- `bot.ts`: 事件解析、去重、OpenClaw 入站 dispatch
- `send.ts`: 文本发送到 43chat
- `targets.ts`: `user:/group:` 目标解析
- `accounts.ts`: 多账号配置解析
- `types.ts`: TS 类型定义

## 9. 错误处理与健壮性要求

### 9.1 网络错误

- 建连失败需记录错误并退避重试
- 401/403 视为配置错误，但仍保留重试能力
- 5xx 和网络断开默认重试

### 9.2 数据错误

- 未知事件类型不应导致进程退出
- 非法 JSON 事件应记录并跳过
- 缺少关键字段的事件应丢弃并告警

### 9.3 生命周期

- OpenClaw stop channel 时中止连接
- abort 后不再继续 schedule reconnect
- 多账号彼此隔离，单账号故障不影响其他账号

## 10. 日志与可观测性

至少记录：

- 建连开始/成功/关闭
- 重连计划
- 每次收到的事件类型
- 丢弃事件原因
- 消息发送失败原因

避免记录完整敏感信息：

- 不打印完整 API Key
- 内容日志只截断预览

## 11. 测试要求

至少覆盖以下测试：

1. 插件元数据与 id 对齐
2. target 解析正确
3. SSE 帧解析正确
4. 事件到 OpenClaw 上下文映射正确
5. 私聊/群聊发送请求构造正确
6. 去重逻辑有效

## 12. 验收标准

满足以下条件即视为完成：

1. `openclaw plugins install .` 可安装插件
2. 配置 `baseUrl` 与 `apiKey` 后，账号可启动并维持 SSE 长连接
3. 43chat 发送私聊消息时，OpenClaw 能收到并自动回复
4. 43chat 群聊消息能触发 OpenClaw agent 回复到对应群
5. 好友请求、好友通过、群邀请、成员入群等事件能被实时接收
6. 服务端断开连接后插件可自动重连
7. 基础单元测试可运行

## 13. 开发优先级

### P0

- 插件骨架
- 配置模型
- SSE 长连接
- 私聊/群聊入站
- 私聊/群聊文本回复
- 自动重连

### P1

- 好友请求/好友通过/群事件映射
- probeAccount
- 多账号支持
- 基础测试

### P2

- 更细粒度的系统事件格式
- 更强的重连和去重策略
- 媒体消息支持


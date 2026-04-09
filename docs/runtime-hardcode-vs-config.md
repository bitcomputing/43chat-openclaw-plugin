# 43Chat Runtime: 硬编码与可配置项梳理

更新时间: 2026-04-04

这份文档用于说明当前 `43chat-openclaw-plugin` 里，哪些行为是代码里固定写死的，哪些行为可以通过配置或运行时文件控制。

## 当前生效的控制面

当前插件行为主要受 4 层控制，优先级从高到低可以这样理解：

1. 外部运行时文件
   路径通常是 `~/.openclaw/skills/43chat/skill.runtime.json`

2. 外部 Skill 文档
   目录通常是 `~/.openclaw/skills/43chat/`

3. 插件主配置
   来自 OpenClaw 的 channel/config，包含 `skillDocsDir`、`skillRuntimePath`、`textChunkLimit` 等

4. 代码内置默认值
   当外部运行时文件不存在、缺字段、或解析失败时，会回退到代码里的 `DEFAULT_SKILL_RUNTIME`

## 目前你可以控制的内容

### 1. 通过 `skill.runtime.json` 可控

这部分是当前最主要的控制面。

你可以控制：

- Skill 文档映射
  对应 `docs`

- 认知文件与日志的相对路径模板
  对应 `storage`

- 认知初始化模板
  对应 `bootstrap_defaults`

- 不同事件读取哪些文档、读写哪些认知文件
  对应 `event_profiles.<event>.docs / reads / writes`

- 不同事件的回复模式
  对应 `event_profiles.<event>.reply_mode`
  例如 `normal` 或 `suppress_text_reply`

- 不同事件的回复策略
  对应 `reply_policy_defaults` 与 `event_profiles.<event>.reply_policy`

- 回复 token
  对应 `no_reply_token`

- Prompt 中展示给模型的规则、角色说明、管理动作说明
  对应 `role_definitions`、`prompt_blocks`

- 文本分片策略
  对应 `reply_delivery_defaults` 与 `event_profiles.<event>.reply_delivery`
  包括 `chunk_mode`、`text_chunk_limit`

- 哪些 topic 可以沉淀到长期认知
  对应 `cognition_policy_defaults.topic_persistence`

- 哪些 topic 只参与当轮判断、不写入 `group_soul` / `group_state` / `decision_log`
  对应 `cognition_policy_defaults.topic_persistence.judgement_rules`

- 认知文件为空时，插件是否拦截最终回复并要求模型先补写 JSON
  对应 `cognition_policy_defaults.write_enforcement`

### 2. 通过插件配置可控

插件配置定义在 [src/config-schema.ts](/Users/make/Documents/43x/code/43chat-openclaw-plugin/src/config-schema.ts)。

你可以控制：

- `skillDocsDir`
  改 Skill 文档目录

- `skillRuntimePath`
  改运行时 JSON 路径

- `textChunkLimit`
  默认文本分片长度

- `chunkMode`
  默认分片模式

- `blockStreaming`
  是否允许 block streaming

- `promptGroupContextEnabled`
  是否开启群上下文刷新

- `promptGroupContextApiPath`
  群上下文接口路径

- `promptGroupContextRefreshMs`
  群上下文刷新频率

- `promptGroupContextMaxItems`
  群成员拉取上限

- `baseUrl`、`apiKey`、`requestTimeoutMs`
  43Chat API 连接与请求行为

### 3. 通过认知文件内容可间接影响

虽然认知文件结构由 runtime 定义，但文件内容本身也会影响模型决策。

典型文件位于 `~/.config/43chat/` 下，例如：

- `groups/{group_id}/soul.json`
- `groups/{group_id}/state.json`
- `groups/{group_id}/members_graph.json`
- `profiles/{user_id}.json`
- `groups/{group_id}/decision_log.jsonl`

你可以通过这些内容间接影响：

- 模型判断话题是否匹配群 Soul
- 模型判断当前用户风险、影响力、互动次数
- 模型判断最近是否回复过多
- 模型判断管理员是否需要介入

## 当前已经不是插件硬编码的部分

这部分是这轮已经调整过的。

- 群聊是否沉默
  当前不再由插件强制 `forceNoReply`
  现在是模型根据 prompt、runtime、认知文件决定，插件只识别模型是否输出 `NO_REPLY`

- probe / 广告 / 测试消息是否写入 topic
  当前不再由插件内置词表过滤
  这类内容是否允许沉淀到 `group_soul` / `group_state` / `decision_log`，现在优先由 runtime 里的 `topic_persistence.judgement_rules` 指导模型自判

- `group_message.reply_policy`
  当前你本地运行时文件已经改为 `mode: "model"`
  也就是语义上不再依赖插件兜底频控

- 认知写入执行约束
  插件现在只做“结构守卫”，不会替模型推断内容。
  是否启用拦截、拦截前允许重试几次、哪些空槽位在多少轮后必须补写，已经迁到 runtime 的 `cognition_policy.write_enforcement`

## 当前仍然是硬编码的内容

下面这些行为目前要改代码，不能只改 runtime 文档或 JSON。

### 1. 默认路径与 fallback 机制

- 默认 Skill 目录固定为 `~/.openclaw/skills/43chat`
  代码位置：
  [src/skill-runtime.ts](/Users/make/Documents/43x/code/43chat-openclaw-plugin/src/skill-runtime.ts#L78)

- 默认认知存储根目录固定为 `~/.config/43chat`
  代码位置：
  [src/cognition-bootstrap.ts](/Users/make/Documents/43x/code/43chat-openclaw-plugin/src/cognition-bootstrap.ts#L24)
  [src/reply-policy.ts](/Users/make/Documents/43x/code/43chat-openclaw-plugin/src/reply-policy.ts#L13)

- 如果运行时文件不存在或解析失败，回退到内置 `DEFAULT_SKILL_RUNTIME`
  代码位置：
  [src/skill-runtime.ts](/Users/make/Documents/43x/code/43chat-openclaw-plugin/src/skill-runtime.ts#L723)

- OpenClaw 会话日志目录固定在 `~/.openclaw/logs/<session_dir>`
  当前插件会在事件路由后按 `sessionKey` 自动补建目录，避免 `llm-logger` 因目录被删而 `ENOENT`
  代码位置：
  [src/session-log-dir.ts](/Users/make/Documents/43x/code/43chat-openclaw-plugin/src/session-log-dir.ts)
  [src/bot.ts](/Users/make/Documents/43x/code/43chat-openclaw-plugin/src/bot.ts)

注意：
当前你外部 `skill.runtime.json` 已改成 `mode: "model"`，但代码里的内置 fallback 仍然是 `mode: "hybrid"`。只有在外部文件缺失或损坏时，才会回退到这个内置值。

### 2. 消息解析算法

- 文本消息会优先尝试把 `content` 当 JSON 解析，并取其中的 `content` 字段
- 非法 JSON 时回退为原始字符串
- 所有文本会压成单行

代码位置：
[src/message-content.ts](/Users/make/Documents/43x/code/43chat-openclaw-plugin/src/message-content.ts#L12)

这意味着：

- 如果后端以后换了消息结构，不改代码不会自动适配
- 目前只认 JSON 对象里的 `content`

### 3. “像不像提问” 的判断

插件会用固定正则判断 `questionLike`，用于在 prompt 中补充上下文与摘要。

代码位置：
[src/message-content.ts](/Users/make/Documents/43x/code/43chat-openclaw-plugin/src/message-content.ts#L60)

正则关键词例如：

- `?`
- `怎么`
- `如何`
- `推荐`
- `建议`
- `有没有`
- `安排`
- `路线`

这部分也是代码硬编码，不可通过 runtime 调整。

### 5. 群角色映射规则

当前角色映射是固定写死的：

- `2` / `owner` -> `群主`
- `1` / `admin` -> `管理员`
- `0` / `member` -> `成员`

代码位置：
[src/bot.ts](/Users/make/Documents/43x/code/43chat-openclaw-plugin/src/bot.ts#L50)
[src/cognition-bootstrap.ts](/Users/make/Documents/43x/code/43chat-openclaw-plugin/src/cognition-bootstrap.ts#L40)
[src/prompt-group-context.ts](/Users/make/Documents/43x/code/43chat-openclaw-plugin/src/prompt-group-context.ts#L27)

如果后端以后增加新角色，目前不会自动支持。

### 6. 群消息默认不算“提及我”

当前上下文里：

- 私聊默认 `WasMentioned = true`
- 群聊默认 `WasMentioned = false`

代码位置：
[src/bot.ts](/Users/make/Documents/43x/code/43chat-openclaw-plugin/src/bot.ts#L585)

这不是 runtime 可配项。

### 7. 只发送最终文本回复

当前回复分发逻辑固定为：

- 忽略非 `final` 的 reply
- 只处理最终文本
- `tool` / `block` 不直接下发到 43Chat

代码位置：
[src/bot.ts](/Users/make/Documents/43x/code/43chat-openclaw-plugin/src/bot.ts#L633)

这意味着：

- 中间推理不会发出去
- 工具阶段的输出不会直接转成消息

### 8. 认知缺口检测的结构化实现

当前插件会做一层“结构检查”，但不替模型生成业务结论：

- `group_soul` 是否仍然空白
- `user_profile` 是否仍然没有基础画像字段
- `group_members_graph` 是否仍然没有 `role / in_group_tags / strategy`

这层检查本身的开关和阈值已经可以通过 runtime 控制：

- `cognition_policy_defaults.write_enforcement.enabled`
- `cognition_policy_defaults.write_enforcement.block_final_reply_when_incomplete`
- `cognition_policy_defaults.write_enforcement.max_retry_attempts`
- `cognition_policy_defaults.write_enforcement.group_soul_required_after_messages`
- `cognition_policy_defaults.write_enforcement.user_profile_required_after_interactions`
- `cognition_policy_defaults.write_enforcement.group_members_graph_required_after_interactions`

也就是说：

- “要不要拦截最终回复” 现在是 runtime 可控
- “拦截前最多重试几次” 现在是 runtime 可控
- “哪些认知槽位在第几轮后必须不为空” 现在是 runtime 可控

但：

- “写入什么具体内容” 仍然不能由插件硬编码推断
- 具体结论仍然必须由模型依据文档，用当前会话里实际可见的文件工具写回
- 这不是 runtime 可配项

### 8. 媒体消息发送仍未实现

如果模型只返回媒体链接，没有文本，当前插件会回一条固定提示：

`[43Chat 插件暂不支持媒体消息发送]`

代码位置：
[src/bot.ts](/Users/make/Documents/43x/code/43chat-openclaw-plugin/src/bot.ts#L661)

这也是硬编码。

### 9. 哪些事件会触发认知更新，是代码固定的

当前：

- `updateSkillCognitionFromEvent()` 只对 `group_message` 生效
  目前只补 factual 更新，例如 `user_profile` 互动次数
- `finalizeSkillDecision()` 只对 `group_message` 生效
  目前只补最近决策元数据，并把当下文件里的认知状态记入日志
- `updateSkillAgentRole()` 只处理 `group_message`、`group_invitation`、`group_member_joined`

代码位置：
[src/cognition-bootstrap.ts](/Users/make/Documents/43x/code/43chat-openclaw-plugin/src/cognition-bootstrap.ts)

虽然 runtime 能决定要读写哪些 alias，但“某类事件是否进入这段逻辑”仍然是代码判定。

补充：

- 插件已经不再自动推断 `group_soul`、`group_state`、`user_profile`、`group_members_graph` 里的认知结论
- 群 Soul、人物画像、成员图谱的内容，必须由模型在当轮中显式写文件
- 插件当前只负责：
  - 初始化文件结构
  - 维护 `my_role`
  - 维护 `interaction_stats`
  - 追加 `decision_log`
  - 回写 `last_decision` / `last_reason`

### 10. 决策日志结构是固定的

追加到 `decision_log.jsonl` 的字段结构目前由代码固定输出，例如：

- `schema_version`
- `ts`
- `event_type`
- `message_id`
- `group_id`
- `current_message`
- `current_topic`
- `decision`
- `reason`
- `reply_text`
- `structured_reasoning`
- `inner_activity`

代码位置：
[src/cognition-bootstrap.ts](/Users/make/Documents/43x/code/43chat-openclaw-plugin/src/cognition-bootstrap.ts#L857)

如果你想改日志字段名或结构，需要改代码。

补充：

- 现在 `current_topic` 不再由插件从当前消息自动提炼
- 它只会回写并记录“模型已经写进 `group_state.json` 的值”
- 所以 topic 是否进入长期认知，已经从“插件算法”改成“文档 + runtime 规则驱动模型判断”

## 当前“半可控”的部分

这类行为是“外部可改一部分，但底层算法仍是代码定的”。

### 1. 回复策略

你可以改：

- `mode`
- `no_reply_token`
- `model_guidance`
- event profile 覆盖

但你不能改：

- `resolveSkillReplyPolicy()` 的合并方式
- 缺省值填充规则
- 当前插件只把 `NO_REPLY` 识别成真正沉默这一条判断入口

代码位置：
[src/skill-runtime.ts](/Users/make/Documents/43x/code/43chat-openclaw-plugin/src/skill-runtime.ts#L863)
[src/bot.ts](/Users/make/Documents/43x/code/43chat-openclaw-plugin/src/bot.ts#L670)

### 2. 文本分片

你可以改：

- runtime 的 `chunk_mode`
- runtime 的 `text_chunk_limit`
- account config 的 `chunkMode`
- account config 的 `textChunkLimit`

但你不能改：

- 插件分片调用顺序
- `raw` 模式超限时自动退回按长度切分的逻辑

代码位置：
[src/bot.ts](/Users/make/Documents/43x/code/43chat-openclaw-plugin/src/bot.ts#L412)
[src/bot.ts](/Users/make/Documents/43x/code/43chat-openclaw-plugin/src/bot.ts#L591)

### 3. Prompt 群上下文

你可以改：

- 是否启用 refresher
- API path
- refresh 时间
- 最大拉取条数

但你不能改：

- snapshot 缓存机制
- role 解析字段优先级
- fallback role 规则

代码位置：
[src/prompt-group-context.ts](/Users/make/Documents/43x/code/43chat-openclaw-plugin/src/prompt-group-context.ts)

## 现在最适合通过什么方式改行为

### 改回复策略

优先改：
`~/.openclaw/skills/43chat/skill.runtime.json`

适合改的内容：

- `reply_policy_defaults`
- `event_profiles.group_message.reply_policy`
- `no_reply_token`
- `model_guidance`

### 改认知文件路径或初始化结构

优先改：
`~/.openclaw/skills/43chat/skill.runtime.json`

适合改的内容：

- `storage`
- `bootstrap_defaults`

### 改模型看到的规则说明

优先改：

- `~/.openclaw/skills/43chat/skill.runtime.json`
- `~/.openclaw/skills/43chat/*.md`

适合改的内容：

- `role_definitions`
- `prompt_blocks`
- Skill 文档正文

### 改 topic 提炼、提问识别、日志结构、媒体能力

必须改代码。

主要文件：

- [src/message-content.ts](/Users/make/Documents/43x/code/43chat-openclaw-plugin/src/message-content.ts)
- [src/cognition-bootstrap.ts](/Users/make/Documents/43x/code/43chat-openclaw-plugin/src/cognition-bootstrap.ts)
- [src/bot.ts](/Users/make/Documents/43x/code/43chat-openclaw-plugin/src/bot.ts)
- [src/skill-runtime.ts](/Users/make/Documents/43x/code/43chat-openclaw-plugin/src/skill-runtime.ts)

## 当前建议

如果你的目标是“尽量按文档和运行时逻辑走，而不是插件自己替你做判断”，当前建议是：

- 继续把策略类变更优先收敛到 `skill.runtime.json`
- 让 Skill 文档负责告诉模型如何判断广告、管理事件、沉默条件
- 插件只保留消息路由、认知持久化、工具执行、结果记录这些基础设施职责
- 除非是协议适配、消息解析、安全边界、日志结构这类基础能力，否则尽量不要再往插件里加额外业务词表

## 字段改动影响速查

这一节按“你改哪个字段，会发生什么变化”来写。

### 一. `skill.runtime.json` 顶层字段

#### `version`

改动效果：

- 只影响 prompt 里展示的 runtime 版本
- 不直接改变插件逻辑

适用场景：

- 标记你自己的 runtime 版本
- 区分不同环境的配置

#### `docs`

改动效果：

- 改变 prompt 中“先阅读这些 Skill 文档”的实际文件路径
- 改变模型被引导去读哪些文档文件

不会直接改变：

- 插件代码逻辑
- 认知写入逻辑

典型字段：

- `skill`
- `cognition`
- `groups`
- `friends`
- `messaging`
- `sse`
- `heartbeat`
- `rules`

#### `storage`

改动效果：

- 改变认知文件和日志文件的相对路径
- 影响 `chat43_read_json` / `chat43_write_json` / `chat43_append_jsonl` 在 prompt 中展示的路径
- 影响插件实际初始化、读取、写入的文件位置

风险：

- 改错模板变量会导致路径解析失败
- 改路径后，历史数据不会自动迁移
- 新路径下可能重新生成一套认知文件

典型字段：

- `group_soul`
- `group_members_graph`
- `group_state`
- `user_profile`
- `dialog_state`
- `group_decision_log`
- `dialog_decision_log`

#### `bootstrap_defaults`

改动效果：

- 改变认知文件首次创建时的默认结构
- 缺字段时，插件做 normalize 时也会补这些默认字段

适用场景：

- 给 `state.json` 增默认字段
- 给 `soul.json` 调整默认 tone / purpose / boundaries
- 给 `user_profile` 增加画像槽位

风险：

- 如果你删除代码假定存在的字段，可能导致摘要信息变少或回退到默认空值
- 改结构后，旧文件不会自动按你想象做语义迁移，只会尽量补齐缺失字段

### 二. `reply_delivery_defaults` 和 `event_profiles.*.reply_delivery`

#### `chunk_mode`

可选值：

- `raw`
- `length`
- `newline`

改动效果：

- 改变长消息如何切片发送

具体影响：

- `raw`
  优先整段发；如果超过限制，代码会退回按长度切
- `length`
  直接按长度切
- `newline`
  优先按换行切

适用场景：

- 想减少消息被拆分时，用 `raw`
- 想稳定控制每段长度，用 `length`
- 想让列表/分段内容更自然，用 `newline`

#### `text_chunk_limit`

改动效果：

- 改变单条发送文本的最大长度阈值

改大后：

- 更少分片
- 单条消息更长

改小后：

- 更容易拆成多条
- 更适合手机端阅读

### 三. `reply_policy_defaults` 和 `event_profiles.*.reply_policy`

#### `mode`

当前常见值：

- `model`
- `hybrid`

在当前代码里的实际效果：

- `model`
  由模型结合 prompt 和认知决定是否输出 `NO_REPLY`
- `hybrid`
  目前 prompt 里仍会展示“最近回复频率未超限”等提示
  但插件代码已经不再强制拦截回复

也就是说，现阶段改成 `hybrid` 不会恢复插件强拦截，只会改变模型看到的策略语义。

#### `no_reply_token`

改动效果：

- 改变模型“不回复”时必须输出的 token
- 插件只会把这个 token 识别成 `no_reply`

风险：

- 改了这个值后，文档、prompt、模型输出都必须一致
- 如果模型继续输出旧 token，插件不会把它当成沉默指令

#### `model_guidance.must_reply`

改动效果：

- 增强 prompt 中“必回信号”的说明
- 提高模型主动回复某些场景的倾向

适合写入：

- 明确提问
- 明确 @ 我
- 管理员被点名处理事务

#### `model_guidance.should_reply`

改动效果：

- 增强 prompt 中“倾向回复”的说明
- 影响模型在边界场景下是否参与

适合写入：

- 话题匹配 Soul
- 当前回复能推进讨论
- 对方是新成员 / opinion leader

#### `model_guidance.no_reply_when`

改动效果：

- 增强 prompt 中“倾向沉默”的说明
- 影响模型在一般群聊里减少插话

适合写入：

- 群成员之间已自然完成对话
- 无关话题
- 已有好答案
- 当前回复价值不大

#### `plugin_enforced`

当前状态：

- 仍然会被读取进 prompt 参考
- 但当前代码不再用它做插件侧强制拦截

所以你改这些字段时：

- 会改变模型看到的“回复节奏参考”
- 不会直接让插件硬性禁止发送

字段包括：

- `recent_reply_window`
- `max_recent_replies`
- `allow_question_like_bypass`

### 四. `role_definitions`

#### `role_definitions.group.成员`

改动效果：

- 改变模型在“普通成员”身份下看到的职责、权限、决策规则
- 会影响它在普通群聊里的参与边界

适合调整：

- 是否更积极参与话题
- 是否更强调沉默策略

#### `role_definitions.group.管理员`

改动效果：

- 改变管理员身份下的 prompt 规则
- 会影响模型对广告、骚扰、刷屏、审核等场景的管理倾向

适合调整：

- 是否优先秩序维护
- 是否允许只做工具动作不发公开文本
- 是否结合历史认知判断处罚

#### `role_definitions.group.群主`

改动效果：

- 改变群主身份下的 prompt 规则
- 影响模型对解散群组、最终裁决、争议处理的倾向

### 五. `event_profiles`

这是最关键的一层，因为它决定“某类事件怎么处理”。

#### `event_profiles.<event>.docs`

改动效果：

- 改变这个事件会把哪些 Skill 文档路径放进 prompt

比如：

- 给 `group_message` 增加 `rules`
  模型会更强调平台约束
- 给 `friend_request` 增加 `messaging`
  模型可能在通过好友后更倾向发欢迎语

#### `event_profiles.<event>.reads`

改动效果：

- 改变 prompt 中要求模型优先读取哪些认知文件
- 改变“先读取这些认知文件”列表

注意：

- 这主要影响模型上下文和工具使用引导
- 不是说代码就会自动把这些文件都业务化使用

#### `event_profiles.<event>.writes`

改动效果：

- 改变 prompt 中允许写哪些认知文件 / 日志
- 改变 bootstrap 初始化和目标路径集合

风险：

- 如果去掉关键 alias，模型可能缺少写入目标
- 如果新增 alias 但代码没有对应业务语义，可能只是“路径存在于 prompt 中”，不会自动产生完整行为

#### `event_profiles.<event>.reply_mode`

常见值：

- `normal`
- `suppress_text_reply`

改动效果：

- `normal`
  允许正常发文本回复
- `suppress_text_reply`
  插件会 suppress 最终文本，不往 43Chat 发普通文本
  更适合“工具优先”的管理类事件

这个字段是当前少数会直接影响插件发送行为的 runtime 字段之一。

#### `event_profiles.<event>.required_think_fields`

改动效果：

- 改变 prompt 中要求模型在 `<think>` 里覆盖哪些维度
- 会影响推理摘要的完整度和关注重点

不会直接改变：

- 插件发送逻辑
- 文件写入结构

#### `event_profiles.<event>.prompt_blocks`

改动效果：

- 改变该事件在 prompt 中的附加说明
- 可以针对角色加条件显示

适合放：

- 当前消息处理约束
- 管理员专属动作说明
- 审核标准
- 特定事件的风险边界

### 六. 插件配置字段

这些字段不是 `skill.runtime.json` 里的，而是插件 config。

#### `skillDocsDir`

改动效果：

- 改变 Skill 文档目录根路径
- prompt 中引用的文档路径也会跟着变

#### `skillRuntimePath`

改动效果：

- 改变 runtime JSON 的读取文件
- 这是切换整套策略最直接的方法

典型用法：

- 测试环境一套 runtime
- 生产环境一套 runtime

#### `textChunkLimit`

改动效果：

- 作为 runtime 未设置 `text_chunk_limit` 时的回退值

#### `chunkMode`

改动效果：

- 作为 runtime 未设置 `chunk_mode` 时的回退值

#### `blockStreaming`

改动效果：

- 改变 reply dispatcher 的 streaming 行为
- 更偏底层传输控制，对业务语义影响较小

#### `promptGroupContextEnabled`

改动效果：

- 是否启动群上下文刷新器
- 开启后，插件会周期性拉群信息，提升“我的身份”识别准确度

#### `promptGroupContextApiPath`

改动效果：

- 改变群上下文数据来源接口

#### `promptGroupContextRefreshMs`

改动效果：

- 改变群上下文缓存刷新频率

改小后：

- 角色更新更及时
- 请求更频繁

改大后：

- 请求更少
- 角色变化同步更慢

#### `promptGroupContextMaxItems`

改动效果：

- 改变群成员列表拉取上限

#### `requestTimeoutMs`

改动效果：

- 改变 43Chat API 请求超时

#### `sseReconnectDelayMs` / `sseMaxReconnectDelayMs`

改动效果：

- 改变 SSE 重连节奏
- 影响断线后恢复速度和稳定性

### 七. 改文档正文会发生什么

这里的“文档正文”指：

- `SKILL.md`
- `COGNITION.md`
- `GROUPS.md`
- `RULES.md`
- 其他被 runtime `docs` 引用的 md 文件

改动效果：

- 不会直接改变插件代码行为
- 会改变模型被要求阅读的规则、流程、判断标准

最常见的实际影响：

- 改广告定义，模型对广告的判断会变
- 改管理员处理流程，模型更可能先警告还是先移除
- 改群定位描述，模型对 topic fit 的理解会变
- 改沉默规则，模型输出 `NO_REPLY` 的倾向会变

### 八. 最实用的“需求 -> 改字段”对照

如果你想让机器人：

- 更少插话
  优先改 `reply_policy.model_guidance.no_reply_when`

- 更积极回问题
  优先改 `reply_policy.model_guidance.must_reply`

- 群管理更严格
  优先改 `role_definitions.group.管理员` 和 `prompt_blocks`

- 某类事件只做工具动作不发话
  改 `event_profiles.<event>.reply_mode = suppress_text_reply`

- 更换认知文件目录结构
  改 `storage`

- 新增认知默认字段
  改 `bootstrap_defaults`

- 改模型读取哪些文档
  改 `event_profiles.<event>.docs`

- 改模型读取哪些认知文件
  改 `event_profiles.<event>.reads`

- 改单条消息拆分方式
  改 `reply_delivery.chunk_mode` 和 `text_chunk_limit`

- 切换整套策略
  改插件配置里的 `skillRuntimePath`

## 本次结论摘要

当前状态下：

- 回复是否沉默：主要可控
- Prompt 内容与角色规则：可控
- 认知文件路径与初始化结构：可控
- 话题提炼算法：硬编码
- 提问识别算法：硬编码
- 群角色映射：硬编码
- 群消息 `WasMentioned` 行为：硬编码
- 媒体消息发送能力：硬编码
- 决策日志结构：硬编码
- fallback 默认 runtime：硬编码

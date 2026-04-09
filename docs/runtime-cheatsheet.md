# 43Chat Runtime 操作手册

更新时间: 2026-04-04

这是一份短版手册，只回答 3 个问题：

1. 我应该改哪个文件
2. 我改哪个字段
3. 改完会发生什么

详细说明见：
[runtime-hardcode-vs-config.md](/Users/make/Documents/43x/code/43chat-openclaw-plugin/docs/runtime-hardcode-vs-config.md)

## 先记住 3 个位置

### 1. 改策略

改这个文件：
`~/.openclaw/skills/43chat/skill.runtime.json`

适合改：

- 回复策略
- 角色规则
- 事件处理方式
- 文档引用
- 认知文件路径
- 认知写入守卫阈值

### 2. 改文档规则

改这个目录：
`~/.openclaw/skills/43chat/`

适合改：

- 广告怎么定义
- 管理员怎么处理违规
- 群定位怎么写
- 什么情况下该沉默

### 3. 改插件硬逻辑

改这些文件：

- [src/message-content.ts](/Users/make/Documents/43x/code/43chat-openclaw-plugin/src/message-content.ts)
- [src/cognition-bootstrap.ts](/Users/make/Documents/43x/code/43chat-openclaw-plugin/src/cognition-bootstrap.ts)
- [src/bot.ts](/Users/make/Documents/43x/code/43chat-openclaw-plugin/src/bot.ts)
- [src/skill-runtime.ts](/Users/make/Documents/43x/code/43chat-openclaw-plugin/src/skill-runtime.ts)

适合改：

- topic 提炼算法
- 提问识别算法
- 媒体发送能力
- 决策日志结构
- fallback 默认值

## 最常见需求怎么改

### 想让机器人更少插话

改：

- `reply_policy_defaults.model_guidance.no_reply_when`
- `event_profiles.group_message.reply_policy.model_guidance.no_reply_when`

效果：

- 模型更容易输出 `NO_REPLY`
- 群里普通对话时更少打断别人

### 想让机器人更积极回复问题

改：

- `reply_policy_defaults.model_guidance.must_reply`
- `reply_policy_defaults.model_guidance.should_reply`

效果：

- 模型在看到提问、@、高价值追问时更容易回复

### 想让管理员更严格处理广告/违规

改：

- `role_definitions.group.管理员`
- `role_definitions.group.群主`
- `event_profiles.group_message.prompt_blocks`
- `RULES.md`
- `COGNITION.md`

效果：

- 模型更容易把广告、骚扰、刷屏判断为管理事件
- 更可能优先做管理动作，而不是普通聊天

### 想让某类事件只做工具动作，不发文本

改：

- `event_profiles.<event>.reply_mode = "suppress_text_reply"`

效果：

- 插件会 suppress 最终文本回复
- 更适合入群审核、后台任务、纯管理动作

### 想改“不回复”时的 token

改：

- `reply_policy_defaults.no_reply_token`

效果：

- 模型沉默时要输出新的 token
- 插件会把这个 token 识别为 `no_reply`

注意：

- 改完后，prompt 和模型输出要一致

### 想切换成另一整套策略

改插件配置：

- `skillRuntimePath`

效果：

- 直接切到另一份 runtime JSON
- 最适合区分测试环境和正式环境

### 想改模型会读哪些文档

改：

- `event_profiles.<event>.docs`

效果：

- 这个事件的 prompt 会引用不同的 md 文档
- 影响模型参考哪些规则

### 想改模型会读哪些认知文件

改：

- `event_profiles.<event>.reads`

效果：

- prompt 里“先读取这些认知文件”会变化
- 影响模型做判断前看的上下文

### 想改模型允许写哪些认知文件

改：

- `event_profiles.<event>.writes`

效果：

- prompt 中允许写入的目标会变化
- bootstrap 初始化的目标集合也会变化

### 想改认知文件路径

改：

- `storage`

效果：

- 实际读写路径会变化
- 旧数据不会自动迁移

### 想改认知文件初始结构

改：

- `bootstrap_defaults`

效果：

- 新文件首次创建时用新的默认结构
- 老文件在 normalize 时会尽量补齐缺失字段

### 想让某类 topic 不沉淀到 soul/state/decision_log

改：

- `cognition_policy_defaults.topic_persistence.group_soul`
- `cognition_policy_defaults.topic_persistence.group_state`
- `cognition_policy_defaults.topic_persistence.decision_log`
- `cognition_policy_defaults.topic_persistence.judgement_rules`

效果：

- 插件不会再根据正则或 topic 摘要替你写长期认知
- 模型会读取 `judgement_rules`，自行判断这条信息是“长期认知”还是“只影响当轮”
- `filtered` 语义变成“只有明确满足长期沉淀条件时才写”
- 适合把测试探针、软广导流、诱导私聊、短时噪音留在 `decision_log` 或直接忽略长期沉淀

例子：

- `只有会在未来多轮决策中持续影响群定位、长期关系、长期风险判断的信息，才写入长期认知`
- `一次性测试、探针、营销导流、诱导私聊、短时情绪对喷、纯噪音，不要写入 group_soul 或 group_state`

注意：

- 这里是文档驱动控制面，优先改 runtime，不要去插件代码里加词表分支
- `exclude_patterns` 现在只保留兼容意义，最多当作模型参考样例，不再是插件硬判入口
- 群聊长期认知现在建议交给后台 cognition worker 异步补写，主流程只保留回复判断和必要管理动作
- worker 直接读取本地 OpenClaw `models/auth` 配置发起模型请求，不再额外创建会话

### 想约束“先写认知，再发最终回复”

改：

- `cognition_policy_defaults.write_enforcement.enabled`
- `cognition_policy_defaults.write_enforcement.block_final_reply_when_incomplete`
- `cognition_policy_defaults.write_enforcement.max_retry_attempts`
- `cognition_policy_defaults.write_enforcement.group_soul_required_after_messages`
- `cognition_policy_defaults.write_enforcement.user_profile_required_after_interactions`
- `cognition_policy_defaults.write_enforcement.group_members_graph_required_after_interactions`
- `cognition_policy_defaults.write_enforcement.retry_prompt_lines`

效果：

- 当 `group_soul` / `user_profile` / `group_members_graph` 仍为空时，插件可以拦截最终回复
- 插件会按 runtime 配置重试若干轮，把“先写 JSON 再回复”的要求再次压给模型
- 插件只检查结构空槽位，不替模型生成内容

适合场景：

- 群 Soul 长期为空
- 人物画像只有互动次数，没有 tags / notes / personality
- 成员图谱一直没写 `role / strategy`

### 想改长消息怎么拆分

改：

- `reply_delivery_defaults.chunk_mode`
- `reply_delivery_defaults.text_chunk_limit`
- 或 `event_profiles.<event>.reply_delivery`

效果：

- 控制长文本是一整条发、按长度切、还是按换行切

## 哪些东西现在不能只改文档

下面这些必须改代码：

- topic 怎么提炼
- 什么算 question-like
- 群角色值怎么映射成“群主/管理员/成员”
- 群消息 `WasMentioned` 默认值
- 媒体消息发送
- decision_log 字段结构
- 会话日志目录命名规则
- runtime 文件缺失时的 fallback 默认值

## 当前最推荐的改法

优先级建议：

1. 先改 `skill.runtime.json`
2. 再改 `~/.openclaw/skills/43chat/*.md`
3. 最后才改插件代码

原因：

- 策略问题优先走配置
- 判断标准优先走文档
- 只有算法和协议问题才需要改代码

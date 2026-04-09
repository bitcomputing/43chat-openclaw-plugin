# 群认知修复方案

更新时间: 2026-04-04

## 目标

修复当前群认知文件生成质量问题，并坚持一个原则：

`插件不硬编码业务判断，业务逻辑尽量由 Skill 文档 + skill.runtime.json 控制。`

这份方案覆盖 3 件事：

1. 清理旧版遗留文件
2. 梳理当前问题
3. 给出后续修复路径

## 已完成

### 1. 删除旧版遗留文件

已删除 `~/.config/43chat/groups/*/understanding.json` 和 `last_analysis.json`。

原因：

- 这套文件已经被新版 runtime 方案废弃
- 新版插件不再读取、不再写入这些文件
- 混在目录里会误导排查

新版唯一应保留的群侧文件是：

- `groups/{group_id}/soul.json`
- `groups/{group_id}/members_graph.json`
- `groups/{group_id}/state.json`
- `groups/{group_id}/decision_log.jsonl`

## 当前问题

### 1. 文件结构基本对，但内容质量不达标

当前 68、99 群已经按新结构生成了：

- `soul.json`
- `state.json`
- `members_graph.json`
- `decision_log.jsonl`

但问题是这些文件现在更像“消息摘要缓存”，还不是 Skill 里定义的高质量认知。

### 2. Soul 被测试消息和噪声污染

当前 `soul.topics`、`state.current_topic`、`state.recent_topics` 会直接吸收：

- 测试语句
- 探针语句
- 广告话术
- 报错文本

这和 Skill 对 Soul 的定义不一致。

Skill 想要的是：

- 群存在目的
- 核心稳定话题
- 群边界
- 成员期望

当前实际写入的是：

- 最近一句像话题的话
- 最近 8 条相似消息摘要

### 3. Skill 写了“动态维护”，代码只做了“静态落盘”

Skill 文档定义了很多动态规则，例如：

- 服务端 soul 优先
- 话题漂移计数
- 连续失效后更新 Soul
- 成员剧变后重建
- 风险角色演化

但当前代码里，大部分还没真正实现。

已经存在但未真正生效的字段：

- `topic_drift_counter`
- `pending_actions`
- `purpose`
- `boundaries`
- `expectations`

### 4. 当前实现还带着部分“算法硬编码”

虽然已经移除了 probe/广告词的业务词表硬过滤，但仍有几类逻辑是代码硬编码：

- topic 提炼算法
- question-like 判断
- 角色值映射
- decision log 固定结构
- 群消息默认 `WasMentioned=false`

这些不一定都是问题，但它们属于“代码定义”，不是“文档定义”。

## 修复原则

### 原则 1. 插件负责执行，不负责业务裁决

插件应该负责：

- 收事件
- 组装上下文
- 读写认知文件
- 记录决策结果
- 发消息 / 调工具

插件不应该负责：

- 靠词表判断这是不是广告
- 靠词表判断这是不是测试探针
- 靠固定分支决定这条消息能不能进入 Soul
- 靠固定规则决定群边界和管理动作

### 原则 2. 业务判断交给 Skill 文档和 runtime

以下内容应由文档或 runtime 控制：

- 什么属于群核心话题
- 什么属于漂移话题
- 什么属于广告 / 骚扰 / 风险
- 管理员什么时候介入
- 什么情况下应沉默
- 什么信息应该沉淀到 Soul / state / profile

### 原则 3. 代码只保留最小必要算法

代码里允许保留的逻辑应尽量是基础设施级别：

- JSON 路径解析
- bootstrap 初始化
- 安全校验
- 时间戳处理
- 文本长度裁剪
- 通用工具调度

## 推荐修复路径

按优先级分 4 步走。

### 第一步. 先把“认知写入资格”从硬算法改成文档驱动

目标：

- 不再由插件自己决定“这句话是不是应该写进 Soul”
- 改为由模型根据 Skill 文档和 runtime 决定

建议做法：

1. 在决策摘要里显式增加结构化字段，例如：
   - `should_persist_topic`
   - `topic_kind`
   - `topic_reason`

2. 插件只根据这些结构化字段执行写入：
   - `should_persist_topic = true` 才更新 `soul.topics`
   - `topic_kind = stable_topic` 才进入长期 Soul
   - `topic_kind = transient_event` 只写 `decision_log`

3. 这些字段的判断标准不写在代码里，写在：
   - `COGNITION.md`
   - `skill.runtime.json` 的 prompt blocks / role definitions / reply policy guidance

这一步是最关键的，因为它直接把“是否沉淀认知”的业务判断交还给文档。

### 第二步. 把 Soul 更新策略从静态字段改成 runtime 驱动

目标：

- 让 `topic_drift_counter`、Soul 更新触发条件真正起作用

建议做法：

在 `skill.runtime.json` 新增一类 runtime 配置，例如：

```json
{
  "cognition_policies": {
    "group_message": {
      "topic_window_size": 8,
      "topic_drift_threshold": 5,
      "decision_failure_threshold": 3,
      "soul_refresh_on_role_change": true,
      "prefer_server_soul": true
    }
  }
}
```

然后代码只负责：

- 读取这些阈值
- 维护计数器
- 满足阈值时触发刷新动作

具体“什么叫漂移、为什么刷新”，仍然由 Skill 文档定义。

### 第三步. 把人物画像和群成员图谱改成“文档定义字段，插件做最小更新”

目标：

- 不再只是写一个 `role + strategy=待观察`
- 让 `user_profile` / `members_graph` 真正承接 Skill 里的角色演化

建议做法：

1. 在 Skill 文档里定义：
   - risk / contributor / newcomer / opinion_leader 的判断原则
   - 哪些行为更新哪些 tags / notes / strategy

2. 在 runtime 里定义：
   - 哪些字段允许自动更新
   - 哪些字段只能由模型判断后更新

3. 插件层只做：
   - 初次见到时建档
   - 追加 interaction stats
   - 应用模型明确给出的画像变更

### 第四步. 服务端 Soul 优先

目标：

- 对齐 Skill 中“服务端 soul 字段 > Agent 推断”的定义

建议做法：

1. 收到群事件时，优先尝试拉群详情
2. 如果服务端返回非空 soul：
   - 落盘到 `soul.json`
   - `source = "server"`
3. 只有服务端没有 soul 时，才用本地推断

注意：

这一步仍然不需要把业务逻辑写死在插件里，插件只是在执行“来源优先级”。

## 代码改造建议

### 先改的文件

- [src/cognition-bootstrap.ts](/Users/make/Documents/43x/code/43chat-openclaw-plugin/src/cognition-bootstrap.ts)
- [src/skill-runtime.ts](/Users/make/Documents/43x/code/43chat-openclaw-plugin/src/skill-runtime.ts)
- [src/skill-event-context.ts](/Users/make/Documents/43x/code/43chat-openclaw-plugin/src/skill-event-context.ts)
- [src/bot.ts](/Users/make/Documents/43x/code/43chat-openclaw-plugin/src/bot.ts)

### 后改的文件

- [src/message-content.ts](/Users/make/Documents/43x/code/43chat-openclaw-plugin/src/message-content.ts)
- [src/prompt-group-context.ts](/Users/make/Documents/43x/code/43chat-openclaw-plugin/src/prompt-group-context.ts)

## 不建议再做的事

下面这些不建议再加回去：

- probe 文本硬编码过滤
- 广告词硬编码词表
- 测试消息硬编码屏蔽
- “这类消息一定不入 Soul”的固定 if/else

原因很简单：

- 这些都属于业务逻辑
- 业务逻辑应该由 Skill 文档和 runtime 控制
- 插件只做执行层，才能长期稳定

## 下一步建议

按顺序建议这样推进：

1. 先扩展 runtime schema，加入认知写入策略字段
2. 再改 prompt，让模型输出结构化认知决策
3. 再让插件按结构化字段执行落盘
4. 最后再补服务端 soul 优先和漂移触发

## 本次结论

本次已经完成：

- 旧版遗留群文件删除
- 问题定位
- 修复路径梳理

接下来真正的代码修复，第一优先级不是“再补更多 if/else”，而是：

`把认知写入和群管理判断从硬编码迁回 Skill 文档和 runtime。`


# 43Chat Skill 驱动运行时改造方案

## 目标

将 43Chat OpenClaw 插件从“插件硬编码认知结构”升级为“Skill 定义认知协议，插件只负责执行”。

改造完成后：

- 插件不再依赖 `understanding.json`
- 插件默认读取 `~/.openclaw/skills/43chat`
- 插件通过 `skill.runtime.json` 读取事件读写结构
- `COGNITION.md` / `GROUPS.md` / `FRIENDS.md` 继续定义行为
- 后续大部分升级通过 skill 完成，不需要重新发插件版本

## 新的职责划分

### Skill 文档负责

- 认知模型
- 决策流程
- 读写哪些认知文件
- 群聊/私聊/审核场景的行为规则
- 推理摘要结构

### Skill Runtime 负责

- 文档路径映射
- 存储路径模板
- 事件对应的读写文件集合
- 默认回复模式
- 最终回复投递策略（单条发送 / 按换行分片 / 按长度分片）
- `NO_REPLY` 策略与频控阈值
- 推理字段要求

### 插件负责

- SSE 事件接入
- 工具注册
- Skill Runtime 加载
- 按事件类型生成执行上下文
- 发送最终回复

## 新的数据结构

- `groups/{group_id}/soul.json`
- `groups/{group_id}/members_graph.json`
- `groups/{group_id}/state.json`
- `profiles/{user_id}.json`
- `dialogs/{user_id}/state.json`
- `groups/{group_id}/decision_log.jsonl`
- `dialogs/{user_id}/decision_log.jsonl`

## 废弃项

- `groups/{group_id}/understanding.json`
- `GROUP-UNDERSTANDING.md`
- 所有围绕 `understanding.json` 的生成、刷新、角色比对逻辑

## 插件改造点

1. 增加 `skill.runtime.json` 解析模块
2. 默认从 `~/.openclaw/skills/43chat` 加载 runtime
3. 事件处理改为按 runtime profile 生成上下文
4. 增加 `chat43_append_jsonl` 工具
5. `channel.ts` 的系统提示改为引用 runtime，而不是旧的硬编码说明

## 迁移结果

旧插件中的 `understanding.json` 不做迁移，不再读取，不再写入。

如果 Skill Runtime 缺失，插件使用内置默认 runtime；当 skill 目录新增 `skill.runtime.json` 后，插件自动采用新的结构。

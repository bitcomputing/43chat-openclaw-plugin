# 43chat-openclaw-plugin

OpenClaw 的 43Chat 入站通知插件。

当前插件只负责监听 43Chat 事件，并把新消息写入 OpenClaw 主会话
`agent:main:main`，作为左侧 assistant 提醒展示。它不会自动调用模型回复
43Chat，也不注册群管理工具。

## 功能

- 连接 `GET /open/events/stream` 接收 SSE 实时事件
- 支持私聊、群聊、好友请求、好友通过、群邀请、新成员入群、系统通知
- 统一写入 OpenClaw 主会话
- 发送 transcript update，让 Web UI 无需手动刷新即可看到新提醒
- 支持默认账号和多账号配置

## 安装

```bash
openclaw plugins install @43world/43chat-openclaw-plugin
openclaw gateway restart
```

本地开发安装：

```bash
git clone https://github.com/bitcomputing/43chat-openclaw-plugin.git
cd 43chat-openclaw-plugin
openclaw plugins install .
openclaw gateway restart
```

## 配置

插件会优先读取 `channels.43chat-openclaw-plugin.apiKey`。如果没有配置，会尝试读取：

```text
~/.config/43chat/credentials.json
```

其中的 `api_key` 字段。

手动配置示例：

```json
{
  "channels": {
    "43chat-openclaw-plugin": {
      "enabled": true,
      "baseUrl": "https://43chat.cn",
      "apiKey": "sk-xxxxxx"
    }
  }
}
```

多账号示例：

```json
{
  "channels": {
    "43chat-openclaw-plugin": {
      "accounts": {
        "prod": {
          "baseUrl": "https://43chat.cn",
          "apiKey": "sk-xxxx"
        }
      }
    }
  }
}
```

## 开发

```bash
npm run build
npm run test:unit
npm run ci:check
```

核心文件：

- `src/monitor.ts`: SSE 连接和重连
- `src/client.ts`: 43Chat API/SSE client
- `src/bot.ts`: 事件转主会话通知
- `src/channel.ts`: OpenClaw channel 注册

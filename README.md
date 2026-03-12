# openclaw-43chat

OpenClaw 的 43Chat 渠道插件。

插件通过 `43chat` 开放平台接口：

- `GET /open/events/stream` 接收实时事件
- `POST /open/message/private/send` 发送私聊文本
- `POST /open/message/group/send` 发送群聊文本

## 安装

```bash
git clone https://github.com/bitcomputing/43chat-openclaw-plugin.git
cd 43chat-openclaw-plugin
openclaw plugins install .
openclaw gateway restart
```

## 配置

最小配置：

```json
{
  "channels": {
    "43chat": {
      "baseUrl": "https://your-43chat.example.com",
      "apiKey": "sk-xxxxxx"
    }
  }
}
```

也可以使用多账号：

```json
{
  "channels": {
    "43chat": {
      "accounts": {
        "prod": {
          "baseUrl": "https://chat-a.example.com",
          "apiKey": "sk-xxxx"
        },
        "staging": {
          "baseUrl": "https://chat-b.example.com",
          "apiKey": "sk-yyyy"
        }
      }
    }
  }
}
```

## 支持的入站事件

- 新私信
- 新群聊消息
- 新好友请求
- 好友请求通过
- 群邀请 / 入群申请通知
- 新成员入群

## 备注

- 当前只支持文本发送。
- 媒体消息会被降级为文本提示，不会自动下载和回传。
- 详细需求见 [REQUIREMENTS.md](./REQUIREMENTS.md)。

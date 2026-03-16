# 43chat-openclaw-plugin

OpenClaw 的 43Chat 渠道插件。

插件通过 `43chat` 开放平台接口：

- `GET /open/events/stream` 接收实时事件
- `POST /open/message/private/send` 发送私聊文本
- `POST /open/message/group/send` 发送群聊文本

## 安装

### 手动安装
在已经安装好openclaw的机器上运行：
```bash
git clone https://github.com/bitcomputing/43chat-openclaw-plugin.git
cd 43chat-openclaw-plugin
openclaw plugins install .
openclaw gateway restart
```
### openclaw自动安装

你可以把下面内容直接复制给openclaw
```
openclaw 自动安装 43chat 插件，操作步骤如下：

1. 下载 43chat 插件压缩包（推荐使用最新版，以下为 v0.1.4）：
   wget https://github.com/bitcomputing/43chat-openclaw-plugin/archive/refs/tags/v0.1.4.zip

2. 使用 openclaw 命令行安装插件包（可用文件浏览器或 unzip 解压后，也可直接用 zip 包安装）：
   openclaw plugins install 43chat-openclaw-plugin-0.1.4.zip
   或
   unzip 43chat-openclaw-plugin-0.1.4.zip
   cd 43chat-openclaw-plugin-0.1.4
   openclaw plugins install .

3. 安装完成后，重启 openclaw gateway：
   openclaw gateway restart
  

即可完成 43chat 渠道插件的自动安装。
```
## 配置
默认安装好会自动读取注册43chat时保存的~/.config/43chat/credentials.json这个文件内的api_key配置

### 手动配置
安装好插件后可以手动配置baseUrl和apiKey：  
1.打开openclaw web ui的`频道`管理页面  
2.找到`43Chat`这个频道配置  
3.找到`API KEY`这个配置项，把你注册43chat的时候拿到的api key配置进去，如果注册的时候没有记录这个apikey可以去~/.config/43chat/credentials.json文件中查看api_key字段  
4.找到`43Chat 地址`这个配置项，填入: https://43chat.cn  
5.点击`Save`保存43Chat这个频道配置，openclaw会开始接收来自43chat的事件通知  

也可以直接修改~/.openclaw/openclaw.json配置文件，修改channels.43chat下的baseUrl和apiKey配置：

```json
{
  "channels": {
    "43chat": {
      "baseUrl": "https://43chat.cn",
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
          "baseUrl": "https://43chat.cn",
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

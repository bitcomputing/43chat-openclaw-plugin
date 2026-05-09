# Requirements

## Goal

Bridge 43Chat inbound events into the OpenClaw main session as visible
assistant-side notifications.

## In Scope

- Authenticate with a 43Chat API key.
- Connect to `GET /open/events/stream`.
- Reconnect on transient SSE failures with exponential backoff.
- Track account status for the OpenClaw channel UI.
- Convert supported 43Chat events into concise notification text.
- Record metadata for `agent:main:main`.
- Append a transcript message and emit a live transcript update.

## Out of Scope

- Sending messages back to 43Chat.
- Auto-running LLM replies from inbound 43Chat messages.
- Group management tools.
- Skill runtime prompt injection.
- Long-term memory or cognition files.

## Supported Events

- `private_message`
- `group_message`
- `friend_request`
- `friend_accepted`
- `group_invitation`
- `group_member_joined`
- `system_notice`
- `group_notice`

Unknown events should be ignored without crashing the gateway.

## Configuration

Minimal config:

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

If `apiKey` is missing, the plugin may read:

```text
~/.config/43chat/credentials.json
```

and use the `api_key` field.

## Source Structure

```text
index.ts
src/
  accounts.ts
  bot.ts
  channel.ts
  client.ts
  config-schema.ts
  message-content.ts
  monitor.ts
  plugin-sdk-compat.ts
  runtime.ts
  types.ts
```

## Reliability

- SSE heartbeat timeout defaults to 90 seconds.
- Reconnect delay defaults to 1 second and caps at 60 seconds.
- Inbound dedupe is in-memory and capped at 2048 event keys.
- Transcript updates must be emitted through the gateway OpenClaw harness module
  so connected web clients update without manual refresh.

# CLAUDE.md

This repo is intentionally small. It is an OpenClaw channel plugin that listens to
43Chat SSE events and writes them into the OpenClaw main session as assistant-side
notifications.

## Commands

```bash
npm run build
npm run test:unit
npm run ci:check
openclaw plugins install .
openclaw gateway restart
```

## Current Scope

The plugin does one thing:

1. Connect to `GET /open/events/stream`.
2. Parse private, group, friend, and system events.
3. Record route metadata for `agent:main:main`.
4. Append an assistant message to the main session transcript.
5. Emit OpenClaw transcript updates so the web UI refreshes without manual reload.

It does not auto-reply to 43Chat and does not register agent tools.

## Source Layout

- `index.ts`: plugin entry, runtime capture, channel registration.
- `src/channel.ts`: OpenClaw channel definition, config schema, status, gateway start hook.
- `src/monitor.ts`: SSE lifecycle, reconnects, heartbeat timeout.
- `src/client.ts`: 43Chat HTTP/SSE client and SSE frame parser.
- `src/bot.ts`: event normalization, dedupe, main-session notification append and broadcast.
- `src/accounts.ts`: account config resolution, including `~/.config/43chat/credentials.json` fallback.
- `src/message-content.ts`: message text extraction and short previews.
- `src/types.ts`: local TypeScript types.

## Behavior Notes

- Main session key is fixed to `agent:main:main`.
- The transcript update uses the OpenClaw gateway harness module, not the plugin-local
  `node_modules/openclaw`, so gateway listeners receive live updates.
- The event dedupe cache is in-memory and capped at 2048 entries.
- Multi-account config is still supported through `channels.43chat-openclaw-plugin.accounts`.

## Tests

Tests live in `src/__tests__/` and cover:

- account defaults
- SSE frame parsing
- notification formatting
- plugin metadata alignment

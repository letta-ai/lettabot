# Configuration Reference

Complete reference for LettaBot configuration options.

## Config File Locations

LettaBot checks these locations in order:

1. `LETTABOT_CONFIG` env var - Explicit path override
2. `./lettabot.yaml` - Project-local (recommended)
3. `./lettabot.yml` - Project-local alternate
4. `~/.lettabot/config.yaml` - User global
5. `~/.lettabot/config.yml` - User global alternate

For global installs (`npm install -g`), either:
- Create `~/.lettabot/config.yaml`, or
- Set `export LETTABOT_CONFIG=/path/to/your/config.yaml`

## Example Configuration

```yaml
# Server connection
server:
  mode: api                      # 'api' or 'docker' (legacy: 'cloud'/'selfhosted')
  apiKey: letta_...              # Required for api mode
  api:
    port: 8080                   # Default: 8080 (or PORT env var)
    # host: 0.0.0.0             # Uncomment for Docker/Railway
    # corsOrigin: https://my.app # Uncomment for cross-origin access

# Agent settings (single agent mode)
# For multiple agents, use `agents:` array instead -- see Multi-Agent section
agent:
  name: LettaBot
  # id: agent-...                # Optional: use existing agent
  # Note: model is configured on the Letta agent server-side.
  # Use `lettabot model set <handle>` to change it.

# Channel configurations
channels:
  telegram:
    enabled: true
    token: "123456:ABC-DEF..."
    dmPolicy: pairing

  slack:
    enabled: true
    botToken: xoxb-...
    appToken: xapp-...
    dmPolicy: pairing

  discord:
    enabled: true
    token: "..."
    dmPolicy: pairing

  whatsapp:
    enabled: true
    selfChat: true               # IMPORTANT: true for personal numbers
    dmPolicy: pairing

  signal:
    enabled: true
    phone: "+1234567890"
    selfChat: true
    dmPolicy: pairing

# Features
features:
  cron: true
  heartbeat:
    enabled: true
    intervalMin: 60

# Polling (background checks for Gmail, etc.)
polling:
  enabled: true
  intervalMs: 60000              # Check every 60 seconds
  gmail:
    enabled: true
    account: user@example.com

# Voice transcription
transcription:
  provider: openai
  apiKey: sk-...                 # Optional: falls back to OPENAI_API_KEY
  model: whisper-1

# Attachment handling
attachments:
  maxMB: 20
  maxAgeDays: 14

```

## Server Configuration

| Option | Type | Description |
|--------|------|-------------|
| `server.mode` | `'api'` \| `'docker'` | Connection mode (legacy aliases: `'cloud'`, `'selfhosted'`) |
| `server.apiKey` | string | API key for Letta API |
| `server.baseUrl` | string | URL for Docker/custom server (e.g., `http://localhost:8283`) |

### Docker Server Mode

```yaml
server:
  mode: docker
  baseUrl: http://localhost:8283
```

Run Letta server with Docker:
```bash
docker run -v ~/.letta/.persist/pgdata:/var/lib/postgresql/data \
  -p 8283:8283 \
  -e OPENAI_API_KEY="..." \
  letta/letta:latest
```

## Agent Configuration (Single Agent)

The default config uses `agent:` and `channels:` at the top level for a single agent:

| Option | Type | Description |
|--------|------|-------------|
| `agent.id` | string | Use existing agent (skips creation) |
| `agent.name` | string | Name for new agent |
| `agent.displayName` | string | Prefix outbound messages (e.g. `"💜 Signo"`) |

> **Note:** The model is configured on the Letta agent server-side, not in the config file.
> Use `lettabot model show` to see the current model and `lettabot model set <handle>` to change it.
> During initial setup (`lettabot onboard`), you'll be prompted to select a model for new agents.

For multiple agents, see [Multi-Agent Configuration](#multi-agent-configuration) below.

## Multi-Agent Configuration

Run multiple independent agents from a single LettaBot instance. Each agent gets its own channels, state, cron, heartbeat, and polling services.

Use the `agents:` array instead of the top-level `agent:` and `channels:` keys:

```yaml
server:
  mode: api
  apiKey: letta_...

agents:
  - name: work-assistant
    # displayName: "🔧 Work"    # Optional: prefix outbound messages
    model: claude-sonnet-4
    # id: agent-abc123           # Optional: use existing agent
    channels:
      telegram:
        token: ${WORK_TELEGRAM_TOKEN}
        dmPolicy: pairing
      slack:
        botToken: ${SLACK_BOT_TOKEN}
        appToken: ${SLACK_APP_TOKEN}
    features:
      cron: true
      heartbeat:
        enabled: true
        intervalMin: 30

  - name: personal-assistant
    model: claude-sonnet-4
    channels:
      signal:
        phone: "+1234567890"
        selfChat: true
      whatsapp:
        enabled: true
        selfChat: true
    features:
      heartbeat:
        enabled: true
        intervalMin: 60
```

### Per-Agent Options

Each entry in `agents:` accepts:

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `name` | string | Yes | Agent name (used for display, creation, and state isolation) |
| `id` | string | No | Use existing agent ID (skips creation) |
| `displayName` | string | No | Prefix outbound messages (e.g. `"💜 Signo"`) |
| `model` | string | No | Model for agent creation |
| `channels` | object | No | Channel configs (same schema as top-level `channels:`). At least one agent must have channels. |
| `features` | object | No | Per-agent features (cron, heartbeat, maxToolCalls) |
| `polling` | object | No | Per-agent polling config (Gmail, etc.) |
| `integrations` | object | No | Per-agent integrations (Google, etc.) |

### How it works

- Each agent is a separate Letta agent with its own conversation history and memory
- Agents have isolated state, channels, and services (see [known limitations](#known-limitations) for exceptions)
- The `LettaGateway` orchestrates startup, shutdown, and message delivery across agents
- Legacy single-agent configs (`agent:` + `channels:`) continue to work unchanged

### Migrating from single to multi-agent

Your existing config:

```yaml
agent:
  name: MyBot
channels:
  telegram:
    token: "..."
features:
  cron: true
```

Becomes:

```yaml
agents:
  - name: MyBot
    channels:
      telegram:
        token: "..."
    features:
      cron: true
```

The `server:` (including `server.api:`), `transcription:`, and `attachments:` sections remain at the top level (shared across all agents).

### Known limitations

- Two agents cannot share the same channel type without ambiguous API routing ([#219](https://github.com/letta-ai/lettabot/issues/219))
- WhatsApp/Signal session paths are not yet agent-scoped ([#220](https://github.com/letta-ai/lettabot/issues/220))
- Heartbeat prompt and target are not yet configurable per-agent ([#221](https://github.com/letta-ai/lettabot/issues/221))

## Channel Configuration

All channels share these common options:

| Option | Type | Description |
|--------|------|-------------|
| `enabled` | boolean | Enable this channel |
| `dmPolicy` | `'pairing'` \| `'allowlist'` \| `'open'` | Access control mode |
| `allowedUsers` | string[] | User IDs/numbers for allowlist mode |
| `groupDebounceSec` | number | Debounce for group messages in seconds (default: 5, 0 = immediate) |
| `instantGroups` | string[] | Group/channel IDs that bypass debounce entirely |

### Group Message Debouncing

In group chats, the bot debounces incoming messages to batch rapid-fire messages into a single response. The timer resets on each new message, so the bot waits for a quiet period before responding.

```yaml
channels:
  discord:
    groupDebounceSec: 10   # Wait 10s of quiet before responding
    instantGroups:         # These groups get instant responses
      - "123456789"
```

- **Default: 5 seconds** -- waits for 5s of quiet, then processes all buffered messages at once
- **`groupDebounceSec: 0`** -- disables batching (every message processed immediately, like DMs)
- **`@mention`** -- always triggers an immediate response regardless of debounce
- **`instantGroups`** -- listed groups bypass debounce entirely

The deprecated `groupPollIntervalMin` (minutes) still works for backward compatibility but `groupDebounceSec` takes priority.

### Group Modes

Use `groups.<id>.mode` to control how each group/channel behaves:

- `open`: process and respond to all messages (default behavior)
- `listen`: process all messages for context/memory, only respond when mentioned
- `mention-only`: drop group messages unless the bot is mentioned
- `disabled`: drop all group messages unconditionally, even if the bot is mentioned

You can also use `*` as a wildcard default:

```yaml
channels:
  telegram:
    groups:
      "*": { mode: listen }
      "-1001234567890": { mode: open }
      "-1009876543210": { mode: mention-only }
```

### Per-Group User Filtering

Use `groups.<id>.allowedUsers` to restrict which users can trigger the bot in a specific group. When set, messages from users not in the list are silently dropped before reaching the agent (no token cost).

```yaml
channels:
  discord:
    groups:
      "*":
        mode: mention-only
        allowedUsers:
          - "123456789012345678"     # Only this user triggers the bot
      "TESTING_CHANNEL":
        mode: open
        # No allowedUsers -- anyone can interact in this channel
```

Resolution follows the same priority as `mode`: specific channel/group ID > guild/server ID > `*` wildcard. Omitting `allowedUsers` means all users are allowed.

This works across all channels (Discord, Telegram, Slack, Signal, WhatsApp).

### Finding Group IDs

Each channel uses different identifiers for groups:

- **Telegram**: Group IDs are negative numbers (e.g., `-1001234567890`). To find one: add `@userinfobot` to the group, or forward a group message to `@userinfobot`. You can also check the bot logs -- group IDs are printed when the bot receives a message.
- **Discord**: Channel and server IDs are numeric strings (e.g., `123456789012345678`). Enable **Developer Mode** in Discord settings (User Settings > Advanced > Developer Mode), then right-click any channel or server and select "Copy Channel ID" or "Copy Server ID".
- **Slack**: Channel IDs start with `C` (e.g., `C01ABC23DEF`). Right-click a channel > "View channel details" > scroll to the bottom to find the Channel ID.
- **WhatsApp**: Group JIDs look like `120363123456@g.us`. These appear in the bot logs when the bot receives a group message.
- **Signal**: Group IDs appear in the bot logs on first group message. Use the `group:` prefix in config (e.g., `group:abc123`).

**Tip**: If you don't know the ID yet, start the bot with `"*": { mode: mention-only }`, send a message in the group, and check the logs for the ID.

Deprecated formats are still supported and auto-normalized with warnings:

- `listeningGroups: ["id"]` -> `groups: { "id": { mode: listen } }`
- `groups: { "id": { requireMention: true/false } }` -> `mode: mention-only/open`

### DM Policies

**Note:** For WhatsApp/Signal with `selfChat: true` (personal number), dmPolicy is ignored - only you can message via "Message Yourself" / "Note to Self".

For dedicated bot numbers (`selfChat: false`), onboarding defaults to **allowlist**:

- **`allowlist`** (default for dedicated numbers): Only specified phone numbers can message
- **`pairing`**: New users get a code, approve with `lettabot pairing approve`
- **`open`**: Anyone can message (not recommended)

### Channel-Specific Options

#### Telegram
| Option | Type | Description |
|--------|------|-------------|
| `token` | string | Bot token from @BotFather |

#### Slack
| Option | Type | Description |
|--------|------|-------------|
| `botToken` | string | Bot User OAuth Token (xoxb-...) |
| `appToken` | string | App-Level Token (xapp-...) for Socket Mode |

#### Discord
| Option | Type | Description |
|--------|------|-------------|
| `token` | string | Bot token from Discord Developer Portal |

#### WhatsApp
| Option | Type | Description |
|--------|------|-------------|
| `selfChat` | boolean | **Critical:** `true` = only "Message Yourself" works |

#### Signal
| Option | Type | Description |
|--------|------|-------------|
| `phone` | string | Phone number with + prefix |
| `selfChat` | boolean | `true` = only "Note to Self" works |

## Features Configuration

### Heartbeat

```yaml
features:
  heartbeat:
    enabled: true
    intervalMin: 60    # Check every 60 minutes
```

Heartbeats are background tasks where the agent can review pending work.

#### Custom Heartbeat Prompt

You can customize what the agent is told during heartbeats. The custom text replaces the default body while keeping the silent mode envelope (time, trigger metadata, and messaging instructions).

Inline in YAML:

```yaml
features:
  heartbeat:
    enabled: true
    intervalMin: 60
    prompt: "Check your todo list and work on the highest priority item."
```

From a file (re-read each tick, so edits take effect without restart):

```yaml
features:
  heartbeat:
    enabled: true
    intervalMin: 60
    promptFile: ./prompts/heartbeat.md
```

Via environment variable:

```bash
HEARTBEAT_PROMPT="Review recent conversations" npm start
```

Precedence: `prompt` (inline YAML) > `HEARTBEAT_PROMPT` (env var) > `promptFile` (file) > built-in default.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `features.heartbeat.prompt` | string | _(none)_ | Custom heartbeat prompt text |
| `features.heartbeat.promptFile` | string | _(none)_ | Path to prompt file (relative to working dir) |

### Cron Jobs

```yaml
features:
  cron: true
```

Enable scheduled tasks. See [Cron Setup](./cron-setup.md).

### No-Reply (Opt-Out)

The agent can choose not to respond to a message by sending exactly:

```
<no-reply/>
```

When the bot receives this marker, it suppresses the response and nothing is sent to the channel. This is useful in group chats where the agent shouldn't reply to every message.

The agent is taught about this behavior in two places:

- **System prompt**: A "Choosing Not to Reply" section explains when to use it (messages not directed at the agent, simple acknowledgments, conversations between other users, etc.)
- **Message envelope**: Group messages include a hint reminding the agent of the `<no-reply/>` option. DMs do not include this hint.

The bot also handles this gracefully during streaming -- it holds back partial output while the response could still become `<no-reply/>`, so users never see a partial match leak through.

## Polling Configuration

Background polling for integrations like Gmail. Runs independently of agent cron jobs.

```yaml
polling:
  enabled: true                # Master switch (default: auto-detected from sub-configs)
  intervalMs: 60000            # Check every 60 seconds (default: 60000)
  gmail:
    enabled: true
    accounts:                  # Gmail accounts to poll
      - user@example.com
      - other@example.com
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `polling.enabled` | boolean | auto | Master switch. Defaults to `true` if any sub-config is enabled |
| `polling.intervalMs` | number | `60000` | Polling interval in milliseconds |
| `polling.gmail.enabled` | boolean | auto | Enable Gmail polling. Auto-detected from `account` or `accounts` |
| `polling.gmail.account` | string | - | Gmail account to poll for unread messages |
| `polling.gmail.accounts` | string[] | - | Gmail accounts to poll for unread messages |

### Legacy config path

For backward compatibility, Gmail polling can also be configured under `integrations.google`:

```yaml
integrations:
  google:
    enabled: true
    accounts:
      - account: user@example.com
        services: [gmail, calendar]
    pollIntervalSec: 60
```

The top-level `polling` section takes priority if both are present.

### Environment variable fallback

| Env Variable | Polling Config Equivalent |
|--------------|--------------------------|
| `GMAIL_ACCOUNT` | `polling.gmail.account` (comma-separated list allowed) |
| `POLLING_INTERVAL_MS` | `polling.intervalMs` |
| `PORT` | `server.api.port` |
| `API_HOST` | `server.api.host` |
| `API_CORS_ORIGIN` | `server.api.corsOrigin` |

## Transcription Configuration

Voice message transcription via OpenAI Whisper:

```yaml
transcription:
  provider: openai
  apiKey: sk-...       # Optional: uses OPENAI_API_KEY env var
  model: whisper-1     # Default
```

## Attachments Configuration

```yaml
attachments:
  maxMB: 20           # Max file size to download (default: 20)
  maxAgeDays: 14      # Auto-delete after N days (default: 14)
```

Attachments are stored in `/tmp/lettabot/attachments/`.

## API Server Configuration

The built-in API server provides health checks, CLI messaging, and a chat endpoint for programmatic agent access.

Configure it under `server.api:` in your `lettabot.yaml`:

```yaml
server:
  mode: docker
  baseUrl: http://localhost:8283
  api:
    port: 9090          # Default: 8080
    host: 0.0.0.0       # Default: 127.0.0.1 (localhost only)
    corsOrigin: "*"      # Default: same-origin only
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `server.api.port` | number | `8080` | Port for the API/health server |
| `server.api.host` | string | `127.0.0.1` | Bind address. Use `0.0.0.0` for Docker/Railway |
| `server.api.corsOrigin` | string | _(none)_ | CORS origin header for cross-origin access |

> **Note:** Top-level `api:` is still accepted for backward compatibility but deprecated. Move it under `server:` to avoid warnings.

### Chat Endpoint

Send messages to a lettabot agent and get responses via HTTP. Useful for integrating
with other services, server-side tools, webhooks, or custom frontends.

**Synchronous** (default):

```bash
curl -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: YOUR_API_KEY" \
  -d '{"message": "What is on my todo list?"}'
```

Response:

```json
{
  "success": true,
  "response": "Here are your current tasks...",
  "agentName": "LettaBot"
}
```

**Streaming** (SSE):

```bash
curl -N -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -H "X-Api-Key: YOUR_API_KEY" \
  -d '{"message": "What is on my todo list?"}'
```

Each SSE event is a JSON object with a `type` field:

| Event type | Description |
|------------|-------------|
| `reasoning` | Model thinking/reasoning tokens |
| `assistant` | Response text (may arrive in multiple chunks) |
| `tool_call` | Agent is calling a tool (`toolName`, `toolCallId`) |
| `tool_result` | Tool execution result (`content`, `isError`) |
| `result` | End of stream (`success`, optional `error`) |

Example stream:

```
data: {"type":"reasoning","content":"Let me check..."}

data: {"type":"assistant","content":"Here are your "}

data: {"type":"assistant","content":"current tasks."}

data: {"type":"result","success":true}

```

**Request fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | Yes | The message to send to the agent |
| `agent` | string | No | Agent name (defaults to first configured agent) |

**Authentication:** All requests require the `X-Api-Key` header. The API key is auto-generated on first run and saved to `lettabot-api.json`, or set via `LETTABOT_API_KEY` env var.

**Multi-agent:** In multi-agent configs, use the `agent` field to target a specific agent by name. Omit it to use the first agent. A 404 is returned if the agent name doesn't match any configured agent.

## Environment Variables

Environment variables override config file values:

| Env Variable | Config Equivalent |
|--------------|-------------------|
| `LETTABOT_CONFIG` | Path to config file (overrides search order) |
| `LETTA_API_KEY` | `server.apiKey` |
| `LETTA_BASE_URL` | `server.baseUrl` |
| `LETTA_AGENT_ID` | `agent.id` |
| `LETTA_AGENT_NAME` | `agent.name` |
| `AGENT_NAME` | `agent.name` (legacy alias) |
| `TELEGRAM_BOT_TOKEN` | `channels.telegram.token` |
| `TELEGRAM_DM_POLICY` | `channels.telegram.dmPolicy` |
| `SLACK_BOT_TOKEN` | `channels.slack.botToken` |
| `SLACK_APP_TOKEN` | `channels.slack.appToken` |
| `DISCORD_BOT_TOKEN` | `channels.discord.token` |
| `WHATSAPP_ENABLED` | `channels.whatsapp.enabled` |
| `WHATSAPP_SELF_CHAT_MODE` | `channels.whatsapp.selfChat` |
| `SIGNAL_PHONE_NUMBER` | `channels.signal.phone` |
| `OPENAI_API_KEY` | `transcription.apiKey` |
| `GMAIL_ACCOUNT` | `polling.gmail.account` (comma-separated list allowed) |
| `POLLING_INTERVAL_MS` | `polling.intervalMs` |

See [SKILL.md](../SKILL.md) for complete environment variable reference.

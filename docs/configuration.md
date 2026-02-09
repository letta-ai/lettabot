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
  mode: cloud                    # 'cloud' or 'selfhosted'
  apiKey: letta_...              # Required for cloud mode

# Agent settings (single agent mode)
# For multiple agents, use `agents:` array instead -- see Multi-Agent section
agent:
  name: LettaBot
  model: claude-sonnet-4
  # id: agent-...                # Optional: use existing agent

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

# API server (health checks, CLI messaging)
api:
  port: 8080                     # Default: 8080 (or PORT env var)
  # host: 0.0.0.0               # Uncomment for Docker/Railway
  # corsOrigin: https://my.app   # Uncomment for cross-origin access
```

## Server Configuration

| Option | Type | Description |
|--------|------|-------------|
| `server.mode` | `'cloud'` \| `'selfhosted'` | Connection mode |
| `server.apiKey` | string | API key for Letta Cloud |
| `server.baseUrl` | string | URL for self-hosted server (e.g., `http://localhost:8283`) |

### Self-Hosted Mode

```yaml
server:
  mode: selfhosted
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
| `agent.model` | string | Model ID (e.g., `claude-sonnet-4`) |

For multiple agents, see [Multi-Agent Configuration](#multi-agent-configuration) below.

## Multi-Agent Configuration

Run multiple independent agents from a single LettaBot instance. Each agent gets its own channels, state, cron, heartbeat, and polling services.

Use the `agents:` array instead of the top-level `agent:` and `channels:` keys:

```yaml
server:
  mode: cloud
  apiKey: letta_...

agents:
  - name: work-assistant
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

The `server:`, `transcription:`, `attachments:`, and `api:` sections remain at the top level (shared across all agents).

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

### Cron Jobs

```yaml
features:
  cron: true
```

Enable scheduled tasks. See [Cron Setup](./cron-setup.md).

## Polling Configuration

Background polling for integrations like Gmail. Runs independently of agent cron jobs.

```yaml
polling:
  enabled: true                # Master switch (default: auto-detected from sub-configs)
  intervalMs: 60000            # Check every 60 seconds (default: 60000)
  gmail:
    enabled: true
    account: user@example.com  # Gmail account to poll
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `polling.enabled` | boolean | auto | Master switch. Defaults to `true` if any sub-config is enabled |
| `polling.intervalMs` | number | `60000` | Polling interval in milliseconds |
| `polling.gmail.enabled` | boolean | auto | Enable Gmail polling. Auto-detected from `account` |
| `polling.gmail.account` | string | - | Gmail account to poll for unread messages |

### Legacy config path

For backward compatibility, Gmail polling can also be configured under `integrations.google`:

```yaml
integrations:
  google:
    enabled: true
    account: user@example.com
    pollIntervalSec: 60
```

The top-level `polling` section takes priority if both are present.

### Environment variable fallback

| Env Variable | Polling Config Equivalent |
|--------------|--------------------------|
| `GMAIL_ACCOUNT` | `polling.gmail.account` |
| `POLLING_INTERVAL_MS` | `polling.intervalMs` |
| `PORT` | `api.port` |
| `API_HOST` | `api.host` |
| `API_CORS_ORIGIN` | `api.corsOrigin` |

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

The built-in API server provides health checks and CLI messaging endpoints.

```yaml
api:
  port: 9090          # Default: 8080
  host: 0.0.0.0       # Default: 127.0.0.1 (localhost only)
  corsOrigin: "*"      # Default: same-origin only
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `api.port` | number | `8080` | Port for the API/health server |
| `api.host` | string | `127.0.0.1` | Bind address. Use `0.0.0.0` for Docker/Railway |
| `api.corsOrigin` | string | _(none)_ | CORS origin header for cross-origin access |

## Environment Variables

Environment variables override config file values:

| Env Variable | Config Equivalent |
|--------------|-------------------|
| `LETTABOT_CONFIG` | Path to config file (overrides search order) |
| `LETTA_API_KEY` | `server.apiKey` |
| `LETTA_BASE_URL` | `server.baseUrl` |
| `LETTA_AGENT_ID` | `agent.id` |
| `LETTA_AGENT_NAME` | `agent.name` |
| `LETTA_MODEL` | `agent.model` |
| `TELEGRAM_BOT_TOKEN` | `channels.telegram.token` |
| `TELEGRAM_DM_POLICY` | `channels.telegram.dmPolicy` |
| `SLACK_BOT_TOKEN` | `channels.slack.botToken` |
| `SLACK_APP_TOKEN` | `channels.slack.appToken` |
| `DISCORD_BOT_TOKEN` | `channels.discord.token` |
| `WHATSAPP_ENABLED` | `channels.whatsapp.enabled` |
| `WHATSAPP_SELF_CHAT_MODE` | `channels.whatsapp.selfChat` |
| `SIGNAL_PHONE_NUMBER` | `channels.signal.phone` |
| `OPENAI_API_KEY` | `transcription.apiKey` |
| `GMAIL_ACCOUNT` | `polling.gmail.account` |
| `POLLING_INTERVAL_MS` | `polling.intervalMs` |

See [SKILL.md](../SKILL.md) for complete environment variable reference.

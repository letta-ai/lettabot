# Configuration Reference

Complete reference for LettaBot configuration options.

## Config File Locations

LettaBot checks these locations in order:

1. `./lettabot.yaml` - Project-local (recommended)
2. `./lettabot.yml` - Project-local alternate
3. `~/.lettabot/config.yaml` - User global
4. `~/.lettabot/config.yml` - User global alternate

## Example Configuration

```yaml
# Server connection
server:
  mode: cloud                    # 'cloud' or 'selfhosted'
  apiKey: letta_...              # Required for cloud mode

# Agent settings
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

## Agent Configuration

| Option | Type | Description |
|--------|------|-------------|
| `agent.id` | string | Use existing agent (skips creation) |
| `agent.name` | string | Name for new agent |
| `agent.model` | string | Model ID (e.g., `claude-sonnet-4`) |

## Channel Configuration

All channels share these common options:

| Option | Type | Description |
|--------|------|-------------|
| `enabled` | boolean | Enable this channel |
| `dmPolicy` | `'pairing'` \| `'allowlist'` \| `'open'` | Access control mode |
| `allowedUsers` | string[] | User IDs/numbers for allowlist mode |

### DM Policies

- **`pairing`** (recommended): New users get a code, approve with `lettabot pairing approve`
- **`allowlist`**: Only specified user IDs can message
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

## Environment Variables

Environment variables override config file values:

| Env Variable | Config Equivalent |
|--------------|-------------------|
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

See [SKILL.md](../SKILL.md) for complete environment variable reference.

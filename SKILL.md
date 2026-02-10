---
name: lettabot
description: Set up and run LettaBot - a multi-channel AI assistant for Telegram, Slack, Discord, WhatsApp, and Signal. Supports both interactive wizard and non-interactive (agent-friendly) configuration.
---

# LettaBot Setup

Multi-channel AI assistant with persistent memory across Telegram, Slack, Discord, WhatsApp, and Signal.

## Quick Setup (Agent-Friendly)

For non-interactive setup (ideal for coding agents):

```bash
# 1. Clone and install
git clone https://github.com/letta-ai/lettabot.git
cd lettabot
npm install
npm run build
npm link

# 2. Configure required variables
export LETTA_API_KEY="letta_..."        # From app.letta.com

# 3. Configure channel (example: Telegram)
export TELEGRAM_BOT_TOKEN="123456:ABC-DEF..."  # From @BotFather

# 4. Run non-interactive setup
lettabot onboard --non-interactive

# 5. Start the bot
lettabot server
```

**Safe defaults used if not set:**
- `LETTA_BASE_URL`: `https://api.letta.com`
- `LETTA_AGENT_NAME`: `"lettabot"`
- Model: selected during `lettabot onboard` or changed with `lettabot model set <handle>`
- `*_DM_POLICY`: `"pairing"` (requires approval before messaging)
- `WHATSAPP_SELF_CHAT_MODE`: `true` (only "Message Yourself" chat)
- `SIGNAL_SELF_CHAT_MODE`: `true` (only "Note to Self")

The setup will show which defaults are being used and validate safety-critical settings.

## Interactive Setup

For human-friendly setup with wizard:

```bash
lettabot onboard
```

The wizard will guide you through:
- Letta API authentication (OAuth or API key)
- Agent selection/creation
- Channel configuration (Telegram, Slack, Discord, WhatsApp, Signal)

## Environment Variables

### Authentication

| Variable | Description | Default |
|----------|-------------|---------|
| `LETTA_API_KEY` | API key from app.letta.com | Required (unless self-hosted) |
| `LETTA_BASE_URL` | API endpoint | `https://api.letta.com` |

### Agent Selection

| Variable | Description | Default |
|----------|-------------|---------|
| `LETTA_AGENT_ID` | Use existing agent (skip agent creation) | Creates new agent |
| `LETTA_AGENT_NAME` | Name for new agent | `"lettabot"` |
| ~~`LETTA_MODEL`~~ | *Removed* - model is set on the agent server-side. Use `lettabot model set <handle>`. | - |

### Telegram

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather | ✅ | - |
| `TELEGRAM_DM_POLICY` | Access control: `pairing` \| `allowlist` \| `open` | ❌ | `pairing` |
| `TELEGRAM_ALLOWED_USERS` | Comma-separated user IDs (if dmPolicy=allowlist) | ❌ | - |

### Slack (Socket Mode)

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (xoxb-...) | ✅ | - |
| `SLACK_APP_TOKEN` | App-Level Token (xapp-...) for Socket Mode | ✅ | - |
| `SLACK_APP_NAME` | Custom app name | ❌ | `LETTA_AGENT_NAME` or `"LettaBot"` |
| `SLACK_DM_POLICY` | Access control: `pairing` \| `allowlist` \| `open` | ❌ | `pairing` |
| `SLACK_ALLOWED_USERS` | Comma-separated Slack user IDs (if dmPolicy=allowlist) | ❌ | - |

**Setup Slack app:** See [Slack Setup Wizard](./src/setup/slack-wizard.ts) or run `lettabot onboard` for guided setup.

### Discord

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `DISCORD_BOT_TOKEN` | Bot token from discord.com/developers/applications | ✅ | - |
| `DISCORD_DM_POLICY` | Access control: `pairing` \| `allowlist` \| `open` | ❌ | `pairing` |
| `DISCORD_ALLOWED_USERS` | Comma-separated Discord user IDs (if dmPolicy=allowlist) | ❌ | - |

**Setup Discord bot:** See [docs/discord-setup.md](./docs/discord-setup.md)

### WhatsApp

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `WHATSAPP_ENABLED` | Enable WhatsApp: `true` \| `false` | ✅ | - |
| `WHATSAPP_SELF_CHAT_MODE` | Self-chat mode: `true` (personal) \| `false` (dedicated) | ✅ | `true` (safe) |
| `WHATSAPP_DM_POLICY` | Access control: `pairing` \| `allowlist` \| `open` | ❌ | `pairing` |
| `WHATSAPP_ALLOWED_USERS` | Comma-separated phone numbers with + (if dmPolicy=allowlist) | ❌ | - |

**CRITICAL - Read Before Enabling:**
- `WHATSAPP_SELF_CHAT_MODE=true` (personal number): Only responds to "Message Yourself" chat ✅ SAFE
- `WHATSAPP_SELF_CHAT_MODE=false` (dedicated bot number): Responds to ALL incoming messages ⚠️ USE WITH CAUTION
- Default is `true` for safety - bot will NOT message your contacts unless you explicitly set to `false`

**First-Time Setup - QR Code Warning:**
- QR code prints to console when `lettabot server` runs for the first time
- **DO NOT background the server** until after QR code is scanned
- **AI agents using Letta Code or similar**: Output may be truncated! If QR code is not visible:
  1. Tell the agent to stop the server
  2. Run `lettabot server` yourself in a terminal
  3. Scan the QR code when it appears
  4. After pairing, the agent can manage the server normally
- Alternative: Instruct agent "Run lettabot server in FOREGROUND and do NOT background it"
- After initial pairing completes, server can be backgrounded in future runs

### Signal

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `SIGNAL_PHONE_NUMBER` | Your phone number (with +) | ✅ | - |
| `SIGNAL_DM_POLICY` | Access control: `pairing` \| `allowlist` \| `open` | ❌ | `pairing` |
| `SIGNAL_ALLOWED_USERS` | Comma-separated phone numbers with + (if dmPolicy=allowlist) | ❌ | - |

**Setup:** Requires Signal CLI - see [signal-cli documentation](https://github.com/AsamK/signal-cli).

## Channel-Specific Setup

### Telegram Bot Setup

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow prompts
3. Copy the token (format: `123456:ABC-DEF...`)
4. Set `TELEGRAM_BOT_TOKEN` environment variable

### Slack App Setup (Interactive)

For Socket Mode (required for real-time messages):

```bash
lettabot onboard
# Select "Slack" → "Guided setup"
```

This uses a manifest to pre-configure:
- Socket Mode
- 5 bot scopes (app_mentions:read, chat:write, im:*)
- 2 event subscriptions (app_mention, message.im)

### Slack App Setup (Manual)

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Create app from manifest (see `src/setup/slack-wizard.ts` for manifest YAML)
3. Install to workspace → copy Bot Token (`xoxb-...`)
4. Enable Socket Mode → generate App Token (`xapp-...`)
5. Set both tokens in environment

## Access Control

Each channel supports three DM policies:

- **`pairing`** (recommended): Users get a code, you approve via `lettabot pairing approve <channel> <code>`
- **`allowlist`**: Only specified user IDs can message
- **`open`**: Anyone can message (not recommended)

## Group Settings (Optional)

Group settings apply to Telegram, Slack, Discord, WhatsApp, and Signal.

**YAML fields (per channel under `channels.<name>`):**
- `groupDebounceSec`: Debounce seconds for group batching (default: 5)
- `groupPollIntervalMin`: Deprecated (minutes)
- `instantGroups`: Group IDs that bypass batching
- `listeningGroups`: Group IDs where the bot observes and only replies when mentioned

**Environment variables (non-interactive onboarding):**
- `<CHANNEL>_GROUP_DEBOUNCE_SEC` (seconds, e.g. `5`)
- `<CHANNEL>_GROUP_POLL_INTERVAL_MIN` (deprecated, use `_GROUP_DEBOUNCE_SEC` instead)
- `<CHANNEL>_INSTANT_GROUPS` (comma-separated)
- `<CHANNEL>_LISTENING_GROUPS` (comma-separated)

Example:

```yaml
channels:
  slack:
    enabled: true
    botToken: xoxb-...
    appToken: xapp-...
    groupDebounceSec: 5
    instantGroups: ["C0123456789"]
    listeningGroups: ["C0987654321"]
```

## Configuration File

After onboarding, config is saved to `~/.lettabot/config.yaml`:

```yaml
server:
  baseUrl: https://api.letta.com
  apiKey: letta_...
  agentId: agent-...

channels:
  telegram:
    enabled: true
    botToken: 123456:ABC-DEF...
    dmPolicy: pairing
  
  slack:
    enabled: true
    botToken: xoxb-...
    appToken: xapp-...
    dmPolicy: pairing
```

Edit this file directly or re-run `lettabot onboard` to reconfigure.

## Commands

```bash
# Setup
lettabot onboard                    # Interactive wizard
lettabot onboard --non-interactive  # Env-based setup (agent-friendly)

# Run
lettabot server                     # Start bot server

# Manage
lettabot pairing list               # List pending pairing requests
lettabot pairing approve <channel> <code>  # Approve user
lettabot skills                     # Enable/disable skills

# Scheduling
lettabot cron list                  # List scheduled tasks
lettabot cron add "Daily standup at 9am" "0 9 * * *"  # Add cron job
```

## Troubleshooting

### "Module not found" errors

Make sure you've run `npm run build` after installing or pulling updates.

### Telegram bot not responding

1. Check token is correct: `curl https://api.telegram.org/bot<TOKEN>/getMe`
2. Ensure bot is started: `lettabot server` should show "Connected to Telegram"
3. Check access control: User may need pairing approval

### Slack not receiving messages

1. Verify Socket Mode is enabled in Slack app settings
2. Check both tokens are set: `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`
3. Ensure event subscriptions are configured (app_mention, message.im)

### WhatsApp QR code not appearing

1. Make sure Signal Desktop is closed (conflicts with baileys)
2. Delete `~/.wwebjs_auth` if previously used different library
3. Check no other WhatsApp Web sessions are active

## Example: Agent Setup Flow

For coding agents helping users set up LettaBot:

```bash
# 1. Clone and build
git clone https://github.com/letta-ai/lettabot.git
cd lettabot
npm install && npm run build && npm link

# 2. Get Letta API key
# Guide user to app.letta.com → API Keys → Create Key

# 3. Get Telegram bot token
# Guide user to @BotFather → /newbot → follow prompts

# 4. Set environment variables
export LETTA_API_KEY="letta_..."
export TELEGRAM_BOT_TOKEN="123456:ABC-DEF..."
# Defaults will be used for LETTA_BASE_URL, agent name, and DM policy

# 5. Run non-interactive setup
lettabot onboard --non-interactive

# 6. Instruct user to start server
# DON'T start server automatically - user must see output
echo "Setup complete! Run 'lettabot server' to start the bot."
```

**For WhatsApp (QR code required on first run):**
```bash
export LETTA_API_KEY="letta_..."
export WHATSAPP_ENABLED="true"
export WHATSAPP_SELF_CHAT_MODE="true"  # REQUIRED: true=personal number, false=dedicated bot
lettabot onboard --non-interactive

# CRITICAL: Do NOT auto-start the server!
# Tell user: "WhatsApp setup complete. Please run 'lettabot server' in your terminal."
# User must see QR code in console output to scan it.
# After first pairing, server can be managed normally.
```

**Agent Instructions:**
If an AI agent is helping with setup and WhatsApp is configured:
1. Complete `lettabot onboard --non-interactive`
2. **DO NOT** run `lettabot server` automatically
3. Tell user: "Setup complete! Please run `lettabot server` in a terminal to see the WhatsApp QR code"
4. Wait for user confirmation that QR was scanned
5. After confirmation, server can be managed normally

The agent can verify success by checking:
- `lettabot server` output shows "Connected to Telegram" (or other channel)
- Config file exists at `~/.lettabot/config.yaml`
- User can message bot on configured channel(s)

## Self-Hosted Letta

To use a self-hosted Letta server:

```bash
# Run Letta Docker
docker run -v ~/.letta/.persist/pgdata:/var/lib/postgresql/data \
  -p 8283:8283 \
  -e OPENAI_API_KEY="your_openai_api_key" \
  letta/letta:latest

# Configure LettaBot
export LETTA_BASE_URL="http://localhost:8283"
export LETTA_API_KEY="sk-..."  # From Letta admin panel

lettabot onboard --non-interactive
```

## Skills Integration

LettaBot supports loading skills from:
- **Clawdhub** ([clawdhub.com](https://clawdhub.com))
- **skills.sh** repositories
- Local `.skills/` directory

```bash
# Install skill from Clawdhub
npx molthub@latest install sonoscli

# Connect to LettaBot
lettabot skills
# Space to toggle, Enter to confirm

# Skills will be available to agent
```

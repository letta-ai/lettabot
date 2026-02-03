# LettaBot

Your personal AI assistant that remembers everything across **Telegram, Slack, Discord, WhatsApp, and Signal**. Powered by the [Letta Code SDK](https://github.com/letta-ai/letta-code-sdk).

<img width="750" alt="lettabot-preview" src="https://github.com/user-attachments/assets/9f01b845-d5b0-447b-927d-ae15f9ec7511" />

## Features

- **Multi-Channel** - Chat seamlessly across Telegram, Slack, Discord, WhatsApp, and Signal
- **Unified Memory** - Single agent remembers everything from all channels
- **Persistent Memory** - Agent remembers conversations across sessions (days/weeks/months)
- **Local Tool Execution** - Agent can read files, search code, run commands on your machine
- **Voice Messages** - Automatic transcription via OpenAI Whisper
- **Heartbeat** - Periodic check-ins where the agent reviews tasks
- **Scheduling** - Agent can create one-off reminders and recurring tasks
- **Streaming Responses** - Real-time message updates as the agent thinks

## Quick Start

### Prerequisites

- Node.js 20+
- A Letta API key from [app.letta.com](https://app.letta.com) (or a running [Letta Docker server](https://docs.letta.com/guides/docker/))
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

### Install

```bash
# Clone the repository
git clone https://github.com/letta-ai/lettabot.git
cd lettabot

# Install dependencies
npm install

# Build and link the CLI globally
npm run build
npm link
```

### Update

```bash
# Pull latest changes
git pull origin main

# Reinstall dependencies and rebuild
npm install
npm run build
```

#### Optional: Run a Letta Docker server 
You can use `lettabot` with a Docker server with: 
```
docker run \
  -v ~/.letta/.persist/pgdata:/var/lib/postgresql/data \
  -p 8283:8283 \
  -e OPENAI_API_KEY="your_openai_api_key" \
  letta/letta:latest
```
See the [documentation](https://docs.letta.com/guides/docker/) for more details on running with Docker. 

### Setup

**Option 1: AI-Assisted Setup (Recommended)**

Paste this into Letta Code, Claude Code, Cursor, or any AI coding assistant:

```
Clone https://github.com/letta-ai/lettabot, read the SKILL.md
for setup instructions, and help me configure Telegram.
```

You'll need:
- A Letta API key from [app.letta.com](https://app.letta.com) (or a [Letta Docker server](https://docs.letta.com/guides/docker/))
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

The AI will handle cloning, installing, and configuration autonomously.

**Option 2: Interactive Wizard**

For manual step-by-step setup:

```bash
git clone https://github.com/letta-ai/lettabot.git
cd lettabot
npm install && npm run build && npm link
lettabot onboard
```

### Run

```bash
lettabot server
```

That's it! Message your bot on Telegram.

> **Note:** For detailed environment variable reference and multi-channel setup, see [SKILL.md](./SKILL.md)

## Voice Messages

LettaBot can transcribe voice messages using OpenAI Whisper. Voice messages are automatically converted to text and sent to the agent with a `[Voice message]:` prefix.

**Supported channels:** Telegram, WhatsApp, Signal, Slack, Discord

### Configuration

Add your OpenAI API key to `lettabot.config.yaml`:

```yaml
transcription:
  provider: openai
  apiKey: sk-...
  model: whisper-1  # optional, defaults to whisper-1
```

Or set via environment variable:

```bash
export OPENAI_API_KEY=sk-...
```

If no API key is configured, voice messages are silently ignored.

## Skills
LettaBot is compatible with [skills.sh](https://skills.sh) and [Clawdhub](https://clawdhub.com/). 

```bash
# from Clawdhub
npx molthub@latest install sonoscli

# from skills.sh
npm run skills:add supabase/agent-skills

# connect to LettaBot
lettabot skills

◆  Enable skills (space=toggle, enter=confirm):
│  ◻ ── ClawdHub Skills ── (~/clawd/skills)
│  ◻ 🦞 sonoscli
│  ◻ ── Vercel Skills ── (~/.agents/skills)
│  ◻ 🔼 supabase/agent-skills
│  ◻ ── Built-in Skills ──
│  ◻ 📦 1password
│  ◻ ...

# View LettaBot skills
lettabot skills status
```

### Home Assistant

Control your smart home with LettaBot:

```bash
# 1. Install the skill from ClawdHub
npx clawdhub@latest install homeassistant

# 2. Enable the skill
lettabot skills sync
# Select "homeassistant" from the list

# 3. Configure credentials (see skill docs for details)
# You'll need: HA URL + Long-Lived Access Token
```

Then ask your bot things like:
- "Turn off the living room lights"
- "What's the temperature in the bedroom?"
- "Set the thermostat to 72"

## CLI Commands

| Command | Description |
|---------|-------------|
| `lettabot onboard` | Interactive setup wizard |
| `lettabot server` | Start the bot server |
| `lettabot configure` | View and edit configuration |
| `lettabot skills status` | Show enabled and available skills |
| `lettabot destroy` | Delete all local data and start fresh |
| `lettabot help` | Show help |


## Channel Setup

LettaBot uses a **single agent with a single conversation** across all channels:

```
Telegram ──┐
Slack ─────┤
Discord ───┼──→ ONE AGENT ──→ ONE CONVERSATION
WhatsApp ──┤    (memory)      (chat history)
Signal ────┘
```

- Start a conversation on Telegram
- Continue it on Slack
- Pick it up on WhatsApp
- The agent remembers everything!

| Channel | Guide | Requirements |
|---------|-------|--------------|
| Telegram | [Setup Guide](docs/getting-started.md) | Bot token from @BotFather |
| Slack | [Setup Guide](docs/slack-setup.md) | Slack app with Socket Mode |
| Discord | [Setup Guide](docs/discord-setup.md) | Discord bot + Message Content Intent |
| WhatsApp | [Setup Guide](docs/whatsapp-setup.md) | Phone with WhatsApp |
| Signal | [Setup Guide](docs/signal-setup.md) | signal-cli + phone number |

At least one channel is required. Telegram is the easiest to start with.

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message and help |
| `/status` | Show current session info |
| `/heartbeat` | Manually trigger a heartbeat check-in |

## Background Tasks (Heartbeats & Cron)

Heartbeats and cron jobs run in **Silent Mode** - the agent's text responses are NOT automatically sent to users during these background tasks. This is intentional: the agent decides when something is worth interrupting you for.

To send messages during silent mode, the agent must explicitly use the CLI:

```bash
lettabot-message send --text "Hey, I found something interesting!"
```

The agent sees a clear `[SILENT MODE]` banner when triggered by heartbeats/cron, along with instructions on how to use the CLI.

**Requirements for background messaging:**
- The **Bash tool must be enabled** for the agent to run the CLI
- A user must have messaged the bot at least once (to establish a delivery target)

If your agent isn't sending messages during heartbeats, check the [ADE](https://app.letta.com) to see what the agent is doing and whether it's attempting to use `lettabot-message`.

## Connect to Letta Code 
Any LettaBot agent can also be directly chatted with through [Letta Code](https://github.com/letta-ai/letta-code). Use the `/status` command to find your `agent_id`, and run: 
```sh
letta --agent <agent_id>
```

## Security

### Network Architecture

**LettaBot uses outbound connections only** - no public URL or gateway required:

| Channel | Connection Type | Exposed Ports |
|---------|-----------------|---------------|
| Telegram | Long-polling (outbound HTTP) | None |
| Slack | Socket Mode (outbound WebSocket) | None |
| Discord | Gateway (outbound WebSocket) | None |
| WhatsApp | Outbound WebSocket via Baileys | None |
| Signal | Local daemon on 127.0.0.1 | None |

### Tool Execution

By default, the agent is restricted to **read-only** operations:
- `Read`, `Glob`, `Grep` - File exploration
- `web_search` - Internet queries
- `conversation_search` - Search past messages

### Access Control

LettaBot supports pairing-based access control. When `TELEGRAM_DM_POLICY=pairing`:
1. Unauthorized users get a pairing code
2. You approve codes via `lettabot pairing approve telegram <CODE>`
3. Approved users can then chat with the bot

## Development

```bash
# Run in development mode (auto-reload)
npm run dev

# Build for production
npm run build

# Start production server
lettabot server
```

## Troubleshooting

### WhatsApp

**Session errors / "Bad MAC" messages**
These are normal Signal Protocol renegotiation messages. They're noisy but harmless.

**Messages going to wrong chat**
Clear the session and re-link:
```bash
rm -rf ./data/whatsapp-session
lettabot server  # Scan QR again
```

### Signal

**Port 8090 already in use**
```bash
SIGNAL_HTTP_PORT=8091
```

### General

**Agent not responding**
Delete the agent store to create a fresh agent:
```bash
lettabot destroy 
```

**Heartbeat/cron messages not reaching my chat**
Heartbeats and cron jobs run in "Silent Mode" - the agent's text output is private and not auto-delivered. To send messages during background tasks, the agent must run:
```bash
lettabot-message send --text "Your message here"
```
Check the [ADE](https://app.letta.com) to see if your agent is attempting to use this command. Common issues:
- Bash tool not enabled (agent can't run CLI commands)
- Agent doesn't understand it needs to use the CLI
- No delivery target set (user never messaged the bot first)

## Documentation

- [Getting Started](docs/getting-started.md)
- [Slack Setup](docs/slack-setup.md)
- [Discord Setup](docs/discord-setup.md)
- [WhatsApp Setup](docs/whatsapp-setup.md)
- [Signal Setup](docs/signal-setup.md)

## Acknowledgement
Some skills were adapted from [Moltbot](https://github.com/moltbot/moltbot). 

## License

Apache-2.0

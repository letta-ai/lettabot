# Getting Started

Get LettaBot running in 5 minutes.

## Prerequisites

- Node.js 20+ 
- npm or yarn
- A Telegram account
- A Letta account ([app.letta.com](https://app.letta.com))

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/letta-ai/lettabot.git
cd lettabot
npm install
```

### 2. Create a Telegram Bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts
3. Copy the **bot token** (looks like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

### 3. Get a Letta API Key

1. Go to [app.letta.com](https://app.letta.com)
2. Sign in or create an account
3. Go to Settings > API Keys
4. Create a new API key and copy it

### 4. Configure LettaBot

**Option A: Interactive Setup (Recommended)**

```bash
npm run build
npm link
lettabot onboard
```

This will walk you through configuration interactively.

**Option B: Manual Setup**

```bash
cp .env.example .env
```

Edit `.env`:
```bash
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
LETTA_API_KEY=your_letta_api_key
```

### 5. Start the Bot

```bash
npm run dev
```

You should see:
```
Starting LettaBot...
Bot started as @your_bot_name
Allowed users: all
```

### 6. Chat with Your Bot

Open Telegram and message your bot. Try:
- "Hello!"
- "What can you help me with?"
- "Remember that my favorite color is blue"

## Configuration Options

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | From @BotFather |
| `LETTA_API_KEY` | Yes | From app.letta.com |
| `ALLOWED_USERS` | No | Comma-separated Telegram user IDs to allow |
| `WORKING_DIR` | No | Base directory for agent workspaces (default: `/tmp/lettabot`) |
| `LETTA_CLI_PATH` | No | Custom path to letta CLI |

## Restricting Access

To limit who can use your bot, set `ALLOWED_USERS`:

```bash
# Find your Telegram user ID by messaging @userinfobot
ALLOWED_USERS=123456789,987654321
```

## Next Steps

- [Commands Reference](./commands.md) - Learn all bot commands
- [Gmail Integration](./gmail-pubsub.md) - Set up email notifications
- [Slack Setup](./slack-setup.md) - Add Slack channel
- [Discord Setup](./discord-setup.md) - Add Discord channel

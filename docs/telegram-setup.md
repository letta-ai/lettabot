# Telegram Setup for LettaBot

This guide walks you through setting up Telegram as a channel for LettaBot.

## Overview

LettaBot connects to Telegram using the **Bot API** with long-polling:
- No public URL required (no webhook needed)
- Works behind firewalls
- Automatic reconnection handling

## Prerequisites

- A Telegram account
- LettaBot installed and configured with at least `LETTA_API_KEY`

## Step 1: Create a Bot with BotFather

1. Open Telegram and search for **@BotFather**
2. Start a chat and send `/newbot`
3. Choose a **display name** for your bot (e.g., `LettaBot`)
4. Choose a **username** ending in `bot` (e.g., `my_letta_bot`)
5. BotFather will respond with your **bot token**

   > **Important**: Copy this token immediately. It looks like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`

## Step 2: Configure LettaBot

Run the onboarding wizard and select Telegram:

```bash
lettabot onboard
```

Or add directly to your `lettabot.yaml`:

```yaml
channels:
  telegram:
    enabled: true
    token: "123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
    dmPolicy: pairing  # or 'allowlist' or 'open'
```

Or use environment variables:

```bash
export TELEGRAM_BOT_TOKEN="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
export TELEGRAM_DM_POLICY="pairing"
```

## Step 3: Start LettaBot

```bash
lettabot server
```

You should see:
```
Registered channel: Telegram
[Telegram] Bot started as @your_bot_username
[Telegram] DM policy: pairing
```

## Step 4: Test the Integration

1. Open Telegram and search for your bot's username
2. Click **Start** or send `/start`
3. If using pairing mode, you'll receive a pairing code
4. Approve the code: `lettabot pairing approve telegram ABCD1234`
5. Send a message: `Hello!`
6. The bot should respond

## Access Control

LettaBot supports three DM policies for Telegram:

### Pairing (Default)
```yaml
dmPolicy: pairing
```
- New users receive a pairing code
- Approve with: `lettabot pairing approve telegram <CODE>`
- Most secure for personal use

### Allowlist
```yaml
dmPolicy: allowlist
allowedUsers:
  - 123456789  # Telegram user IDs
```
- Only specified users can interact
- Find your user ID: Message @userinfobot or check the bot logs

### Open
```yaml
dmPolicy: open
```
- Anyone can message the bot
- Not recommended for personal bots

## Bot Commands

LettaBot responds to these Telegram commands:

| Command | Description |
|---------|-------------|
| `/start` | Welcome message and help |
| `/help` | Show available commands |
| `/status` | Show current bot status |
| `/heartbeat` | Trigger a heartbeat (silent) |

## Features

### Voice Messages

Send a voice message to have it transcribed and processed:

1. Requires `OPENAI_API_KEY` for transcription
2. The bot transcribes and responds to the content
3. Configure in `lettabot.yaml`:
   ```yaml
   transcription:
     provider: openai
     apiKey: sk-...  # Optional: uses OPENAI_API_KEY env var
   ```

### Attachments

The bot can receive and process:
- Photos
- Documents
- Videos
- Audio files
- Stickers
- Animations (GIFs)

Attachments are downloaded to `/tmp/lettabot/attachments/telegram/` and the agent can view images using its Read tool.

### Long Messages

Telegram limits messages to 4096 characters. LettaBot automatically splits longer responses into multiple messages at paragraph or line boundaries, so no content is lost.

### Reactions

LettaBot can react to messages using the `lettabot-react` CLI:

```bash
# React to the most recent message
lettabot-react add --emoji "eyes"

# React to a specific message
lettabot-react add --emoji "thumbsup" --channel telegram --chat 123456789 --message 42
```

Telegram supports a limited set of reaction emojis. Common ones:
`thumbsup`, `heart`, `fire`, `eyes`, `clap`, `tada`

## Troubleshooting

### Bot not responding

1. **Check the token**: Make sure you copied the full token from BotFather
2. **Check pairing**: If using pairing mode, approve new users with `lettabot pairing list telegram`
3. **Check logs**: Look for errors in the console output

### "Unauthorized" error

Your bot token is invalid:
1. Go back to @BotFather
2. Send `/mybots` and select your bot
3. Click **API Token** to see the current token
4. If needed, use **Revoke current token** to generate a new one

### Bot responds slowly

This is normal - the bot needs to:
1. Receive your message
2. Send it to the Letta agent
3. Wait for the agent to respond
4. Send the response back

First responses may take longer as the agent "wakes up".

### Voice messages not working

1. Make sure `OPENAI_API_KEY` is set
2. Check the logs for transcription errors
3. Verify your OpenAI account has API access

### Rate limiting

If the bot stops responding temporarily, Telegram may be rate-limiting requests. Wait a few minutes and try again.

## Security Notes

- **Bot tokens** should be kept secret - never commit them to git
- Use `dmPolicy: pairing` or `allowlist` in production
- The bot can only see messages sent directly to it
- Group functionality is not currently supported

## Cross-Channel Memory

Since LettaBot uses a single agent across all channels:
- Messages you send on Telegram continue the same conversation as Slack/Discord
- The agent remembers context from all channels
- You can start a conversation on Telegram and continue it on another channel

## Next Steps

- [Slack Setup](./slack-setup.md)
- [Discord Setup](./discord-setup.md)
- [WhatsApp Setup](./whatsapp-setup.md)
- [Signal Setup](./signal-setup.md)

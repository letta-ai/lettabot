# WhatsApp Setup for LettaBot

This guide walks you through setting up WhatsApp as a channel for LettaBot.

## Overview

LettaBot connects to WhatsApp using **Baileys**, which uses the WhatsApp Web protocol. This means:
- Uses your personal WhatsApp account (or a dedicated number)
- No WhatsApp Business API required
- Free to use
- Requires QR code scan on first setup

## Prerequisites

- A phone with WhatsApp installed
- LettaBot installed and configured with at least `LETTA_API_KEY`

## Step 1: Enable WhatsApp in Configuration

Add to your `lettabot.yaml` or set environment variables:

```yaml
# lettabot.yaml
channels:
  whatsapp:
    enabled: true
    selfChatMode: true    # IMPORTANT: See below
    dmPolicy: pairing     # or 'allowlist' or 'open'
```

Or via environment variables:

```bash
# WhatsApp Configuration
WHATSAPP_ENABLED=true
WHATSAPP_SELF_CHAT_MODE=true  # CRITICAL - see below
WHATSAPP_DM_POLICY=pairing

# Optional: Restrict to specific phone numbers (if dmPolicy=allowlist)
# WHATSAPP_ALLOWED_USERS=+15551234567,+15559876543
```

### Self-Chat Mode (Critical Safety Setting)

**`selfChatMode: true`** (default, recommended for personal numbers):
- Bot ONLY responds to "Message Yourself" chat
- Bot will NOT message your contacts
- Safe to use with your personal WhatsApp number

**`selfChatMode: false`** (for dedicated bot numbers):
- Bot responds to ALL incoming messages
- Use ONLY with a dedicated phone number
- Risk of bot messaging your contacts if misconfigured

> **Warning:** If using your personal WhatsApp number, ALWAYS keep `selfChatMode: true` to prevent the bot from accidentally messaging your contacts.

## Step 2: Start LettaBot

```bash
npm run dev
```

You'll see output like:
```
Registered channel: WhatsApp
[WhatsApp] Scan the QR code above to login
```

A QR code will be displayed in your terminal.

## Step 3: Scan the QR Code

1. Open WhatsApp on your phone
2. Go to **Settings** → **Linked Devices**
3. Tap **"Link a Device"**
4. Scan the QR code displayed in your terminal

Once connected, you'll see:
```
[WhatsApp] Connected!
```

## Step 4: Test the Integration

1. From another phone (or WhatsApp Web with a different account), send a message to the number you just linked
2. The bot should respond

Or test with yourself:
1. Open a note-to-self chat (message yourself)
2. Send a test message

## Session Persistence

After the first QR scan, your session is saved to disk (default: `./data/whatsapp-session/`). 

On subsequent restarts:
- No QR scan needed
- Bot reconnects automatically
- If session expires, a new QR code will be shown

## Restricting Access

To restrict which phone numbers can interact with the bot:

```bash
# Include country code with + prefix
WHATSAPP_ALLOWED_USERS=+15551234567,+15559876543
```

**Note**: Only DMs are restricted. Group messages may still be received (but not responded to unless the sender is allowed).

## Cross-Channel Memory

Since LettaBot uses a single agent across all channels:
- Messages from WhatsApp continue the same conversation as Telegram/Slack
- The agent remembers context from all channels
- Start a conversation on Telegram, continue it on WhatsApp

## Important Limitations

### Message Editing
WhatsApp doesn't support editing messages. When the bot streams a long response, it will send the full message at once rather than updating incrementally.

### Rate Limits
WhatsApp has strict rate limits to prevent spam:
- Don't send too many messages too quickly
- Avoid automated bulk messaging
- Risk of account ban if abused

### Personal Account
This uses your personal WhatsApp account:
- Messages appear as coming from your number
- Consider using a dedicated phone number for the bot
- Your contacts will see the bot as "you"
- **Use `selfChatMode: true`** to prevent bot from messaging your contacts

### Multi-Device Limitations
- WhatsApp allows up to 4 linked devices
- The bot counts as one linked device
- If you unlink the bot, you'll need to scan the QR code again

## Media Support

LettaBot supports receiving images, documents, and voice messages:

- **Images**: Downloaded and shown to the agent (agent can view using Read tool)
- **Voice messages**: Automatically transcribed via OpenAI Whisper
- **Documents**: Downloaded with metadata shown to agent

Configure attachment handling in `lettabot.yaml`:

```yaml
attachments:
  maxMB: 20          # Max file size to download (default: 20MB)
  maxAgeDays: 14     # Auto-delete after N days (default: 14)
```

Attachments are stored in `/tmp/lettabot/attachments/` by default.

## Running in Production

For production deployments:

1. **Use a dedicated phone number** - Don't use your personal WhatsApp
2. **Persistent storage** - Make sure `WHATSAPP_SESSION_PATH` points to persistent storage
3. **Monitor reconnections** - The bot auto-reconnects, but check logs for issues
4. **Backup session** - Back up the session folder to avoid re-scanning QR codes

## Troubleshooting

### QR Code Not Showing

If no QR code appears:
- Check that `WHATSAPP_ENABLED=true` is set
- Look for error messages in the console
- Make sure you have a terminal that supports QR code display

### "Connection Closed" Errors

This usually means:
- WhatsApp Web session was logged out from your phone
- Network connectivity issues
- WhatsApp servers are temporarily unavailable

The bot will automatically try to reconnect.

### "Logged Out" State

If you see "logged out" in the logs:
1. Delete the session folder: `rm -rf ./data/whatsapp-session`
2. Restart LettaBot
3. Scan the new QR code

### Messages Not Being Received

1. Check `selfChatMode` setting - if `true`, only "Message Yourself" works
2. Make sure the sender's number is allowed by `dmPolicy` setting
3. If `dmPolicy: allowlist`, check `allowedUsers` list
4. Look for errors in the console

### Bot Responding to Old Messages

On first connection, the bot might receive some historical messages. This is normal WhatsApp behavior. The bot will only respond to new messages going forward.

## Security Notes

- **Session files** contain authentication data - keep them secure
- Don't share your session folder
- Use `WHATSAPP_ALLOWED_USERS` to restrict who can interact with the bot
- Consider the privacy implications of using a personal number

## Directory Structure

```
data/
└── whatsapp-session/
    ├── creds.json         # Authentication credentials
    ├── app-state-sync-*   # App state
    └── ...                # Other session data
```

## Next Steps

- [Slack Setup](./slack-setup.md)
- [Discord Setup](./discord-setup.md)
- [Signal Setup](./signal-setup.md)

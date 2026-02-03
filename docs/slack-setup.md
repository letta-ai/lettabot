# Slack Setup for LettaBot

This guide walks you through setting up Slack as a channel for LettaBot.

## Overview

LettaBot connects to Slack using **Socket Mode**, which means:
- No public URL required (no ngrok needed)
- Works behind firewalls
- Real-time bidirectional communication

## Prerequisites

- A Slack workspace where you have permission to install apps
- LettaBot installed and configured with at least `LETTA_API_KEY`

## Step 1: Create a Slack App

1. Go to **https://api.slack.com/apps**
2. Click **"Create New App"**
3. Choose **"From scratch"**
4. Enter:
   - **App Name**: `LettaBot` (or your preferred name)
   - **Workspace**: Select your workspace
5. Click **"Create App"**

## Step 2: Enable Socket Mode

Socket Mode lets your bot connect without exposing a public endpoint.

1. In the left sidebar, click **"Socket Mode"**
2. Toggle **"Enable Socket Mode"** → ON
3. You'll be prompted to create an **App-Level Token**:
   - **Token Name**: `socket-token`
   - **Scopes**: Add `connections:write`
   - Click **"Generate"**
4. **Copy the token** (starts with `xapp-`)
   
   This is your `SLACK_APP_TOKEN`

## Step 3: Set Bot Permissions

1. In the left sidebar, go to **"OAuth & Permissions"**
2. Scroll to **"Scopes"** → **"Bot Token Scopes"**
3. Add these scopes:

| Scope | Purpose |
|-------|---------|
| `app_mentions:read` | React when someone @mentions your bot |
| `chat:write` | Send messages |
| `im:history` | Read DM message history |
| `im:read` | View DM channel info |
| `im:write` | Start DM conversations |

## Step 4: Enable Events

1. In the left sidebar, go to **"Event Subscriptions"**
2. Toggle **"Enable Events"** → ON
3. Scroll to **"Subscribe to bot events"**
4. Add these events:

| Event | Purpose |
|-------|---------|
| `app_mention` | Triggers when someone @mentions your bot in a channel |
| `message.im` | Triggers when someone DMs your bot |

5. Click **"Save Changes"**

> **Important**: If you add or change events after installing the app, you must reinstall it (Step 6) for changes to take effect. The token stays the same.

## Step 5: Configure App Home (Optional but Recommended)

1. In the left sidebar, go to **"App Home"**
2. Under **"Show Tabs"**, enable:
   - **Messages Tab** → ON (allows DMs to your bot)
   - Check **"Allow users to send Slash commands and messages from the messages tab"**

## Step 6: Install to Workspace

1. In the left sidebar, go to **"Install App"**
2. Click **"Install to Workspace"**
3. Review the permissions and click **"Allow"**
4. **Copy the Bot Token** (starts with `xoxb-`)

   This is your `SLACK_BOT_TOKEN`

## Step 7: Configure LettaBot

Add these to your `.env` file:

```bash
# Slack Configuration
SLACK_BOT_TOKEN=xoxb-your-bot-token-here
SLACK_APP_TOKEN=xapp-your-app-token-here

# Optional: Restrict to specific Slack user IDs
# SLACK_ALLOWED_USERS=U01234567,U98765432
```

## Step 8: Start LettaBot

```bash
npm run dev
```

You should see:
```
Registered channel: Slack
[Slack] Bot started in Socket Mode
```

## Step 9: Test the Integration

### Direct Message
1. In Slack, look for your bot under **Apps** in the left sidebar
2. Click on the bot to open a DM
3. Send a message: `Hello!`
4. The bot should respond

### Channel Mention
1. Invite your bot to a channel: `/invite @LettaBot`
2. Mention the bot: `@LettaBot what time is it?`
3. The bot should respond in the channel

### Thread Replies
- If you mention the bot in a thread, it will reply in that thread
- If you mention the bot in a channel (not a thread), it starts a new thread from your message

## Cross-Channel Memory

Since LettaBot uses a single agent across all channels:
- Messages you send on Slack continue the same conversation as Telegram
- The agent remembers context from both channels
- You can start a conversation on Telegram and continue it on Slack

## Restricting Access

To restrict which Slack users can interact with the bot:

1. Find user IDs:
   - Click on a user's profile in Slack
   - Click the **⋮** menu → **"Copy member ID"**
   - IDs look like `U01ABCD2EFG`

2. Add to `.env`:
   ```bash
   SLACK_ALLOWED_USERS=U01234567,U98765432
   ```

## Troubleshooting

### Bot not connecting

**Error**: "Socket Mode not enabled"
- Go to api.slack.com/apps → Your App → Socket Mode → Enable it

**Error**: "invalid_auth"
- Double-check your `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`
- Make sure you copied the full tokens including the `xoxb-` and `xapp-` prefixes

### Bot not responding to DMs

1. Go to **App Home** in your Slack app settings
2. Enable **"Messages Tab"**
3. Check **"Allow users to send messages from the messages tab"**
4. Reinstall the app if you changed these settings

### "Sending messages to this app has been turned off"

Even after enabling the Messages Tab and reinstalling, Slack may cache the old state:
1. **Refresh Slack**: Press `Cmd+R` (Mac) or `Ctrl+R` (Windows/Linux)
2. **Or restart Slack** entirely
3. If still stuck, remove the bot from your Apps sidebar and re-add it

### Bot not responding to @mentions

1. Go to **Event Subscriptions**
2. Make sure **"Enable Events"** is toggled ON
3. Make sure `app_mention` is listed under "Subscribe to bot events"
4. Click **"Save Changes"** at the bottom
5. Go to **OAuth & Permissions**
6. Make sure `app_mentions:read` scope is added
7. Reinstall the app: **Install App** → **Reinstall to Workspace**

> **Note**: Adding scopes only gives permission; you must also subscribe to events to receive them.

### "missing_scope" error

If you see a missing scope error:
1. Go to **OAuth & Permissions**
2. Add the missing scope
3. Go to **Install App** → **Reinstall to Workspace**

### Bot responds slowly

This is normal - the bot needs to:
1. Receive your message
2. Send it to the Letta agent
3. Wait for the agent to respond
4. Stream the response back

First responses may take longer as the agent "wakes up".

## Security Notes

- **Socket Mode tokens** (`xapp-`) should be kept secret
- **Bot tokens** (`xoxb-`) should be kept secret
- Use `SLACK_ALLOWED_USERS` in production to restrict access
- The bot can only see messages in channels it's invited to, or DMs sent directly to it

## Next Steps

- [WhatsApp Setup](./whatsapp-setup.md)
- [Discord Setup](./discord-setup.md)
- [Signal Setup](./signal-setup.md)

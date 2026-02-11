# Discord Setup for LettaBot

This guide walks you through setting up Discord as a channel for LettaBot.

## Overview

LettaBot connects to Discord using a **Bot Application** with the Gateway API:
- No public URL required (uses WebSocket connection)
- Works behind firewalls
- Real-time bidirectional communication

## Prerequisites

- A Discord server where you have permission to add bots
- LettaBot installed and configured with at least `LETTA_API_KEY`

## Step 1: Create a Discord Application

1. Go to **https://discord.com/developers/applications**
2. Click **"New Application"**
3. Enter a name (e.g., `LettaBot`)
4. Click **"Create"**

## Step 2: Create the Bot

1. In the left sidebar, click **"Bot"**
2. Click **"Reset Token"** (or "Add Bot" if this is new)
3. **Copy the token** - this is your `DISCORD_BOT_TOKEN`

   > **Important**: You can only see this token once. If you lose it, you'll need to reset it.

## Step 3: Enable Message Content Intent

This is required for the bot to read message content.

1. Still in the **"Bot"** section
2. Scroll down to **"Privileged Gateway Intents"**
3. Enable **"MESSAGE CONTENT INTENT"**
4. Click **"Save Changes"**

## Step 4: Generate Invite URL

1. In the left sidebar, go to **"OAuth2"** → **"URL Generator"**
2. Under **"Scopes"**, select:
   - `bot`
3. Under **"Bot Permissions"**, select:
   - `Send Messages`
   - `Read Message History`
   - `View Channels`
4. Copy the generated URL at the bottom

Or use this URL template (replace `YOUR_CLIENT_ID`):
```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=68608&scope=bot
```

> **Tip**: Your Client ID is in **"General Information"** or in the URL when viewing your app.

## Step 5: Add Bot to Your Server

1. Open the invite URL from Step 4 in your browser
2. Select the server you want to add the bot to
3. Click **"Authorize"**
4. Complete the CAPTCHA if prompted

You should see `[Bot Name] has joined the server` in Discord.

## Step 6: Configure LettaBot

Run the onboarding wizard and select Discord:

```bash
lettabot onboard
```

Or add directly to your `lettabot.yaml`:

```yaml
channels:
  discord:
    enabled: true
    token: "your-bot-token-here"
    dmPolicy: pairing  # or 'allowlist' or 'open'
```

## Step 7: Start LettaBot

```bash
lettabot server
```

You should see:
```
Registered channel: Discord
[Discord] Connecting...
[Discord] Bot logged in as YourBot#1234
[Discord] DM policy: pairing
```

## Step 8: Test the Integration

### In a Server Channel
1. Go to a text channel in your Discord server
2. Type `@YourBot hello!`
3. The bot should respond

### Direct Message
1. Right-click on the bot in the server member list
2. Click **"Message"**
3. Send a message: `Hello!`
4. The bot should respond (may require pairing approval first)

## Access Control

LettaBot supports three DM policies for Discord:

### Pairing (Recommended)
```yaml
dmPolicy: pairing
```
- New users receive a pairing code
- Approve with: `lettabot pairing approve discord <CODE>`
- Most secure for personal use

### Allowlist
```yaml
dmPolicy: allowlist
allowedUsers:
  - "123456789012345678"  # Discord user IDs
```
- Only specified users can interact
- Find user IDs: Enable Developer Mode in Discord settings, then right-click a user → "Copy User ID"

### Open
```yaml
dmPolicy: open
```
- Anyone can message the bot
- Not recommended for personal bots

## Group Behavior

By default, the bot processes and responds to all messages in server channels (`open` mode). You can control this with the `groups` config.

### Group Modes

Three modes are available:

- **`open`** -- Bot responds to all messages in the channel (default)
- **`listen`** -- Bot processes all messages for context/memory, but only responds when @mentioned
- **`mention-only`** -- Bot completely ignores messages unless @mentioned (cheapest option -- messages are dropped at the adapter level before reaching the agent)
- **`disabled`** -- Bot drops all messages in the channel unconditionally, even if @mentioned

### Configuring group modes

Add a `groups` section to your Discord channel config. Keys can be channel IDs, guild (server) IDs, or `*` as a wildcard default:

```yaml
channels:
  discord:
    enabled: true
    token: "your-bot-token"
    groups:
      "*": { mode: mention-only }              # default: require @mention everywhere
      "123456789012345678": { mode: open }      # this channel: respond to everything
      "987654321098765432": { mode: listen }    # this channel: read all, respond on mention
```

Mode resolution priority: channel ID > guild ID > `*` wildcard > `open` (built-in default).

To find channel and server IDs: enable **Developer Mode** in Discord settings (User Settings > Advanced > Developer Mode), then right-click any channel or server and select "Copy Channel ID" or "Copy Server ID".

### Channel allowlisting

If you define `groups` with specific IDs and **do not** include a `*` wildcard, the bot will only be active in those listed channels. Messages in unlisted channels are silently dropped -- they never reach the agent and consume no tokens.

```yaml
channels:
  discord:
    token: "your-bot-token"
    groups:
      "111111111111111111": { mode: open }
      "222222222222222222": { mode: mention-only }
      # No "*" -- all other channels are completely ignored
```

This is the recommended approach when you want to restrict the bot to specific channels.

### Per-group user filtering

Use `allowedUsers` within a group entry to restrict which Discord users can trigger the bot. Messages from other users are silently dropped before reaching the agent.

```yaml
channels:
  discord:
    token: "your-bot-token"
    groups:
      "*":
        mode: mention-only
        allowedUsers:
          - "YOUR_DISCORD_USER_ID"   # Only you can trigger the bot
      "TESTING_CHANNEL":
        mode: open
        # No allowedUsers -- anyone can interact here
```

Find your Discord user ID: enable Developer Mode in Discord settings, then right-click your name and select "Copy User ID".

## Multiple Bots on Discord

If you run multiple agents in a [multi-agent configuration](./configuration.md#multi-agent-configuration), each with their own Discord adapter, there are two scenarios to consider.

### Separate Discord app tokens (recommended)

Each bot connects independently. Give each its own `groups` config:

```yaml
agents:
  - name: helper-bot
    channels:
      discord:
        token: "TOKEN_A"
        groups:
          "*": { mode: mention-only }

  - name: creative-bot
    channels:
      discord:
        token: "TOKEN_B"
        groups:
          "*": { mode: mention-only }
```

These bots are fully isolated -- Discord delivers messages to each token independently.

### Shared Discord app token

If two agents share the same Discord app token, Discord delivers every message to both adapter instances. Use channel allowlisting (no `*` wildcard) to partition which channels each bot handles:

```yaml
agents:
  - name: bot1
    channels:
      discord:
        token: "SHARED_TOKEN"
        groups:
          "CHANNEL_FOR_BOT1": { mode: mention-only }
          # No "*" -- bot1 ignores all other channels

  - name: bot2
    channels:
      discord:
        token: "SHARED_TOKEN"
        groups:
          "CHANNEL_FOR_BOT2": { mode: mention-only }
          # No "*" -- bot2 ignores all other channels
```

Both adapters technically receive every Discord event, but the non-matching adapter drops messages immediately in the event handler -- no agent interaction, no token cost. For true isolation at the Discord level, use separate app tokens.

## Adding Reactions

LettaBot can react to messages using the `lettabot-react` CLI:

```bash
# React to the most recent message
lettabot-react add --emoji ":eyes:"

# React to a specific message
lettabot-react add --emoji ":thumbsup:" --channel discord --chat 123456789 --message 987654321
```

## Troubleshooting

### Bot shows as offline

1. Make sure LettaBot is running (`lettabot server`)
2. Check for errors in the console
3. Verify your bot token is correct

### Bot doesn't respond to messages

1. **Check MESSAGE CONTENT INTENT** is enabled:
   - Discord Developer Portal → Your App → Bot → Privileged Gateway Intents
   - Toggle ON "MESSAGE CONTENT INTENT"

2. **Check bot has permissions** in the channel:
   - Server Settings → Roles → Your Bot's Role
   - Or check channel-specific permissions

3. **Check pairing status** if using pairing mode:
   - New users need to be approved via `lettabot pairing list`

### All bots respond to every message

If you run multiple agents sharing the same Discord token and all of them respond to every message, you need to configure channel allowlisting. Add a `groups` section to each agent's Discord config with specific channel IDs and **no `*` wildcard**. See [Multiple Bots on Discord](#multiple-bots-on-discord) above.

### "0 Servers" in Developer Portal

The bot hasn't been invited to any servers yet. Use the invite URL from Step 4.

### Bot can't DM users

Discord bots can only DM users who:
- Share a server with the bot, OR
- Have previously DM'd the bot

This is a Discord limitation, not a LettaBot issue.

### Rate limiting

If the bot stops responding temporarily, it may be rate-limited by Discord. Wait a few minutes and try again. Avoid sending many messages in quick succession.

## Security Notes

- **Bot tokens** should be kept secret - never commit them to git
- Use `dmPolicy: pairing` or `allowlist` in production
- The bot can only see messages in channels it has access to
- DMs are only visible between the bot and that specific user

## Cross-Channel Memory

Since LettaBot uses a single agent across all channels:
- Messages you send on Discord continue the same conversation as Telegram/Slack
- The agent remembers context from all channels
- You can start a conversation on Telegram and continue it on Discord

## Next Steps

- [Slack Setup](./slack-setup.md)
- [WhatsApp Setup](./whatsapp-setup.md)
- [Signal Setup](./signal-setup.md)

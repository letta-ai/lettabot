# Matrix Setup for LettaBot

This guide walks you through setting up Matrix as a channel for LettaBot.

## Overview

LettaBot connects to Matrix using the **matrix-bot-sdk** library:
- Works with any Matrix homeserver (matrix.org, self-hosted Synapse, etc.)
- No public URL required (uses long-polling)
- Works behind firewalls
- Supports E2E encryption (experimental)

## Prerequisites

- A Matrix account for the bot on any homeserver (e.g., matrix.org)
- LettaBot installed and configured with at least `LETTA_API_KEY`

## Step 1: Create a Bot Account

### Option A: Using Element (Web Client)

1. Go to **https://app.element.io** (or your homeserver's web client)
2. Click **"Create Account"**
3. Choose your homeserver (e.g., matrix.org)
4. Enter a **username** for your bot (e.g., `lettabot`)
5. Set a **password**
6. Click **"Create Account"**

### Option B: Using curl (Self-Hosted Synapse)

If you have a self-hosted Synapse server with admin access:

```bash
curl -X POST https://your-homeserver.com/_matrix/client/v3/register \
  -H "Content-Type: application/json" \
  -d '{
    "auth": {"type": "m.login.dummy"},
    "user_id": "lettabot",
    "password": "your-secure-password"
  }'
```

## Step 2: Get an Access Token

### Option A: Via Element (Recommended for Development)

1. Open Element and log in as your bot account
2. Click your **profile picture** → **Settings**
3. Go to **Help & About**
4. Scroll down to **Advanced** section
5. Click **"Access Token"**
6. Copy the token (looks like `syt_xxxxxxxxxx...`)

### Option B: Via curl

```bash
curl -X POST https://matrix.org/_matrix/client/v3/login \
  -H "Content-Type: application/json" \
  -d '{
    "type": "m.login.password",
    "user": "@lettabot:matrix.org",
    "password": "your-password",
    "initial_device_display_name": "LettaBot"
  }'
```

The response contains:
```json
{
  "user_id": "@lettabot:matrix.org",
  "access_token": "syt_xxxxxxxxxx...",
  "device_id": "ABC123",
  "home_server": "matrix.org"
}
```

> **Important**: Keep your access token secret - never commit it to git.

## Step 3: Get Your User ID

Your user ID is in the format `@username:homeserver`. For example:
- `@lettabot:matrix.org` (on matrix.org)
- `@lettabot:your-homeserver.com` (on self-hosted)

You can find it in Element: Settings → Help & About, or use the login response from above.

## Step 4: Configure LettaBot

### Environment Variables

```bash
export MATRIX_HOMESERVER_URL="https://matrix.org"
export MATRIX_ACCESS_TOKEN="syt_xxxxxxxxxx..."
export MATRIX_USER_ID="@lettabot:matrix.org"
export MATRIX_DEVICE_ID="ABC123"
export MATRIX_DM_POLICY="pairing"
```

Optional variables:

```bash
# Restrict DMs to specific user IDs
export MATRIX_ALLOWED_USERS="@alice:matrix.org,@bob:matrix.org"

# E2E encryption (experimental)
export MATRIX_E2EE="true"

# Custom storage path for bot state
export MATRIX_STORE_PATH="./data/matrix-store"
```

### YAML Configuration

Add to your `lettabot.yaml`:

```yaml
channels:
  matrix:
    enabled: true
    homeserverUrl: "https://matrix.org"
    accessToken: "syt_xxxxxxxxxx..."
    userId: "@lettabot:matrix.org"
    deviceId: "ABC123"
    dmPolicy: pairing        # or 'allowlist' or 'open'
    # streaming: true         # Optional: progressively edit messages as tokens arrive
    # e2ee: false             # Optional: experimental E2E encryption
    # storePath: ./data/matrix-store
    # allowedUsers:           # Optional: restrict to specific users
    #   - "@alice:matrix.org"
    #   - "@bob:matrix.org"
```

## Step 5: Start LettaBot

```bash
lettabot server
```

You should see:

```
Registered channel: Matrix
[Matrix] Connecting to Matrix homeserver...
[Matrix] Matrix adapter started as @lettabot:matrix.org
[Matrix] DM policy: pairing
```

## Step 6: Test the Integration

### Direct Message

1. Open Element (or any Matrix client)
2. Click **"Start Chat"**
3. Search for your bot's user ID (e.g., `@lettabot:matrix.org`)
4. Click the result to open a DM
5. Send a message: `Hello!`
6. If using pairing mode, you'll receive a pairing code
7. Approve the code: `lettabot pairing approve matrix <CODE>`
8. Try again - the bot should respond

### Room (Group Chat)

1. Create a new room in Element
2. Invite your bot user
3. The bot will auto-join
4. Mention the bot or send a message (depending on group mode)
5. The bot should respond

## Access Control

LettaBot supports three DM policies for Matrix:

### Pairing (Recommended)

```yaml
dmPolicy: pairing
```

- New users receive a pairing code
- Approve with: `lettabot pairing approve matrix <CODE>`
- Most secure for personal use

### Allowlist

```yaml
dmPolicy: allowlist
allowedUsers:
  - "@alice:matrix.org"
  - "@bob:matrix.org"
```

- Only specified users can interact
- Users are identified by their full Matrix user ID

### Open

```yaml
dmPolicy: open
```

- Anyone can message the bot
- Not recommended for personal bots

## Room Behavior

### Auto-Join

The bot automatically joins any room it's invited to. No configuration needed.

### Group Modes

By default, the bot processes and responds to all messages in rooms (`open` mode). You can control this with the `groups` config.

Three modes are available:

- **`open`** — Bot responds to all messages in the room (default)
- **`listen`** — Bot processes all messages for context/memory, but only responds when mentioned
- **`mention-only`** — Bot completely ignores messages unless mentioned (cheapest option)
- **`disabled`** — Bot drops all messages in the room unconditionally, even if mentioned

### Configuring Group Modes

Add a `groups` section to your Matrix channel config. Keys are room IDs or `*` as a wildcard default:

```yaml
channels:
  matrix:
    enabled: true
    homeserverUrl: "https://matrix.org"
    accessToken: "syt_..."
    userId: "@lettabot:matrix.org"
    groups:
      "*": { mode: mention-only }              # default: require mention everywhere
      "!abc123:matrix.org": { mode: open }      # this room: respond to everything
      "!xyz789:matrix.org": { mode: listen }    # this room: read all, respond on mention
```

To find room IDs: In Element, go to Room Settings → Advanced → Room ID (it starts with `!`).

### Channel Allowlisting

If you define `groups` with specific IDs and **do not** include a `*` wildcard, the bot will only be active in those listed rooms. Messages in unlisted rooms are silently dropped.

```yaml
channels:
  matrix:
    homeserverUrl: "https://matrix.org"
    accessToken: "syt_..."
    userId: "@lettabot:matrix.org"
    groups:
      "!room1:matrix.org": { mode: open }
      "!room2:matrix.org": { mode: mention-only }
      # No "*" — all other rooms are completely ignored
```

### Per-Group User Filtering

Use `allowedUsers` within a group entry to restrict which Matrix users can trigger the bot:

```yaml
channels:
  matrix:
    homeserverUrl: "https://matrix.org"
    accessToken: "syt_..."
    userId: "@lettabot:matrix.org"
    groups:
      "*":
        mode: mention-only
        allowedUsers:
          - "@alice:matrix.org"     # Only Alice can trigger the bot
      "!public:matrix.org":
        mode: open
        # No allowedUsers — anyone can interact here
```

## Markdown and Formatting

The bot sends formatted responses using Matrix's HTML format:

- **Bold**: `**text**`
- **Italic**: `*text*`
- **Code**: `` `code` ``
- **Code blocks**: ` ```code``` `
- **Links**: `[text](url)`

The bot sends both plain text and HTML versions of messages for compatibility with all clients.

## E2E Encryption (Experimental)

Matrix supports end-to-end encryption (E2EE). LettaBot has experimental support:

```yaml
channels:
  matrix:
    enabled: true
    homeserverUrl: "https://matrix.org"
    accessToken: "syt_..."
    userId: "@lettabot:matrix.org"
    e2ee: true
```

**Note**: E2E support is experimental and may have limitations. The bot will auto-accept room invites and participate in encrypted conversations, but device verification workflows may require manual setup.

## Bot Commands

LettaBot responds to these Matrix commands:

| Command | Description |
|---------|-------------|
| `/start` | Welcome message and help |
| `/help` | Show available commands |
| `/status` | Show current bot status |
| `/heartbeat` | Trigger a heartbeat (silent) |
| `/reset` | Reset agent state |
| `/model` | Show current model |
| `/models` | List available models |
| `/setconv` | Set conversation mode |

## Troubleshooting

### Bot not connecting

**Error**: "Invalid access token"

1. Double-check your `MATRIX_ACCESS_TOKEN` and `MATRIX_USER_ID`
2. Log in to Element with your bot account and get a fresh token
3. Make sure the token hasn't expired (Element tokens are long-lived but may rotate)

### Bot not responding to messages

1. Check the console logs for errors
2. Make sure you've approved the pairing code if using `pairing` mode
3. Verify the bot is in the room (check room members list)

### "Connection failed" error

1. Check the `MATRIX_HOMESERVER_URL` is correct (e.g., `https://matrix.org`)
2. Make sure your internet connection is stable
3. Try using a different homeserver URL if matrix.org is unavailable

### Bot doesn't auto-join rooms

1. Make sure the bot account is online/active in Element
2. Check that the bot's Matrix client has not stopped (look for errors in logs)
3. Try inviting the bot again

### Permission errors

If the bot can't send messages in a room:

1. Check room permissions — the bot may need higher privileges
2. Ask a room admin to promote the bot if needed
3. In Element: Room Settings → Members → Find the bot → Promote to Moderator (if needed)

### E2E encryption issues

If E2E is enabled and the bot can't participate:

1. Make sure the room and bot account both support E2E
2. Try disabling E2E and re-enabling to reset the state
3. Manually verify the bot's device in Element: Settings → Security → Devices

## Security Notes

- **Access tokens** should be kept secret - never commit them to git
- Use `dmPolicy: pairing` or `allowlist` in production
- The bot can only see messages in rooms it's a member of
- DMs are only visible between the bot and that specific user
- Device IDs are optional but recommended for production (prevents new device warnings)

## Cross-Channel Memory

Since LettaBot uses a single agent across all channels:
- Messages you send on Matrix continue the same conversation as Telegram/Slack/Discord
- The agent remembers context from all channels
- You can start a conversation on Matrix and continue it on another channel

## Mention Patterns (Advanced)

By default, the bot checks if its user ID is mentioned in messages. For custom mention patterns:

```yaml
channels:
  matrix:
    homeserverUrl: "https://matrix.org"
    accessToken: "syt_..."
    userId: "@lettabot:matrix.org"
    mentionPatterns:
      - "@lettabot"          # Match simple mentions
      - "bot:"               # Match "bot: ..." style
      - "^!"                 # Match messages starting with !
```

## Next Steps

- [Telegram Setup](./telegram-setup.md)
- [Slack Setup](./slack-setup.md)
- [Discord Setup](./discord-setup.md)
- [WhatsApp Setup](./whatsapp-setup.md)
- [Signal Setup](./signal-setup.md)

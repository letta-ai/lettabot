# Telegram MTProto (User Account) Setup Guide

This guide explains how to run LettaBot as a Telegram **user account** instead of a bot. This uses the MTProto protocol via TDLib, giving you full user capabilities.

## Overview: Bot API vs MTProto

| Feature | Bot API | MTProto (User) |
|---------|---------|----------------|
| **Setup** | Simple (BotFather token) | Phone + API credentials |
| **DM users first** | No (must wait for user) | Yes |
| **File size limit** | 50 MB | 2 GB |
| **Privacy mode** | Restricted in groups | Full access |
| **Rate limits** | 30 req/sec | Higher limits |
| **Appears as** | Bot account | Regular user |

**Choose MTProto if you need:** User-first DMs, larger files, or full group access.

## Prerequisites

1. **Telegram account** with a phone number
2. **API credentials** from my.telegram.org (see below)
3. **LettaBot** installed with dependencies

## Getting API Credentials

1. Go to [my.telegram.org](https://my.telegram.org)
2. Log in with your phone number
3. Click **"API development tools"**
4. Fill in the form:
   - **App title**: LettaBot (or any name)
   - **Short name**: lettabot
   - **Platform**: Desktop
   - **Description**: AI assistant
5. Click **"Create application"**
6. Note your **API ID** and **API Hash**

> **Security Note**: Keep your API credentials secret. Never commit them to git or share them publicly. They are tied to your Telegram account.

## Configuration

Add these to your `.env` file:

```bash
# Telegram MTProto User Mode
TELEGRAM_PHONE_NUMBER=+1234567890
TELEGRAM_API_ID=12345678
TELEGRAM_API_HASH=abcdef1234567890abcdef1234567890

# Optional: Custom database directory (default: ./data/telegram-mtproto)
# TELEGRAM_MTPROTO_DB_DIR=./data/telegram-mtproto

# DM policy (same as bot mode)
TELEGRAM_DM_POLICY=pairing
# TELEGRAM_ALLOWED_USERS=123456789,987654321
```

**Important**: Do NOT set `TELEGRAM_BOT_TOKEN` at the same time. You must choose one mode or the other.

## First Run Authentication

On first run, you'll see prompts for authentication:

```
$ lettabot server

[Telegram MTProto] Starting authentication...
[Telegram MTProto] Sending phone number...
[Telegram MTProto] Verification code sent to your Telegram app
Enter verification code: █
```

1. Open your Telegram app on another device
2. You'll receive a login code message
3. Enter the code in the terminal

If you have 2FA enabled:

```
[Telegram MTProto] 2FA password required
Enter 2FA password: █
```

Enter your Telegram 2FA password.

On success:

```
[Telegram MTProto] Authenticated successfully!
[Telegram MTProto] Session saved to ./data/telegram-mtproto/
```

## Subsequent Runs

After initial authentication, the session is saved. You won't need to enter codes again:

```
$ lettabot server

[Telegram MTProto] Starting adapter...
[Telegram MTProto] Authenticated successfully!
[Telegram MTProto] Session saved to ./data/telegram-mtproto/
[Telegram MTProto] Adapter started
```

## Troubleshooting

### "Phone number banned" or "PHONE_NUMBER_BANNED"

Your phone number may be flagged by Telegram. This can happen if:
- The number was recently used for spam
- Too many failed login attempts
- Account previously terminated

**Solution**: Contact Telegram support or use a different number.

### "FLOOD_WAIT_X" errors

You're sending too many requests. TDLib handles this automatically by waiting, but you'll see delay messages in logs.

**Solution**: This is normal - TDLib will retry automatically.

### Session keeps asking for code

The session database may be corrupted.

**Solution**: Delete the database directory and re-authenticate:
```bash
rm -rf ./data/telegram-mtproto
lettabot server
```

### "API_ID_INVALID" or "API_HASH_INVALID"

Your API credentials are incorrect.

**Solution**: Double-check the values from my.telegram.org.

### Database grows very large

TDLib caches data locally, which can grow to 50+ MB quickly.

**Solution**: This is normal. For very long sessions, you may want to periodically clear the database and re-authenticate.

## Switching Between Bot and MTProto

To switch modes:

1. **Stop LettaBot**
2. **Edit `.env`**:
   - For Bot mode: Set `TELEGRAM_BOT_TOKEN`, remove/comment `TELEGRAM_PHONE_NUMBER`
   - For MTProto: Set `TELEGRAM_PHONE_NUMBER` + API credentials, remove/comment `TELEGRAM_BOT_TOKEN`
3. **Start LettaBot**

You cannot run both modes simultaneously.

## Security Notes

1. **API credentials**: Treat like passwords. They can be used to access your Telegram account.

2. **Session files**: The `./data/telegram-mtproto/` directory contains your authenticated session. Anyone with these files can act as your Telegram account.

3. **gitignore**: The session directory is automatically gitignored. Never commit it.

4. **Account security**: Consider using a dedicated phone number for bots rather than your personal number.

5. **Logout**: To revoke the session:
   - Go to Telegram Settings → Devices
   - Find "TDLib" or the session
   - Click "Terminate Session"

## Using with DM Policy

MTProto mode supports the same DM policies as bot mode:

- **pairing** (default): Unknown users must be approved before chatting
- **allowlist**: Only users in `TELEGRAM_ALLOWED_USERS` can message
- **open**: Anyone can message

```bash
# Pairing mode (recommended for most users)
TELEGRAM_DM_POLICY=pairing

# Or pre-approve specific users
TELEGRAM_ALLOWED_USERS=123456789,987654321
```

### Admin Notifications for Pairing

When using pairing mode, you can set up an admin chat to receive pairing requests:

```bash
# Your Telegram user ID or a group chat ID for admin notifications
TELEGRAM_ADMIN_CHAT_ID=137747014
```

**How it works:**

1. Unknown user sends a message
2. User sees: *"Your request has been passed on to the admin."*
3. Admin chat receives notification with username and user ID
4. Admin replies **"approve"** or **"deny"** to the notification
5. Both user and admin get confirmation

**Approve/Deny keywords:**
- Approve: `approve`, `yes`, `y`
- Deny: `deny`, `no`, `n`, `reject`

If no admin chat is configured, pairing codes are logged to the console instead.

**Pairing request behavior:**
- Repeated messages from the same unapproved user do not create duplicate admin notifications.
- If the pending pairing queue is full, the user gets: *"Too many pending pairing requests. Please try again later."*

## Group Chat Policy

Since MTProto gives you full group access, you need to control when the agent responds in groups. The **group policy** determines this:

| Policy | Behavior |
|--------|----------|
| **mention** | Only respond when @mentioned by username |
| **reply** | Only respond when someone replies to agent's message |
| **both** | Respond to mentions OR replies (default) |
| **off** | Never respond in groups, DMs only |

```bash
# Only respond when @mentioned (recommended for busy groups)
TELEGRAM_GROUP_POLICY=mention

# Only respond to replies
TELEGRAM_GROUP_POLICY=reply

# Respond to either mentions or replies (default)
TELEGRAM_GROUP_POLICY=both

# Never respond in groups
TELEGRAM_GROUP_POLICY=off
```

**Note**: Group policy does NOT affect DMs - direct messages always work based on your DM policy.

### How Mentions Work

The agent responds when:
- Someone types `@yourusername` in their message
- Someone uses Telegram's mention feature (clicking your name in the member list)

### How Reply Detection Works

The agent tracks messages it sends. When someone replies to one of those messages (using Telegram's reply feature), the agent will respond.

**Tip**: For busy groups, use `mention` policy. For small groups or channels, `both` works well.

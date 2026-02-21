# Signal Setup Guide

LettaBot can connect to Signal using [signal-cli](https://github.com/AsamK/signal-cli), a command-line interface for Signal.

## Prerequisites

### 1. Install signal-cli

**macOS (Homebrew):**
```bash
brew install signal-cli
```

**Linux:**
```bash
# Download latest release from https://github.com/AsamK/signal-cli/releases
# Extract and add to PATH
```

### 2. Register Your Phone Number

You have two options:

#### Option A: Link as Secondary Device (Recommended)

Link signal-cli to your existing Signal account without disrupting your phone app:

```bash
# Generate a linking QR code/URI
signal-cli link -n "LettaBot"
```

This will display a `sgnl://linkdevice?uuid=...` URI. On your phone:
1. Open Signal → Settings (tap your profile)
2. Tap "Linked Devices"
3. Tap "Link New Device" (+ button)
4. Scan the QR code or enter the URI

**Benefits:**
- Your phone's Signal app continues to work normally
- Bot runs as a linked device (like Signal Desktop)
- Both your phone and the bot receive messages
- You can unlink the bot anytime from your phone

#### Option B: Primary Registration (Dedicated Number Only)

Register signal-cli as the primary device (requires a dedicated phone number):

```bash
# Request verification code (sent via SMS)
signal-cli -a +1XXXXXXXXXX register

# Enter the code you receive
signal-cli -a +1XXXXXXXXXX verify CODE
```

**Warning:** This will log out your Signal mobile app. Only use this option with a dedicated bot number, not your personal number.

## Configuration

Add to your `.env`:

```bash
# Required: Phone number you registered
SIGNAL_PHONE_NUMBER=+17075204676

# Optional: Path to signal-cli (if not in PATH)
# SIGNAL_CLI_PATH=/usr/local/bin/signal-cli

# Optional: HTTP daemon settings (default: 127.0.0.1:8090)
# SIGNAL_HTTP_HOST=127.0.0.1
# SIGNAL_HTTP_PORT=8090

# Optional: Self-chat mode for "Note to Self" (default: true)
# SIGNAL_SELF_CHAT_MODE=true
```

**Note:** For personal numbers (`selfChatMode: true`), `dmPolicy` is ignored - only you can message via "Note to Self". For dedicated bot numbers, onboarding defaults to `allowlist`.

## How It Works

LettaBot automatically:
1. Starts signal-cli in daemon mode (JSON-RPC over HTTP)
2. Connects via Server-Sent Events (SSE) for incoming messages
3. Sends replies via JSON-RPC

The daemon runs on port 8090 by default to avoid conflicts with other services.

## Features

- **Direct Messages** - Receive and respond to DMs
- **Note to Self** - Use Signal's "Note to Self" feature to message yourself (selfChatMode)
- **Allowlist** - For dedicated numbers, only pre-approved phone numbers can message

## Troubleshooting

### Port Conflict
If port 8090 is in use, change it:
```bash
SIGNAL_HTTP_PORT=8091
```

### Daemon Won't Start
Check if signal-cli is in your PATH:
```bash
which signal-cli
```

If not, set the full path:
```bash
SIGNAL_CLI_PATH=/opt/homebrew/bin/signal-cli
```

### "Note to Self" Not Working
Messages you send to yourself appear via `syncMessage.sentMessage`, not `dataMessage`. LettaBot handles this automatically when `SIGNAL_SELF_CHAT_MODE=true` (the default).

### Registration Issues
If you get errors during registration:
1. Make sure the number can receive SMS
2. Try with `--captcha` if prompted
3. Check signal-cli GitHub issues for common problems

## Architecture

```
┌────────────────┐     HTTP      ┌──────────────┐
│   LettaBot     │◄────────────►│  signal-cli  │
│  (Signal.ts)   │   (JSON-RPC)  │   (daemon)   │
└────────────────┘               └──────┬───────┘
        │                               │
        │ SSE (events)                  │ Signal Protocol
        │◄──────────────────────────────┤
        │                               ▼
        │                        ┌──────────────┐
        │                        │   Signal     │
        │                        │   Servers    │
        │                        └──────────────┘
```

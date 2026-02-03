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

You need a phone number that can receive SMS for verification.

```bash
# Request verification code (sent via SMS)
signal-cli -a +1XXXXXXXXXX register

# Enter the code you receive
signal-cli -a +1XXXXXXXXXX verify CODE
```

**Note:** You can only have one Signal client per number. Registering signal-cli will log out your Signal mobile app. Consider using a secondary number.

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

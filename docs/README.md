# LettaBot Documentation

LettaBot is a multi-channel AI assistant powered by [Letta](https://letta.com) that provides persistent memory and local tool execution across Telegram, Slack, Discord, WhatsApp, and Signal.

## Guides

- [Getting Started](./getting-started.md) - Installation and basic setup
- [Docker Server Setup](./selfhosted-setup.md) - Run with your own Letta server
- [Configuration Reference](./configuration.md) - All config options
- [Commands Reference](./commands.md) - Bot commands reference
- [CLI Tools](./cli-tools.md) - Agent/operator CLI tools
- [Chat API](./configuration.md#chat-endpoint) - HTTP endpoint for programmatic agent access
- [Open WebUI Setup](./openwebui-setup.md) - Web chat UI via OpenAI-compatible API
- [Response Directives](./directives.md) - XML action directives (reactions, etc.)
- [Scheduling Tasks](./cron-setup.md) - Cron jobs and heartbeats
- [Gmail Pub/Sub](./gmail-pubsub.md) - Email notifications integration
- [Railway Deployment](./railway-deploy.md) - Deploy to Railway
- [Releasing](./releasing.md) - How to create releases

### Channel Setup
- [Telegram Setup](./telegram-setup.md) - BotFather token setup
- [Slack Setup](./slack-setup.md) - Socket Mode configuration
- [Discord Setup](./discord-setup.md) - Bot application setup
- [WhatsApp Setup](./whatsapp-setup.md) - Baileys/QR code setup
- [Signal Setup](./signal-setup.md) - signal-cli daemon setup

## Architecture

LettaBot uses a **single agent with unified memory** across all channels:

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        Your Server / Machine                              │
│                                                                           │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌──────────┐  ┌───────┐ │
│  │  Telegram  │  │   Slack    │  │  Discord   │  │ WhatsApp │  │ Signal│ │
│  │  (grammY)  │  │  (Socket)  │  │ (Gateway)  │  │(Baileys) │  │ (CLI) │ │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘  └────┬─────┘  └───┬───┘ │
│        │               │               │              │            │      │
│        └───────────────┴───────────────┴──────────────┴────────────┘      │
│                                    │                                      │
│                          ┌─────────▼─────────┐                            │
│                          │   LettaBot Core   │                            │
│                          │   (TypeScript)    │                            │
│                          │                   │                            │
│                          │  • Message Router │                            │
│                          │  • Session Mgmt   │                            │
│                          │  • Heartbeat/Cron │                            │
│                          └─────────┬─────────┘                            │
│                                    │                                      │
│                          ┌─────────▼─────────┐                            │
│                          │  Letta Code SDK   │                            │
│                          │  (subprocess)     │                            │
│                          │                   │                            │
│                          │  Local Tools:     │                            │
│                          │  • Read/Glob/Grep │                            │
│                          │  • Bash           │                            │
│                          │  • web_search     │                            │
│                          └─────────┬─────────┘                            │
└────────────────────────────────────┼──────────────────────────────────────┘
                                     │ Letta API
                                     ▼
                       ┌──────────────────────────┐
                       │      Letta Server        │
                       │  (api.letta.com or       │
                       │   Docker/custom)         │
                       │                          │
                       │  • Agent Memory          │
                       │  • LLM Inference         │
                       │  • Conversation History  │
                       └──────────────────────────┘
```

## Key Features

- **Multi-Channel** - Chat across Telegram, Slack, Discord, WhatsApp, and Signal
- **Unified Memory** - Single agent remembers everything from all channels
- **Persistent Memory** - Conversations persist across days/weeks/months
- **Local Tool Execution** - Agent can search files, run commands on your machine
- **Voice Messages** - Automatic transcription via OpenAI Whisper
- **Streaming Responses** - Real-time message updates as the agent thinks
- **Background Tasks** - Heartbeats and cron jobs for proactive actions

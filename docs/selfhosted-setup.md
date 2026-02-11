# Docker Server Setup

Run LettaBot with your own Letta Docker/custom server instead of Letta API.

## Prerequisites

1. **Docker** installed and running
2. **Node.js 20+** for LettaBot
3. **API keys** for your LLM provider (OpenAI, Anthropic, etc.)

## Step 1: Start Letta Server

```bash
docker run -d \
  --name letta-server \
  -v ~/.letta/.persist/pgdata:/var/lib/postgresql/data \
  -p 8283:8283 \
  -e OPENAI_API_KEY="sk-..." \
  letta/letta:latest
```

For Anthropic models:
```bash
docker run -d \
  --name letta-server \
  -v ~/.letta/.persist/pgdata:/var/lib/postgresql/data \
  -p 8283:8283 \
  -e ANTHROPIC_API_KEY="sk-ant-..." \
  letta/letta:latest
```

Verify it's running:
```bash
curl http://localhost:8283/v1/health
```

## Step 2: Configure LettaBot

### Option A: Interactive Setup (Recommended)

```bash
lettabot onboard
```

Select "Enter Docker server URL" and enter `http://localhost:8283`.

### Option B: Manual Configuration

Create `lettabot.yaml`:

```yaml
server:
  mode: docker
  baseUrl: http://localhost:8283
  # apiKey: optional-if-server-requires-auth

agent:
  name: LettaBot
  model: gpt-4o                     # Or claude-sonnet-4, etc.

channels:
  telegram:
    enabled: true
    token: YOUR_TELEGRAM_BOT_TOKEN  # From @BotFather
    dmPolicy: pairing               # pairing | allowlist | open

features:
  cron: false
  heartbeat:
    enabled: false
```

## Step 3: Start LettaBot

```bash
lettabot server
```

You should see:
```
[Config] Loaded from /path/to/lettabot.yaml
[Config] Mode: docker, Agent: LettaBot, Model: gpt-4o
Starting LettaBot...
LettaBot initialized. Agent ID: (new)
[Telegram] Bot started as @YourBotName
```

## Network Configuration

### Remote Server

If your Letta server is on a different machine:

```yaml
server:
  baseUrl: http://192.168.1.100:8283
```

### Docker to Docker

If LettaBot runs in Docker and needs to reach Letta server on the host:

```yaml
server:
  baseUrl: http://host.docker.internal:8283
```

### Docker Compose

```yaml
services:
  letta:
    image: letta/letta:latest
    ports:
      - "8283:8283"
    volumes:
      - letta-data:/var/lib/postgresql/data
    environment:
      - OPENAI_API_KEY=${OPENAI_API_KEY}

  lettabot:
    build: .
    depends_on:
      - letta
    environment:
      - LETTA_BASE_URL=http://letta:8283
    volumes:
      - ./lettabot.yaml:/app/lettabot.yaml
      - ./lettabot-agent.json:/app/lettabot-agent.json

volumes:
  letta-data:
```

## Troubleshooting

### Connection Refused

```
Error: connect ECONNREFUSED 127.0.0.1:8283
```

**Fix:** Ensure Letta server is running:
```bash
docker ps | grep letta
curl http://localhost:8283/v1/health
```

### Agent Stuck / Not Responding

If the bot hangs after sending a message:

**1. Check for pending tool approvals**

Some tools may have `requires_approval: true` set. LettaBot disables these on startup, but check:

```bash
# List tools and their approval status
curl http://localhost:8283/v1/agents/YOUR_AGENT_ID/tools | jq '.[].requires_approval'

# Disable approval for a specific tool
curl -X PATCH http://localhost:8283/v1/tools/TOOL_ID \
  -H "Content-Type: application/json" \
  -d '{"requires_approval": null}'
```

**2. Invalid conversation ID**

If the conversation was deleted but LettaBot still references it:

```bash
# Clear the stored conversation (keeps agent)
cat lettabot-agent.json | jq 'del(.conversationId)' > tmp.json && mv tmp.json lettabot-agent.json

# Restart
lettabot server
```

**3. Check server logs**

```bash
docker logs letta-server --tail 100
```

### Model Not Available

```
Error: Model 'claude-sonnet-4' not found
```

Ensure you set the correct API key when starting Letta server:
- OpenAI models: `-e OPENAI_API_KEY="sk-..."`
- Anthropic models: `-e ANTHROPIC_API_KEY="sk-ant-..."`

### Reset Everything

```bash
# Remove LettaBot state
rm lettabot-agent.json

# Remove Letta server data (WARNING: deletes all agents)
docker stop letta-server
docker rm letta-server
rm -rf ~/.letta/.persist/pgdata

# Restart fresh
docker run ... (same command as before)
lettabot server
```

## Running as a Service

### systemd (Linux)

Create `/etc/systemd/system/lettabot.service`:

```ini
[Unit]
Description=LettaBot - Multi-channel AI Assistant
After=network.target docker.service
Wants=docker.service

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/lettabot
ExecStart=/usr/bin/npx lettabot server
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable lettabot
sudo systemctl start lettabot

# View logs
journalctl -u lettabot -f
```

### launchd (macOS)

Create `~/Library/LaunchAgents/com.lettabot.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.lettabot</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/npx</string>
        <string>lettabot</string>
        <string>server</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/lettabot</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/lettabot.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/lettabot.err</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.lettabot.plist

# View logs
tail -f /tmp/lettabot.log
```

## Hardware Requirements

**Minimum for LettaBot itself:**
- 512MB RAM, 1 CPU core
- LettaBot is lightweight - the heavy lifting is done by Letta server

**For Letta server with cloud LLMs (OpenAI/Anthropic):**
- 2GB RAM, 2 CPU cores
- No GPU required (LLM runs in the cloud)

**For local LLM inference (e.g., Ollama):**
- 16GB+ system RAM for 7B models
- 48GB+ for 70B models
- GPU recommended: 8GB+ VRAM for 7B, 48GB+ for larger

## Security Considerations

1. **Network exposure**: Don't expose port 8283 to the internet without authentication
2. **API keys**: Keep your `.env` and `lettabot.yaml` out of version control
3. **Tool permissions**: Review which tools your agent has access to (Bash can execute arbitrary commands)
4. **DM policy**: Use `pairing` (default) to require approval for new users

## Getting Help

- [GitHub Issues](https://github.com/letta-ai/lettabot/issues)
- [Letta Documentation](https://docs.letta.com)
- [Letta Discord](https://discord.gg/letta)

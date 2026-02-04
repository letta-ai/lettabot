# Railway Deployment

Deploy LettaBot to [Railway](https://railway.app) for always-on hosting.

## One-Click Deploy

1. Fork this repository
2. Connect to Railway
3. Set environment variables (see below)
4. Deploy!

**No local setup required.** LettaBot automatically finds or creates your agent by name.

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `LETTA_API_KEY` | Your Letta Cloud API key ([get one here](https://app.letta.com)) |

### Channel Configuration (at least one required)

**Telegram:**
```
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_DM_POLICY=pairing
```

**Discord:**
```
DISCORD_BOT_TOKEN=your-bot-token
DISCORD_DM_POLICY=pairing
```

**Slack:**
```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_NAME` | `LettaBot` | Agent name (used to find/create agent) |
| `MODEL` | `zai/glm-4.7` | Model for new agents (ignored for existing agents) |
| `LETTA_AGENT_ID` | - | Override auto-discovery with specific agent ID |
| `CRON_ENABLED` | `false` | Enable cron jobs |
| `HEARTBEAT_INTERVAL_MIN` | - | Enable heartbeats (minutes) |
| `HEARTBEAT_TARGET` | - | Target chat (e.g., `telegram:123456`) |
| `OPENAI_API_KEY` | - | For voice message transcription |

## How It Works

### Agent Discovery

On startup, LettaBot:
1. Checks for `LETTA_AGENT_ID` env var - uses if set
2. Otherwise, searches Letta Cloud for an agent named `AGENT_NAME` (default: "LettaBot")
3. If found, uses the existing agent (preserves memory!)
4. If not found, creates a new agent on first message

This means **your agent persists across deploys** without any manual ID copying.

### Build & Deploy

Railway automatically:
- Detects Node.js and installs dependencies
- Runs `npm run build` to compile TypeScript
- Runs `npm start` to start the server
- Sets the `PORT` environment variable
- Monitors `/health` endpoint

## Persistent Storage

The Railway template includes a persistent volume mounted at `/data`. This is set up automatically when you deploy using the button above.

### What Gets Persisted

- **Agent ID** - No need to set `LETTA_AGENT_ID` manually after first run
- **Cron jobs** - Scheduled tasks survive restarts
- **Skills** - Downloaded skills persist
- **Attachments** - Downloaded media files

### Volume Size

- Free plan: 0.5 GB (sufficient for most use cases)
- Hobby plan: 5 GB
- Pro plan: 50 GB

### Manual Deployment (Without Template)

If you deploy manually from a fork instead of using the template, you'll need to add a volume yourself:

1. In your Railway project, click **+ New** and select **Volume**
2. Connect the volume to your LettaBot service
3. Set the mount path to `/data`

LettaBot automatically detects `RAILWAY_VOLUME_MOUNT_PATH` and uses it for persistent data.

## Channel Limitations

| Channel | Railway Support | Notes |
|---------|-----------------|-------|
| Telegram | Yes | Full support |
| Discord | Yes | Full support |
| Slack | Yes | Full support |
| WhatsApp | No | Requires local QR pairing |
| Signal | No | Requires local device registration |

## Troubleshooting

### "No channels configured"

Set at least one channel token (TELEGRAM_BOT_TOKEN, DISCORD_BOT_TOKEN, or SLACK tokens).

### Agent not found / wrong agent

- Check `AGENT_NAME` matches your intended agent
- Or set `LETTA_AGENT_ID` explicitly to use a specific agent
- Multiple agents with the same name? The most recently created one is used

### Health check failing

Check Railway logs for startup errors. Common issues:
- Missing `LETTA_API_KEY`
- Invalid channel tokens

### Data not persisting

If data is lost between restarts:
1. Verify a volume is attached to your service
2. Check that the mount path is set (e.g., `/data`)
3. Look for `[Storage] Railway volume detected` in startup logs
4. If not using a volume, set `LETTA_AGENT_ID` explicitly

## Deploy Button

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/lettabot?utm_medium=integration&utm_source=template&utm_campaign=generic)

Or add to your README:

```markdown
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/lettabot?utm_medium=integration&utm_source=template&utm_campaign=generic)
```

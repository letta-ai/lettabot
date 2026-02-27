# Cloud Deployment

Deploy LettaBot to any cloud platform that supports Docker or Node.js.

## Prerequisites

- A [Letta API key](https://app.letta.com) (or a self-hosted Letta server -- see [Docker Server Setup](./selfhosted-setup.md))
- At least one channel token (Telegram, Discord, or Slack)
- A working `lettabot.yaml` config (run `lettabot onboard` to create one)

## Configuration

Cloud platforms typically don't support config files directly. LettaBot solves this with `LETTABOT_CONFIG_YAML` -- a single environment variable containing your entire config.

### Encoding Your Config

```bash
# Using the CLI helper (recommended)
lettabot config encode

# Or manually
base64 < lettabot.yaml | tr -d '\n'
```

Set the output as `LETTABOT_CONFIG_YAML` on your platform. This is the only env var you need -- everything (API key, channels, features) is in the YAML.

Both base64-encoded and raw YAML values are accepted. Base64 is recommended since some platforms don't handle multi-line env vars well.

### Verifying

To decode and inspect what a `LETTABOT_CONFIG_YAML` value contains:

```bash
LETTABOT_CONFIG_YAML=... lettabot config decode
```

## Docker

LettaBot includes a Dockerfile for containerized deployment.

### Build and Run

```bash
docker build -t lettabot .

docker run -d \
  -e LETTABOT_CONFIG_YAML="$(base64 < lettabot.yaml | tr -d '\n')" \
  -p 8080:8080 \
  lettabot
```

### Docker Compose

```yaml
services:
  lettabot:
    build: .
    ports:
      - "8080:8080"
    environment:
      - LETTABOT_CONFIG_YAML=${LETTABOT_CONFIG_YAML}
    restart: unless-stopped
```

If running alongside a self-hosted Letta server, see [Docker Server Setup](./selfhosted-setup.md) for the Letta container config.

## Fly.io

```bash
# Install CLI
brew install flyctl
fly auth login

# Launch (detects Dockerfile automatically)
fly launch

# Set your config
fly secrets set LETTABOT_CONFIG_YAML="$(base64 < lettabot.yaml | tr -d '\n')"

# Set a stable API key (optional, prevents regeneration across deploys)
fly secrets set LETTABOT_API_KEY=$(openssl rand -hex 32)

# Deploy
fly deploy
```

`fly launch` generates a `fly.toml` with your app name. Edit it to keep the bot running (Fly defaults to stopping idle machines):

```toml
[http_service]
  auto_stop_machines = false
  min_machines_running = 1
```

Scale to 1 machine (multiple instances would conflict on channel tokens):

```bash
fly scale count 1
```

## Railway

See [Railway Deployment](./railway-deploy.md) for the full guide including one-click deploy, persistent volumes, and Railway-specific configuration.

The short version:

1. Fork the repo and connect to Railway
2. Set `LETTABOT_CONFIG_YAML` (or individual env vars for simple setups)
3. Deploy

## Other Platforms

Any platform that runs Docker images or Node.js works. Set `LETTABOT_CONFIG_YAML` as an env var and you're done.

**Render:** Deploy from GitHub, set env var in dashboard.

**DigitalOcean App Platform:** Use the Dockerfile, set env var in app settings.

**Any VPS (EC2, Linode, Hetzner):** Build the Docker image and run it, or install Node.js and run `npm start` directly.

## Web Portal

LettaBot includes an admin portal at `/portal` for managing pairing approvals from a browser. Navigate to `https://your-host/portal` and enter your API key to:

- View pending pairing requests across all channels
- Approve users with one click
- Auto-refreshes every 10 seconds

## API Key

An API key is auto-generated on first boot and printed in logs. It's required for the web portal and HTTP API endpoints.

To make it stable across deploys, set `LETTABOT_API_KEY` as an environment variable:

```bash
# Fly.io
fly secrets set LETTABOT_API_KEY=$(openssl rand -hex 32)

# Railway / Render / etc.
# Set LETTABOT_API_KEY in the platform's env var UI
```

## Health Check

LettaBot exposes `GET /health` which returns `ok`. Configure your platform's health check to use this endpoint.

## Channel Limitations

| Channel | Cloud Support | Notes |
|---------|--------------|-------|
| Telegram | Yes | Full support |
| Discord | Yes | Full support |
| Slack | Yes | Full support |
| WhatsApp | No | Requires local QR code pairing |
| Signal | No | Requires local device registration |

# Open WebUI Setup for LettaBot

LettaBot exposes an [OpenAI-compatible API](./configuration.md#api-server-configuration) that any standard OpenAI client can connect to. [Open WebUI](https://github.com/open-webui/open-webui) is an open-source chat frontend that speaks this protocol, giving you a polished web interface for your LettaBot agent.

## Prerequisites

- **Docker** installed and running
- **LettaBot running in API mode** (`server.mode: api` in `lettabot.yaml`)
- **API key** from `lettabot-api.json` (auto-generated on first run)

## Step 1: Start Open WebUI

LettaBot's API server defaults to port 8080, so map Open WebUI to a different port (3000 in this example):

```bash
docker run -d -p 3000:8080 \
  -e OPENAI_API_KEY=your_api_key_from_lettabot_api_json \
  -e OPENAI_API_BASE_URL=http://host.docker.internal:8080/v1 \
  --add-host=host.docker.internal:host-gateway \
  -v open-webui:/app/backend/data \
  --name open-webui \
  --restart always \
  ghcr.io/open-webui/open-webui:main
```

| Environment Variable | Description |
|---------------------|-------------|
| `OPENAI_API_KEY` | API key from `lettabot-api.json` or `LETTABOT_API_KEY` env var |
| `OPENAI_API_BASE_URL` | LettaBot's OpenAI-compatible endpoint. Use `host.docker.internal` to reach the host machine from inside Docker |

## Step 2: Create an Account

Open http://localhost:3000 in your browser. The first account you create becomes the admin. This is local to the Docker volume -- pick any email and password.

## Step 3: Select Model and Chat

In the chat interface, open the model dropdown (top of the chat area) and select your agent's name. The model list is built from the `name` field of each agent in your `lettabot.yaml` -- e.g., if your agent is named `LettaBot`, that's what appears. Type a message and you should see your agent respond with full streaming support.

## Troubleshooting

### Port conflict

If port 3000 is already in use, change the host port in the Docker command (e.g., `-p 3001:8080`).

### "Invalid API key" from LettaBot

Verify the key matches what's in `lettabot-api.json`:

```bash
cat lettabot-api.json
```

### Can't log in after recreating the container

Open WebUI persists data in a Docker volume. If you forgot your password, remove the volume and start fresh:

```bash
docker rm -f open-webui
docker volume rm open-webui
```

Then re-run the `docker run` command from Step 1.

### Connection refused from Open WebUI

Make sure LettaBot is running and the `--add-host=host.docker.internal:host-gateway` flag is included. This allows the container to reach services on your host machine. On Linux, you may also need `--network=host` instead.

## Cleanup

To stop and remove Open WebUI:

```bash
docker rm -f open-webui        # Remove container
docker volume rm open-webui    # Remove data (optional)
```

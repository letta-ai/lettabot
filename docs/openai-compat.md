# OpenAI-Compatible API

LettaBot exposes an OpenAI-compatible API so you can point any OpenAI SDK or tool at your LettaBot server and interact with your agents directly.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/models` | List available agents (as "models") |
| `POST` | `/v1/chat/completions` | Send a message and get a response (sync or streaming) |

Both endpoints run on the same API server as the rest of LettaBot (default port `8080`, configurable via `server.api.port`).

## Authentication

All requests require an API key, passed as either:

- `Authorization: Bearer <key>`
- `X-Api-Key: <key>`

The API key is auto-generated on first run and saved to `lettabot-api.json`, or set via the `LETTABOT_API_KEY` environment variable. This is the same key used by the `/api/v1/chat` endpoint.

## Quick Start

### Python

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8080/v1",
    api_key="YOUR_API_KEY",
)

# Sync
response = client.chat.completions.create(
    model="lettabot",  # your agent name
    messages=[{"role": "user", "content": "What's on my todo list?"}],
)
print(response.choices[0].message.content)

# Streaming
stream = client.chat.completions.create(
    model="lettabot",
    messages=[{"role": "user", "content": "What's on my todo list?"}],
    stream=True,
)
for chunk in stream:
    delta = chunk.choices[0].delta
    if delta.content:
        print(delta.content, end="", flush=True)
```

### Node / TypeScript

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:8080/v1",
  apiKey: "YOUR_API_KEY",
});

// Sync
const response = await client.chat.completions.create({
  model: "lettabot",
  messages: [{ role: "user", content: "What's on my todo list?" }],
});
console.log(response.choices[0].message.content);

// Streaming
const stream = await client.chat.completions.create({
  model: "lettabot",
  messages: [{ role: "user", content: "What's on my todo list?" }],
  stream: true,
});
for await (const chunk of stream) {
  const delta = chunk.choices[0].delta;
  if (delta.content) process.stdout.write(delta.content);
}
```

### curl

**Sync:**

```bash
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "lettabot",
    "messages": [{"role": "user", "content": "What is on my todo list?"}]
  }'
```

**Streaming:**

```bash
curl -N -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "lettabot",
    "messages": [{"role": "user", "content": "What is on my todo list?"}],
    "stream": true
  }'
```

## Model Mapping

The `model` field maps to your agent names. Use `GET /v1/models` to list them:

```bash
curl http://localhost:8080/v1/models \
  -H "Authorization: Bearer YOUR_API_KEY"
```

```json
{
  "object": "list",
  "data": [
    { "id": "lettabot", "object": "model", "created": 1740000000, "owned_by": "lettabot" },
    { "id": "helper-bot", "object": "model", "created": 1740000000, "owned_by": "lettabot" }
  ]
}
```

If you omit `model` in a chat request, the first configured agent is used.

## Streaming

When `stream: true`, responses arrive as Server-Sent Events (SSE). The stream includes:

- **Content deltas** -- incremental text from the assistant
- **Tool call deltas** -- tool invocations with name and arguments
- **Finish chunk** -- `finish_reason: "stop"`
- **`[DONE]` sentinel** -- end of stream

Internal events (reasoning, tool results) are filtered and not included in the stream.

## Supported Parameters

| Parameter | Supported | Notes |
|-----------|-----------|-------|
| `model` | Yes | Maps to agent name |
| `messages` | Yes | Only the last user message is extracted (see below) |
| `stream` | Yes | `true` for SSE streaming, `false`/omitted for sync |
| `temperature` | Ignored | Accepted but has no effect |
| `max_tokens` | Ignored | Accepted but has no effect |
| `tools` | Ignored | Agent tools are configured server-side |
| `top_p` | Ignored | Accepted but has no effect |
| All others | Ignored | Silently accepted for compatibility |

## How Messages Are Handled

The OpenAI API lets you send a full conversation in the `messages` array. LettaBot handles this differently:

- **Only the last user message is extracted** and sent to the agent
- Multi-turn context is managed by Letta's built-in memory and conversation history, not by the messages array
- System messages, assistant messages, and tool messages in the array are ignored

This means you don't need to manage conversation history client-side -- the agent remembers everything on its own.

## Limitations

- **`usage` is always `null`** -- token counts are not tracked
- **No multi-turn passthrough** -- only the last user message is used (see above)
- **Tool definitions ignored** -- tools are configured on the agent, not per-request
- **Reasoning events filtered** -- the agent's internal reasoning is not exposed in the stream

## Use with Open WebUI

Since the endpoint is OpenAI-compatible, you can connect it to [Open WebUI](https://github.com/open-webui/open-webui) or any other OpenAI-compatible frontend. Point the frontend at `http://localhost:8080/v1` with your API key.

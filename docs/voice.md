# Voice

LettaBot has full voice support: it can receive voice messages (transcribed to text) and reply with voice memos (generated via TTS). Both features work across Telegram, WhatsApp, Signal, Discord, and Slack.

## Voice Transcription (Receiving Voice Messages)

When a user sends a voice message, LettaBot downloads the audio, transcribes it via the configured provider, and delivers the text to the agent with a `[Voice message]:` prefix.

### Providers

**OpenAI Whisper** (default):

```yaml
transcription:
  provider: openai
  apiKey: sk-...       # Optional: falls back to OPENAI_API_KEY env var
  model: whisper-1     # Default
```

**Mistral Voxtral** (faster, lower cost):

```yaml
transcription:
  provider: mistral
  apiKey: ...          # Optional: falls back to MISTRAL_API_KEY env var
  model: voxtral-mini-latest  # Default
```

Or configure via environment variables alone:

```bash
# OpenAI (default provider when no config is set)
export OPENAI_API_KEY=sk-...

# Mistral (requires provider to be set in config)
export MISTRAL_API_KEY=...
```

If no API key is configured, users who send voice messages will receive an error message with a setup link.

### Supported Audio Formats

These formats are sent directly to the transcription API (some with a filename remap):

`flac`, `m4a`, `mp3`, `mp4`, `mpeg`, `mpga`, `oga`, `ogg`, `opus`, `wav`, `webm`

These formats are automatically converted to MP3 via ffmpeg (if installed):

`aac`, `amr`, `caf`, `3gp`, `3gpp`

Files over 20MB are automatically split into 10-minute chunks before transcription.

### Channel Support

| Channel   | Format received | Notes |
|-----------|----------------|-------|
| Telegram  | OGG/Opus       | Native voice messages |
| WhatsApp  | OGG/Opus       | Push-to-talk voice messages |
| Signal    | Various        | Voice attachments |
| Discord   | Various        | Audio file attachments |
| Slack     | Various        | Audio file uploads |

## Voice Memos (Sending Voice Notes)

The agent can reply with voice notes using the `<voice>` directive. The text is sent to a TTS provider, converted to OGG Opus audio, and delivered as a native voice bubble (on Telegram and WhatsApp) or a playable audio attachment (on Discord and Slack).

### How It Works

The agent includes a `<voice>` tag in its response:

```xml
<actions>
  <voice>Hey, here's a quick update on that thing we discussed.</voice>
</actions>
```

This can be combined with text -- anything after the `</actions>` block is sent as a normal message alongside the voice note:

```xml
<actions>
  <voice>Here's the summary as audio.</voice>
</actions>
And here it is in text form too!
```

See [directives.md](./directives.md) for the full directive reference.

### Providers

**ElevenLabs** (default):

```yaml
tts:
  provider: elevenlabs
  apiKey: sk_475a...                    # Or ELEVENLABS_API_KEY env var
  voiceId: onwK4e9ZLuTAKqWW03F9         # Or ELEVENLABS_VOICE_ID env var
  model: eleven_multilingual_v2         # Or ELEVENLABS_MODEL_ID
```

Browse voices at [elevenlabs.io/voice-library](https://elevenlabs.io/voice-library).

**OpenAI**:

```yaml
tts:
  provider: openai
  apiKey: sk-...                        # Or OPENAI_API_KEY env var
  voiceId: alloy                        # Or OPENAI_TTS_VOICE (options: alloy, echo, fable, onyx, nova, shimmer)
  model: tts-1                          # Or OPENAI_TTS_MODEL (use tts-1-hd for higher quality)
```

### Channel Support

| Channel   | Delivery | Notes |
|-----------|----------|-------|
| Telegram  | Native voice bubble | Falls back to audio file if user has voice message privacy enabled (Telegram Premium). Users can allow via Settings > Privacy and Security > Voice Messages. |
| WhatsApp  | Native voice bubble | Sent with push-to-talk (`ptt: true`) for native rendering. |
| Discord   | Audio attachment | Playable inline. |
| Slack     | Audio attachment | Playable inline. |
| Signal    | Audio attachment | Sent as a file attachment. |

### When to Use Voice

- User sent a voice message and a voice reply feels natural
- User explicitly asks for a voice/audio response
- Short, conversational responses (under ~30 seconds of speech)

### When NOT to Use Voice

- Code snippets, file paths, URLs, or structured data -- these should be text
- Long responses (keep voice under ~30 seconds)
- When the user has indicated a preference for text

## CLI Tools

### `lettabot-tts`

Generate audio from the command line:

```bash
lettabot-tts "Hello, this is a test"           # Outputs file path to stdout
lettabot-tts "Hello" /tmp/output.ogg            # Explicit output path
```

Output files are written to `data/outbound/` by default and auto-cleaned after 1 hour.

### `lettabot-message --voice`

Send a voice note from a background task (heartbeat, cron):

```bash
# Generate + send in one step
OUTPUT=$(lettabot-tts "Your message here") || exit 1
lettabot-message send --file "$OUTPUT" --voice

# Send to a specific channel
lettabot-message send --file "$OUTPUT" --voice --channel telegram --chat 123456
```

## Environment Variable Reference

| Variable | Description | Default |
|----------|-------------|---------|
| **Transcription** | | |
| `OPENAI_API_KEY` | OpenAI API key (Whisper transcription + OpenAI TTS) | -- |
| `MISTRAL_API_KEY` | Mistral API key (Voxtral transcription) | -- |
| `TRANSCRIPTION_MODEL` | Override transcription model | `whisper-1` / `voxtral-mini-latest` |
| **Text-to-Speech** | | |
| `TTS_PROVIDER` | TTS backend | `elevenlabs` |
| `ELEVENLABS_API_KEY` | ElevenLabs API key | -- |
| `ELEVENLABS_VOICE_ID` | ElevenLabs voice ID | `onwK4e9ZLuTAKqWW03F9` |
| `ELEVENLABS_MODEL_ID` | ElevenLabs model | `eleven_multilingual_v2` |
| `OPENAI_TTS_VOICE` | OpenAI TTS voice name | `alloy` |
| `OPENAI_TTS_MODEL` | OpenAI TTS model | `tts-1` |

All environment variables can be overridden by the equivalent YAML config fields (see above).

## Troubleshooting

### Voice messages not transcribing

1. Check that an API key is configured -- either in `lettabot.yaml` under `transcription.apiKey` or via the `OPENAI_API_KEY` / `MISTRAL_API_KEY` environment variable
2. Check the logs for transcription errors
3. If using an unsupported audio format, install `ffmpeg` for automatic conversion

### Voice memos not generating

1. Check that a TTS provider is configured -- either in `lettabot.yaml` under `tts` or via `ELEVENLABS_API_KEY` / `OPENAI_API_KEY`
2. Check that `jq` and `curl` are installed (required by the `lettabot-tts` script)
3. Check logs for TTS API errors (HTTP status codes, rate limits)

### Telegram voice privacy

If the bot sends audio files instead of voice bubbles on Telegram, the recipient has voice message privacy enabled (Telegram Premium feature). They can allow voice messages via Settings > Privacy and Security > Voice Messages.

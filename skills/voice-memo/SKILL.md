---
name: voice-memo
description: Reply with voice memos using ElevenLabs text-to-speech. Use when the user sends a voice message, asks for an audio reply, or when a voice response would be more natural.
---

# Voice Memo Responses

Generate voice memos using ElevenLabs TTS and send them as native voice notes.

## Requirements

Set `TTS_PROVIDER` to choose the TTS backend (default: `elevenlabs`).

**ElevenLabs** (`TTS_PROVIDER=elevenlabs`):
- `ELEVENLABS_API_KEY` -- required
- `ELEVENLABS_VOICE_ID` -- optional (default: `21m00Tcm4TlvDq8ikWAM` / Rachel)
- `ELEVENLABS_MODEL_ID` -- optional (default: `eleven_multilingual_v2`)

**OpenAI** (`TTS_PROVIDER=openai`):
- `OPENAI_API_KEY` -- required (usually already set)
- `OPENAI_TTS_VOICE` -- optional (default: `alloy`)
- `OPENAI_TTS_MODEL` -- optional (default: `tts-1`)

## Usage

`lettabot-tts` is on PATH and callable directly. It generates an OGG Opus audio file and prints the output path.

```bash
lettabot-tts "Your message here"
# prints: /tmp/lettabot/data/outbound/voice-1709012345.ogg
```

### Responsive mode

Generate audio, then send via directive:

```bash
OUTPUT=$(lettabot-tts "Your message here")
```

Then respond with:

```
<actions>
  <send-file path="<output path>" kind="audio" cleanup="true" />
</actions>
```

Or with accompanying text:

```
<actions>
  <send-file path="<output path>" kind="audio" cleanup="true" />
</actions>
Here's a voice reply!
```

### Silent mode (heartbeats, cron)

```bash
OUTPUT=$(lettabot-tts "Your message here") || exit 1
lettabot-message send --file "$OUTPUT" --voice
```

## When to Use Voice

- User sent a voice message and a voice reply feels natural
- User explicitly asks for a voice/audio response
- Short, conversational responses (voice is awkward for long technical content)

## When NOT to Use Voice

- Code snippets, file paths, URLs, or structured data (these should be text)
- Long responses -- keep voice memos under ~30 seconds of speech
- When the user has indicated a preference for text
- When `ELEVENLABS_API_KEY` is not set

## Notes

- Audio format is OGG Opus, which renders as native voice bubbles on Telegram and WhatsApp
- Discord and Slack will show it as a playable audio attachment
- Use `cleanup="true"` to delete the audio file after sending
- The `data/outbound/` directory is the default allowed path for send-file directives
- The script uses `$LETTABOT_WORKING_DIR` to output files to the correct directory
- On Telegram, if the user has voice message privacy enabled (Telegram Premium), the bot falls back to sending as an audio file instead of a voice bubble. Users can allow voice messages via Settings > Privacy and Security > Voice Messages.

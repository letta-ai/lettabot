---
name: voice-memo
description: Reply with voice memos using text-to-speech. Use when the user sends a voice message, asks for an audio reply, or when a voice response would be more natural.
---

# Voice Memo Responses

Generate voice memos using TTS and send them as native voice notes.

## Usage

Use the `<voice>` directive to send voice memos. No tool calls needed:

```
<actions>
  <voice>Hey, here's a quick update on that thing we discussed.</voice>
</actions>
```

With accompanying text:

```
<actions>
  <voice>Here's the summary as audio.</voice>
</actions>
And here it is in text form too!
```

### Silent mode (heartbeats, cron)

For background tasks that need to send voice without a user message context:

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

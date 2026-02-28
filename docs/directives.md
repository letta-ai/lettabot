# Response Directives

LettaBot supports XML response directives -- lightweight actions that the agent embeds directly in its text responses. The bot parses and executes these directives before delivering the message, stripping them from the output so the user never sees raw XML.

This is cheaper than tool calls (no round trip to the server) and extends the existing `<no-reply/>` pattern.

## How It Works

The agent includes an `<actions>` block at the **start** of its response:

```
<actions>
  <react emoji="thumbsup" />
</actions>
Great idea!
```

The bot:
1. Detects the `<actions>` block during streaming (held back from display)
2. Parses the directives inside it
3. Executes each directive (e.g. adds a reaction)
4. Delivers only the clean text (`Great idea!`) to the user

If the `<actions>` block is the entire response (no text after it), the directive executes silently with no message sent.

## Supported Directives

### `<react>`

Adds an emoji reaction to a message.

```xml
<react emoji="thumbsup" />
<react emoji="eyes" message="456" />
```

**Attributes:**
- `emoji` (required) -- The emoji to react with. Accepts:
  - Text aliases: `thumbsup`, `eyes`, `fire`, `heart`, `tada`, `clap`, `smile`, `laughing`, `ok_hand`, `thumbs_up`, `+1`
  - Colon-wrapped aliases: `:thumbsup:`
  - Unicode emoji: direct characters like `👍`
- `message` (optional) -- Target message ID. Defaults to the message that triggered the response.

### `<send-file>`

Sends a file or image to the same channel/chat as the triggering message.

```xml
<send-file path="/tmp/report.pdf" caption="Report attached" />
<send-file path="/tmp/photo.png" kind="image" caption="Look!" />
<send-file path="/tmp/voice.ogg" kind="audio" cleanup="true" />
<send-file path="/tmp/temp-export.csv" cleanup="true" />
```

**Attributes:**
- `path` / `file` (required) -- Local file path on the LettaBot server
- `caption` / `text` (optional) -- Caption text for the file
- `kind` (optional) -- `image`, `file`, or `audio` (defaults to auto-detect based on extension). Audio files (.ogg, .opus, .mp3, .m4a, .wav, .aac, .flac) are auto-detected as `audio`.
- `cleanup` (optional) -- `true` to delete the file after sending (default: false)

**Security:**
- File paths are restricted to the configured `sendFileDir` directory (defaults to `data/outbound/` under the agent's working directory). Paths outside this directory are blocked and logged.
- Symlinks that resolve outside the allowed directory are also blocked.
- File size is limited to `sendFileMaxSize` (default: 50MB).
- The `cleanup` attribute only works when `sendFileCleanup: true` is set in the agent's features config (disabled by default).

### `<voice>`

Generates speech from text via TTS and sends it as a native voice note. No tool calls needed.

```xml
<voice>Hey, here's a quick voice reply!</voice>
```

The text content is sent to the configured TTS provider (see [TTS Configuration](./configuration.md#text-to-speech-tts-configuration)), converted to audio, and delivered as a voice note. Audio is automatically cleaned up after sending.

- Requires `tts` to be configured in `lettabot.yaml`
- Renders as native voice bubbles on Telegram and WhatsApp
- Discord and Slack receive a playable audio attachment
- On Telegram, falls back to audio file if voice messages are restricted by Premium privacy settings
- Can be combined with text: any text after the `</actions>` block is sent as a normal message alongside the voice note

### `<no-reply/>`

Suppresses response delivery entirely. The agent's text is discarded.

```
<no-reply/>
```

This is a standalone marker (not inside `<actions>`) and must be the entire response text. Useful when the agent decides observation is more appropriate than replying (e.g. in group chats).

## Attribute Quoting

The parser accepts multiple quoting styles to handle variation in LLM output:

```xml
<!-- All of these work -->
<react emoji="thumbsup" />
<react emoji='thumbsup' />
<react emoji=\"thumbsup\" />
```

Backslash-escaped quotes (common when LLMs generate XML inside a JSON context) are normalized before parsing.

## Channel Support

| Channel   | `addReaction` | `send-file` | `kind="audio"` | Notes |
|-----------|:---:|:---:|:---:|-------|
| Telegram  | Yes | Yes | Voice note (`sendVoice`) | Falls back to `sendAudio` if voice messages are restricted by Telegram Premium privacy settings. |
| Slack     | Yes | Yes | Audio attachment | Reactions use Slack emoji names (`:thumbsup:` style). |
| Discord   | Yes | Yes | Audio attachment | Custom server emoji not yet supported. |
| WhatsApp  | No  | Yes | Voice note (PTT) | Sent with `ptt: true` for native voice bubble. |
| Signal    | No  | No  | No | Directive skipped with a warning. |

When a channel doesn't implement `addReaction`, the directive is silently skipped and a warning is logged. This never blocks message delivery.

## Emoji Alias Resolution

Each channel adapter resolves emoji aliases independently since platforms have different requirements:

- **Telegram/Discord**: Map text aliases (`thumbsup`, `fire`, etc.) to Unicode characters
- **Slack**: Maps Unicode back to Slack shortcode names, or passes `:alias:` format through directly

The common aliases supported across all reaction-capable channels:

| Alias | Emoji |
|-------|-------|
| `eyes` | 👀 |
| `thumbsup` / `thumbs_up` / `+1` | 👍 |
| `heart` | ❤️ |
| `fire` | 🔥 |
| `smile` | 😄 |
| `laughing` | 😆 |
| `tada` | 🎉 |
| `clap` | 👏 |
| `ok_hand` | 👌 |

Unicode emoji can always be used directly and are passed through as-is.

## Streaming Behavior

During streaming, the bot holds back display while the response could still be an `<actions>` block or `<no-reply/>` marker. Once the block is complete (or clearly not present), the cleaned text begins streaming to the user. This prevents raw XML from flashing in the chat.

## Extending with New Directives

The parser (`src/core/directives.ts`) is designed to be extensible. Adding a new directive type involves:

1. Add the tag name to `CHILD_DIRECTIVE_REGEX` (e.g. `<(react|send-file)`)
2. Add a new interface to the `Directive` union type
3. Add a parsing case in `parseChildDirectives()`
4. Add an execution case in `executeDirectives()` in `bot.ts`

See issue [#240](https://github.com/letta-ai/lettabot/issues/240) for planned directives.

## Source

- Parser: `src/core/directives.ts`
- Execution: `src/core/bot.ts` (`executeDirectives()`)
- Tests: `src/core/directives.test.ts`
- Original PR: [#239](https://github.com/letta-ai/lettabot/pull/239)

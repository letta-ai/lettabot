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

| Channel   | `addReaction` | Notes |
|-----------|:---:|-------|
| Telegram  | Yes | Limited to Telegram's [allowed reaction set](https://core.telegram.org/bots/api#reactiontype) (~75 emoji) |
| Slack     | Yes | Uses Slack emoji names (`:thumbsup:` style). Custom workspace emoji supported. |
| Discord   | Yes | Unicode emoji and common aliases. Custom server emoji not yet supported. |
| WhatsApp  | No  | Directive is skipped with a warning |
| Signal    | No  | Directive is skipped with a warning |

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

See issue [#240](https://github.com/letta-ai/lettabot/issues/240) for planned directives like `<send-file>`.

## Source

- Parser: `src/core/directives.ts`
- Execution: `src/core/bot.ts` (`executeDirectives()`)
- Tests: `src/core/directives.test.ts`
- Original PR: [#239](https://github.com/letta-ai/lettabot/pull/239)

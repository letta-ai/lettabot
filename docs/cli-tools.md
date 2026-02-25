# CLI Tools

LettaBot ships with a few small CLIs that the agent can invoke via Bash, or you can run manually.
They use the same config/credentials as the bot server.

## lettabot-message

Send a message to the most recent chat, or target a specific channel/chat.

```bash
lettabot-message send --text "Hello from a background task"
lettabot-message send --text "Hello" --channel slack --chat C123456
lettabot-message send --file /tmp/report.pdf --text "Report attached" --channel discord --chat 123456789
lettabot-message send --file /tmp/voice.ogg --voice    # Send as native voice note
```

## lettabot-react

Add a reaction to a message (emoji can be unicode or :alias:).

```bash
lettabot-react add --emoji :eyes: --channel discord --chat 123 --message 456
lettabot-react add --emoji "👍"
```

## lettabot-history

Fetch recent messages from supported channels (Discord, Slack).

```bash
lettabot-history fetch --limit 25 --channel discord --chat 123456789
lettabot-history fetch --limit 10 --channel slack --chat C123456 --before 1712345678.000100
```

Notes:
- History fetch is not supported by the Telegram Bot API, Signal, or WhatsApp.
- If you omit `--channel` or `--chat`, the CLI falls back to the last message target stored in `lettabot-agent.json`.
- You need the channel-specific bot token set (`DISCORD_BOT_TOKEN` or `SLACK_BOT_TOKEN`).
- File sending uses the API server and requires `LETTABOT_API_KEY` (supported: telegram, slack, discord, whatsapp).

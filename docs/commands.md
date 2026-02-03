# Commands Reference

LettaBot responds to these slash commands in chat channels.

## Available Commands

### `/start` or `/help`

Shows the welcome message and list of available commands.

```
LettaBot - AI assistant with persistent memory

Commands:
/status - Show current status
/help - Show this message

Just send me a message to get started!
```

### `/status`

Shows your current agent ID and connection status.

Useful for debugging or if you need to reference your agent in other tools.

**Example:**
```
You: /status
Bot: Agent: agent-a1b2c3d4-...
     Model: claude-sonnet-4
     Channels: telegram, slack
```

### `/heartbeat`

Manually triggers a heartbeat check-in.

Heartbeats are background tasks where the agent can:
- Review pending tasks
- Check reminders
- Perform proactive actions

**Note:** This command runs silently - the agent won't automatically reply. If the agent wants to message you during a heartbeat, it will use the `lettabot-message` CLI.

## Sending Messages

Just type any message to chat with your agent. The agent has:

- **Persistent memory** - Remembers your conversations over time
- **Tool access** - Can search files, browse the web, and more
- **Streaming responses** - You'll see the response appear in real-time

**Tips:**
- Be specific in your requests
- The agent remembers context, so you can refer back to previous conversations
- For long tasks, the "typing..." indicator will stay active

## Formatting

The bot supports markdown formatting in responses:

- **Bold** text
- *Italic* text
- `Inline code`
- ```Code blocks```
- [Links](https://example.com)

Note: Available formatting varies by channel. WhatsApp and Signal have limited markdown support.

## Cross-Channel Commands

Commands work the same across all channels (Telegram, Slack, Discord, WhatsApp, Signal). The agent maintains a single conversation across all channels.

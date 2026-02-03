# Scheduling Tasks (Cron & Heartbeat)

LettaBot supports two types of background tasks:
- **Cron jobs**: Send scheduled messages at specific times
- **Heartbeats**: Periodic agent check-ins

## Enabling Background Tasks

Add to your `lettabot.yaml`:

```yaml
features:
  cron: true
  heartbeat:
    enabled: true
    intervalMin: 60    # Every 60 minutes
```

Or via environment variables:

```bash
CRON_ENABLED=true
HEARTBEAT_ENABLED=true
HEARTBEAT_INTERVAL_MIN=60
```

## Cron Jobs

Schedule tasks that send you messages at specific times.

### Creating a Job

```bash
lettabot-cron create \
  --name "Morning Briefing" \
  --schedule "0 8 * * *" \
  --message "Good morning! Review tasks for today." \
  --deliver telegram:123456789
```

**Options:**
- `--name` - Job name (required)
- `--schedule` - Cron expression (required)
- `--message` - Message sent when job runs (required)
- `--deliver` - Where to send: `channel:chatId` (defaults to last messaged chat)

### Managing Jobs

```bash
lettabot-cron list              # Show all jobs
lettabot-cron delete <id>       # Delete a job
lettabot-cron enable <id>       # Enable a job
lettabot-cron disable <id>      # Disable a job
```

### Cron Expression Syntax

```
┌───────── minute (0-59)
│ ┌─────── hour (0-23)
│ │ ┌───── day of month (1-31)
│ │ │ ┌─── month (1-12)
│ │ │ │ ┌─ day of week (0-6, Sun=0)
* * * * *
```

**Examples:**

| Expression | When |
|------------|------|
| `0 8 * * *` | Daily at 8:00 AM |
| `0 9 * * 1-5` | Weekdays at 9:00 AM |
| `0 */2 * * *` | Every 2 hours |
| `30 17 * * 5` | Fridays at 5:30 PM |
| `0 0 1 * *` | First of month at midnight |

### Example Jobs

**Daily morning check-in:**
```bash
lettabot-cron create \
  -n "Morning" \
  -s "0 8 * * *" \
  -m "Good morning! What's on today's agenda?"
```

**Weekly review:**
```bash
lettabot-cron create \
  -n "Weekly Review" \
  -s "0 17 * * 5" \
  -m "Friday wrap-up: What did we accomplish this week?"
```

**Hourly reminder:**
```bash
lettabot-cron create \
  -n "Hydration" \
  -s "0 * * * *" \
  -m "Time to drink water!"
```

## Heartbeats

Heartbeats are periodic check-ins where the agent can:
- Review pending tasks
- Check reminders
- Perform proactive actions

### Configuration

```yaml
features:
  heartbeat:
    enabled: true
    intervalMin: 60    # Default: 60 minutes
```

### Manual Trigger

You can trigger a heartbeat manually via the `/heartbeat` command in any channel.

### How It Works

1. At each interval (or when `/heartbeat` is called), the agent receives a heartbeat message
2. The agent runs in **Silent Mode** - responses are not automatically delivered
3. If the agent wants to message you, it must use `lettabot-message send`

This prevents unwanted messages while allowing proactive behavior when needed.

## Silent Mode

Both cron jobs and heartbeats run in **Silent Mode**:

- The agent's text output is NOT automatically sent to users
- The agent sees a `[SILENT MODE]` banner with instructions
- To send messages, the agent must explicitly run:

```bash
lettabot-message send --text "Your message here"
```

**Requirements for background messaging:**
- Bash tool must be enabled for the agent
- A user must have messaged the bot at least once (establishes delivery target)

## Monitoring & Logs

### Check Job Status

```bash
lettabot-cron list
```

Shows:
- Job ID, name, schedule
- Next run time
- Last run status

### Log Files

- `cron-jobs.json` - Job configurations
- `cron-log.jsonl` - Execution logs

## Troubleshooting

### Cron jobs not running

1. Check `features.cron: true` in config
2. Verify schedule expression is valid
3. Check `lettabot-cron list` for next run time

### Agent not sending messages during heartbeat

1. Check if Bash tool is enabled (agent needs to run CLI)
2. Verify a user has messaged the bot at least once
3. Check the [ADE](https://app.letta.com) to see agent activity

### Jobs running but no messages received

The agent runs in Silent Mode - it must actively choose to send messages. Check the agent's behavior in the ADE to see what it's doing during background tasks.

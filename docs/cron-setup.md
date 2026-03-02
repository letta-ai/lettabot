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
- `--deliver` - Where to send: `channel:chatId` (defaults to last messaged chat at creation time; falls back to last messaged chat at runtime)
- `--silent` - Do not deliver response automatically (agent must use `lettabot-message send`)

### Managing Jobs

```bash
lettabot-cron list              # Show all jobs
lettabot-cron update <id> ...   # Update job properties (--deliver, --name, --message, etc.)
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
    skipRecentUserMin: 5  # Skip auto-heartbeats for N minutes after user messages (0 disables)
```

By default, automatic heartbeats are skipped for 5 minutes after a user message to avoid immediate follow-up noise.
- Set `skipRecentUserMin: 0` to disable this skip behavior.
- Manual `/heartbeat` always bypasses the skip check.

### Manual Trigger

You can trigger a heartbeat manually via the `/heartbeat` command in any channel.

### How It Works

1. At each interval (or when `/heartbeat` is called), the agent receives a heartbeat message
2. The agent runs in **Silent Mode** - responses are not automatically delivered
3. If the agent wants to message you, it must use `lettabot-message send`

This prevents unwanted messages while allowing proactive behavior when needed.

### Heartbeat To-Dos

Heartbeats include a `PENDING TO-DOS` section when actionable tasks exist. Tasks can come from:
- `lettabot todo ...` CLI commands
- The `manage_todo` tool
- Built-in Letta Code todo tools (`TodoWrite`, `WriteTodos`, `write_todos`), which are synced into LettaBot's persistent todo store

Only actionable tasks are shown in the heartbeat prompt:
- `completed: false`
- `snoozed_until` not set, or already in the past

## Delivery Behavior

### Cron Jobs

Cron jobs deliver responses automatically:
- If `--deliver` was specified at creation, responses go to that channel/chat
- If `--deliver` was omitted, the CLI auto-fills from the last messaged chat
- At runtime, if a job has no configured delivery target, it falls back to the most recent message target
- Use `--silent` at creation to explicitly opt out of automatic delivery

### Heartbeats (Silent Mode)

Heartbeats run in **Silent Mode** -- responses are NOT automatically delivered:

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

### Cron Storage Path

Cron state is resolved with deterministic precedence:

1. `RAILWAY_VOLUME_MOUNT_PATH`
2. `DATA_DIR`
3. `WORKING_DIR`
4. `/tmp/lettabot`

Migration note:
- Older versions used `process.cwd()/cron-jobs.json` when `DATA_DIR` was not set.
- On first run after upgrade, LettaBot auto-copies that legacy file into the new canonical cron path.

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

1. Check `lettabot-cron list` -- does the job show a delivery target?
2. If delivery shows `(none)`, the job was created without `--deliver` and no user had messaged the bot yet
3. Fix: `lettabot-cron update <id> --deliver telegram:123456789` (or your channel:chatId)
4. Alternatively, send the bot any message to establish a last-message target -- new runs will auto-deliver
5. Check logs for `"mode":"silent"` entries -- this confirms the job ran but had nowhere to send the response

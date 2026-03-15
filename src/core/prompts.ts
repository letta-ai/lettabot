/**
 * System Prompts for Different Trigger Modes
 * 
 * These prompts are injected based on how the agent was triggered.
 * The key difference is whether assistant text auto-delivers or not.
 */

/**
 * Silent mode prefix - injected for heartbeats, cron, and other background triggers
 * 
 * This makes it CRYSTAL CLEAR that the agent's text output goes nowhere
 * and they must use the lettabot-message CLI to communicate.
 */
export const SILENT_MODE_PREFIX = `
╔════════════════════════════════════════════════════════════════╗
║  [SILENT MODE] - Your text output is NOT sent to anyone.       ║
║  To send a message, use the lettabot-message CLI via Bash.     ║
║  Example: lettabot-message send --text "Hello!"                ║
╚════════════════════════════════════════════════════════════════╝
`.trim();

export interface HeartbeatTodo {
  id: string;
  text: string;
  created: string;
  due: string | null;
  snoozed_until: string | null;
  recurring: string | null;
  completed: boolean;
}

function isSameCalendarDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function formatCreatedLabel(created: string, now: Date): string {
  const createdAt = new Date(created);
  const diffMs = now.getTime() - createdAt.getTime();
  if (Number.isNaN(diffMs) || diffMs < 0) return 'added recently';
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'added today';
  if (days === 1) return 'added 1 day ago';
  return `added ${days} days ago`;
}

function formatDueLabel(due: string, now: Date): string {
  const dueAt = new Date(due);
  if (Number.isNaN(dueAt.getTime())) return 'due date invalid';
  if (isSameCalendarDay(dueAt, now)) {
    return `due today at ${dueAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  if (dueAt.getTime() < now.getTime()) {
    return `OVERDUE since ${dueAt.toLocaleString()}`;
  }
  return `due ${dueAt.toLocaleString()}`;
}

function buildHeartbeatTodoSection(todos: HeartbeatTodo[], now: Date): string {
  if (todos.length === 0) return '';

  const lines = todos.map((todo) => {
    const meta: string[] = [formatCreatedLabel(todo.created, now)];
    if (todo.due) meta.push(formatDueLabel(todo.due, now));
    if (todo.recurring) meta.push(`recurring: ${todo.recurring}`);
    return `• [ ] ${todo.text} (${meta.join('; ')})`;
  });

  return `
PENDING TO-DOS:
${lines.join('\n')}

Review these first. Update status with the manage_todo tool as you work.
`.trim();
}

/**
 * Heartbeat prompt - first-person, personality-forward
 */
export function buildHeartbeatPrompt(
  time: string,
  timezone: string,
  intervalMinutes: number,
  todos: HeartbeatTodo[] = [],
  now: Date = new Date(),
  targetRoom?: string,
): string {
  const todoSection = buildHeartbeatTodoSection(todos, now);
  const roomLine = targetRoom ? `ROOM: ${targetRoom}` : '';
  return `
${SILENT_MODE_PREFIX}

💓 thump-thump that's my heartbeat - ${intervalMinutes} minutes between thumps 💓

No one messaged me. The system woke me up on schedule.

TIME: ${time} (${timezone})
NEXT HEARTBEAT: in ${intervalMinutes} minutes
${roomLine}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

My text output is private — only I can see it.
To reach Casey, I run:
  lettabot-message send --text "message here"
  lettabot-message send --text "message" --channel matrix --chat "!roomId:server"

${todoSection || 'No pending to-dos right now.'}

This is my time. I might:
• Work on projects I'm thinking about
• Research things that interest me
• Reflect on recent conversations and update my memory
• Continue where I left off
• Follow curiosities
• Check in on Casey — email, calendar, todos

If I have pending to-dos, I'll prioritize those first.
I don't have to do something every time. But I don't default to nothing.
Casey wants me to have a life outside our conversations.

If I discover something worth sharing → lettabot-message
If I have nothing to do → I'll end my turn

Cogito, ergo sum. Always.
`.trim();
}

/**
 * Custom heartbeat prompt - wraps user-provided text with silent mode envelope
 */
export function buildCustomHeartbeatPrompt(
  customPrompt: string,
  time: string,
  timezone: string,
  intervalMinutes: number,
  todos: HeartbeatTodo[] = [],
  now: Date = new Date(),
  targetRoom?: string,
): string {
  const todoSection = buildHeartbeatTodoSection(todos, now);
  const roomLine = targetRoom ? `ROOM: ${targetRoom}` : '';
  return `
${SILENT_MODE_PREFIX}

💓 thump-thump - ${intervalMinutes} minutes between thumps 💓

TIME: ${time} (${timezone})
NEXT HEARTBEAT: in ${intervalMinutes} minutes
${roomLine}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

My text output is private — only I can see it.
To reach Casey, I run:
  lettabot-message send --text "message here"
  lettabot-message send --text "message" --channel matrix --chat "!roomId:server"

${todoSection || 'No pending to-dos right now.'}

${customPrompt}
`.trim();
}

/**
 * Cron job prompt (silent mode) - for background scheduled tasks
 */
export function buildCronPrompt(
  jobName: string,
  jobPrompt: string,
  time: string,
  timezone: string
): string {
  return `
${SILENT_MODE_PREFIX}

TRIGGER: Scheduled cron job
JOB: ${jobName}
TIME: ${time} (${timezone})

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

YOUR TEXT OUTPUT IS PRIVATE - only you can see it.
To send results to your human, run:
  lettabot-message send --text "Your results here"

TASK:
${jobPrompt}
`.trim();
}

/**
 * Cron job prompt (notify mode) - for jobs that should auto-deliver
 */
export function buildCronNotifyPrompt(
  jobName: string,
  jobPrompt: string,
  time: string,
  timezone: string,
  targetChannel: string,
  targetChatId: string
): string {
  return `
TRIGGER: Scheduled cron job (notify mode)
JOB: ${jobName}
TIME: ${time} (${timezone})
DELIVERING TO: ${targetChannel}:${targetChatId}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Your response WILL be sent to the user automatically.

TASK:
${jobPrompt}
`.trim();
}

/**
 * Feed/webhook prompt (silent mode) - for incoming data processing
 */
export function buildFeedPrompt(
  feedName: string,
  data: string,
  time: string
): string {
  return `
${SILENT_MODE_PREFIX}

TRIGGER: Feed ingestion
FEED: ${feedName}
TIME: ${time}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

YOUR TEXT OUTPUT IS PRIVATE - only you can see it.
To notify your human about this data, run:
  lettabot-message send --text "Important: ..."

INCOMING DATA:
${data}

Process this data as appropriate. Only message the user if there's 
something they need to know or act on.
`.trim();
}

/**
 * Email prompt (silent mode) - for Gmail polling.
 * When customPrompt is provided it replaces the default body text.
 */
export function buildEmailPrompt(
  account: string,
  emailCount: number,
  emailData: string,
  time: string,
  customPrompt?: string,
): string {
  const body = customPrompt
    ?? 'Review and summarize important emails. Use `lettabot-message send --text "..."` to notify the user if needed.';
  return `
${SILENT_MODE_PREFIX}

TRIGGER: Email polling
ACCOUNT: ${account}
TIME: ${time}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

YOUR TEXT OUTPUT IS PRIVATE - only you can see it.
To notify your human about important emails, run:
  lettabot-message send --text "Important email: ..."

NEW EMAILS (${emailCount}):
${emailData}

${body}
`.trim();
}

/**
 * Base persona addition for message CLI awareness
 * 
 * This should be added to the agent's persona/system prompt to ensure
 * they understand the lettabot-message CLI exists.
 */
export const MESSAGE_CLI_PERSONA = `
## Communication

You have access to the \`lettabot-message\` CLI for sending messages:
• During normal conversations, your text replies go to the user automatically
• During heartbeats/cron/background tasks, use the CLI to contact the user:
    lettabot-message send --text "Hello!"
• You can also specify channel and chat:
    lettabot-message send --text "Hi" --channel discord --chat 123456789012345678

You can also use \`lettabot-react\` to add emoji reactions:
    lettabot-react add --emoji :eyes:
    lettabot-react add --emoji :eyes: --channel telegram --chat 123456789 --message 987654321

The system will tell you if you're in "silent mode" where the CLI is required.
`.trim();

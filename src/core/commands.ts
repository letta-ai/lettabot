/**
 * Slash Command Utilities
 * 
 * Shared command parsing and help text for all channels.
 */

export const COMMANDS = ['status', 'heartbeat', 'reset', 'help', 'start'] as const;
export type Command = typeof COMMANDS[number];

export const HELP_TEXT = `LettaBot - AI assistant with persistent memory

Commands:
/status - Show current status
/heartbeat - Trigger heartbeat
/reset - Reset conversation (keeps agent memory)
/help - Show this message

Just send a message to get started!`;

/**
 * Parse a slash command from message text.
 * Returns the command name if valid, null otherwise.
 */
export function parseCommand(text: string | undefined | null): Command | null {
  if (!text?.startsWith('/')) return null;
  const cmd = text.slice(1).split(/\s+/)[0]?.toLowerCase();
  return COMMANDS.includes(cmd as Command) ? (cmd as Command) : null;
}

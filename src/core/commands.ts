/**
 * Slash Command Utilities
 * 
 * Shared command parsing and help text for all channels.
 */

export const COMMANDS = ['status', 'heartbeat', 'reset', 'cancel', 'help', 'start', 'model'] as const;
export type Command = typeof COMMANDS[number];

export interface ParsedCommand {
  command: Command;
  args: string;
}

export const HELP_TEXT = `LettaBot - AI assistant with persistent memory

Commands:
/status - Show current status
/heartbeat - Trigger heartbeat
/reset - Reset conversation (keeps agent memory)
/cancel - Abort the current agent run
/model - Show current model and list available models
/model <handle> - Switch to a different model
/help - Show this message

Just send a message to get started!`;

/**
 * Parse a slash command from message text.
 * Returns the command and any trailing arguments, or null if not a valid command.
 */
export function parseCommand(text: string | undefined | null): ParsedCommand | null {
  if (!text?.startsWith('/')) return null;
  const parts = text.slice(1).split(/\s+/);
  const cmd = parts[0]?.toLowerCase();
  if (!COMMANDS.includes(cmd as Command)) return null;
  return { command: cmd as Command, args: parts.slice(1).join(' ') };
}

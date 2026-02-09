#!/usr/bin/env node
/**
 * lettabot-history - Fetch message history from channels
 *
 * Usage:
 *   lettabot-history fetch --limit 50 [--channel discord] [--chat 123456] [--before 789]
 */

// Config loaded from lettabot.yaml
import { loadConfig, applyConfigToEnv } from '../config/index.js';
const config = loadConfig();
applyConfigToEnv(config);
import { fetchHistory, isValidLimit, parseFetchArgs } from './history-core.js';
import { loadLastTarget, STORE_PATH } from './shared.js';

async function fetchCommand(args: string[]): Promise<void> {
  const parsed = parseFetchArgs(args);
  let channel = parsed.channel || '';
  let chatId = parsed.chatId || '';
  const before = parsed.before || '';
  const limit = parsed.limit;

  if (!isValidLimit(limit)) {
    console.error('Error: --limit must be a positive integer');
    console.error('Usage: lettabot-history fetch --limit 50 [--channel discord] [--chat 123456] [--before 789]');
    process.exit(1);
  }

  if (!channel || !chatId) {
    const lastTarget = loadLastTarget(STORE_PATH);
    if (lastTarget) {
      channel = channel || lastTarget.channel;
      chatId = chatId || lastTarget.chatId;
    }
  }

  if (!channel) {
    console.error('Error: --channel is required (no default available)');
    console.error('Specify: --channel discord|slack');
    process.exit(1);
  }

  if (!chatId) {
    console.error('Error: --chat is required (no default available)');
    console.error('Specify: --chat <chat_id>');
    process.exit(1);
  }

  try {
    const output = await fetchHistory(channel, chatId, limit, before || undefined);
    console.log(output);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

function showHelp(): void {
  console.log(`
lettabot-history - Fetch message history from channels

Commands:
  fetch [options]        Fetch recent messages

Fetch options:
  --limit, -l <n>        Max messages (default: 50)
  --channel, -c <name>   Channel: discord, slack
  --chat, --to <id>      Chat/conversation ID (default: last messaged)
  --before, -b <id>      Fetch messages before this message ID

Examples:
  lettabot-history fetch --limit 50
  lettabot-history fetch --limit 50 --channel discord --chat 123456789
  lettabot-history fetch --limit 50 --before 987654321
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    showHelp();
    return;
  }

  if (command === 'fetch') {
    await fetchCommand(args.slice(1));
    return;
  }

  console.error(`Unknown command: ${command}`);
  showHelp();
  process.exit(1);
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

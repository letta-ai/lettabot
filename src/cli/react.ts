#!/usr/bin/env node
/**
 * lettabot-react - Add reactions to messages
 *
 * Usage:
 *   lettabot-react add --emoji "👀" [--channel telegram] [--chat 123456] [--message 789]
 *   lettabot-react add --emoji :eyes:
 *
 * The agent can use this CLI via Bash to react to messages.
 */

// Config loaded from lettabot.yaml
import { loadConfig, applyConfigToEnv } from '../config/index.js';
const config = loadConfig();
applyConfigToEnv(config);
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { getDataDir } from '../utils/paths.js';

interface LastTarget {
  channel: string;
  chatId: string;
  messageId?: string;
}

interface AgentStore {
  agentId?: string;
  lastMessageTarget?: LastTarget;
}

const STORE_PATH = resolve(getDataDir(), 'lettabot-agent.json');

function loadLastTarget(): LastTarget | null {
  try {
    if (existsSync(STORE_PATH)) {
      const store: AgentStore = JSON.parse(readFileSync(STORE_PATH, 'utf-8'));
      return store.lastMessageTarget || null;
    }
  } catch {
    // Ignore
  }
  return null;
}

const EMOJI_ALIAS_TO_UNICODE: Record<string, string> = {
  eyes: '👀',
  thumbsup: '👍',
  thumbs_up: '👍',
  '+1': '👍',
  heart: '❤️',
  fire: '🔥',
  smile: '😄',
  laughing: '😆',
  tada: '🎉',
  clap: '👏',
  ok_hand: '👌',
};

const UNICODE_TO_ALIAS = new Map<string, string>(
  Object.entries(EMOJI_ALIAS_TO_UNICODE).map(([name, value]) => [value, name])
);

function parseAlias(input: string): string | null {
  const match = input.match(/^:([^:]+):$/);
  return match ? match[1] : null;
}

function resolveEmoji(input: string): { unicode?: string; slackName?: string } {
  const alias = parseAlias(input);
  if (alias) {
    return { unicode: EMOJI_ALIAS_TO_UNICODE[alias], slackName: alias };
  }
  return { unicode: input, slackName: UNICODE_TO_ALIAS.get(input) };
}

async function addTelegramReaction(chatId: string, messageId: string, emoji: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set');

  const response = await fetch(`https://api.telegram.org/bot${token}/setMessageReaction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: Number(messageId),
      reaction: [{ type: 'emoji', emoji }],
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Telegram API error: ${error}`);
  }
}

async function addSlackReaction(chatId: string, messageId: string, name: string): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error('SLACK_BOT_TOKEN not set');

  const response = await fetch('https://slack.com/api/reactions.add', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      channel: chatId,
      name,
      timestamp: messageId,
    }),
  });

  const result = await response.json() as { ok: boolean; error?: string };
  if (!result.ok) {
    throw new Error(`Slack API error: ${result.error || 'unknown error'}`);
  }
}

async function addDiscordReaction(chatId: string, messageId: string, emoji: string): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error('DISCORD_BOT_TOKEN not set');

  const encoded = encodeURIComponent(emoji);
  const response = await fetch(
    `https://discord.com/api/v10/channels/${chatId}/messages/${messageId}/reactions/${encoded}/@me`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bot ${token}`,
      },
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Discord API error: ${error}`);
  }
}

async function addReaction(channel: string, chatId: string, messageId: string, emoji: string): Promise<void> {
  const { unicode, slackName } = resolveEmoji(emoji);
  const channelName = channel.toLowerCase();

  switch (channelName) {
    case 'telegram': {
      if (!unicode) throw new Error('Unknown emoji alias for Telegram');
      return addTelegramReaction(chatId, messageId, unicode);
    }
    case 'slack': {
      const name = slackName || parseAlias(emoji)?.replace(/:/g, '') || '';
      if (!name) throw new Error('Unknown emoji alias for Slack');
      return addSlackReaction(chatId, messageId, name);
    }
    case 'discord': {
      if (!unicode) throw new Error('Unknown emoji alias for Discord');
      return addDiscordReaction(chatId, messageId, unicode);
    }
    default:
      throw new Error(`Unknown channel: ${channel}. Supported: telegram, slack, discord`);
  }
}

async function addCommand(args: string[]): Promise<void> {
  let emoji = '';
  let channel = '';
  let chatId = '';
  let messageId = '';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if ((arg === '--emoji' || arg === '-e') && next) {
      emoji = next;
      i++;
    } else if ((arg === '--channel' || arg === '-c') && next) {
      channel = next;
      i++;
    } else if ((arg === '--chat' || arg === '--to') && next) {
      chatId = next;
      i++;
    } else if ((arg === '--message' || arg === '--message-id' || arg === '-m') && next) {
      messageId = next;
      i++;
    }
  }

  if (!emoji) {
    console.error('Error: --emoji is required');
    console.error('Usage: lettabot-react add --emoji "👀" [--channel telegram] [--chat 123456] [--message 789]');
    process.exit(1);
  }

  if (!channel || !chatId || !messageId) {
    const lastTarget = loadLastTarget();
    if (lastTarget) {
      channel = channel || lastTarget.channel;
      chatId = chatId || lastTarget.chatId;
      messageId = messageId || lastTarget.messageId || '';
    }
  }

  if (!channel) {
    console.error('Error: --channel is required (no default available)');
    console.error('Specify: --channel telegram|slack|discord');
    process.exit(1);
  }

  if (!chatId) {
    console.error('Error: --chat is required (no default available)');
    process.exit(1);
  }

  if (!messageId) {
    console.error('Error: --message is required (no default available)');
    console.error('Provide --message or reply to a message first.');
    process.exit(1);
  }

  try {
    await addReaction(channel, chatId, messageId, emoji);
    console.log(`✓ Reacted in ${channel}:${chatId} (${messageId}) with ${emoji}`);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

function showHelp(): void {
  console.log(`
lettabot-react - Add reactions to messages

Commands:
  add [options]           Add a reaction

Add options:
  --emoji, -e <emoji>     Emoji to react with (unicode or :alias:)
  --channel, -c <name>    Channel: telegram, slack, discord (default: last used)
  --chat, --to <id>       Chat/conversation ID (default: last messaged)
  --message, -m <id>      Message ID (default: last messaged)

Examples:
  lettabot-react add --emoji "👀"
  lettabot-react add --emoji :eyes: --channel discord --chat 123 --message 456

Environment variables:
  TELEGRAM_BOT_TOKEN      Required for Telegram
  SLACK_BOT_TOKEN         Required for Slack
  DISCORD_BOT_TOKEN       Required for Discord
`);
}

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'add':
    addCommand(args.slice(1));
    break;
  case 'help':
  case '--help':
  case '-h':
    showHelp();
    break;
  default:
    if (command) {
      if (command.startsWith('-')) {
        addCommand(args);
        break;
      }
      console.error(`Unknown command: ${command}`);
    }
    showHelp();
    break;
}

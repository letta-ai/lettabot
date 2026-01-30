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
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

interface LastTarget {
  channel: string;
  chatId: string;
}

interface AgentStore {
  lastMessageTarget?: LastTarget;
}

const STORE_PATH = resolve(process.cwd(), 'lettabot-agent.json');

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

async function fetchDiscordHistory(chatId: string, limit: number, before?: string): Promise<string> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error('DISCORD_BOT_TOKEN not set');
  }

  const params = new URLSearchParams({ limit: String(limit) });
  if (before) params.set('before', before);

  const response = await fetch(`https://discord.com/api/v10/channels/${chatId}/messages?${params.toString()}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bot ${token}`,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Discord API error: ${error}`);
  }

  const messages = await response.json() as Array<{
    id: string;
    content: string;
    author?: { username?: string; discriminator?: string };
    timestamp?: string;
  }>;

  const output = {
    count: messages.length,
    messages: messages.map((msg) => ({
      messageId: msg.id,
      author: msg.author?.username ? `${msg.author.username}#${msg.author.discriminator || '0000'}` : 'unknown',
      content: msg.content || '',
      timestamp: msg.timestamp,
    })),
  };

  return JSON.stringify(output, null, 2);
}

async function fetchSlackHistory(chatId: string, limit: number, before?: string): Promise<string> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    throw new Error('SLACK_BOT_TOKEN not set');
  }

  const response = await fetch('https://slack.com/api/conversations.history', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      channel: chatId,
      limit,
      ...(before ? { latest: before, inclusive: false } : {}),
    }),
  });

  const result = await response.json() as { ok: boolean; error?: string; messages?: Array<{ ts?: string; text?: string; user?: string; bot_id?: string }> };
  if (!result.ok) {
    throw new Error(`Slack API error: ${result.error || 'unknown error'}`);
  }

  const output = {
    count: result.messages?.length || 0,
    messages: (result.messages || []).map((msg) => ({
      messageId: msg.ts,
      author: msg.user || msg.bot_id || 'unknown',
      content: msg.text || '',
      timestamp: msg.ts ? new Date(Number(msg.ts) * 1000).toISOString() : undefined,
    })),
  };

  return JSON.stringify(output, null, 2);
}

async function fetchHistory(channel: string, chatId: string, limit: number, before?: string): Promise<string> {
  switch (channel.toLowerCase()) {
    case 'discord':
      return fetchDiscordHistory(chatId, limit, before);
    case 'slack':
      return fetchSlackHistory(chatId, limit, before);
    case 'telegram':
      throw new Error('Telegram history fetch is not supported by the Bot API');
    case 'signal':
      throw new Error('Signal history fetch is not supported');
    case 'whatsapp':
      throw new Error('WhatsApp history fetch is not supported');
    default:
      throw new Error(`Unknown channel: ${channel}. Supported: discord, slack`);
  }
}

async function fetchCommand(args: string[]): Promise<void> {
  let channel = '';
  let chatId = '';
  let before = '';
  let limit = 50;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if ((arg === '--limit' || arg === '-l') && next) {
      limit = Number(next);
      i++;
    } else if ((arg === '--channel' || arg === '-c') && next) {
      channel = next;
      i++;
    } else if ((arg === '--chat' || arg === '--to') && next) {
      chatId = next;
      i++;
    } else if ((arg === '--before' || arg === '-b') && next) {
      before = next;
      i++;
    }
  }

  if (!channel || !chatId) {
    const lastTarget = loadLastTarget();
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

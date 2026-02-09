import type { LastTarget } from './shared.js';

export const DEFAULT_LIMIT = 50;

export function isValidLimit(limit: number): boolean {
  return Number.isInteger(limit) && limit > 0;
}

export function parseFetchArgs(args: string[]): {
  channel?: string;
  chatId?: string;
  before?: string;
  limit: number;
} {
  let channel = '';
  let chatId = '';
  let before = '';
  let limit = DEFAULT_LIMIT;

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

  return {
    channel: channel || undefined,
    chatId: chatId || undefined,
    before: before || undefined,
    limit,
  };
}

export async function fetchDiscordHistory(chatId: string, limit: number, before?: string): Promise<string> {
  limit = Math.min(limit, 100);
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
    author?: { username?: string; globalName?: string };
    timestamp?: string;
  }>;

  const output = {
    count: messages.length,
    messages: messages.map((msg) => ({
      messageId: msg.id,
      author: msg.author?.globalName || msg.author?.username || 'unknown',
      content: msg.content || '',
      timestamp: msg.timestamp,
    })),
  };

  return JSON.stringify(output, null, 2);
}

export async function fetchSlackHistory(chatId: string, limit: number, before?: string): Promise<string> {
  limit = Math.min(limit, 1000);
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

  const result = await response.json() as {
    ok: boolean;
    error?: string;
    messages?: Array<{ ts?: string; text?: string; user?: string; bot_id?: string }>;
  };
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

export async function fetchHistory(channel: string, chatId: string, limit: number, before?: string): Promise<string> {
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

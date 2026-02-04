#!/usr/bin/env node
/**
 * lettabot-message - Send messages to channels
 * 
 * Usage:
 *   lettabot-message send --text "Hello!" [--channel telegram] [--chat 123456]
 *   lettabot-message send -t "Hello!"
 * 
 * The agent can use this CLI via Bash to send messages during silent mode
 * (heartbeats, cron jobs) or to send to different channels during conversations.
 */

// Config loaded from lettabot.yaml
import { loadConfig, applyConfigToEnv } from '../config/index.js';
const config = loadConfig();
applyConfigToEnv(config);
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { getDataDir } from '../utils/paths.js';

// Types
interface LastTarget {
  channel: string;
  chatId: string;
}

interface AgentStore {
  agentId?: string;
  lastMessageTarget?: LastTarget;  // Note: field is "lastMessageTarget" not "lastTarget"
}

// Store path (same location as bot uses)
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

// Channel senders
async function sendTelegram(chatId: string, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN not set');
  }
  
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
    }),
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Telegram API error: ${error}`);
  }
  
  const result = await response.json() as { ok: boolean; result?: { message_id: number } };
  if (!result.ok) {
    throw new Error(`Telegram API returned ok=false`);
  }
  
  console.log(`✓ Sent to telegram:${chatId} (message_id: ${result.result?.message_id})`);
}

async function sendSlack(chatId: string, text: string): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    throw new Error('SLACK_BOT_TOKEN not set');
  }
  
  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      channel: chatId,
      text: text,
    }),
  });
  
  const result = await response.json() as { ok: boolean; ts?: string; error?: string };
  if (!result.ok) {
    throw new Error(`Slack API error: ${result.error}`);
  }
  
  console.log(`✓ Sent to slack:${chatId} (ts: ${result.ts})`);
}

async function sendSignal(chatId: string, text: string): Promise<void> {
  // We talk to the signal-cli daemon JSON-RPC API (the same daemon the Signal adapter uses).
  // This is *not* the signal-cli-rest-api container.
  const apiUrl = process.env.SIGNAL_CLI_REST_API_URL || 'http://127.0.0.1:8090';
  const phoneNumber = process.env.SIGNAL_PHONE_NUMBER;

  if (!phoneNumber) {
    throw new Error('SIGNAL_PHONE_NUMBER not set');
  }

  // Support group IDs in the same format we use everywhere else.
  const params: Record<string, unknown> = {
    account: phoneNumber,
    message: text,
  };

  if (chatId.startsWith('group:')) {
    params.groupId = chatId.slice('group:'.length);
  } else {
    params.recipient = [chatId];
  }

  const body = JSON.stringify({
    jsonrpc: '2.0',
    method: 'send',
    params,
    id: Date.now(),
  });

  const response = await fetch(`${apiUrl}/api/v1/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  // signal-cli returns status 201 with empty body sometimes.
  if (response.status === 201) {
    console.log(`✓ Sent to signal:${chatId}`);
    return;
  }

  const textBody = await response.text();
  if (!response.ok) {
    throw new Error(`Signal API error: ${textBody}`);
  }

  if (!textBody.trim()) {
    console.log(`✓ Sent to signal:${chatId}`);
    return;
  }

  const parsed = JSON.parse(textBody) as { result?: unknown; error?: { code?: number; message?: string } };
  if (parsed.error) {
    throw new Error(`Signal RPC ${parsed.error.code ?? 'unknown'}: ${parsed.error.message ?? 'unknown error'}`);
  }

  console.log(`✓ Sent to signal:${chatId}`);
}

async function sendWhatsApp(chatId: string, text: string): Promise<void> {
  // WhatsApp requires a running session, so we write to a queue file
  // that the bot process picks up. For now, error out.
  throw new Error('WhatsApp sending via CLI not yet supported (requires active session)');
}

async function sendDiscord(chatId: string, text: string): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error('DISCORD_BOT_TOKEN not set');
  }

  const response = await fetch(`https://discord.com/api/v10/channels/${chatId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bot ${token}`,
    },
    body: JSON.stringify({ content: text }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Discord API error: ${error}`);
  }

  const result = await response.json() as { id?: string };
  console.log(`✓ Sent to discord:${chatId} (id: ${result.id || 'unknown'})`);
}

async function sendToChannel(channel: string, chatId: string, text: string): Promise<void> {
  switch (channel.toLowerCase()) {
    case 'telegram':
      return sendTelegram(chatId, text);
    case 'slack':
      return sendSlack(chatId, text);
    case 'signal':
      return sendSignal(chatId, text);
    case 'whatsapp':
      return sendWhatsApp(chatId, text);
    case 'discord':
      return sendDiscord(chatId, text);
    default:
      throw new Error(`Unknown channel: ${channel}. Supported: telegram, slack, signal, whatsapp, discord`);
  }
}

// Command handlers
async function sendCommand(args: string[]): Promise<void> {
  let text = '';
  let channel = '';
  let chatId = '';
  
  // Parse args
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    
    if ((arg === '--text' || arg === '-t') && next) {
      text = next;
      i++;
    } else if ((arg === '--channel' || arg === '-c') && next) {
      channel = next;
      i++;
    } else if ((arg === '--chat' || arg === '--to') && next) {
      chatId = next;
      i++;
    }
  }
  
  if (!text) {
    console.error('Error: --text is required');
    console.error('Usage: lettabot-message send --text "Hello!" [--channel telegram] [--chat 123456]');
    process.exit(1);
  }
  
  // Resolve defaults from last target
  if (!channel || !chatId) {
    const lastTarget = loadLastTarget();
    if (lastTarget) {
      channel = channel || lastTarget.channel;
      chatId = chatId || lastTarget.chatId;
    }
  }
  
  if (!channel) {
    console.error('Error: --channel is required (no default available)');
    console.error('Specify: --channel telegram|slack|signal|discord');
    process.exit(1);
  }
  
  if (!chatId) {
    console.error('Error: --chat is required (no default available)');
    console.error('Specify: --chat <chat_id>');
    process.exit(1);
  }
  
  try {
    await sendToChannel(channel, chatId, text);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

function showHelp(): void {
  console.log(`
lettabot-message - Send messages to channels

Commands:
  send [options]          Send a message

Send options:
  --text, -t <text>       Message text (required)
  --channel, -c <name>    Channel: telegram, slack, signal, discord (default: last used)
  --chat, --to <id>       Chat/conversation ID (default: last messaged)

Examples:
  # Send to last messaged user/channel
  lettabot-message send --text "Hello!"

  # Send to specific Telegram chat
  lettabot-message send --text "Hello!" --channel telegram --chat 123456789

  # Short form
  lettabot-message send -t "Done!" -c telegram -to 123456789

Environment variables:
  TELEGRAM_BOT_TOKEN      Required for Telegram
  SLACK_BOT_TOKEN         Required for Slack
  DISCORD_BOT_TOKEN       Required for Discord
  SIGNAL_PHONE_NUMBER     Required for Signal
  SIGNAL_CLI_REST_API_URL Signal daemon URL (default: http://127.0.0.1:8090)
`);
}

// Main
const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'send':
    sendCommand(args.slice(1));
    break;
    
  case 'help':
  case '--help':
  case '-h':
    showHelp();
    break;
    
  default:
    if (command) {
      // Assume it's send with args starting with the command
      // e.g., `lettabot-message --text "Hi"` (no 'send' subcommand)
      if (command.startsWith('-')) {
        sendCommand(args);
        break;
      }
      console.error(`Unknown command: ${command}`);
    }
    showHelp();
    break;
}

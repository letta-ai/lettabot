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
import { existsSync, readFileSync } from 'node:fs';
import { loadLastTarget, STORE_PATH } from './shared.js';

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

/**
 * Send message or file via API (unified multipart endpoint)
 */
async function sendViaApi(
  channel: string,
  chatId: string,
  options: {
    text?: string;
    filePath?: string;
    kind?: 'image' | 'file';
  }
): Promise<void> {
  const apiUrl = process.env.LETTABOT_API_URL || 'http://localhost:8080';
  const apiKey = process.env.LETTABOT_API_KEY;

  if (!apiKey) {
    throw new Error('LETTABOT_API_KEY not set. Check bot server logs for the key.');
  }

  // Check if file exists
  if (options.filePath && !existsSync(options.filePath)) {
    throw new Error(`File not found: ${options.filePath}`);
  }

  // Everything uses multipart now (Option B)
  const formData = new FormData();
  formData.append('channel', channel);
  formData.append('chatId', chatId);

  if (options.text) {
    formData.append('text', options.text);
  }

  if (options.filePath) {
    const fileContent = readFileSync(options.filePath);
    const fileName = options.filePath.split('/').pop() || 'file';
    formData.append('file', new Blob([fileContent]), fileName);
  }

  if (options.kind) {
    formData.append('kind', options.kind);
  }

  const response = await fetch(`${apiUrl}/api/v1/messages`, {
    method: 'POST',
    headers: {
      'X-Api-Key': apiKey,
    },
    body: formData,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API error (${response.status}): ${error}`);
  }

  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error || 'Unknown error');
  }

  const type = options.filePath ? 'file' : 'message';
  console.log(`✓ Sent ${type} to ${channel}:${chatId}`);
}

async function sendWhatsApp(chatId: string, text: string): Promise<void> {
  return sendViaApi('whatsapp', chatId, { text });
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
  let filePath = '';
  let kind: 'image' | 'file' | undefined = undefined;
  let channel = '';
  let chatId = '';

  // Parse args
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if ((arg === '--text' || arg === '-t') && next) {
      text = next;
      i++;
    } else if ((arg === '--file' || arg === '-f') && next) {
      filePath = next;
      i++;
    } else if (arg === '--image') {
      kind = 'image';
    } else if ((arg === '--channel' || arg === '-c' || arg === '-C') && next) {
      channel = next;
      i++;
    } else if ((arg === '--chat' || arg === '--to') && next) {
      chatId = next;
      i++;
    }
  }

  // Check if text OR file provided
  if (!text && !filePath) {
    console.error('Error: --text or --file is required');
    console.error('Usage: lettabot-message send --text "..." OR --file path.pdf [--text "caption"]');
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
    console.error('Specify: --channel telegram|slack|signal|discord|whatsapp');
    process.exit(1);
  }

  if (!chatId) {
    console.error('Error: --chat is required (no default available)');
    console.error('Specify: --chat <chat_id>');
    process.exit(1);
  }

  try {
    // Use API for WhatsApp (unified multipart endpoint)
    if (channel === 'whatsapp') {
      await sendViaApi(channel, chatId, { text, filePath, kind });
    } else if (filePath) {
      // Other channels with files - not yet implemented via API
      throw new Error(`File sending for ${channel} requires API (currently only WhatsApp supported via API)`);
    } else {
      // Other channels with text only - direct API calls
      await sendToChannel(channel, chatId, text);
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

function showHelp(): void {
  console.log(`
lettabot-message - Send messages or files to channels

Commands:
  send [options]          Send a message or file

Send options:
  --text, -t <text>       Message text (or caption when used with --file)
  --file, -f <path>       File path (optional, for file messages)
  --image                 Treat file as image (vs document)
  --channel, -c <name>    Channel: telegram, slack, whatsapp, discord (default: last used)
  --chat, --to <id>       Chat/conversation ID (default: last messaged)

Examples:
  # Send text message
  lettabot-message send --text "Hello!"

  # Send file with caption/text
  lettabot-message send --file screenshot.png --text "Check this out"

  # Send file without text
  lettabot-message send --file photo.jpg --image

  # Send to specific WhatsApp chat
  lettabot-message send --file report.pdf --text "Report attached" --channel whatsapp --chat "+1555@s.whatsapp.net"

  # Short form
  lettabot-message send -t "Done!" -f doc.pdf -c telegram

Environment variables:
  TELEGRAM_BOT_TOKEN      Required for Telegram
  SLACK_BOT_TOKEN         Required for Slack
  DISCORD_BOT_TOKEN       Required for Discord
  SIGNAL_PHONE_NUMBER     Required for Signal (text only, no files)
  LETTABOT_API_KEY        Required for WhatsApp (text and files)
  LETTABOT_API_URL        API server URL (default: http://localhost:8080)
  SIGNAL_CLI_REST_API_URL Signal daemon URL (default: http://127.0.0.1:8090)

Note: WhatsApp uses the API server. Other channels use direct platform APIs.
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

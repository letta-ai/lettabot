#!/usr/bin/env node
/**
 * lettabot-channels - Discover channels across platforms
 *
 * Usage:
 *   lettabot-channels list [--channel discord|slack]
 *
 * The agent can use this CLI via Bash to discover channel IDs
 * for sending messages with lettabot-message.
 */

// Config loaded from lettabot.yaml
import { loadConfig, applyConfigToEnv } from '../config/index.js';
const config = loadConfig();
applyConfigToEnv(config);

// Types
interface DiscordGuild {
  id: string;
  name: string;
}

interface DiscordChannel {
  id: string;
  name: string;
  type: number;
}

interface SlackChannel {
  id: string;
  name: string;
  is_member: boolean;
}

// Discord channel types that are text-based
const DISCORD_TEXT_CHANNEL_TYPES = new Set([
  0,  // GUILD_TEXT
  2,  // GUILD_VOICE
  5,  // GUILD_ANNOUNCEMENT
  13, // GUILD_STAGE_VOICE
  15, // GUILD_FORUM
]);

async function listDiscord(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error('Discord: DISCORD_BOT_TOKEN not set, skipping.');
    return;
  }

  const headers = { Authorization: `Bot ${token}` };

  // Fetch guilds the bot is in
  const guildsRes = await fetch('https://discord.com/api/v10/users/@me/guilds', { headers });
  if (!guildsRes.ok) {
    const error = await guildsRes.text();
    console.error(`Discord: Failed to fetch guilds: ${error}`);
    return;
  }

  const guilds = (await guildsRes.json()) as DiscordGuild[];
  if (guilds.length === 0) {
    console.log('Discord:\n  (bot is not in any servers)');
    return;
  }

  console.log('Discord:');

  for (const guild of guilds) {
    const channelsRes = await fetch(`https://discord.com/api/v10/guilds/${guild.id}/channels`, { headers });
    if (!channelsRes.ok) {
      console.log(`  Server: ${guild.name}`);
      console.log(`    (failed to fetch channels)`);
      continue;
    }

    const channels = (await channelsRes.json()) as DiscordChannel[];
    const textChannels = channels
      .filter((c) => DISCORD_TEXT_CHANNEL_TYPES.has(c.type))
      .sort((a, b) => a.name.localeCompare(b.name));

    console.log(`  Server: ${guild.name}`);
    if (textChannels.length === 0) {
      console.log(`    (no text channels)`);
    } else {
      const maxNameLen = Math.max(...textChannels.map((c) => c.name.length));
      for (const ch of textChannels) {
        const padded = ch.name.padEnd(maxNameLen);
        console.log(`    #${padded}  (id: ${ch.id})`);
      }
    }
  }
}

async function listSlack(): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.error('Slack: SLACK_BOT_TOKEN not set, skipping.');
    return;
  }

  const params = new URLSearchParams({
    types: 'public_channel,private_channel',
    limit: '1000',
  });

  const res = await fetch(`https://slack.com/api/conversations.list?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const data = (await res.json()) as { ok: boolean; channels?: SlackChannel[]; error?: string };
  if (!data.ok) {
    console.error(`Slack: API error: ${data.error}`);
    return;
  }

  const channels = (data.channels || []).sort((a, b) => a.name.localeCompare(b.name));

  console.log('Slack:');
  if (channels.length === 0) {
    console.log('  (no channels found)');
  } else {
    const maxNameLen = Math.max(...channels.map((c) => c.name.length));
    for (const ch of channels) {
      const padded = ch.name.padEnd(maxNameLen);
      console.log(`  #${padded}  (id: ${ch.id})`);
    }
  }
}

function printUnsupported(platform: string): void {
  console.log(`${platform}: Channel listing not supported (platform does not expose a bot-visible channel list).`);
}

async function listCommand(args: string[]): Promise<void> {
  let channel = '';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if ((arg === '--channel' || arg === '-c') && next) {
      channel = next.toLowerCase();
      i++;
    }
  }

  if (channel) {
    switch (channel) {
      case 'discord':
        await listDiscord();
        break;
      case 'slack':
        await listSlack();
        break;
      case 'telegram':
        printUnsupported('Telegram');
        break;
      case 'whatsapp':
        printUnsupported('WhatsApp');
        break;
      case 'signal':
        printUnsupported('Signal');
        break;
      default:
        console.error(`Unknown channel: ${channel}. Supported for listing: discord, slack`);
        process.exit(1);
    }
  } else {
    // List all configured platforms
    const hasDiscord = !!process.env.DISCORD_BOT_TOKEN;
    const hasSlack = !!process.env.SLACK_BOT_TOKEN;

    if (!hasDiscord && !hasSlack) {
      console.log('No supported platforms configured. Set DISCORD_BOT_TOKEN or SLACK_BOT_TOKEN.');
      return;
    }

    if (hasDiscord) {
      await listDiscord();
    }
    if (hasSlack) {
      if (hasDiscord) console.log('');
      await listSlack();
    }
  }
}

function showHelp(): void {
  console.log(`
lettabot-channels - Discover channels across platforms

Commands:
  list [options]          List channels with their IDs

List options:
  --channel, -c <name>    Platform to list: discord, slack (default: all configured)

Examples:
  # List channels for all configured platforms
  lettabot-channels list

  # List Discord channels only
  lettabot-channels list --channel discord

  # List Slack channels only
  lettabot-channels list --channel slack

Environment variables:
  DISCORD_BOT_TOKEN       Required for Discord channel listing
  SLACK_BOT_TOKEN         Required for Slack channel listing

Note: Telegram, WhatsApp, and Signal do not support channel listing.
`);
}

// Main
const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'list':
    listCommand(args.slice(1));
    break;

  case 'help':
  case '--help':
  case '-h':
    showHelp();
    break;

  default:
    if (command) {
      // Allow `lettabot-channels --channel discord` without 'list'
      if (command.startsWith('-')) {
        listCommand(args);
        break;
      }
      console.error(`Unknown command: ${command}`);
    }
    showHelp();
    break;
}

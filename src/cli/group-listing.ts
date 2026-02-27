/**
 * Group Listing Helpers
 *
 * Shared module for listing group/channel IDs across platforms.
 * Used by both the `lettabot channels list-groups` CLI subcommand
 * and the standalone `lettabot-channels` binary.
 */

import { loadAppConfigOrExit, normalizeAgents, type AgentConfig } from '../config/index.js';

// ── Types ────────────────────────────────────────────────────────────────────

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

// ── Platform Listing ─────────────────────────────────────────────────────────

async function listDiscord(token?: string): Promise<void> {
  const discordToken = token || process.env.DISCORD_BOT_TOKEN;
  if (!discordToken) {
    console.error('Discord: DISCORD_BOT_TOKEN not set, skipping.');
    return;
  }

  const headers = { Authorization: `Bot ${discordToken}` };
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
      console.log(`  Server: ${guild.name} (id: ${guild.id})`);
      console.log('    (failed to fetch channels)');
      continue;
    }

    const channels = (await channelsRes.json()) as DiscordChannel[];
    const textChannels = channels
      .filter((c) => DISCORD_TEXT_CHANNEL_TYPES.has(c.type))
      .sort((a, b) => a.name.localeCompare(b.name));

    console.log(`  Server: ${guild.name} (id: ${guild.id})`);
    if (textChannels.length === 0) {
      console.log('    (no text channels)');
    } else {
      const maxNameLen = Math.max(...textChannels.map((c) => c.name.length));
      for (const ch of textChannels) {
        const padded = ch.name.padEnd(maxNameLen);
        console.log(`    #${padded}  (id: ${ch.id})`);
      }
    }
  }
}

async function listSlack(token?: string): Promise<void> {
  const slackToken = token || process.env.SLACK_BOT_TOKEN;
  if (!slackToken) {
    console.error('Slack: SLACK_BOT_TOKEN not set, skipping.');
    return;
  }

  const allChannels: SlackChannel[] = [];
  let cursor = '';

  // Cursor-based pagination for workspaces with >1000 channels
  while (true) {
    const params = new URLSearchParams({
      types: 'public_channel,private_channel',
      exclude_archived: 'true',
      limit: '1000',
    });
    if (cursor) params.set('cursor', cursor);

    const res = await fetch(`https://slack.com/api/conversations.list?${params}`, {
      headers: { Authorization: `Bearer ${slackToken}` },
    });

    const data = (await res.json()) as {
      ok: boolean;
      channels?: SlackChannel[];
      error?: string;
      response_metadata?: { next_cursor?: string };
    };
    if (!data.ok) {
      console.error(`Slack: API error: ${data.error}`);
      return;
    }

    allChannels.push(...(data.channels || []));
    cursor = data.response_metadata?.next_cursor || '';
    if (!cursor) break;
  }

  const channels = allChannels.sort((a, b) => a.name.localeCompare(b.name));

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

// ── Agent Config Resolution ──────────────────────────────────────────────────

export function resolveAgentConfig(agentName?: string): AgentConfig | undefined {
  if (!agentName) return undefined;

  const config = loadAppConfigOrExit();
  const agents = normalizeAgents(config);

  const exact = agents.find(a => a.name === agentName);
  if (exact) return exact;

  const lower = agentName.toLowerCase();
  const found = agents.find(a => a.name.toLowerCase() === lower);
  if (found) return found;

  console.error(`Agent "${agentName}" not found in config`);
  process.exit(1);
}

export function resolveListingTokens(
  agentConfig: AgentConfig | undefined,
  agentName?: string,
): { discordToken?: string; slackToken?: string } {
  // When an agent is explicitly selected, only use that agent's configured tokens.
  // Do not fall back to global env vars (prevents cross-agent token leakage).
  if (agentName) {
    return {
      discordToken: agentConfig?.channels?.discord?.token,
      slackToken: agentConfig?.channels?.slack?.botToken,
    };
  }

  return {
    discordToken: agentConfig?.channels?.discord?.token || process.env.DISCORD_BOT_TOKEN,
    slackToken: agentConfig?.channels?.slack?.botToken || process.env.SLACK_BOT_TOKEN,
  };
}

// ── Arg Parsing ──────────────────────────────────────────────────────────────

export function parseChannelArgs(args: string[]): { channel?: string; agent?: string; error?: string } {
  let channel: string | undefined;
  let agent: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--channel' || arg === '-c') {
      if (!next || next.startsWith('-')) return { error: 'Missing value for --channel' };
      channel = next.toLowerCase();
      i++;
      continue;
    }
    if (arg === '--agent') {
      if (!next || next.startsWith('-')) return { error: 'Missing value for --agent' };
      agent = next;
      i++;
      continue;
    }
    if (!arg.startsWith('-')) {
      if (!channel) {
        channel = arg.toLowerCase();
      } else {
        return { error: `Unexpected argument: ${arg}` };
      }
      continue;
    }
  }

  return { channel, agent };
}

// ── Main Entry Points ────────────────────────────────────────────────────────

export async function listGroups(channel?: string, agentName?: string): Promise<void> {
  const agentConfig = resolveAgentConfig(agentName);

  const { discordToken, slackToken } = resolveListingTokens(agentConfig, agentName);

  if (channel) {
    switch (channel) {
      case 'discord':
        await listDiscord(discordToken);
        break;
      case 'slack':
        await listSlack(slackToken);
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
    return;
  }

  const hasDiscord = !!discordToken;
  const hasSlack = !!slackToken;

  if (!hasDiscord && !hasSlack) {
    if (agentName) {
      console.log(`No Discord or Slack channels configured for agent "${agentName}".`);
    } else {
      console.log('No supported platforms configured. Set DISCORD_BOT_TOKEN or SLACK_BOT_TOKEN.');
    }
    return;
  }

  if (hasDiscord) {
    await listDiscord(discordToken);
  }
  if (hasSlack) {
    if (hasDiscord) console.log('');
    await listSlack(slackToken);
  }
}

export async function listGroupsFromArgs(args: string[]): Promise<void> {
  const { channel, agent, error } = parseChannelArgs(args);
  if (error) {
    console.error(error);
    process.exit(1);
  }
  await listGroups(channel, agent);
}

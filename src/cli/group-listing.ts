/**
 * Group Listing Helpers
 *
 * Shared helper for listing group/channel IDs across platforms.
 */

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

async function listSlack(): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.error('Slack: SLACK_BOT_TOKEN not set, skipping.');
    return;
  }

  const allChannels: SlackChannel[] = [];
  let cursor = '';

  while (true) {
    const params = new URLSearchParams({
      types: 'public_channel,private_channel',
      exclude_archived: 'true',
      limit: '1000',
    });
    if (cursor) params.set('cursor', cursor);

    const res = await fetch(`https://slack.com/api/conversations.list?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
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

function parseChannelArgs(args: string[]): { channel?: string; error?: string } {
  let channel: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if ((arg === '--channel' || arg === '-c') && next) {
      channel = next.toLowerCase();
      i++;
      continue;
    }
    if (arg === '--channel' || arg === '-c') {
      return { error: 'Missing value for --channel' };
    }
    if (!arg.startsWith('-') && !channel) {
      channel = arg.toLowerCase();
    }
  }

  return { channel };
}

export async function listGroups(channel?: string): Promise<void> {
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
    return;
  }

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

export async function listGroupsFromArgs(args: string[]): Promise<void> {
  const { channel, error } = parseChannelArgs(args);
  if (error) {
    console.error(error);
    process.exit(1);
  }
  await listGroups(channel);
}

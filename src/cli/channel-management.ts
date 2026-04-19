/**
 * Channel Management CLI
 * 
 * Ergonomic commands for adding, removing, and managing channels.
 * Uses shared setup functions from src/channels/setup.ts.
 */

import * as p from '@clack/prompts';
import { loadAppConfigOrExit, saveConfig, resolveConfigPath } from '../config/index.js';
import { 
  CHANNELS, 
  getChannelHint, 
  getSetupFunction,
  type ChannelId 
} from '../channels/setup.js';
import { listGroupsFromArgs } from './group-listing.js';

// ============================================================================
// Status Helpers
// ============================================================================

interface ChannelStatus {
  id: ChannelId;
  displayName: string;
  enabled: boolean;
  hint: string;
  details?: string;
}

function getChannelDetails(id: ChannelId, channelConfig: any): string | undefined {
  if (!channelConfig?.enabled) return undefined;
  
  switch (id) {
    case 'telegram':
    case 'discord':
      return `${channelConfig.dmPolicy || 'pairing'} mode`;
    case 'slack':
      return channelConfig.allowedUsers?.length 
        ? `${channelConfig.allowedUsers.length} allowed users`
        : 'workspace access';
    case 'whatsapp':
    case 'signal':
      return channelConfig.selfChat !== false ? 'self-chat mode' : 'dedicated number';
    case 'bluesky':
      return channelConfig.wantedDids?.length
        ? `${channelConfig.wantedDids.length} DID(s)`
        : 'Jetstream feed';
    default:
      return undefined;
  }
}

/**
 * Resolve merged channels from a config object.
 * In multi-agent format (agents[] present), merges agents[0].channels with
 * top-level channels (agent-level takes precedence for overlapping fields).
 * In single-agent format, returns top-level channels directly.
 */
export function resolveChannels(config: any): Record<string, any> {
  const agentChannels = config.agents?.[0]?.channels;
  return {
    ...config.channels,
    ...(agentChannels?.telegram ? { telegram: { ...agentChannels.telegram, ...config.channels?.telegram } } : {}),
    ...(agentChannels?.slack ? { slack: { ...agentChannels.slack, ...config.channels?.slack } } : {}),
    ...(agentChannels?.discord ? { discord: { ...agentChannels.discord, ...config.channels?.discord } } : {}),
    ...(agentChannels?.whatsapp ? { whatsapp: { ...agentChannels.whatsapp, ...config.channels?.whatsapp } } : {}),
    ...(agentChannels?.signal ? { signal: { ...agentChannels.signal, ...config.channels?.signal } } : {}),
    ...(agentChannels?.bluesky ? { bluesky: { ...agentChannels.bluesky, ...config.channels?.bluesky } } : {}),
  };
}

/**
 * Check if config uses multi-agent format (agents[] with entries).
 */
export function isMultiAgentConfig(config: any): boolean {
  return !!(config.agents && Array.isArray(config.agents) && config.agents.length > 0);
}

function getChannelStatus(): ChannelStatus[] {
  const rawConfig = loadAppConfigOrExit();
  const channels = resolveChannels(rawConfig);
  
  return CHANNELS.map(ch => {
    const channelConfig = channels[ch.id as keyof typeof channels];
    return {
      id: ch.id,
      displayName: ch.displayName,
      enabled: channelConfig?.enabled || false,
      hint: getChannelHint(ch.id),
      details: getChannelDetails(ch.id, channelConfig),
    };
  });
}

// ============================================================================
// Commands
// ============================================================================

export async function listChannels(): Promise<void> {
  const channels = getChannelStatus();
  
  console.log('\n🔌 Channel Status\n');
  console.log('  Channel     Status      Details');
  console.log('  ──────────────────────────────────────────');
  
  for (const ch of channels) {
    const status = ch.enabled ? '✓ Enabled ' : '✗ Disabled';
    const details = ch.details || ch.hint;
    console.log(`  ${ch.displayName.padEnd(10)}  ${status}  ${details}`);
  }
  
  console.log('\n  Config: ' + resolveConfigPath());
  console.log('');
}

export async function interactiveChannelMenu(): Promise<void> {
  p.intro('🔌 Channel Management');
  
  const channels = getChannelStatus();
  const enabledCount = channels.filter(c => c.enabled).length;
  
  const statusLines = channels.map(ch => {
    const status = ch.enabled ? '✓' : '✗';
    const details = ch.enabled && ch.details ? ` (${ch.details})` : '';
    return `  ${status} ${ch.displayName}${details}`;
  });
  
  p.note(statusLines.join('\n'), `${enabledCount} of ${channels.length} channels enabled`);
  
  const action = await p.select({
    message: 'What would you like to do?',
    options: [
      { value: 'add', label: 'Add a channel', hint: 'Set up a new integration' },
      { value: 'remove', label: 'Remove a channel', hint: 'Disable and clear config' },
      { value: 'edit', label: 'Edit channel settings', hint: 'Update existing config' },
      { value: 'exit', label: 'Exit', hint: '' },
    ],
  });
  
  if (p.isCancel(action) || action === 'exit') {
    p.outro('');
    return;
  }
  
  switch (action) {
    case 'add': {
      const disabled = channels.filter(c => !c.enabled);
      if (disabled.length === 0) {
        p.log.info('All channels are already enabled.');
        return interactiveChannelMenu();
      }
      
      const channel = await p.select({
        message: 'Which channel would you like to add?',
        options: disabled.map(c => ({ value: c.id, label: c.displayName, hint: c.hint })),
      });
      
      if (!p.isCancel(channel)) {
        await addChannel(channel as ChannelId);
      }
      break;
    }
    
    case 'remove': {
      const enabled = channels.filter(c => c.enabled);
      if (enabled.length === 0) {
        p.log.info('No channels are enabled.');
        return interactiveChannelMenu();
      }
      
      const channel = await p.select({
        message: 'Which channel would you like to remove?',
        options: enabled.map(c => ({ value: c.id, label: c.displayName, hint: c.details || '' })),
      });
      
      if (!p.isCancel(channel)) {
        await removeChannel(channel as ChannelId);
      }
      break;
    }
    
    case 'edit': {
      const enabled = channels.filter(c => c.enabled);
      if (enabled.length === 0) {
        p.log.info('No channels are enabled. Add a channel first.');
        return interactiveChannelMenu();
      }
      
      const channel = await p.select({
        message: 'Which channel would you like to edit?',
        options: enabled.map(c => ({ value: c.id, label: c.displayName, hint: c.details || '' })),
      });
      
      if (!p.isCancel(channel)) {
        await addChannel(channel as ChannelId);
      }
      break;
    }
  }
  
  p.outro('');
}

export async function addChannel(channelId?: string): Promise<void> {
  if (!channelId) {
    p.intro('🔌 Add Channel');
    
    const channels = getChannelStatus();
    const disabled = channels.filter(c => !c.enabled);
    
    if (disabled.length === 0) {
      p.log.info('All channels are already enabled.');
      p.outro('');
      return;
    }
    
    const selected = await p.select({
      message: 'Which channel would you like to add?',
      options: disabled.map(c => ({ value: c.id, label: c.displayName, hint: c.hint })),
    });
    
    if (p.isCancel(selected)) {
      p.cancel('Cancelled');
      return;
    }
    
    channelId = selected as string;
  }
  
  const channelIds = CHANNELS.map(c => c.id);
  if (!channelIds.includes(channelId as ChannelId)) {
    console.error(`Unknown channel: ${channelId}`);
    console.error(`Valid channels: ${channelIds.join(', ')}`);
    process.exit(1);
  }
  
  const config = loadAppConfigOrExit();
  
  // In multi-agent format, read/write from agents[0].channels
  const multiAgent = isMultiAgentConfig(config);
  const channelSource = multiAgent
    ? (config.agents![0].channels ?? {})
    : config.channels;
  const existingConfig = channelSource[channelId as keyof typeof channelSource];
  
  // Get and run the setup function
  const setup = getSetupFunction(channelId as ChannelId);
  const newConfig = await setup(existingConfig);
  
  // Save — write to the correct location based on config format
  if (multiAgent) {
    (config.agents![0].channels as any)[channelId] = newConfig;
  } else {
    (config.channels as any)[channelId] = newConfig;
  }
  saveConfig(config);
  p.log.success(`Configuration saved to ${resolveConfigPath()}`);
}

export async function removeChannel(channelId?: string): Promise<void> {
  const channelIds = CHANNELS.map(c => c.id);
  
  if (!channelId) {
    console.error('Usage: lettabot channels remove <channel>');
    console.error(`Valid channels: ${channelIds.join(', ')}`);
    process.exit(1);
  }
  
  if (!channelIds.includes(channelId as ChannelId)) {
    console.error(`Unknown channel: ${channelId}`);
    console.error(`Valid channels: ${channelIds.join(', ')}`);
    process.exit(1);
  }
  
  const config = loadAppConfigOrExit();
  
  // In multi-agent format, read/write from agents[0].channels
  const multiAgent = isMultiAgentConfig(config);
  const channelSource = multiAgent
    ? (config.agents![0].channels ?? {})
    : config.channels;
  const channelConfig = channelSource[channelId as keyof typeof channelSource];
  
  if (!channelConfig?.enabled) {
    console.log(`${channelId} is already disabled.`);
    return;
  }
  
  const meta = CHANNELS.find(c => c.id === channelId)!;
  const confirmed = await p.confirm({
    message: `Remove ${meta.displayName}? This will disable the channel.`,
    initialValue: false,
  });
  
  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel('Cancelled');
    return;
  }
  
  // Write to the correct location based on config format
  if (multiAgent) {
    (config.agents![0].channels as any)[channelId] = { enabled: false };
  } else {
    (config.channels as any)[channelId] = { enabled: false };
  }
  saveConfig(config);
  p.log.success(`${meta.displayName} disabled`);
}

// ============================================================================
// Main Command Handler
// ============================================================================

export async function channelManagementCommand(subCommand?: string, channelName?: string, extraArgs: string[] = []): Promise<void> {
  switch (subCommand) {
    case 'list':
    case 'ls':
      await listChannels();
      break;
    case 'list-groups':
    case 'groups': {
      const args = channelName ? [channelName, ...extraArgs] : extraArgs;
      await listGroupsFromArgs(args);
      break;
    }
    case 'add':
      await addChannel(channelName);
      break;
    case 'remove':
    case 'rm':
      await removeChannel(channelName);
      break;
    default:
      await interactiveChannelMenu();
      break;
  }
}

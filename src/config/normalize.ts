/**
 * Config Normalization
 * 
 * Converts legacy single-agent configs to multi-agent format
 * and ensures all required fields are present.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentBinding,
  AgentConfig,
  LettaBotConfig,
  NormalizedConfig,
} from './types.js';

const DEFAULT_WORKSPACE = join(homedir(), '.lettabot', 'workspace');
const DEFAULT_MODEL = 'zai/glm-4.7';

/**
 * Normalize config to multi-agent format
 * 
 * This function:
 * 1. Converts legacy single-agent `agent` field to `agents.list[]`
 * 2. Ensures defaults are populated
 * 3. Creates implicit bindings for single-account channels
 */
export function normalizeConfig(config: LettaBotConfig): NormalizedConfig {
  // Check if already using multi-agent format
  const hasMultiAgent = config.agents?.list && config.agents.list.length > 0;
  
  let agents: NormalizedConfig['agents'];
  let bindings: AgentBinding[];
  
  if (hasMultiAgent) {
    // Multi-agent mode: use as-is with defaults filled in
    const defaultModel = config.agents?.defaults?.model || config.agent?.model || DEFAULT_MODEL;
    
    agents = {
      defaults: {
        model: defaultModel,
        ...config.agents?.defaults,
      },
      list: config.agents!.list!.map(agent => ({
        ...agent,
        workspace: resolveWorkspace(agent.workspace, agent.id),
        model: agent.model || defaultModel,
      })),
    };
    
    // Ensure at least one default agent
    if (!agents.list.some(a => a.default)) {
      agents.list[0].default = true;
    }
    
    bindings = config.bindings || [];
  } else {
    // Legacy single-agent mode: convert to multi-agent
    const legacyAgent = config.agent;
    const agentId = legacyAgent?.id || 'main';
    const agentName = legacyAgent?.name || 'LettaBot';
    const agentModel = legacyAgent?.model || DEFAULT_MODEL;
    
    agents = {
      defaults: {
        model: agentModel,
      },
      list: [{
        id: agentId,
        name: agentName,
        default: true,
        workspace: DEFAULT_WORKSPACE,
        model: agentModel,
      }],
    };
    
    // No explicit bindings in legacy mode - default agent handles all
    bindings = [];
  }
  
  // Create implicit bindings for channels without explicit bindings
  bindings = addImplicitBindings(config, agents.list, bindings);
  
  // Build normalized config (omit legacy `agent` field)
  const { agent: _legacyAgent, ...rest } = config;
  
  return {
    ...rest,
    agents,
    bindings,
  };
}

/**
 * Resolve workspace path, expanding ~ and ensuring absolute path
 */
function resolveWorkspace(workspace: string, agentId: string): string {
  if (!workspace) {
    return join(homedir(), '.lettabot', `workspace-${agentId}`);
  }
  
  // Expand ~ to home directory
  if (workspace.startsWith('~')) {
    return workspace.replace('~', homedir());
  }
  
  return workspace;
}

/**
 * Add implicit bindings for single-account channels
 * 
 * When a channel has no explicit bindings and uses single-account mode,
 * we implicitly route it to the default agent.
 */
function addImplicitBindings(
  config: LettaBotConfig,
  agentsList: AgentConfig[],
  existingBindings: AgentBinding[]
): AgentBinding[] {
  const bindings = [...existingBindings];
  const defaultAgent = agentsList.find(a => a.default) || agentsList[0];
  
  // Helper to check if a channel/account combo already has a binding
  const hasBinding = (channel: string, accountId?: string): boolean => {
    return bindings.some(b => {
      if (b.match.channel !== channel) return false;
      // If checking specific account, must match
      if (accountId && b.match.accountId && b.match.accountId !== accountId) return false;
      // If no specific account in binding, it's a catch-all for the channel
      if (!b.match.accountId && !b.match.peer) return true;
      return b.match.accountId === accountId;
    });
  };
  
  // Process each channel type
  const channelTypes = ['telegram', 'slack', 'discord', 'whatsapp', 'signal'] as const;
  
  for (const channelType of channelTypes) {
    const channelConfig = config.channels[channelType];
    if (!channelConfig?.enabled) continue;
    
    // Check for multi-account mode
    const accounts = (channelConfig as any).accounts as Record<string, unknown> | undefined;
    
    if (accounts && Object.keys(accounts).length > 0) {
      // Multi-account: add binding for each account without explicit binding
      for (const accountId of Object.keys(accounts)) {
        if (!hasBinding(channelType, accountId)) {
          bindings.push({
            agentId: defaultAgent.id,
            match: { channel: channelType, accountId },
          });
        }
      }
    } else {
      // Single account: add binding if no channel-wide binding exists
      if (!hasBinding(channelType)) {
        bindings.push({
          agentId: defaultAgent.id,
          match: { channel: channelType },
        });
      }
    }
  }
  
  return bindings;
}

/**
 * Get list of enabled channel account pairs from config
 */
export function getEnabledChannelAccounts(config: LettaBotConfig | NormalizedConfig): Array<{
  channel: string;
  accountId: string;
}> {
  const result: Array<{ channel: string; accountId: string }> = [];
  
  const channelTypes = ['telegram', 'slack', 'discord', 'whatsapp', 'signal'] as const;
  
  for (const channelType of channelTypes) {
    const channelConfig = config.channels[channelType];
    if (!channelConfig?.enabled) continue;
    
    const accounts = (channelConfig as any).accounts as Record<string, unknown> | undefined;
    
    if (accounts && Object.keys(accounts).length > 0) {
      for (const accountId of Object.keys(accounts)) {
        result.push({ channel: channelType, accountId });
      }
    } else {
      // Single account mode uses 'default' as accountId
      result.push({ channel: channelType, accountId: 'default' });
    }
  }
  
  return result;
}

/**
 * Validate config and return errors
 */
export function validateConfig(config: LettaBotConfig): string[] {
  const errors: string[] = [];
  
  // Check for multi-agent mode
  if (config.agents?.list && config.agents.list.length > 0) {
    // Validate agent IDs are unique
    const ids = new Set<string>();
    for (const agent of config.agents.list) {
      if (!agent.id) {
        errors.push('Agent config missing required "id" field');
      } else if (ids.has(agent.id)) {
        errors.push(`Duplicate agent ID: ${agent.id}`);
      } else {
        ids.add(agent.id);
      }
      
      if (!agent.workspace) {
        errors.push(`Agent "${agent.id}" missing required "workspace" field`);
      }
    }
    
    // Validate bindings reference valid agents
    if (config.bindings) {
      for (const binding of config.bindings) {
        if (!ids.has(binding.agentId)) {
          errors.push(`Binding references unknown agent: ${binding.agentId}`);
        }
        if (!binding.match?.channel) {
          errors.push(`Binding for agent "${binding.agentId}" missing required "match.channel" field`);
        }
      }
    }
  }
  
  // Validate at least one channel is enabled (or will be via multi-agent)
  const hasChannel = Object.values(config.channels || {}).some(
    ch => ch && typeof ch === 'object' && (ch as any).enabled
  );
  if (!hasChannel) {
    errors.push('No channels enabled. Enable at least one channel (telegram, slack, discord, whatsapp, or signal)');
  }
  
  return errors;
}

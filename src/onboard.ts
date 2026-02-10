/**
 * LettaBot Onboarding - Modular setup wizard with review/edit capability
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as p from '@clack/prompts';
import { saveConfig, syncProviders } from './config/index.js';
import type { LettaBotConfig, ProviderConfig } from './config/types.js';
import { isLettaCloudUrl } from './utils/server.js';
import { CHANNELS, getChannelHint, isSignalCliInstalled, setupTelegram, setupSlack, setupDiscord, setupWhatsApp, setupSignal } from './channels/setup.js';

// ============================================================================
// Non-Interactive Helpers
// ============================================================================

function parseCsvList(value?: string): string[] | undefined {
  if (!value) return undefined;
  const items = value.split(',').map(s => s.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function parseOptionalInt(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readConfigFromEnv(existingConfig: any): any {
  return {
    baseUrl: process.env.LETTA_BASE_URL || existingConfig.server?.baseUrl || 'https://api.letta.com',
    apiKey: process.env.LETTA_API_KEY || existingConfig.server?.apiKey,
    agentId: process.env.LETTA_AGENT_ID || existingConfig.agent?.id,
    agentName: process.env.LETTA_AGENT_NAME || existingConfig.agent?.name || 'lettabot',
    
    telegram: {
      enabled: !!process.env.TELEGRAM_BOT_TOKEN,
      botToken: process.env.TELEGRAM_BOT_TOKEN || existingConfig.channels?.telegram?.token,
      dmPolicy: process.env.TELEGRAM_DM_POLICY || existingConfig.channels?.telegram?.dmPolicy || 'pairing',
      allowedUsers: process.env.TELEGRAM_ALLOWED_USERS?.split(',').map(s => s.trim()) || existingConfig.channels?.telegram?.allowedUsers,
      groupDebounceSec: parseOptionalInt(process.env.TELEGRAM_GROUP_DEBOUNCE_SEC)
        ?? existingConfig.channels?.telegram?.groupDebounceSec,
      groupPollIntervalMin: parseOptionalInt(process.env.TELEGRAM_GROUP_POLL_INTERVAL_MIN)
        ?? existingConfig.channels?.telegram?.groupPollIntervalMin,
      instantGroups: parseCsvList(process.env.TELEGRAM_INSTANT_GROUPS)
        ?? existingConfig.channels?.telegram?.instantGroups,
      listeningGroups: parseCsvList(process.env.TELEGRAM_LISTENING_GROUPS)
        ?? existingConfig.channels?.telegram?.listeningGroups,
    },
    
    slack: {
      enabled: !!(process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN),
      botToken: process.env.SLACK_BOT_TOKEN || existingConfig.channels?.slack?.botToken,
      appToken: process.env.SLACK_APP_TOKEN || existingConfig.channels?.slack?.appToken,
      dmPolicy: process.env.SLACK_DM_POLICY || existingConfig.channels?.slack?.dmPolicy || 'pairing',
      allowedUsers: process.env.SLACK_ALLOWED_USERS?.split(',').map(s => s.trim()) || existingConfig.channels?.slack?.allowedUsers,
      groupDebounceSec: parseOptionalInt(process.env.SLACK_GROUP_DEBOUNCE_SEC)
        ?? existingConfig.channels?.slack?.groupDebounceSec,
      groupPollIntervalMin: parseOptionalInt(process.env.SLACK_GROUP_POLL_INTERVAL_MIN)
        ?? existingConfig.channels?.slack?.groupPollIntervalMin,
      instantGroups: parseCsvList(process.env.SLACK_INSTANT_GROUPS)
        ?? existingConfig.channels?.slack?.instantGroups,
      listeningGroups: parseCsvList(process.env.SLACK_LISTENING_GROUPS)
        ?? existingConfig.channels?.slack?.listeningGroups,
    },
    
    discord: {
      enabled: !!process.env.DISCORD_BOT_TOKEN,
      botToken: process.env.DISCORD_BOT_TOKEN || existingConfig.channels?.discord?.token,
      dmPolicy: process.env.DISCORD_DM_POLICY || existingConfig.channels?.discord?.dmPolicy || 'pairing',
      allowedUsers: process.env.DISCORD_ALLOWED_USERS?.split(',').map(s => s.trim()) || existingConfig.channels?.discord?.allowedUsers,
      groupDebounceSec: parseOptionalInt(process.env.DISCORD_GROUP_DEBOUNCE_SEC)
        ?? existingConfig.channels?.discord?.groupDebounceSec,
      groupPollIntervalMin: parseOptionalInt(process.env.DISCORD_GROUP_POLL_INTERVAL_MIN)
        ?? existingConfig.channels?.discord?.groupPollIntervalMin,
      instantGroups: parseCsvList(process.env.DISCORD_INSTANT_GROUPS)
        ?? existingConfig.channels?.discord?.instantGroups,
      listeningGroups: parseCsvList(process.env.DISCORD_LISTENING_GROUPS)
        ?? existingConfig.channels?.discord?.listeningGroups,
    },
    
    whatsapp: {
      enabled: process.env.WHATSAPP_ENABLED === 'true' || !!existingConfig.channels?.whatsapp?.enabled,
      selfChat: process.env.WHATSAPP_SELF_CHAT_MODE !== 'false' && (existingConfig.channels?.whatsapp?.selfChat !== false),
      dmPolicy: process.env.WHATSAPP_DM_POLICY || existingConfig.channels?.whatsapp?.dmPolicy || 'pairing',
      allowedUsers: process.env.WHATSAPP_ALLOWED_USERS?.split(',').map(s => s.trim()) || existingConfig.channels?.whatsapp?.allowedUsers,
      groupDebounceSec: parseOptionalInt(process.env.WHATSAPP_GROUP_DEBOUNCE_SEC)
        ?? existingConfig.channels?.whatsapp?.groupDebounceSec,
      groupPollIntervalMin: parseOptionalInt(process.env.WHATSAPP_GROUP_POLL_INTERVAL_MIN)
        ?? existingConfig.channels?.whatsapp?.groupPollIntervalMin,
      instantGroups: parseCsvList(process.env.WHATSAPP_INSTANT_GROUPS)
        ?? existingConfig.channels?.whatsapp?.instantGroups,
      listeningGroups: parseCsvList(process.env.WHATSAPP_LISTENING_GROUPS)
        ?? existingConfig.channels?.whatsapp?.listeningGroups,
    },
    
    signal: {
      enabled: !!process.env.SIGNAL_PHONE_NUMBER,
      phoneNumber: process.env.SIGNAL_PHONE_NUMBER || existingConfig.channels?.signal?.phoneNumber,
      selfChat: process.env.SIGNAL_SELF_CHAT_MODE !== 'false' && (existingConfig.channels?.signal?.selfChat !== false),
      dmPolicy: process.env.SIGNAL_DM_POLICY || existingConfig.channels?.signal?.dmPolicy || 'pairing',
      allowedUsers: process.env.SIGNAL_ALLOWED_USERS?.split(',').map(s => s.trim()) || existingConfig.channels?.signal?.allowedUsers,
      groupDebounceSec: parseOptionalInt(process.env.SIGNAL_GROUP_DEBOUNCE_SEC)
        ?? existingConfig.channels?.signal?.groupDebounceSec,
      groupPollIntervalMin: parseOptionalInt(process.env.SIGNAL_GROUP_POLL_INTERVAL_MIN)
        ?? existingConfig.channels?.signal?.groupPollIntervalMin,
      instantGroups: parseCsvList(process.env.SIGNAL_INSTANT_GROUPS)
        ?? existingConfig.channels?.signal?.instantGroups,
      listeningGroups: parseCsvList(process.env.SIGNAL_LISTENING_GROUPS)
        ?? existingConfig.channels?.signal?.listeningGroups,
    },
  };
}

async function saveConfigFromEnv(config: any, configPath: string): Promise<void> {
  const { saveConfig } = await import('./config/index.js');
  
  const lettabotConfig: LettaBotConfig = {
    server: {
      mode: isLettaCloudUrl(config.baseUrl) ? 'cloud' : 'selfhosted',
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
    },
    agent: {
      id: config.agentId,
      name: config.agentName,
      // model is configured on the Letta agent server-side, not saved to config
    },
    channels: {
      telegram: config.telegram.enabled ? {
        enabled: true,
        token: config.telegram.botToken,
        dmPolicy: config.telegram.dmPolicy,
        allowedUsers: config.telegram.allowedUsers,
        groupDebounceSec: config.telegram.groupDebounceSec,
        groupPollIntervalMin: config.telegram.groupPollIntervalMin,
        instantGroups: config.telegram.instantGroups,
        listeningGroups: config.telegram.listeningGroups,
      } : { enabled: false },
      
      slack: config.slack.enabled ? {
        enabled: true,
        botToken: config.slack.botToken,
        appToken: config.slack.appToken,
        allowedUsers: config.slack.allowedUsers,
        groupDebounceSec: config.slack.groupDebounceSec,
        groupPollIntervalMin: config.slack.groupPollIntervalMin,
        instantGroups: config.slack.instantGroups,
        listeningGroups: config.slack.listeningGroups,
      } : { enabled: false },
      
      discord: config.discord.enabled ? {
        enabled: true,
        token: config.discord.botToken,
        dmPolicy: config.discord.dmPolicy,
        allowedUsers: config.discord.allowedUsers,
        groupDebounceSec: config.discord.groupDebounceSec,
        groupPollIntervalMin: config.discord.groupPollIntervalMin,
        instantGroups: config.discord.instantGroups,
        listeningGroups: config.discord.listeningGroups,
      } : { enabled: false },
      
      whatsapp: config.whatsapp.enabled ? {
        enabled: true,
        selfChat: config.whatsapp.selfChat,
        dmPolicy: config.whatsapp.dmPolicy,
        allowedUsers: config.whatsapp.allowedUsers,
        groupDebounceSec: config.whatsapp.groupDebounceSec,
        groupPollIntervalMin: config.whatsapp.groupPollIntervalMin,
        instantGroups: config.whatsapp.instantGroups,
        listeningGroups: config.whatsapp.listeningGroups,
      } : { enabled: false },
      
      signal: config.signal.enabled ? {
        enabled: true,
        phone: config.signal.phoneNumber,
        selfChat: config.signal.selfChat,
        dmPolicy: config.signal.dmPolicy,
        allowedUsers: config.signal.allowedUsers,
        groupDebounceSec: config.signal.groupDebounceSec,
        groupPollIntervalMin: config.signal.groupPollIntervalMin,
        instantGroups: config.signal.instantGroups,
        listeningGroups: config.signal.listeningGroups,
      } : { enabled: false },
    },
    features: {
      cron: false,
      heartbeat: {
        enabled: false,
        intervalMin: 60,
      },
    },
  };
  
  saveConfig(lettabotConfig);
}

// ============================================================================
// Config Types
// ============================================================================

interface OnboardConfig {
  // Auth
  authMethod: 'keep' | 'oauth' | 'apikey' | 'selfhosted' | 'skip';
  apiKey?: string;
  baseUrl?: string;
  billingTier?: string;
  
  // Agent  
  agentChoice: 'new' | 'existing' | 'env' | 'skip';
  agentId?: string;
  agentName?: string;
  
  // Model (only for new agents)
  model?: string;
  
  // BYOK Providers (for free tier)
  providers?: Array<{ id: string; name: string; apiKey: string }>;
  
  // Channels (with access control)
  telegram: {
    enabled: boolean;
    token?: string;
    dmPolicy?: 'pairing' | 'allowlist' | 'open';
    allowedUsers?: string[];
    groupDebounceSec?: number;
    groupPollIntervalMin?: number;
    instantGroups?: string[];
    listeningGroups?: string[];
  };
  slack: {
    enabled: boolean;
    appToken?: string;
    botToken?: string;
    allowedUsers?: string[];
    groupDebounceSec?: number;
    groupPollIntervalMin?: number;
    instantGroups?: string[];
    listeningGroups?: string[];
  };
  whatsapp: {
    enabled: boolean;
    selfChat?: boolean;
    dmPolicy?: 'pairing' | 'allowlist' | 'open';
    allowedUsers?: string[];
    groupDebounceSec?: number;
    groupPollIntervalMin?: number;
    instantGroups?: string[];
    listeningGroups?: string[];
  };
  signal: {
    enabled: boolean;
    phone?: string;
    selfChat?: boolean;
    dmPolicy?: 'pairing' | 'allowlist' | 'open';
    allowedUsers?: string[];
    groupDebounceSec?: number;
    groupPollIntervalMin?: number;
    instantGroups?: string[];
    listeningGroups?: string[];
  };
  discord: {
    enabled: boolean;
    token?: string;
    dmPolicy?: 'pairing' | 'allowlist' | 'open';
    allowedUsers?: string[];
    groupDebounceSec?: number;
    groupPollIntervalMin?: number;
    instantGroups?: string[];
    listeningGroups?: string[];
  };
  
  // Google Workspace (via gog CLI)
  google: { enabled: boolean; accounts: Array<{ account: string; services: string[] }> };
  
  // Features
  heartbeat: { enabled: boolean; interval?: string };
  cron: boolean;

  // Transcription (voice messages)
  transcription: { enabled: boolean; apiKey?: string; model?: string };
}

const isPlaceholder = (val?: string) => !val || /^(your_|sk-\.\.\.|placeholder|example)/i.test(val);

// ============================================================================
// Step Functions
// ============================================================================

async function stepAuth(config: OnboardConfig, env: Record<string, string>): Promise<void> {
  const { requestDeviceCode, pollForToken } = await import('./auth/oauth.js');
  const { saveTokens, loadTokens, getOrCreateDeviceId, getDeviceName } = await import('./auth/tokens.js');
  
  const baseUrl = config.baseUrl || env.LETTA_BASE_URL || process.env.LETTA_BASE_URL;
  const isLettaCloud = isLettaCloudUrl(baseUrl);
  
  const existingTokens = loadTokens();
  // Check both env and config for existing API key
  const realApiKey = config.apiKey || (isPlaceholder(env.LETTA_API_KEY) ? undefined : env.LETTA_API_KEY);
  const validOAuthToken = isLettaCloud ? existingTokens?.accessToken : undefined;
  const hasExistingAuth = !!realApiKey || !!validOAuthToken;
  const displayKey = realApiKey || validOAuthToken;
  
  // Determine label based on credential type
  const getAuthLabel = () => {
    if (validOAuthToken) return 'Use existing OAuth';
    if (realApiKey?.startsWith('sk-let-')) return 'Use API key';
    return 'Use existing';
  };
  
  const authOptions = [
    ...(hasExistingAuth ? [{ value: 'keep', label: getAuthLabel(), hint: displayKey?.slice(0, 20) + '...' }] : []),
    ...(isLettaCloud ? [{ value: 'oauth', label: 'Login to Letta Platform', hint: 'Opens browser' }] : []),
    { value: 'apikey', label: 'Enter API Key manually', hint: 'Paste your key' },
    { value: 'selfhosted', label: 'Enter self-hosted URL', hint: 'Local Letta server' },
    { value: 'skip', label: 'Skip', hint: 'Continue without auth' },
  ];
  
  const authMethod = await p.select({
    message: 'Authentication',
    options: authOptions,
  });
  if (p.isCancel(authMethod)) { p.cancel('Setup cancelled'); process.exit(0); }
  
  config.authMethod = authMethod as OnboardConfig['authMethod'];
  
  if (authMethod === 'oauth') {
    const spinner = p.spinner();
    spinner.start('Requesting authorization...');
    
    try {
      const deviceData = await requestDeviceCode();
      spinner.stop('Authorization requested');
      
      p.note(
        `Code: ${deviceData.user_code}\n` +
        `URL: ${deviceData.verification_uri_complete}`,
        'Open in Browser'
      );
      
      try {
        const open = (await import('open')).default;
        await open(deviceData.verification_uri_complete, { wait: false });
      } catch {}
      
      spinner.start('Waiting for authorization...');
      const deviceId = getOrCreateDeviceId();
      const deviceName = getDeviceName();
      
      const tokens = await pollForToken(
        deviceData.device_code,
        deviceData.interval,
        deviceData.expires_in,
        deviceId,
        deviceName,
      );
      
      spinner.stop('Authorized!');
      
      const now = Date.now();
      saveTokens({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        tokenExpiresAt: now + tokens.expires_in * 1000,
        deviceId,
        deviceName,
      });
      
      config.apiKey = tokens.access_token;
      env.LETTA_API_KEY = tokens.access_token;
      
    } catch (err) {
      spinner.stop('Authorization failed');
      throw err;
    }
    
  } else if (authMethod === 'apikey') {
    const apiKey = await p.text({ 
      message: 'API Key',
      placeholder: 'sk-...',
    });
    if (p.isCancel(apiKey)) { p.cancel('Setup cancelled'); process.exit(0); }
    if (apiKey) {
      config.apiKey = apiKey;
      env.LETTA_API_KEY = apiKey;
    }
  } else if (authMethod === 'selfhosted') {
    const serverUrl = await p.text({ 
      message: 'Letta server URL',
      placeholder: 'http://localhost:8283',
      initialValue: config.baseUrl || 'http://localhost:8283',
    });
    if (p.isCancel(serverUrl)) { p.cancel('Setup cancelled'); process.exit(0); }
    
    const url = serverUrl || 'http://localhost:8283';
    config.baseUrl = url;
    env.LETTA_BASE_URL = url;
    process.env.LETTA_BASE_URL = url; // Set immediately so model listing works
    
    // Clear any cloud API key since we're using self-hosted
    delete env.LETTA_API_KEY;
    delete process.env.LETTA_API_KEY;
  } else if (authMethod === 'keep') {
    // For OAuth tokens, refresh if needed
    if (existingTokens?.refreshToken) {
      const { isTokenExpired } = await import('./auth/tokens.js');
      const { refreshAccessToken } = await import('./auth/oauth.js');
      
      if (isTokenExpired(existingTokens)) {
      const spinner = p.spinner();
      spinner.start('Refreshing token...');
      try {
        const newTokens = await refreshAccessToken(
          existingTokens.refreshToken,
          existingTokens.deviceId,
          getDeviceName(),
        );
        
        const now = Date.now();
        saveTokens({
          accessToken: newTokens.access_token,
          refreshToken: newTokens.refresh_token ?? existingTokens.refreshToken,
          tokenExpiresAt: now + newTokens.expires_in * 1000,
          deviceId: existingTokens.deviceId,
          deviceName: existingTokens.deviceName,
        });
        
        config.apiKey = newTokens.access_token;
        env.LETTA_API_KEY = newTokens.access_token;
        spinner.stop('Token refreshed');
      } catch {
        spinner.stop('Token refresh failed');
        p.log.warning('Your session may have expired. Try "Login to Letta Platform" to re-authenticate.');
      }
      } else {
        // Token not expired, use existing
        config.apiKey = existingTokens.accessToken;
        env.LETTA_API_KEY = existingTokens.accessToken!;
      }
    } else if (realApiKey) {
      // Using existing API key
      config.apiKey = realApiKey;
      env.LETTA_API_KEY = realApiKey;
    }
  }
  
  // Validate connection (skip if 'skip' was chosen)
  if (config.authMethod !== 'skip') {
    const keyToValidate = config.apiKey || env.LETTA_API_KEY;
    if (keyToValidate) {
      process.env.LETTA_API_KEY = keyToValidate;
    }
    
    const spinner = p.spinner();
    const serverLabel = config.baseUrl || 'Letta Cloud';
    spinner.start(`Checking connection to ${serverLabel}...`);
    try {
      const { testConnection } = await import('./tools/letta-api.js');
      const ok = await testConnection();
      spinner.stop(ok ? `Connected to ${serverLabel}` : 'Connection issue');
      
      if (!ok && config.authMethod === 'selfhosted') {
        p.log.warn(`Could not connect to ${config.baseUrl}. Make sure the server is running.`);
      }
    } catch {
      spinner.stop('Connection check skipped');
    }
  }
}

async function stepAgent(config: OnboardConfig, env: Record<string, string>): Promise<void> {
  const { listAgents } = await import('./tools/letta-api.js');
  const envAgentId = process.env.LETTA_AGENT_ID;
  
  const agentOptions: Array<{ value: string; label: string; hint: string }> = [
    { value: 'new', label: 'Create new agent', hint: 'Start fresh' },
    { value: 'existing', label: 'Select existing', hint: 'From server' },
  ];
  
  if (envAgentId) {
    agentOptions.push({ value: 'env', label: 'Use LETTA_AGENT_ID', hint: envAgentId.slice(0, 15) + '...' });
  }
  agentOptions.push({ value: 'skip', label: 'Skip', hint: 'Keep current' });
  
  const agentChoice = await p.select({
    message: 'Agent',
    options: agentOptions,
  });
  if (p.isCancel(agentChoice)) { p.cancel('Setup cancelled'); process.exit(0); }
  
  config.agentChoice = agentChoice as OnboardConfig['agentChoice'];
  
  if (agentChoice === 'existing') {
    const searchQuery = await p.text({
      message: 'Search by name (Enter for all)',
      placeholder: 'my-agent',
    });
    if (p.isCancel(searchQuery)) { p.cancel('Setup cancelled'); process.exit(0); }
    
    const spinner = p.spinner();
    spinner.start('Fetching agents...');
    const agents = await listAgents(searchQuery || undefined);
    spinner.stop(`Found ${agents.length}`);
    
    if (agents.length > 0) {
      const selectedAgent = await p.select({
        message: 'Select agent',
        options: [
          ...agents.map(a => ({
            value: a.id,
            label: a.name,
            hint: a.id.slice(0, 15) + '...',
          })),
          { value: '__back__', label: '← Back', hint: '' },
        ],
      });
      if (p.isCancel(selectedAgent)) { p.cancel('Setup cancelled'); process.exit(0); }
      
      if (selectedAgent === '__back__') {
        // Re-run agent step from the beginning
        return stepAgent(config, env);
      }
      
      config.agentId = selectedAgent as string;
      const agent = agents.find(a => a.id === config.agentId);
      config.agentName = agent?.name;
    } else {
      p.log.warning('No agents found.');
      // Re-run agent step
      return stepAgent(config, env);
    }
    
  } else if (agentChoice === 'env') {
    config.agentId = envAgentId!;
    
  } else if (agentChoice === 'new') {
    const agentName = await p.text({
      message: 'Agent name',
      placeholder: 'LettaBot',
      initialValue: env.AGENT_NAME || '',
    });
    if (p.isCancel(agentName)) { p.cancel('Setup cancelled'); process.exit(0); }
    config.agentName = agentName || 'LettaBot';
  }
}

// BYOK Provider definitions (same as letta-code)
const BYOK_PROVIDERS = [
  { id: 'anthropic', name: 'lc-anthropic', displayName: 'Anthropic (Claude)', providerType: 'anthropic' },
  { id: 'openai', name: 'lc-openai', displayName: 'OpenAI', providerType: 'openai' },
  { id: 'gemini', name: 'lc-gemini', displayName: 'Google Gemini', providerType: 'google_ai' },
  { id: 'zai', name: 'lc-zai', displayName: 'zAI', providerType: 'zai' },
  { id: 'minimax', name: 'lc-minimax', displayName: 'MiniMax', providerType: 'minimax' },
  { id: 'openrouter', name: 'lc-openrouter', displayName: 'OpenRouter', providerType: 'openrouter' },
];

async function stepProviders(config: OnboardConfig, env: Record<string, string>): Promise<void> {
  // Only for free tier users on Letta Cloud (not self-hosted, not paid)
  if (config.authMethod === 'selfhosted') return;
  if (config.billingTier !== 'free') return;
  
  const selectedProviders = await p.multiselect({
    message: 'Add LLM provider keys (optional - for BYOK models)',
    options: BYOK_PROVIDERS.map(provider => ({
      value: provider.id,
      label: provider.displayName,
      hint: `Connect your ${provider.displayName} API key`,
    })),
    required: false,
  });
  
  if (p.isCancel(selectedProviders)) { p.cancel('Setup cancelled'); process.exit(0); }
  
  // If no providers selected, skip
  if (!selectedProviders || selectedProviders.length === 0) {
    return;
  }
  
  config.providers = [];
  const apiKey = config.apiKey || env.LETTA_API_KEY || process.env.LETTA_API_KEY;
  
  // Collect API keys for each selected provider
  for (const providerId of selectedProviders as string[]) {
    const provider = BYOK_PROVIDERS.find(p => p.id === providerId);
    if (!provider) continue;
    
    const providerKey = await p.text({
      message: `${provider.displayName} API Key`,
      placeholder: 'sk-...',
    });
    
    if (p.isCancel(providerKey)) { p.cancel('Setup cancelled'); process.exit(0); }
    
    if (providerKey) {
      // Create or update provider via Letta API
      const spinner = p.spinner();
      spinner.start(`Connecting ${provider.displayName}...`);
      
      try {
        // First check if provider already exists
        const listResponse = await fetch('https://api.letta.com/v1/providers', {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
        });
        
        let existingProvider: { id: string; name: string } | undefined;
        if (listResponse.ok) {
          const providers = await listResponse.json() as Array<{ id: string; name: string }>;
          existingProvider = providers.find(p => p.name === provider.name);
        }
        
        let response: Response;
        if (existingProvider) {
          // Update existing provider
          response = await fetch(`https://api.letta.com/v1/providers/${existingProvider.id}`, {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              api_key: providerKey,
            }),
          });
        } else {
          // Create new provider
          response = await fetch('https://api.letta.com/v1/providers', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              name: provider.name,
              provider_type: provider.providerType,
              api_key: providerKey,
            }),
          });
        }
        
        if (response.ok) {
          spinner.stop(`Connected ${provider.displayName}`);
          config.providers.push({ id: provider.id, name: provider.name, apiKey: providerKey });

          // If OpenAI was just connected, offer to enable voice transcription
          if (provider.id === 'openai') {
            const enableTranscription = await p.confirm({
              message: 'Enable voice message transcription with this OpenAI key? (uses Whisper)',
              initialValue: true,
            });
            if (!p.isCancel(enableTranscription) && enableTranscription) {
              config.transcription.enabled = true;
              config.transcription.apiKey = providerKey;
            }
          }
        } else {
          const error = await response.text();
          spinner.stop(`Failed to connect ${provider.displayName}: ${error}`);
        }
      } catch (err) {
        spinner.stop(`Failed to connect ${provider.displayName}`);
      }
    }
  }
}

async function stepModel(config: OnboardConfig, env: Record<string, string>): Promise<void> {
  // Only for new agents
  if (config.agentChoice !== 'new') return;
  
  const { buildModelOptions, handleModelSelection, getBillingTier } = await import('./utils/model-selection.js');
  
  const spinner = p.spinner();
  
  // Determine if self-hosted (not Letta Cloud)
  const isSelfHosted = config.authMethod === 'selfhosted';
  
  // Fetch billing tier for Letta Cloud users (if not already fetched)
  let billingTier: string | null = config.billingTier || null;
  if (!isSelfHosted && !billingTier) {
    spinner.start('Checking account...');
    const apiKey = config.apiKey || env.LETTA_API_KEY || process.env.LETTA_API_KEY;
    billingTier = await getBillingTier(apiKey, isSelfHosted);
    config.billingTier = billingTier ?? undefined;
    spinner.stop(billingTier === 'free' ? 'Free plan' : `Plan: ${billingTier || 'unknown'}`);
  }
  
  spinner.start('Fetching models...');
  const apiKey = config.apiKey || env.LETTA_API_KEY || process.env.LETTA_API_KEY;
  const modelOptions = await buildModelOptions({ billingTier, isSelfHosted, apiKey });
  spinner.stop('Models loaded');
  
  // Show appropriate message for free tier
  if (billingTier === 'free') {
    p.log.info('Free plan: GLM and MiniMax models are free. Other models require BYOK (Bring Your Own Key).');
  }
  
  let selectedModel: string | null = null;
  while (!selectedModel) {
    const modelChoice = await p.select({
      message: 'Select model',
      options: modelOptions,
      maxItems: 12,
    });
    if (p.isCancel(modelChoice)) { p.cancel('Setup cancelled'); process.exit(0); }
    
    selectedModel = await handleModelSelection(modelChoice, p.text);
    // If null (e.g., header selected), loop again
  }
  
  config.model = selectedModel;
}

async function stepChannels(config: OnboardConfig, env: Record<string, string>): Promise<void> {
  // Build channel options from shared CHANNELS array
  const channelOptions = CHANNELS.map(ch => ({
    value: ch.id,
    label: ch.displayName,
    hint: getChannelHint(ch.id),
  }));
  
  // Pre-select channels that are already enabled
  const initialChannels: string[] = [];
  if (config.telegram.enabled) initialChannels.push('telegram');
  if (config.slack.enabled) initialChannels.push('slack');
  if (config.discord.enabled) initialChannels.push('discord');
  if (config.whatsapp.enabled) initialChannels.push('whatsapp');
  if (config.signal.enabled) initialChannels.push('signal');
  
  let channels: string[] = [];
  
  while (true) {
    const selectedChannels = await p.multiselect({
      message: 'Select channels (space to toggle, enter to confirm)',
      options: channelOptions,
      initialValues: initialChannels,
      required: false,
    });
    if (p.isCancel(selectedChannels)) { p.cancel('Setup cancelled'); process.exit(0); }
    
    channels = selectedChannels as string[];
    
    if (channels.length === 0) {
      const skipChannels = await p.confirm({
        message: 'No channels selected. Continue without any messaging channels?',
        initialValue: false,
      });
      if (p.isCancel(skipChannels)) { p.cancel('Setup cancelled'); process.exit(0); }
      if (skipChannels) break;
    } else {
      break;
    }
  }
  
  // Handle Signal warning if selected but not installed
  const signalInstalled = isSignalCliInstalled();
  if (channels.includes('signal') && !signalInstalled) {
    p.log.warn('Signal selected but signal-cli is not installed. Install with: brew install signal-cli');
    channels = channels.filter(c => c !== 'signal');
  }
  
  // Update enabled states
  config.telegram.enabled = channels.includes('telegram');
  config.slack.enabled = channels.includes('slack');
  config.discord.enabled = channels.includes('discord');
  config.whatsapp.enabled = channels.includes('whatsapp');
  config.signal.enabled = channels.includes('signal');
  
  // Configure each selected channel using shared setup functions
  if (config.telegram.enabled) {
    const result = await setupTelegram(config.telegram);
    Object.assign(config.telegram, result);
  }
  
  if (config.slack.enabled) {
    const result = await setupSlack(config.slack);
    Object.assign(config.slack, result);
  }
  
  if (config.discord.enabled) {
    const result = await setupDiscord(config.discord);
    Object.assign(config.discord, result);
  }
  
  if (config.whatsapp.enabled) {
    const result = await setupWhatsApp(config.whatsapp);
    Object.assign(config.whatsapp, result);
  }
  
  if (config.signal.enabled) {
    const result = await setupSignal(config.signal);
    Object.assign(config.signal, result);
  }
}

async function stepFeatures(config: OnboardConfig): Promise<void> {
  // Heartbeat
  const setupHeartbeat = await p.confirm({
    message: 'Enable heartbeat? (periodic agent wake-ups)',
    initialValue: config.heartbeat.enabled,
  });
  if (p.isCancel(setupHeartbeat)) { p.cancel('Setup cancelled'); process.exit(0); }
  config.heartbeat.enabled = setupHeartbeat;
  
  if (setupHeartbeat) {
    const interval = await p.text({
      message: 'Interval (minutes)',
      placeholder: '30',
      initialValue: config.heartbeat.interval || '30',
    });
    if (!p.isCancel(interval)) config.heartbeat.interval = interval || '30';
  }
  
  // Cron
  const setupCron = await p.confirm({
    message: 'Enable cron jobs?',
    initialValue: config.cron,
  });
  if (!p.isCancel(setupCron)) config.cron = setupCron;
}

// ============================================================================
// Voice Transcription Setup
// ============================================================================

async function stepTranscription(config: OnboardConfig): Promise<void> {
  // Skip if already configured from the providers step
  if (config.transcription.enabled && config.transcription.apiKey) return;

  const setupTranscription = await p.confirm({
    message: 'Enable voice message transcription? (uses OpenAI Whisper)',
    initialValue: config.transcription.enabled,
  });
  if (p.isCancel(setupTranscription)) { p.cancel('Setup cancelled'); process.exit(0); }
  config.transcription.enabled = setupTranscription;

  if (setupTranscription) {
    const existingKey = process.env.OPENAI_API_KEY;

    const apiKey = await p.text({
      message: 'OpenAI API Key (for Whisper transcription)',
      placeholder: 'sk-...',
      initialValue: existingKey || '',
      validate: (v) => {
        if (!v) return 'API key is required for voice transcription';
      },
    });
    if (p.isCancel(apiKey)) { p.cancel('Setup cancelled'); process.exit(0); }
    config.transcription.apiKey = apiKey;
  }
}

// ============================================================================
// Google Workspace Setup (via gog CLI)
// ============================================================================

const GOG_SERVICES = ['gmail', 'calendar', 'drive', 'contacts', 'docs', 'sheets'];

async function stepGoogle(config: OnboardConfig): Promise<void> {
  // Ask if user wants to set up Google
  const setupGoogle = await p.confirm({
    message: 'Set up Google Workspace? (Gmail, Calendar, Drive, etc.)',
    initialValue: config.google.enabled,
  });
  if (p.isCancel(setupGoogle)) { p.cancel('Setup cancelled'); process.exit(0); }
  
  if (!setupGoogle) {
    config.google.enabled = false;
    config.google.accounts = [];
    return;
  }
  
  // Check if gog is installed
  const gogInstalled = spawnSync('which', ['gog'], { stdio: 'pipe' }).status === 0;
  
  if (!gogInstalled) {
    p.log.warning('gog CLI is not installed.');
    
    // Check if brew is available (macOS)
    const brewInstalled = spawnSync('which', ['brew'], { stdio: 'pipe' }).status === 0;
    
    if (brewInstalled) {
      const installGog = await p.confirm({
        message: 'Install gog via Homebrew?',
        initialValue: true,
      });
      if (p.isCancel(installGog)) { p.cancel('Setup cancelled'); process.exit(0); }
      
      if (installGog) {
        const spinner = p.spinner();
        spinner.start('Installing gog...');
        
        const result = spawnSync('brew', ['install', 'steipete/tap/gogcli'], { 
          stdio: 'pipe',
          timeout: 300000, // 5 min timeout
        });
        
        if (result.status === 0) {
          spinner.stop('gog installed successfully');
        } else {
          spinner.stop('Failed to install gog');
          p.log.error('Installation failed. Try manually: brew install steipete/tap/gogcli');
          config.google.enabled = false;
          config.google.accounts = [];
          return;
        }
      } else {
        p.log.info('Install gog manually: brew install steipete/tap/gogcli');
        config.google.enabled = false;
        config.google.accounts = [];
        return;
      }
    } else {
      p.log.info('Install gog manually from: https://gogcli.sh');
      config.google.enabled = false;
      config.google.accounts = [];
      return;
    }
  }
  
  // Check for existing credentials
  const credentialsResult = spawnSync('gog', ['auth', 'list'], { stdio: 'pipe' });
  const hasCredentials = credentialsResult.status === 0 && 
    credentialsResult.stdout.toString().trim().length > 0 &&
    !credentialsResult.stdout.toString().includes('No accounts');
  
  if (!hasCredentials) {
    // Check if credentials.json exists
    const configDir = process.env.XDG_CONFIG_HOME || `${process.env.HOME}/.config`;
    const credPaths = [
      `${configDir}/gogcli/credentials.json`,
      `${process.env.HOME}/Library/Application Support/gogcli/credentials.json`,
    ];
    
    const hasCredFile = credPaths.some(p => existsSync(p));
    
    if (!hasCredFile) {
      p.note(
        'To use Google Workspace, you need OAuth credentials:\n\n' +
        '1. Go to console.cloud.google.com\n' +
        '2. Create a project (or select existing)\n' +
        '3. Enable APIs: Gmail, Calendar, Drive, etc.\n' +
        '4. Create OAuth 2.0 credentials (Desktop app)\n' +
        '5. Download the JSON file\n' +
        '6. Run: gog auth credentials /path/to/credentials.json',
        'Google OAuth Setup'
      );
      
      const hasCredentials = await p.confirm({
        message: 'Have you already set up OAuth credentials with gog?',
        initialValue: false,
      });
      if (p.isCancel(hasCredentials)) { p.cancel('Setup cancelled'); process.exit(0); }
      
      if (!hasCredentials) {
        p.log.info('Run `gog auth credentials /path/to/client_secret.json` after downloading credentials.');
        config.google.enabled = false;
        config.google.accounts = [];
        return;
      }
    }
  }
  
  // List existing accounts or add new one
  let accounts: string[] = [];
  if (hasCredentials) {
    const listResult = spawnSync('gog', ['auth', 'list', '--json'], { stdio: 'pipe' });
    if (listResult.status === 0) {
      try {
        const parsed = JSON.parse(listResult.stdout.toString());
        if (Array.isArray(parsed)) {
          accounts = parsed.map((a: { email?: string; account?: string }) => a.email || a.account || '').filter(Boolean);
        }
      } catch {
        // Parse as text output
        accounts = listResult.stdout.toString()
          .split('\n')
          .map(line => line.trim())
          .filter(line => line.includes('@'));
      }
    }
  }

  const configuredAccounts = new Map<string, string[]>();
  for (const entry of config.google.accounts) {
    configuredAccounts.set(entry.account, entry.services || []);
  }
  
  const newAccounts: Array<{ account: string; services: string[] }> = [];
  let selectedAccounts: string[] = [];

  if (accounts.length === 0) {
    const firstAccount = await addGoogleAccount();
    if (!firstAccount) {
      config.google.enabled = false;
      config.google.accounts = [];
      return;
    }
    newAccounts.push(firstAccount);
    while (true) {
      const more = await p.confirm({
        message: 'Add another Google account?',
        initialValue: false,
      });
      if (p.isCancel(more)) { p.cancel('Setup cancelled'); process.exit(0); }
      if (!more) break;
      const added = await addGoogleAccount();
      if (added) {
        newAccounts.push(added);
      } else {
        break;
      }
    }
  } else {
    const accountChoices = await p.multiselect({
      message: 'Google accounts to enable',
      options: [
        ...accounts.map(a => ({ value: a, label: a, hint: 'Existing account' })),
        { value: '__new__', label: 'Add new account', hint: 'Authorize another account' },
      ],
      initialValues: config.google.accounts.map(a => a.account).filter(a => accounts.includes(a)),
      required: true,
    });
    if (p.isCancel(accountChoices)) { p.cancel('Setup cancelled'); process.exit(0); }

    selectedAccounts = (accountChoices as string[]).filter(a => a !== '__new__');
    if ((accountChoices as string[]).includes('__new__')) {
      while (true) {
        const added = await addGoogleAccount();
        if (added) {
          newAccounts.push(added);
        } else {
          break;
        }
        const more = await p.confirm({
          message: 'Add another Google account?',
          initialValue: false,
        });
        if (p.isCancel(more)) { p.cancel('Setup cancelled'); process.exit(0); }
        if (!more) break;
      }
    }
  }

  const allAccounts = Array.from(new Set([
    ...selectedAccounts,
    ...newAccounts.map(a => a.account),
  ]));

  if (allAccounts.length === 0) {
    config.google.enabled = false;
    config.google.accounts = [];
    return;
  }

  const newAccountsByEmail = new Map<string, string[]>();
  for (const entry of newAccounts) {
    newAccountsByEmail.set(entry.account, entry.services);
  }

  const finalizedAccounts: Array<{ account: string; services: string[] }> = [];
  for (const account of allAccounts) {
    const presetServices = newAccountsByEmail.get(account) || configuredAccounts.get(account) || ['gmail', 'calendar'];
    const selectedServices = newAccountsByEmail.has(account) ? presetServices : await p.multiselect({
      message: `Services to enable for ${account}`,
      options: GOG_SERVICES.map(s => ({
        value: s,
        label: s.charAt(0).toUpperCase() + s.slice(1),
        hint: s === 'gmail' ? 'Read/send emails' : 
              s === 'calendar' ? 'View/create events' :
              s === 'drive' ? 'Access files' :
              s === 'contacts' ? 'Look up contacts' :
              s === 'docs' ? 'Read documents' :
              'Read/edit spreadsheets',
      })),
      initialValues: presetServices,
      required: true,
    });
    if (p.isCancel(selectedServices)) { p.cancel('Setup cancelled'); process.exit(0); }
    finalizedAccounts.push({
      account,
      services: selectedServices as string[],
    });
  }

  config.google.enabled = true;
  config.google.accounts = finalizedAccounts;
  
  p.log.success(`Google Workspace configured: ${finalizedAccounts.length} account(s)`);
}

async function addGoogleAccount(): Promise<{ account: string; services: string[] } | undefined> {
  const email = await p.text({
    message: 'Google account email',
    placeholder: 'you@gmail.com',
  });
  if (p.isCancel(email) || !email) return undefined;
  
  const services = await p.multiselect({
    message: 'Services to authorize',
    options: GOG_SERVICES.map(s => ({
      value: s,
      label: s.charAt(0).toUpperCase() + s.slice(1),
    })),
    initialValues: ['gmail', 'calendar', 'drive', 'contacts'],
    required: true,
  });
  if (p.isCancel(services)) return undefined;
  
  p.note(
    'A browser window will open for Google authorization.\n' +
    'Sign in with your Google account and grant permissions.',
    'Authorization'
  );
  
  const spinner = p.spinner();
  spinner.start('Authorizing...');
  
  // Run gog auth add (this will open browser)
  const result = spawnSync('gog', [
    'auth', 'add', email,
    '--services', (services as string[]).join(','),
  ], { 
    stdio: 'inherit', // Let it interact with terminal for browser auth
    timeout: 300000, // 5 min timeout
  });
  
  if (result.status === 0) {
    spinner.stop('Account authorized');
    return { account: email, services: services as string[] };
  } else {
    spinner.stop('Authorization failed');
    p.log.error('Failed to authorize account. Try manually: gog auth add ' + email);
    return undefined;
  }
}

// ============================================================================
// Summary & Review
// ============================================================================

function showSummary(config: OnboardConfig): void {
  const lines: string[] = [];
  
  // Auth
  const authLabel = {
    keep: 'Keep existing',
    oauth: 'OAuth login',
    apikey: config.apiKey ? `API Key (${config.apiKey.slice(0, 10)}...)` : 'API Key',
    selfhosted: config.baseUrl ? `Self-hosted (${config.baseUrl})` : 'Self-hosted',
    skip: 'None',
  }[config.authMethod];
  lines.push(`Auth:      ${authLabel}`);
  
  // Agent
  const agentLabel = config.agentId 
    ? `${config.agentName || 'Selected'} (${config.agentId.slice(0, 12)}...)`
    : config.agentName 
      ? `New: ${config.agentName}`
      : config.agentChoice === 'skip' ? 'Keep current' : 'None';
  lines.push(`Agent:     ${agentLabel}`);
  
  // Model
  if (config.model) {
    lines.push(`Model:     ${config.model}`);
  }
  
  // Channels
  const channels: string[] = [];
  if (config.telegram.enabled) channels.push('Telegram');
  if (config.slack.enabled) channels.push('Slack');
  if (config.discord.enabled) channels.push('Discord');
  if (config.whatsapp.enabled) channels.push(config.whatsapp.selfChat ? 'WhatsApp (self)' : 'WhatsApp');
  if (config.signal.enabled) channels.push(config.signal.selfChat ? 'Signal (self)' : 'Signal');
  lines.push(`Channels:  ${channels.length > 0 ? channels.join(', ') : 'None'}`);
  
  // Features
  const features: string[] = [];
  if (config.heartbeat.enabled) features.push(`Heartbeat (${config.heartbeat.interval}m)`);
  if (config.cron) features.push('Cron');
  lines.push(`Features:  ${features.length > 0 ? features.join(', ') : 'None'}`);
  
  // Transcription
  lines.push(`Voice:     ${config.transcription.enabled ? 'Enabled (OpenAI Whisper)' : 'Disabled'}`);

  // Google
  if (config.google.enabled) {
    const googleAccounts = config.google.accounts.map(a => (
      `${a.account} (${a.services?.join(', ') || 'all'})`
    ));
    lines.push(`Google:    ${googleAccounts.join(', ')}`);
  }

  p.note(lines.join('\n'), 'Configuration');
}

type Section = 'auth' | 'agent' | 'channels' | 'features' | 'save';

async function reviewLoop(config: OnboardConfig, env: Record<string, string>): Promise<void> {
  while (true) {
    showSummary(config);
    
    const choice = await p.select({
      message: 'What would you like to do?',
      options: [
        { value: 'save', label: 'Save and finish', hint: '' },
        { value: 'auth', label: 'Change authentication', hint: '' },
        { value: 'agent', label: 'Change agent', hint: '' },
        { value: 'channels', label: 'Change channels', hint: '' },
        { value: 'features', label: 'Change features', hint: '' },
        { value: 'transcription', label: 'Change voice transcription', hint: '' },
        { value: 'google', label: 'Change Google Workspace', hint: '' },
      ],
    });
    if (p.isCancel(choice)) { p.cancel('Setup cancelled'); process.exit(0); }
    
    if (choice === 'save') break;
    
    // Re-run the selected section
    if (choice === 'auth') await stepAuth(config, env);
    else if (choice === 'agent') {
      await stepAgent(config, env);
      if (config.agentChoice === 'new') {
        await stepProviders(config, env);
        await stepModel(config, env);
      }
    }
    else if (choice === 'channels') await stepChannels(config, env);
    else if (choice === 'features') await stepFeatures(config);
    else if (choice === 'transcription') await stepTranscription(config);
    else if (choice === 'google') await stepGoogle(config);
  }
}

// ============================================================================
// Main Onboard Function
// ============================================================================

export async function onboard(options?: { nonInteractive?: boolean }): Promise<void> {
  const nonInteractive = options?.nonInteractive || false;
  // Temporary storage for wizard values
  const env: Record<string, string> = {};
  
  // Load existing config if available
  const { loadConfig, resolveConfigPath } = await import('./config/index.js');
  const existingConfig = loadConfig();
  const configPath = resolveConfigPath();
  const hasExistingConfig = existsSync(configPath);
  
  // Non-interactive mode: read all config from env vars
  if (nonInteractive) {
    console.log('🤖 LettaBot Non-Interactive Setup\n');
    console.log('Reading configuration from environment variables...\n');
    
    const config = readConfigFromEnv(existingConfig);
    
    // Show defaults being used
    console.log('Configuration:');
    console.log(`  Server: ${config.baseUrl}`);
    if (!process.env.LETTA_BASE_URL) {
      console.log('    (using default - override with LETTA_BASE_URL)');
    }
    
    if (config.telegram.enabled) {
      console.log(`  Telegram: enabled`);
      console.log(`    DM Policy: ${config.telegram.dmPolicy}${!process.env.TELEGRAM_DM_POLICY ? ' (default)' : ''}`);
    }
    
    if (config.slack.enabled) {
      console.log(`  Slack: enabled`);
      console.log(`    DM Policy: ${config.slack.dmPolicy}${!process.env.SLACK_DM_POLICY ? ' (default)' : ''}`);
    }
    
    if (config.discord.enabled) {
      console.log(`  Discord: enabled`);
      console.log(`    DM Policy: ${config.discord.dmPolicy}${!process.env.DISCORD_DM_POLICY ? ' (default)' : ''}`);
    }
    
    if (config.whatsapp.enabled) {
      console.log(`  WhatsApp: enabled`);
      console.log(`    Self-chat: ${config.whatsapp.selfChat}`);
      console.log(`    DM Policy: ${config.whatsapp.dmPolicy}${!process.env.WHATSAPP_DM_POLICY ? ' (default)' : ''}`);
      
      // Check if this is first-time WhatsApp setup (no auth data exists)
      const { existsSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const homeDir = process.env.HOME || process.env.USERPROFILE || '';
      const authPath = resolve(homeDir, '.wwebjs_auth');
      const isFirstTime = !existsSync(authPath);
      
      if (isFirstTime) {
        console.log('');
        console.log('⚠️  CRITICAL: First-Time WhatsApp Setup');
        console.log('   A QR code will print when you start the server.');
        console.log('   You MUST see the QR code to scan it with your phone.');
        console.log('');
        console.log('   IF USING AN AI AGENT TO START THE SERVER:');
        console.log('   - Tell the agent: "Run lettabot server in the FOREGROUND"');
        console.log('   - OR: "Do NOT background the server process"');
        console.log('   - The QR code output may be truncated - if you don\'t see it,');
        console.log('     run "lettabot server" yourself in a terminal to see the full output');
        console.log('');
        console.log('   After first pairing, the server can be backgrounded normally.');
      }
    }
    
    if (config.signal.enabled) {
      console.log(`  Signal: enabled`);
      console.log(`    DM Policy: ${config.signal.dmPolicy}${!process.env.SIGNAL_DM_POLICY ? ' (default)' : ''}`);
    }
    
    console.log('');
    
    // Validate required fields
    if (!config.apiKey && isLettaCloudUrl(config.baseUrl)) {
      console.error('❌ Error: LETTA_API_KEY is required');
      console.error('   Get your API key from: https://app.letta.com/settings');
      console.error('   Then run: export LETTA_API_KEY="letta_..."');
      console.error('');
      console.error('   Or use self-hosted Letta:');
      console.error('   export LETTA_BASE_URL="http://localhost:8283"');
      process.exit(1);
    }
    
    // Validate at least one channel is enabled
    const hasChannel = config.telegram.enabled || config.slack.enabled || config.discord.enabled || config.whatsapp.enabled || config.signal.enabled;
    if (!hasChannel) {
      console.error('❌ Error: At least one channel must be configured');
      console.error('');
      console.error('   Telegram:  export TELEGRAM_BOT_TOKEN="..." (from @BotFather)');
      console.error('   Slack:     export SLACK_BOT_TOKEN="..." and SLACK_APP_TOKEN="..."');
      console.error('   Discord:   export DISCORD_BOT_TOKEN="..."');
      console.error('   WhatsApp:  export WHATSAPP_ENABLED=true and WHATSAPP_SELF_CHAT_MODE=true');
      console.error('   Signal:    export SIGNAL_PHONE_NUMBER="+1234567890"');
      process.exit(1);
    }
    
    // CRITICAL: Validate WhatsApp self-chat is explicitly set
    if (config.whatsapp.enabled && process.env.WHATSAPP_SELF_CHAT_MODE === undefined) {
      console.error('❌ Error: WhatsApp requires explicit WHATSAPP_SELF_CHAT_MODE for safety');
      console.error('');
      console.error('   For personal number (SAFE - only "Message Yourself" chat):');
      console.error('   export WHATSAPP_SELF_CHAT_MODE=true');
      console.error('');
      console.error('   For dedicated bot number (UNSAFE - responds to ALL messages):');
      console.error('   export WHATSAPP_SELF_CHAT_MODE=false');
      process.exit(1);
    }
    
    // Test server connection
    console.log(`Connecting to ${config.baseUrl}...`);
    try {
      const res = await fetch(`${config.baseUrl}/v1/health`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        console.log('✅ Connected to server\n');
      } else {
        console.error(`❌ Server returned status ${res.status}`);
        process.exit(1);
      }
    } catch (e) {
      console.error(`❌ Could not connect to ${config.baseUrl}`);
      process.exit(1);
    }
    
    // Save config and exit
    await saveConfigFromEnv(config, configPath);
    console.log(`✅ Configuration saved to ${configPath}\n`);
    console.log('Run "lettabot server" to start the bot.');
    return;
  }
  
  p.intro('🤖 LettaBot Setup');
  
  if (hasExistingConfig) {
    p.log.info(`Loading existing config from ${configPath}`);
  }
  
  // Pre-populate from existing config
  const baseUrl = existingConfig.server.baseUrl || process.env.LETTA_BASE_URL || 'https://api.letta.com';
  const isLocal = !isLettaCloudUrl(baseUrl);
  p.note(`${baseUrl}\n${isLocal ? 'Self-hosted' : 'Letta Cloud'}`, 'Server');
  
  // Test server connection
  const spinner = p.spinner();
  spinner.start('Testing connection...');
  try {
    const res = await fetch(`${baseUrl}/v1/health`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      spinner.stop('Connected to server');
    } else {
      spinner.stop('Server returned error');
      p.log.warning(`Server responded with status ${res.status}`);
    }
  } catch (e) {
    spinner.stop('Connection failed');
    p.log.error(`Could not connect to ${baseUrl}`);
    const continueAnyway = await p.confirm({ message: 'Continue anyway?', initialValue: false });
    if (p.isCancel(continueAnyway) || !continueAnyway) {
      p.cancel('Setup cancelled');
      process.exit(1);
    }
  }
  
  // Initialize config from existing env
  // Pre-populate from existing YAML config
  const config: OnboardConfig = {
    authMethod: hasExistingConfig ? 'keep' : 'skip',
    apiKey: existingConfig.server.apiKey,
    baseUrl: existingConfig.server.baseUrl,
    telegram: { 
      enabled: existingConfig.channels.telegram?.enabled || false,
      token: existingConfig.channels.telegram?.token,
      dmPolicy: existingConfig.channels.telegram?.dmPolicy,
      allowedUsers: existingConfig.channels.telegram?.allowedUsers?.map(String),
    },
    slack: { 
      enabled: existingConfig.channels.slack?.enabled || false,
      appToken: existingConfig.channels.slack?.appToken,
      botToken: existingConfig.channels.slack?.botToken,
      allowedUsers: existingConfig.channels.slack?.allowedUsers,
    },
    discord: {
      enabled: existingConfig.channels.discord?.enabled || false,
      token: existingConfig.channels.discord?.token,
      dmPolicy: existingConfig.channels.discord?.dmPolicy,
      allowedUsers: existingConfig.channels.discord?.allowedUsers,
    },
    whatsapp: { 
      enabled: existingConfig.channels.whatsapp?.enabled || false,
      selfChat: existingConfig.channels.whatsapp?.selfChat ?? true, // Default true
      dmPolicy: existingConfig.channels.whatsapp?.dmPolicy,
    },
    signal: { 
      enabled: existingConfig.channels.signal?.enabled || false,
      phone: existingConfig.channels.signal?.phone,
      selfChat: existingConfig.channels.signal?.selfChat ?? true, // Default true
      dmPolicy: existingConfig.channels.signal?.dmPolicy,
    },
    google: (() => {
      const existingAccounts = existingConfig.integrations?.google?.accounts
        ? existingConfig.integrations.google.accounts.map(a => ({
            account: a.account,
            services: a.services || [],
          }))
        : (existingConfig.integrations?.google?.account ? [{
            account: existingConfig.integrations.google.account,
            services: existingConfig.integrations.google.services || [],
          }] : []);
      return {
        enabled: (existingConfig.integrations?.google?.enabled || false) || existingAccounts.length > 0,
        accounts: existingAccounts,
      };
    })(),
    heartbeat: { 
      enabled: existingConfig.features?.heartbeat?.enabled || false,
      interval: existingConfig.features?.heartbeat?.intervalMin?.toString(),
    },
    cron: existingConfig.features?.cron || false,
    transcription: {
      enabled: !!existingConfig.transcription?.apiKey || !!process.env.OPENAI_API_KEY,
      apiKey: existingConfig.transcription?.apiKey,
      model: existingConfig.transcription?.model,
    },
    agentChoice: hasExistingConfig ? 'env' : 'skip',
    agentName: existingConfig.agent.name,
    agentId: existingConfig.agent.id,
    providers: existingConfig.providers?.map(p => ({ id: p.id, name: p.name, apiKey: p.apiKey })),
  };
  
  // Run through all steps
  await stepAuth(config, env);
  await stepAgent(config, env);
  
  // Fetch billing tier for free plan detection (only for Letta Cloud)
  if (config.authMethod !== 'selfhosted' && config.agentChoice === 'new') {
    const { getBillingTier } = await import('./utils/model-selection.js');
    const spinner = p.spinner();
    spinner.start('Checking account...');
    const apiKey = config.apiKey || env.LETTA_API_KEY || process.env.LETTA_API_KEY;
    const billingTier = await getBillingTier(apiKey, false);
    config.billingTier = billingTier ?? undefined;
    spinner.stop(billingTier === 'free' ? 'Free plan' : `Plan: ${billingTier || 'Pro'}`);
  }
  
  await stepProviders(config, env);
  await stepModel(config, env);
  await stepChannels(config, env);
  await stepFeatures(config);
  await stepTranscription(config);
  await stepGoogle(config);

  // Review loop
  await reviewLoop(config, env);
  
  // Apply config to env
  if (config.agentName) env.AGENT_NAME = config.agentName;
  
  if (config.telegram.enabled && config.telegram.token) {
    env.TELEGRAM_BOT_TOKEN = config.telegram.token;
    if (config.telegram.dmPolicy) env.TELEGRAM_DM_POLICY = config.telegram.dmPolicy;
    if (config.telegram.allowedUsers?.length) {
      env.TELEGRAM_ALLOWED_USERS = config.telegram.allowedUsers.join(',');
    } else {
      delete env.TELEGRAM_ALLOWED_USERS;
    }
  } else {
    delete env.TELEGRAM_BOT_TOKEN;
    delete env.TELEGRAM_DM_POLICY;
    delete env.TELEGRAM_ALLOWED_USERS;
  }
  
  if (config.slack.enabled) {
    if (config.slack.appToken) env.SLACK_APP_TOKEN = config.slack.appToken;
    if (config.slack.botToken) env.SLACK_BOT_TOKEN = config.slack.botToken;
    if (config.slack.allowedUsers?.length) {
      env.SLACK_ALLOWED_USERS = config.slack.allowedUsers.join(',');
    } else {
      delete env.SLACK_ALLOWED_USERS;
    }
  } else {
    delete env.SLACK_APP_TOKEN;
    delete env.SLACK_BOT_TOKEN;
    delete env.SLACK_ALLOWED_USERS;
  }

  if (config.discord.enabled && config.discord.token) {
    env.DISCORD_BOT_TOKEN = config.discord.token;
    if (config.discord.dmPolicy) env.DISCORD_DM_POLICY = config.discord.dmPolicy;
    if (config.discord.allowedUsers?.length) {
      env.DISCORD_ALLOWED_USERS = config.discord.allowedUsers.join(',');
    } else {
      delete env.DISCORD_ALLOWED_USERS;
    }
  } else {
    delete env.DISCORD_BOT_TOKEN;
    delete env.DISCORD_DM_POLICY;
    delete env.DISCORD_ALLOWED_USERS;
  }
  
  if (config.whatsapp.enabled) {
    env.WHATSAPP_ENABLED = 'true';
    if (config.whatsapp.selfChat) env.WHATSAPP_SELF_CHAT_MODE = 'true';
    else delete env.WHATSAPP_SELF_CHAT_MODE;
    if (config.whatsapp.dmPolicy) env.WHATSAPP_DM_POLICY = config.whatsapp.dmPolicy;
    if (config.whatsapp.allowedUsers?.length) {
      env.WHATSAPP_ALLOWED_USERS = config.whatsapp.allowedUsers.join(',');
    } else {
      delete env.WHATSAPP_ALLOWED_USERS;
    }
  } else {
    delete env.WHATSAPP_ENABLED;
    delete env.WHATSAPP_SELF_CHAT_MODE;
    delete env.WHATSAPP_DM_POLICY;
    delete env.WHATSAPP_ALLOWED_USERS;
  }
  
  if (config.signal.enabled && config.signal.phone) {
    env.SIGNAL_PHONE_NUMBER = config.signal.phone;
    // Signal selfChat defaults to true, so only set env if explicitly false (dedicated number)
    if (config.signal.selfChat === false) env.SIGNAL_SELF_CHAT_MODE = 'false';
    else delete env.SIGNAL_SELF_CHAT_MODE;
    if (config.signal.dmPolicy) env.SIGNAL_DM_POLICY = config.signal.dmPolicy;
    if (config.signal.allowedUsers?.length) {
      env.SIGNAL_ALLOWED_USERS = config.signal.allowedUsers.join(',');
    } else {
      delete env.SIGNAL_ALLOWED_USERS;
    }
  } else {
    delete env.SIGNAL_PHONE_NUMBER;
    delete env.SIGNAL_SELF_CHAT_MODE;
    delete env.SIGNAL_DM_POLICY;
    delete env.SIGNAL_ALLOWED_USERS;
  }
  
  if (config.heartbeat.enabled && config.heartbeat.interval) {
    env.HEARTBEAT_INTERVAL_MIN = config.heartbeat.interval;
  } else {
    delete env.HEARTBEAT_INTERVAL_MIN;
  }
  
  if (config.cron) {
    env.CRON_ENABLED = 'true';
  } else {
    delete env.CRON_ENABLED;
  }

  if (config.transcription.enabled && config.transcription.apiKey) {
    env.OPENAI_API_KEY = config.transcription.apiKey;
  }

  // Helper to format access control status
  const formatAccess = (policy?: string, allowedUsers?: string[]) => {
    if (policy === 'pairing') return 'pairing';
    if (policy === 'allowlist') return `allowlist (${allowedUsers?.length || 0} users)`;
    if (policy === 'open') return '⚠️ open';
    return 'pairing';
  };
  
  // Show summary
  const summary = [
    `Agent: ${config.agentId ? `${config.agentName} (${config.agentId.slice(0, 20)}...)` : config.agentName || '(will create on first message)'}`,
    ...(config.model ? [`Model: ${config.model} (for initial agent creation only)`] : []),
    '',
    'Channels:',
    config.telegram.enabled ? `  ✓ Telegram (${formatAccess(config.telegram.dmPolicy, config.telegram.allowedUsers)})` : '  ✗ Telegram',
    config.slack.enabled ? `  ✓ Slack ${config.slack.allowedUsers?.length ? `(${config.slack.allowedUsers.length} allowed users)` : '(workspace access)'}` : '  ✗ Slack',
    config.discord.enabled ? `  ✓ Discord (${formatAccess(config.discord.dmPolicy, config.discord.allowedUsers)})` : '  ✗ Discord',
    config.whatsapp.enabled ? `  ✓ WhatsApp (${formatAccess(config.whatsapp.dmPolicy, config.whatsapp.allowedUsers)})` : '  ✗ WhatsApp',
    config.signal.enabled ? `  ✓ Signal (${formatAccess(config.signal.dmPolicy, config.signal.allowedUsers)})` : '  ✗ Signal',
    '',
    'Integrations:',
    config.google.enabled && config.google.accounts.length > 0
      ? `  ✓ Google (${config.google.accounts.map(a => `${a.account} - ${a.services?.join(', ') || 'all'}`).join(', ')})`
      : '  ✗ Google Workspace',
    '',
    'Features:',
    config.heartbeat.enabled ? `  ✓ Heartbeat (${config.heartbeat.interval}min)` : '  ✗ Heartbeat',
    config.cron ? '  ✓ Cron jobs' : '  ✗ Cron jobs',
    config.transcription.enabled ? '  ✓ Voice transcription (OpenAI Whisper)' : '  ✗ Voice transcription',
  ].join('\n');
  
  p.note(summary, 'Configuration Summary');
  
  // Convert to YAML config
  const yamlConfig: LettaBotConfig = {
    server: {
      mode: config.authMethod === 'selfhosted' ? 'selfhosted' : 'cloud',
      ...(config.authMethod === 'selfhosted' && config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    },
    agent: {
      name: config.agentName || 'LettaBot',
      // model is configured on the Letta agent server-side, not saved to config
      ...(config.agentId ? { id: config.agentId } : {}),
    },
    channels: {
      ...(config.telegram.enabled ? {
        telegram: {
          enabled: true,
          token: config.telegram.token,
          dmPolicy: config.telegram.dmPolicy,
          allowedUsers: config.telegram.allowedUsers,
          groupDebounceSec: config.telegram.groupDebounceSec,
          groupPollIntervalMin: config.telegram.groupPollIntervalMin,
          instantGroups: config.telegram.instantGroups,
          listeningGroups: config.telegram.listeningGroups,
        }
      } : {}),
      ...(config.slack.enabled ? {
        slack: {
          enabled: true,
          appToken: config.slack.appToken,
          botToken: config.slack.botToken,
          allowedUsers: config.slack.allowedUsers,
          groupDebounceSec: config.slack.groupDebounceSec,
          groupPollIntervalMin: config.slack.groupPollIntervalMin,
          instantGroups: config.slack.instantGroups,
          listeningGroups: config.slack.listeningGroups,
        }
      } : {}),
      ...(config.discord.enabled ? {
        discord: {
          enabled: true,
          token: config.discord.token,
          dmPolicy: config.discord.dmPolicy,
          allowedUsers: config.discord.allowedUsers,
          groupDebounceSec: config.discord.groupDebounceSec,
          groupPollIntervalMin: config.discord.groupPollIntervalMin,
          instantGroups: config.discord.instantGroups,
          listeningGroups: config.discord.listeningGroups,
        }
      } : {}),
      ...(config.whatsapp.enabled ? {
        whatsapp: {
          enabled: true,
          selfChat: config.whatsapp.selfChat,
          dmPolicy: config.whatsapp.dmPolicy,
          allowedUsers: config.whatsapp.allowedUsers,
          groupDebounceSec: config.whatsapp.groupDebounceSec,
          groupPollIntervalMin: config.whatsapp.groupPollIntervalMin,
          instantGroups: config.whatsapp.instantGroups,
          listeningGroups: config.whatsapp.listeningGroups,
        }
      } : {}),
      ...(config.signal.enabled ? {
        signal: {
          enabled: true,
          phone: config.signal.phone,
          selfChat: config.signal.selfChat,
          dmPolicy: config.signal.dmPolicy,
          allowedUsers: config.signal.allowedUsers,
          groupDebounceSec: config.signal.groupDebounceSec,
          groupPollIntervalMin: config.signal.groupPollIntervalMin,
          instantGroups: config.signal.instantGroups,
          listeningGroups: config.signal.listeningGroups,
        }
      } : {}),
    },
    features: {
      cron: config.cron,
      heartbeat: {
        enabled: config.heartbeat.enabled,
        intervalMin: config.heartbeat.interval ? parseInt(config.heartbeat.interval) : undefined,
      },
    },
    ...(config.transcription.enabled && config.transcription.apiKey ? {
      transcription: {
        provider: 'openai' as const,
        apiKey: config.transcription.apiKey,
        ...(config.transcription.model ? { model: config.transcription.model } : {}),
      },
    } : {}),
    ...(config.google.enabled ? {
      integrations: {
        google: {
          enabled: true,
          accounts: config.google.accounts,
        },
      },
      ...((() => {
        const gmailAccounts = config.google.accounts
          .filter(a => a.services?.includes('gmail'))
          .map(a => a.account);
        return gmailAccounts.length > 0 ? {
          polling: { gmail: { accounts: gmailAccounts } },
        } : {};
      })()),
    } : {}),
  };
  
  // Add BYOK providers if configured
  if (config.providers && config.providers.length > 0) {
    yamlConfig.providers = config.providers.map(p => ({
      id: p.id,
      name: p.name,
      type: p.id, // id is the type (anthropic, openai, etc.)
      apiKey: p.apiKey,
    }));
  }
  
  // Save YAML config (use project-local path)
  const savePath = resolve(process.cwd(), 'lettabot.yaml');
  saveConfig(yamlConfig, savePath);
  p.log.success('Configuration saved to lettabot.yaml');
  
  // Sync BYOK providers to Letta Cloud
  if (yamlConfig.providers && yamlConfig.providers.length > 0 && yamlConfig.server.mode === 'cloud') {
    const spinner = p.spinner();
    spinner.start('Syncing BYOK providers to Letta Cloud...');
    try {
      await syncProviders(yamlConfig);
      spinner.stop('BYOK providers synced');
    } catch (err) {
      spinner.stop('Failed to sync providers (will retry on startup)');
    }
  }
  
  // Save agent ID with server URL
  if (config.agentId) {
    const baseUrl = env.LETTA_BASE_URL || process.env.LETTA_BASE_URL || 'https://api.letta.com';
    writeFileSync(
      resolve(process.cwd(), 'lettabot-agent.json'),
      JSON.stringify({ 
        agentId: config.agentId,
        baseUrl: baseUrl,
        createdAt: new Date().toISOString(),
      }, null, 2)
    );
    p.log.success(`Agent ID saved: ${config.agentId} (${baseUrl})`);
  }
  
  p.outro('🎉 Setup complete! Run `npx lettabot server` to start.');
}

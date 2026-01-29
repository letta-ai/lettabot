/**
 * LettaBot Onboarding - Modular setup wizard with review/edit capability
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as p from '@clack/prompts';
import { saveConfig, syncProviders } from './config/index.js';
import type { LettaBotConfig, ProviderConfig } from './config/types.js';

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
  telegram: { enabled: boolean; token?: string; dmPolicy?: 'pairing' | 'allowlist' | 'open'; allowedUsers?: string[] };
  slack: { enabled: boolean; appToken?: string; botToken?: string; allowedUsers?: string[] };
  whatsapp: { enabled: boolean; selfChat?: boolean; dmPolicy?: 'pairing' | 'allowlist' | 'open'; allowedUsers?: string[] };
  signal: { enabled: boolean; phone?: string; dmPolicy?: 'pairing' | 'allowlist' | 'open'; allowedUsers?: string[] };
  discord: { enabled: boolean; token?: string; dmPolicy?: 'pairing' | 'allowlist' | 'open'; allowedUsers?: string[] };
  gmail: { enabled: boolean; account?: string };
  
  // Features
  heartbeat: { enabled: boolean; interval?: string };
  cron: boolean;
}

const isPlaceholder = (val?: string) => !val || /^(your_|sk-\.\.\.|placeholder|example)/i.test(val);

// ============================================================================
// Step Functions
// ============================================================================

async function stepAuth(config: OnboardConfig, env: Record<string, string>): Promise<void> {
  const { requestDeviceCode, pollForToken, LETTA_CLOUD_API_URL } = await import('./auth/oauth.js');
  const { saveTokens, loadTokens, getOrCreateDeviceId, getDeviceName } = await import('./auth/tokens.js');
  
  const baseUrl = config.baseUrl || env.LETTA_BASE_URL || process.env.LETTA_BASE_URL;
  const isLettaCloud = !baseUrl || baseUrl === LETTA_CLOUD_API_URL || baseUrl === 'https://api.letta.com';
  
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
  // Check if signal-cli is installed
  const signalInstalled = spawnSync('which', ['signal-cli'], { stdio: 'pipe' }).status === 0;
  
  // Build channel options - show all channels, disabled ones have explanatory hints
  const channelOptions: Array<{ value: string; label: string; hint: string }> = [
    { value: 'telegram', label: 'Telegram', hint: 'Recommended - easiest to set up' },
    { value: 'slack', label: 'Slack', hint: 'Socket Mode app' },
    { value: 'discord', label: 'Discord', hint: 'Bot token + Message Content intent' },
    { value: 'whatsapp', label: 'WhatsApp', hint: 'QR code pairing' },
    { 
      value: 'signal', 
      label: 'Signal', 
      hint: signalInstalled ? 'signal-cli daemon' : '⚠️ signal-cli not installed' 
    },
  ];
  
  // Pre-select channels that are already enabled (preserves existing config)
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
    
    // Confirm if no channels selected
    if (channels.length === 0) {
      const skipChannels = await p.confirm({
        message: 'No channels selected. Continue without any messaging channels?',
        initialValue: false,
      });
      if (p.isCancel(skipChannels)) { p.cancel('Setup cancelled'); process.exit(0); }
      if (skipChannels) break;
      // Otherwise loop back to selection
    } else {
      break;
    }
  }
  
  // Update enabled states
  config.telegram.enabled = channels.includes('telegram');
  config.slack.enabled = channels.includes('slack');
  config.discord.enabled = channels.includes('discord');
  config.whatsapp.enabled = channels.includes('whatsapp');
  
  // Handle Signal - warn if selected but not installed
  if (channels.includes('signal') && !signalInstalled) {
    p.log.warn('Signal selected but signal-cli is not installed. Install with: brew install signal-cli');
    config.signal.enabled = false;
  } else {
    config.signal.enabled = channels.includes('signal');
  }
  
  // Configure each selected channel
  if (config.telegram.enabled) {
    p.note(
      '1. Message @BotFather on Telegram\n' +
      '2. Send /newbot and follow prompts\n' +
      '3. Copy the bot token',
      'Telegram Setup'
    );
    
    const token = await p.text({
      message: 'Telegram Bot Token',
      placeholder: '123456:ABC-DEF...',
      initialValue: config.telegram.token || '',
    });
    if (!p.isCancel(token) && token) config.telegram.token = token;
    
    // Access control
    const dmPolicy = await p.select({
      message: 'Telegram: Who can message the bot?',
      options: [
        { value: 'pairing', label: 'Pairing (recommended)', hint: 'Requires CLI approval' },
        { value: 'allowlist', label: 'Allowlist only', hint: 'Specific user IDs' },
        { value: 'open', label: 'Open', hint: 'Anyone (not recommended)' },
      ],
      initialValue: config.telegram.dmPolicy || 'pairing',
    });
    if (!p.isCancel(dmPolicy)) {
      config.telegram.dmPolicy = dmPolicy as 'pairing' | 'allowlist' | 'open';
      
      if (dmPolicy === 'pairing') {
        p.log.info('Users will get a code. Approve with: lettabot pairing approve telegram CODE');
      } else if (dmPolicy === 'allowlist') {
        const users = await p.text({
          message: 'Allowed Telegram user IDs (comma-separated)',
          placeholder: '123456789,987654321',
          initialValue: config.telegram.allowedUsers?.join(',') || '',
        });
        if (!p.isCancel(users) && users) {
          config.telegram.allowedUsers = users.split(',').map(s => s.trim()).filter(Boolean);
        }
      }
    }
  }
  
  if (config.slack.enabled) {
    const hasExistingTokens = config.slack.appToken || config.slack.botToken;
    
    // Show what's needed
    p.note(
      'Requires two tokens from api.slack.com/apps:\n' +
      '  • App Token (xapp-...) - Socket Mode\n' +
      '  • Bot Token (xoxb-...) - Bot permissions',
      'Slack Requirements'
    );
    
    const wizardChoice = await p.select({
      message: 'Slack setup',
      options: [
        { value: 'wizard', label: 'Guided setup', hint: 'Step-by-step instructions with validation' },
        { value: 'manual', label: 'Manual entry', hint: 'I already have tokens' },
      ],
      initialValue: hasExistingTokens ? 'manual' : 'wizard',
    });
    
    if (p.isCancel(wizardChoice)) {
      p.cancel('Setup cancelled');
      process.exit(0);
    }
    
    if (wizardChoice === 'wizard') {
      const { runSlackWizard } = await import('./setup/slack-wizard.js');
      const result = await runSlackWizard({
        appToken: config.slack.appToken,
        botToken: config.slack.botToken,
        allowedUsers: config.slack.allowedUsers,
      });
      
      if (result) {
        config.slack.appToken = result.appToken;
        config.slack.botToken = result.botToken;
        config.slack.allowedUsers = result.allowedUsers;
      } else {
        // Wizard was cancelled, disable Slack
        config.slack.enabled = false;
      }
    } else {
      // Manual token entry with validation
      const { validateSlackTokens, stepAccessControl, validateAppToken, validateBotToken } = await import('./setup/slack-wizard.js');
      
      p.note(
        'Get tokens from api.slack.com/apps:\n' +
        '• Enable Socket Mode → App-Level Token (xapp-...)\n' +
        '• Install App → Bot User OAuth Token (xoxb-...)\n\n' +
        'See docs/slack-setup.md for detailed instructions',
        'Slack Setup'
      );
      
      const appToken = await p.text({
        message: 'Slack App Token (xapp-...)',
        initialValue: config.slack.appToken || '',
        validate: validateAppToken,
      });
      if (p.isCancel(appToken)) {
        config.slack.enabled = false;
      } else {
        config.slack.appToken = appToken;
      }
      
      const botToken = await p.text({
        message: 'Slack Bot Token (xoxb-...)',
        initialValue: config.slack.botToken || '',
        validate: validateBotToken,
      });
      if (p.isCancel(botToken)) {
        config.slack.enabled = false;
      } else {
        config.slack.botToken = botToken;
      }
      
      // Validate tokens if both provided
      if (config.slack.appToken && config.slack.botToken) {
        await validateSlackTokens(config.slack.appToken, config.slack.botToken);
      }
      
      // Slack access control (reuse wizard step)
      const allowedUsers = await stepAccessControl(config.slack.allowedUsers);
      if (allowedUsers !== undefined) {
        config.slack.allowedUsers = allowedUsers;
      }
    }
  }

  if (config.discord.enabled) {
    p.note(
      '1. Go to discord.com/developers/applications\n' +
      '2. Click "New Application" (or select existing)\n' +
      '3. Go to "Bot" → Copy the Bot Token\n' +
      '4. Enable "Message Content Intent" (under Privileged Gateway Intents)\n' +
      '5. Go to "OAuth2" → "URL Generator"\n' +
      '   • Scopes: bot\n' +
      '   • Permissions: Send Messages, Read Message History, View Channels\n' +
      '6. Copy the generated URL and open it to invite the bot to your server',
      'Discord Setup'
    );

    const token = await p.text({
      message: 'Discord Bot Token',
      placeholder: 'Bot → Reset Token → Copy',
      initialValue: config.discord.token || '',
    });
    if (!p.isCancel(token) && token) {
      config.discord.token = token;
      
      // Extract application ID from token and show invite URL
      // Token format: base64(app_id).timestamp.hmac
      try {
        const appId = Buffer.from(token.split('.')[0], 'base64').toString();
        if (/^\d+$/.test(appId)) {
          // permissions=68608 = Send Messages (2048) + Read Message History (65536) + View Channels (1024)
          const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${appId}&permissions=68608&scope=bot`;
          p.log.info(`Invite URL: ${inviteUrl}`);
          p.log.message('Open this URL in your browser to add the bot to your server.');
        }
      } catch {
        // Token parsing failed, skip showing URL
      }
    }

    const dmPolicy = await p.select({
      message: 'Discord: Who can message the bot?',
      options: [
        { value: 'pairing', label: 'Pairing (recommended)', hint: 'Requires CLI approval' },
        { value: 'allowlist', label: 'Allowlist only', hint: 'Specific user IDs' },
        { value: 'open', label: 'Open', hint: 'Anyone (not recommended)' },
      ],
      initialValue: config.discord.dmPolicy || 'pairing',
    });
    if (!p.isCancel(dmPolicy)) {
      config.discord.dmPolicy = dmPolicy as 'pairing' | 'allowlist' | 'open';

      if (dmPolicy === 'pairing') {
        p.log.info('Users will get a code. Approve with: lettabot pairing approve discord CODE');
      } else if (dmPolicy === 'allowlist') {
        const users = await p.text({
          message: 'Allowed Discord user IDs (comma-separated)',
          placeholder: '123456789012345678,987654321098765432',
          initialValue: config.discord.allowedUsers?.join(',') || '',
        });
        if (!p.isCancel(users) && users) {
          config.discord.allowedUsers = users.split(',').map(s => s.trim()).filter(Boolean);
        }
      }
    }
  }
  
  if (config.whatsapp.enabled) {
    p.note(
      'QR code will appear on first run - scan with your phone.\n' +
      'Phone: Settings → Linked Devices → Link a Device\n\n' +
      '⚠️  Security: Links as a full device to your WhatsApp account.\n' +
      'Can see ALL messages, not just ones sent to the bot.\n' +
      'Consider using a dedicated number for better isolation.',
      'WhatsApp'
    );
    
    const selfChat = await p.confirm({
      message: 'WhatsApp: Self-chat mode? (Message Yourself)',
      initialValue: config.whatsapp.selfChat ?? false,
    });
    if (!p.isCancel(selfChat)) config.whatsapp.selfChat = selfChat;
    
    // Access control (important since WhatsApp has full account access)
    const dmPolicy = await p.select({
      message: 'WhatsApp: Who can message the bot?',
      options: [
        { value: 'pairing', label: 'Pairing (recommended)', hint: 'Requires CLI approval' },
        { value: 'allowlist', label: 'Allowlist only', hint: 'Specific phone numbers' },
        { value: 'open', label: 'Open', hint: '⚠️ Anyone (not recommended - full account access!)' },
      ],
      initialValue: config.whatsapp.dmPolicy || 'pairing',
    });
    if (!p.isCancel(dmPolicy)) {
      config.whatsapp.dmPolicy = dmPolicy as 'pairing' | 'allowlist' | 'open';
      
      if (dmPolicy === 'pairing') {
        p.log.info('Users will get a code. Approve with: lettabot pairing approve whatsapp CODE');
      } else if (dmPolicy === 'allowlist') {
        const users = await p.text({
          message: 'Allowed phone numbers (comma-separated, with +)',
          placeholder: '+15551234567,+15559876543',
          initialValue: config.whatsapp.allowedUsers?.join(',') || '',
        });
        if (!p.isCancel(users) && users) {
          config.whatsapp.allowedUsers = users.split(',').map(s => s.trim()).filter(Boolean);
        }
      }
    }
  }
  
  if (config.signal.enabled) {
    p.note(
      'See docs/signal-setup.md for detailed instructions.\n' +
      'Requires signal-cli registered with your phone number.\n\n' +
      '⚠️  Security: Has full access to your Signal account.\n' +
      'Can see all messages and send as you.',
      'Signal Setup'
    );
    
    const phone = await p.text({
      message: 'Signal phone number',
      placeholder: '+1XXXXXXXXXX',
      initialValue: config.signal.phone || '',
    });
    if (!p.isCancel(phone) && phone) config.signal.phone = phone;
    
    // Access control
    const dmPolicy = await p.select({
      message: 'Signal: Who can message the bot?',
      options: [
        { value: 'pairing', label: 'Pairing (recommended)', hint: 'Requires CLI approval' },
        { value: 'allowlist', label: 'Allowlist only', hint: 'Specific phone numbers' },
        { value: 'open', label: 'Open', hint: 'Anyone (not recommended)' },
      ],
      initialValue: config.signal.dmPolicy || 'pairing',
    });
    if (!p.isCancel(dmPolicy)) {
      config.signal.dmPolicy = dmPolicy as 'pairing' | 'allowlist' | 'open';
      
      if (dmPolicy === 'pairing') {
        p.log.info('Users will get a code. Approve with: lettabot pairing approve signal CODE');
      } else if (dmPolicy === 'allowlist') {
        const users = await p.text({
          message: 'Allowed phone numbers (comma-separated, with +)',
          placeholder: '+15551234567,+15559876543',
          initialValue: config.signal.allowedUsers?.join(',') || '',
        });
        if (!p.isCancel(users) && users) {
          config.signal.allowedUsers = users.split(',').map(s => s.trim()).filter(Boolean);
        }
      }
    }
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
  if (config.signal.enabled) channels.push('Signal');
  lines.push(`Channels:  ${channels.length > 0 ? channels.join(', ') : 'None'}`);
  
  // Features
  const features: string[] = [];
  if (config.heartbeat.enabled) features.push(`Heartbeat (${config.heartbeat.interval}m)`);
  if (config.cron) features.push('Cron');
  lines.push(`Features:  ${features.length > 0 ? features.join(', ') : 'None'}`);
  
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
  }
}

// ============================================================================
// Main Onboard Function
// ============================================================================

export async function onboard(): Promise<void> {
  // Temporary storage for wizard values
  const env: Record<string, string> = {};
  
  // Load existing config if available
  const { loadConfig, resolveConfigPath } = await import('./config/index.js');
  const existingConfig = loadConfig();
  const configPath = resolveConfigPath();
  const hasExistingConfig = existsSync(configPath);
  
  p.intro('🤖 LettaBot Setup');
  
  if (hasExistingConfig) {
    p.log.info(`Loading existing config from ${configPath}`);
  }
  
  // Pre-populate from existing config
  const baseUrl = existingConfig.server.baseUrl || process.env.LETTA_BASE_URL || 'https://api.letta.com';
  const isLocal = baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1');
  p.note(`${baseUrl}\n${isLocal ? 'Local Docker' : 'Letta Cloud'}`, 'Server');
  
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
      selfChat: existingConfig.channels.whatsapp?.selfChat,
      dmPolicy: existingConfig.channels.whatsapp?.dmPolicy,
    },
    signal: { 
      enabled: existingConfig.channels.signal?.enabled || false,
      phone: existingConfig.channels.signal?.phone,
      dmPolicy: existingConfig.channels.signal?.dmPolicy,
    },
    gmail: { enabled: false },
    heartbeat: { 
      enabled: existingConfig.features?.heartbeat?.enabled || false,
      interval: existingConfig.features?.heartbeat?.intervalMin?.toString(),
    },
    cron: existingConfig.features?.cron || false,
    agentChoice: hasExistingConfig ? 'env' : 'skip',
    agentName: existingConfig.agent.name,
    agentId: existingConfig.agent.id,
    model: existingConfig.agent.model,
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
  
  // Review loop
  await reviewLoop(config, env);
  
  // Apply config to env
  if (config.agentName) env.AGENT_NAME = config.agentName;
  if (config.model) env.MODEL = config.model;
  
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
    if (config.signal.dmPolicy) env.SIGNAL_DM_POLICY = config.signal.dmPolicy;
    if (config.signal.allowedUsers?.length) {
      env.SIGNAL_ALLOWED_USERS = config.signal.allowedUsers.join(',');
    } else {
      delete env.SIGNAL_ALLOWED_USERS;
    }
  } else {
    delete env.SIGNAL_PHONE_NUMBER;
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
    `Model: ${config.model || 'default'}`,
    '',
    'Channels:',
    config.telegram.enabled ? `  ✓ Telegram (${formatAccess(config.telegram.dmPolicy, config.telegram.allowedUsers)})` : '  ✗ Telegram',
    config.slack.enabled ? `  ✓ Slack ${config.slack.allowedUsers?.length ? `(${config.slack.allowedUsers.length} allowed users)` : '(workspace access)'}` : '  ✗ Slack',
    config.discord.enabled ? `  ✓ Discord (${formatAccess(config.discord.dmPolicy, config.discord.allowedUsers)})` : '  ✗ Discord',
    config.whatsapp.enabled ? `  ✓ WhatsApp (${formatAccess(config.whatsapp.dmPolicy, config.whatsapp.allowedUsers)})` : '  ✗ WhatsApp',
    config.signal.enabled ? `  ✓ Signal (${formatAccess(config.signal.dmPolicy, config.signal.allowedUsers)})` : '  ✗ Signal',
    '',
    'Features:',
    config.heartbeat.enabled ? `  ✓ Heartbeat (${config.heartbeat.interval}min)` : '  ✗ Heartbeat',
    config.cron ? '  ✓ Cron jobs' : '  ✗ Cron jobs',
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
      model: config.model || 'zai/glm-4.7',
      ...(config.agentId ? { id: config.agentId } : {}),
    },
    channels: {
      ...(config.telegram.enabled ? {
        telegram: {
          enabled: true,
          token: config.telegram.token,
          dmPolicy: config.telegram.dmPolicy,
          allowedUsers: config.telegram.allowedUsers,
        }
      } : {}),
      ...(config.slack.enabled ? {
        slack: {
          enabled: true,
          appToken: config.slack.appToken,
          botToken: config.slack.botToken,
          allowedUsers: config.slack.allowedUsers,
        }
      } : {}),
      ...(config.discord.enabled ? {
        discord: {
          enabled: true,
          token: config.discord.token,
          dmPolicy: config.discord.dmPolicy,
          allowedUsers: config.discord.allowedUsers,
        }
      } : {}),
      ...(config.whatsapp.enabled ? {
        whatsapp: {
          enabled: true,
          selfChat: config.whatsapp.selfChat,
          dmPolicy: config.whatsapp.dmPolicy,
          allowedUsers: config.whatsapp.allowedUsers,
        }
      } : {}),
      ...(config.signal.enabled ? {
        signal: {
          enabled: true,
          phone: config.signal.phone,
          dmPolicy: config.signal.dmPolicy,
          allowedUsers: config.signal.allowedUsers,
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

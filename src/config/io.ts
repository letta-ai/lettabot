/**
 * LettaBot Configuration I/O
 * 
 * Config file location: ~/.lettabot/config.yaml (or ./lettabot.yaml in project)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import YAML from 'yaml';
import type { LettaBotConfig, ProviderConfig } from './types.js';
import { DEFAULT_CONFIG } from './types.js';

// Config file locations (checked in order)
const CONFIG_PATHS = [
  resolve(process.cwd(), 'lettabot.yaml'),           // Project-local
  resolve(process.cwd(), 'lettabot.yml'),            // Project-local alt
  join(homedir(), '.lettabot', 'config.yaml'),       // User global
  join(homedir(), '.lettabot', 'config.yml'),        // User global alt
];

const DEFAULT_CONFIG_PATH = join(homedir(), '.lettabot', 'config.yaml');

/**
 * Find the config file path (first existing, or default)
 */
export function resolveConfigPath(): string {
  for (const p of CONFIG_PATHS) {
    if (existsSync(p)) {
      return p;
    }
  }
  return DEFAULT_CONFIG_PATH;
}

/**
 * Load config from YAML file
 */
export function loadConfig(): LettaBotConfig {
  const configPath = resolveConfigPath();
  
  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }
  
  try {
    const content = readFileSync(configPath, 'utf-8');
    const parsed = YAML.parse(content) as Partial<LettaBotConfig>;
    
    // Merge with defaults
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      server: { ...DEFAULT_CONFIG.server, ...parsed.server },
      agent: { ...DEFAULT_CONFIG.agent, ...parsed.agent },
      channels: { ...DEFAULT_CONFIG.channels, ...parsed.channels },
    };
  } catch (err) {
    console.error(`[Config] Failed to load ${configPath}:`, err);
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Save config to YAML file
 */
export function saveConfig(config: LettaBotConfig, path?: string): void {
  const configPath = path || resolveConfigPath();
  
  // Ensure directory exists
  const dir = dirname(configPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  
  // Convert to YAML with comments
  const content = YAML.stringify(config, {
    indent: 2,
    lineWidth: 0, // Don't wrap lines
  });
  
  writeFileSync(configPath, content, 'utf-8');
  console.log(`[Config] Saved to ${configPath}`);
}

/**
 * Get environment variables from config (for backwards compatibility)
 */
export function configToEnv(config: LettaBotConfig): Record<string, string> {
  const env: Record<string, string> = {};
  
  // Server
  if (config.server.mode === 'selfhosted' && config.server.baseUrl) {
    env.LETTA_BASE_URL = config.server.baseUrl;
  }
  if (config.server.apiKey) {
    env.LETTA_API_KEY = config.server.apiKey;
  }
  
  // Agent
  if (config.agent.id) {
    env.LETTA_AGENT_ID = config.agent.id;
  }
  if (config.agent.name) {
    env.AGENT_NAME = config.agent.name;
  }
  if (config.agent.model) {
    env.MODEL = config.agent.model;
  }
  
  // Channels
  if (config.channels.telegram?.token) {
    env.TELEGRAM_BOT_TOKEN = config.channels.telegram.token;
    if (config.channels.telegram.dmPolicy) {
      env.TELEGRAM_DM_POLICY = config.channels.telegram.dmPolicy;
    }
  }
  if (config.channels.slack?.appToken) {
    env.SLACK_APP_TOKEN = config.channels.slack.appToken;
  }
  if (config.channels.slack?.botToken) {
    env.SLACK_BOT_TOKEN = config.channels.slack.botToken;
  }
  if (config.channels.whatsapp?.enabled) {
    env.WHATSAPP_ENABLED = 'true';
    if (config.channels.whatsapp.selfChat) {
      env.WHATSAPP_SELF_CHAT_MODE = 'true';
    }
  }
  if (config.channels.signal?.phone) {
    env.SIGNAL_PHONE_NUMBER = config.channels.signal.phone;
  }
  if (config.channels.discord?.token) {
    env.DISCORD_BOT_TOKEN = config.channels.discord.token;
    if (config.channels.discord.dmPolicy) {
      env.DISCORD_DM_POLICY = config.channels.discord.dmPolicy;
    }
    if (config.channels.discord.allowedUsers?.length) {
      env.DISCORD_ALLOWED_USERS = config.channels.discord.allowedUsers.join(',');
    }
  }
  
  // Features
  if (config.features?.cron) {
    env.CRON_ENABLED = 'true';
  }
  if (config.features?.heartbeat?.enabled) {
    env.HEARTBEAT_INTERVAL_MIN = String(config.features.heartbeat.intervalMin || 30);
  }
  
  return env;
}

/**
 * Apply config to process.env (YAML config takes priority over .env)
 */
export function applyConfigToEnv(config: LettaBotConfig): void {
  const env = configToEnv(config);
  for (const [key, value] of Object.entries(env)) {
    // YAML config always takes priority
    process.env[key] = value;
  }
}

/**
 * Create BYOK providers on Letta Cloud
 */
export async function syncProviders(config: LettaBotConfig): Promise<void> {
  if (config.server.mode !== 'cloud' || !config.server.apiKey) {
    return;
  }
  
  if (!config.providers || config.providers.length === 0) {
    return;
  }
  
  const apiKey = config.server.apiKey;
  const baseUrl = 'https://api.letta.com';
  
  // List existing providers
  const listResponse = await fetch(`${baseUrl}/v1/providers`, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
  });
  
  const existingProviders = listResponse.ok 
    ? await listResponse.json() as Array<{ id: string; name: string }>
    : [];
  
  // Create or update each provider
  for (const provider of config.providers) {
    const existing = existingProviders.find(p => p.name === provider.name);
    
    try {
      if (existing) {
        // Update existing
        await fetch(`${baseUrl}/v1/providers/${existing.id}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ api_key: provider.apiKey }),
        });
        console.log(`[Config] Updated provider: ${provider.name}`);
      } else {
        // Create new
        await fetch(`${baseUrl}/v1/providers`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            name: provider.name,
            provider_type: provider.type,
            api_key: provider.apiKey,
          }),
        });
        console.log(`[Config] Created provider: ${provider.name}`);
      }
    } catch (err) {
      console.error(`[Config] Failed to sync provider ${provider.name}:`, err);
    }
  }
}

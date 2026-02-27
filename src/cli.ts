#!/usr/bin/env node
/**
 * LettaBot CLI
 * 
 * Commands:
 *   lettabot onboard    - Onboarding workflow (setup integrations, install skills)
 *   lettabot server     - Run the bot server
 *   lettabot configure  - Configure settings
 */

// Config loaded from lettabot.yaml (lazily, so debug/help commands can run with broken config)
import type { LettaBotConfig } from './config/index.js';
import { loadAppConfigOrExit, applyConfigToEnv, serverModeLabel } from './config/index.js';
let cachedConfig: LettaBotConfig | null = null;

function getConfig(): LettaBotConfig {
  if (!cachedConfig) {
    cachedConfig = loadAppConfigOrExit();
    applyConfigToEnv(cachedConfig);
  }
  return cachedConfig;
}
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getCronStorePath, getDataDir, getLegacyCronStorePath, getWorkingDir } from './utils/paths.js';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import updateNotifier from 'update-notifier';
import { Store } from './core/store.js';

// Get the directory where this CLI file is located (works with npx, global install, etc.)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Check for updates (runs in background, shows notification if update available)
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8'));
updateNotifier({ pkg }).notify();

import * as readline from 'node:readline';

const args = process.argv.slice(2);
const command = args[0];
const subCommand = args[1];

// Check if value is a placeholder
const isPlaceholder = (val?: string) => !val || /^(your_|sk-\.\.\.|placeholder|example)/i.test(val);


// Import onboard from separate module
import { onboard } from './onboard.js';

async function configure() {
  const p = await import('@clack/prompts');
  const { resolveConfigPath } = await import('./config/index.js');
  const config = getConfig();
  
  p.intro('🤖 LettaBot Configuration');

  // Show current config from YAML
  const configRows = [
    ['Server Mode', serverModeLabel(config.server.mode)],
    ['API Key', config.server.apiKey ? '✓ Set' : '✗ Not set'],
    ['Agent Name', config.agent.name],
    ['Telegram', config.channels.telegram?.enabled ? '✓ Enabled' : '✗ Disabled'],
    ['Slack', config.channels.slack?.enabled ? '✓ Enabled' : '✗ Disabled'],
    ['Discord', config.channels.discord?.enabled ? '✓ Enabled' : '✗ Disabled'],
    ['Cron', config.features?.cron ? '✓ Enabled' : '✗ Disabled'],
    ['Heartbeat', config.features?.heartbeat?.enabled ? `✓ ${config.features.heartbeat.intervalMin}min` : '✗ Disabled'],
    ['BYOK Providers', config.providers?.length ? config.providers.map(p => p.name).join(', ') : 'None'],
  ];
  
  const maxKeyLength = Math.max(...configRows.map(([key]) => key.length));
  const summary = configRows
    .map(([key, value]) => `${(key + ':').padEnd(maxKeyLength + 1)} ${value}`)
    .join('\n');
  
  p.note(summary, `Current Configuration (${resolveConfigPath()})`);
  
  const choice = await p.select({
    message: 'What would you like to do?',
    options: [
      { value: 'onboard', label: 'Run setup wizard', hint: 'lettabot onboard' },
      { value: 'edit', label: 'Edit config file', hint: resolveConfigPath() },
      { value: 'exit', label: 'Exit', hint: '' },
    ],
  });
  
  if (p.isCancel(choice)) {
    p.cancel('Configuration cancelled');
    return;
  }
  
  switch (choice) {
    case 'onboard':
      await onboard();
      break;
    case 'edit': {
      const configPath = resolveConfigPath();
      const editor = process.env.EDITOR || 'nano';
      console.log(`Opening ${configPath} in ${editor}...`);
      spawnSync(editor, [configPath], { stdio: 'inherit' });
      break;
    }
    case 'exit':
      break;
  }
}

async function configEncode() {
  const { resolveConfigPath, encodeConfigForEnv } = await import('./config/index.js');
  const configPath = resolveConfigPath();

  if (!existsSync(configPath)) {
    console.error(`No config file found at ${configPath}`);
    process.exit(1);
  }

  const content = readFileSync(configPath, 'utf-8');
  const encoded = encodeConfigForEnv(content);
  console.log('Set this environment variable on your cloud platform:\n');
  console.log(`LETTABOT_CONFIG_YAML=${encoded}`);
  console.log(`\nSource: ${configPath} (${content.length} bytes -> ${encoded.length} chars base64)`);
}

async function configDecode() {
  if (!process.env.LETTABOT_CONFIG_YAML) {
    console.error('LETTABOT_CONFIG_YAML is not set');
    process.exit(1);
  }

  const { decodeYamlOrBase64 } = await import('./config/index.js');
  console.log(decodeYamlOrBase64(process.env.LETTABOT_CONFIG_YAML));
}

async function server() {
  const { resolveConfigPath, hasInlineConfig } = await import('./config/index.js');
  const configPath = resolveConfigPath();
  
  // Check if configured (inline config or file)
  if (!existsSync(configPath) && !hasInlineConfig()) {
    console.log(`
No config file found. Searched locations:
  1. LETTABOT_CONFIG_YAML env var (inline YAML or base64 - recommended for cloud)
  2. LETTABOT_CONFIG env var (file path)
  3. ./lettabot.yaml (project-local - recommended for local dev)
  4. ./lettabot.yml
  5. ~/.lettabot/config.yaml (user global)
  6. ~/.lettabot/config.yml

Run "lettabot onboard" to create a config, or set LETTABOT_CONFIG_YAML for cloud deploys.
Encode your config: base64 < lettabot.yaml | tr -d '\\n'
`);
    process.exit(1);
  }
  
  console.log('Starting LettaBot server...\n');
  
  // Start the bot using the compiled JS
  // Use __dirname to find main.js relative to this CLI file (works with npx, global install, etc.)
  const mainPath = resolve(__dirname, 'main.js');
  if (existsSync(mainPath)) {
    spawn('node', [mainPath], {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: { ...process.env },
    });
  } else {
    // Fallback to tsx for development - look for src/main.ts relative to package root
    const packageRoot = resolve(__dirname, '..');
    const mainTsPath = resolve(packageRoot, 'src/main.ts');
    if (existsSync(mainTsPath)) {
      spawn('npx', ['tsx', mainTsPath], {
        stdio: 'inherit',
        cwd: process.cwd(),
      });
    } else {
      console.error('Error: Could not find main.js or main.ts');
      console.error(`  Looked for: ${mainPath}`);
      console.error(`  Looked for: ${mainTsPath}`);
      process.exit(1);
    }
  }
}

// Pairing commands
async function pairingList(channel: string) {
  const { listPairingRequests } = await import('./pairing/store.js');
  const requests = await listPairingRequests(channel);
  
  if (requests.length === 0) {
    console.log(`No pending ${channel} pairing requests.`);
    return;
  }
  
  console.log(`\nPending ${channel} pairing requests (${requests.length}):\n`);
  console.log('  Code      | User ID           | Username          | Requested');
  console.log('  ----------|-------------------|-------------------|---------------------');
  
  for (const r of requests) {
    const username = r.meta?.username ? `@${r.meta.username}` : r.meta?.firstName || '-';
    const date = new Date(r.createdAt).toLocaleString();
    console.log(`  ${r.code.padEnd(10)}| ${r.id.padEnd(18)}| ${username.padEnd(18)}| ${date}`);
  }
  console.log('');
}

async function pairingApprove(channel: string, code: string) {
  const { approvePairingCode } = await import('./pairing/store.js');
  const result = await approvePairingCode(channel, code);
  
  if (!result) {
    console.log(`No pending pairing request found for code: ${code}`);
    process.exit(1);
  }
  
  const name = result.meta?.username ? `@${result.meta.username}` : result.meta?.firstName || result.userId;
  console.log(`✓ Approved ${channel} sender: ${name} (${result.userId})`);
}

function showHelp() {
  console.log(`
LettaBot - Multi-channel AI assistant with persistent memory

Usage: lettabot <command>

Commands:
  onboard              Setup wizard (integrations, skills, configuration)
  server               Start the bot server
  configure            View and edit configuration
  config encode        Encode config file as base64 for LETTABOT_CONFIG_YAML
  config decode        Decode and print LETTABOT_CONFIG_YAML env var
  model                Interactive model selector
  model show           Show current agent model
  model set <handle>   Set model by handle (e.g., anthropic/claude-sonnet-4-5-20250929)
  channels             Manage channels (interactive menu)
  channels list        Show channel status
  channels list-groups List group/channel IDs for Slack/Discord
  channels add <ch>    Add a channel (telegram, slack, discord, whatsapp, signal)
  channels remove <ch> Remove a channel
  logout               Logout from Letta Platform (revoke OAuth tokens)
  skills               Configure which skills are enabled
  skills status        Show skills status
  todo                 Manage per-agent to-dos
  todo list            List todos
  todo add <text>      Add a todo
  todo complete <id>   Mark a todo complete
  todo remove <id>     Remove a todo
  todo snooze <id>     Snooze a todo until a date
  reset-conversation   Clear conversation ID (fixes corrupted conversations)
  destroy              Delete all local data and start fresh
  pairing list <ch>    List pending pairing requests
  pairing approve <ch> <code>   Approve a pairing code
  help                 Show this help message

Examples:
  lettabot onboard                           # First-time setup
  lettabot server                            # Start the bot
  lettabot channels                          # Interactive channel management
  lettabot channels add discord              # Add Discord integration
  lettabot channels remove telegram          # Remove Telegram
  lettabot todo add "Deliver morning report" --recurring "daily 8am"
  lettabot todo list --actionable
  lettabot pairing list telegram             # Show pending Telegram pairings
  lettabot pairing approve telegram ABCD1234 # Approve a pairing code

Environment:
  LETTABOT_CONFIG_YAML    Inline YAML or base64-encoded config (for cloud deploys)
  LETTA_API_KEY           API key from app.letta.com
  TELEGRAM_BOT_TOKEN      Bot token from @BotFather
  TELEGRAM_DM_POLICY      DM access policy (pairing, allowlist, open)
  DISCORD_BOT_TOKEN       Discord bot token
  DISCORD_DM_POLICY       DM access policy (pairing, allowlist, open)
  SLACK_BOT_TOKEN         Slack bot token (xoxb-...)
  SLACK_APP_TOKEN         Slack app token (xapp-...)
  HEARTBEAT_INTERVAL_MIN  Heartbeat interval in minutes
  HEARTBEAT_SKIP_RECENT_USER_MIN  Skip auto-heartbeats after user messages (0 disables)
  CRON_ENABLED            Enable cron jobs (true/false)
`);
}

function getDefaultTodoAgentKey(): string {
  const config = getConfig();
  const configuredName =
    (config.agent?.name?.trim())
    || (config.agents?.length && config.agents[0].name?.trim())
    || 'LettaBot';

  try {
    const store = new Store('lettabot-agent.json', configuredName);
    if (store.agentId) return store.agentId;
  } catch {
    // Ignore; fall back to configured name
  }

  return configuredName;
}

async function main() {
  // Most commands expect config-derived env vars to be applied.
  // Skip bootstrap for help/no-command and config encode/decode so these still work
  // when the current config is broken.
  if (
    command &&
    command !== 'help' &&
    command !== '-h' &&
    command !== '--help' &&
    !(command === 'config' && (subCommand === 'encode' || subCommand === 'decode'))
  ) {
    getConfig();
  }

  switch (command) {
    case 'onboard':
    case 'setup':
    case 'init':
      const nonInteractive = args.includes('--non-interactive') || args.includes('-n');
      await onboard({ nonInteractive });
      break;
      
    case 'server':
    case 'start':
    case 'run':
      await server();
      break;
      
    case 'configure':
    case 'config':
      if (subCommand === 'encode') {
        await configEncode();
      } else if (subCommand === 'decode') {
        await configDecode();
      } else {
        await configure();
      }
      break;
      
    case 'skills': {
      const { showStatus, runSkillsSync } = await import('./skills/index.js');
      switch (subCommand) {
        case 'status':
          await showStatus();
          break;
        default:
          await runSkillsSync();
      }
      break;
    }

    case 'todo': {
      const { todoCommand } = await import('./cli/todo.js');
      await todoCommand(subCommand, args.slice(2), getDefaultTodoAgentKey());
      break;
    }
    
    case 'model': {
      const { modelCommand } = await import('./commands/model.js');
      await modelCommand(subCommand, args[2]);
      break;
    }
    
    case 'channels':
    case 'channel': {
      const { channelManagementCommand } = await import('./cli/channel-management.js');
      await channelManagementCommand(subCommand, args[2], args.slice(3));
      break;
    }
    
    case 'pairing': {
      const channel = subCommand;
      const action = args[2];
      
      if (!channel) {
        console.log('Usage: lettabot pairing <list|approve> <channel> [code]');
        console.log('Example: lettabot pairing list telegram');
        console.log('Example: lettabot pairing approve telegram ABCD1234');
        process.exit(1);
      }
      
      // Support both "pairing list telegram" and "pairing telegram list"
      if (channel === 'list' || channel === 'ls') {
        const ch = action || args[3];
        if (!ch) {
          console.log('Usage: lettabot pairing list <channel>');
          process.exit(1);
        }
        await pairingList(ch);
      } else if (channel === 'approve') {
        const ch = action;
        const code = args[3];
        if (!ch || !code) {
          console.log('Usage: lettabot pairing approve <channel> <code>');
          process.exit(1);
        }
        await pairingApprove(ch, code);
      } else if (action === 'list' || action === 'ls') {
        await pairingList(channel);
      } else if (action === 'approve') {
        const code = args[3];
        if (!code) {
          console.log('Usage: lettabot pairing approve <channel> <code>');
          process.exit(1);
        }
        await pairingApprove(channel, code);
      } else if (action) {
        // Assume "lettabot pairing telegram ABCD1234" means approve
        await pairingApprove(channel, action);
      } else {
        await pairingList(channel);
      }
      break;
    }
      
    case 'destroy': {
      const { rmSync, existsSync } = await import('node:fs');
      const { join } = await import('node:path');
      const p = await import('@clack/prompts');
      
      const dataDir = getDataDir();
      const workingDir = getWorkingDir();
      const agentJsonPath = join(dataDir, 'lettabot-agent.json');
      const skillsDir = join(workingDir, '.skills');
      const cronJobsPath = getCronStorePath();
      const legacyCronJobsPath = getLegacyCronStorePath();
      
      p.intro('🗑️  Destroy LettaBot Data');
      
      p.log.warn('This will delete:');
      p.log.message(`  • Agent store: ${agentJsonPath}`);
      p.log.message(`  • Skills: ${skillsDir}`);
      p.log.message(`  • Cron jobs: ${cronJobsPath}`);
      if (legacyCronJobsPath !== cronJobsPath) {
        p.log.message(`  • Legacy cron jobs: ${legacyCronJobsPath}`);
      }
      p.log.message('');
      p.log.message('Note: The agent on Letta servers will NOT be deleted.');
      
      const confirmed = await p.confirm({
        message: 'Are you sure you want to destroy all local data?',
        initialValue: false,
      });
      
      if (!confirmed || p.isCancel(confirmed)) {
        p.cancel('Cancelled');
        break;
      }
      
      // Delete files
      let deleted = 0;
      
      if (existsSync(agentJsonPath)) {
        rmSync(agentJsonPath);
        p.log.success('Deleted lettabot-agent.json');
        deleted++;
      }
      
      if (existsSync(skillsDir)) {
        rmSync(skillsDir, { recursive: true });
        p.log.success('Deleted .skills/');
        deleted++;
      }
      
      if (existsSync(cronJobsPath)) {
        rmSync(cronJobsPath);
        p.log.success('Deleted cron-jobs.json');
        deleted++;
      }

      if (legacyCronJobsPath !== cronJobsPath && existsSync(legacyCronJobsPath)) {
        rmSync(legacyCronJobsPath);
        p.log.success('Deleted legacy cron-jobs.json');
        deleted++;
      }
      
      if (deleted === 0) {
        p.log.info('Nothing to delete');
      }
      
      p.outro('✨ Done! Run `npx lettabot server` to create a fresh agent.');
      break;
    }
    
    case 'reset-conversation': {
      const p = await import('@clack/prompts');
      const config = getConfig();
      
      p.intro('Reset Conversation');

      const configuredName =
        (config.agent?.name?.trim())
        || (config.agents?.length && config.agents[0].name?.trim())
        || 'LettaBot';

      const configuredAgents = (config.agents?.length ? config.agents : [{ name: configuredName }])
        .map(agent => agent.name?.trim())
        .filter((name): name is string => !!name);

      const uniqueAgents = Array.from(new Set(configuredAgents));

      let targetAgents = uniqueAgents;
      if (uniqueAgents.length > 1) {
        const choice = await p.select({
          message: 'Which agent should be reset?',
          options: [
            { value: '__all__', label: 'All configured agents' },
            ...uniqueAgents.map(name => ({ value: name, label: name })),
          ],
        });
        if (p.isCancel(choice)) {
          p.cancel('Cancelled');
          break;
        }
        targetAgents = choice === '__all__' ? uniqueAgents : [choice as string];
      }

      const entries = targetAgents.map((name) => {
        const store = new Store('lettabot-agent.json', name);
        const info = store.getInfo();
        const perChannelKeys = info.conversations ? Object.keys(info.conversations) : [];
        return {
          name,
          store,
          hasLegacy: !!info.conversationId,
          perChannelKeys,
        };
      });

      const hasAny = entries.some(entry => entry.hasLegacy || entry.perChannelKeys.length > 0);
      if (!hasAny) {
        p.log.info('No conversation IDs stored. Nothing to reset.');
        break;
      }

      for (const entry of entries) {
        if (entry.hasLegacy) {
          p.log.warn(`Current conversation (${entry.name}): ${entry.store.conversationId}`);
        } else if (entry.perChannelKeys.length > 0) {
          p.log.warn(`Current per-channel conversations (${entry.name}): ${entry.perChannelKeys.length}`);
        }
      }
      p.log.message('');
      p.log.message('This will clear the conversation ID(s), causing the bot to create');
      p.log.message('a new conversation on the next message. Use this if you see:');
      p.log.message('  • "stop_reason: error" with empty responses');
      p.log.message('  • Messages not reaching the agent');
      p.log.message('  • Agent returning empty results');
      p.log.message('');
      p.log.message('The agent and its memory will be preserved.');

      const confirmed = await p.confirm({
        message: `Reset conversation${entries.length > 1 ? 's' : ''}?`,
        initialValue: true,
      });

      if (!confirmed || p.isCancel(confirmed)) {
        p.cancel('Cancelled');
        break;
      }

      for (const entry of entries) {
        entry.store.clearConversation();
      }

      p.log.success(`Conversation ID${entries.length > 1 ? 's' : ''} cleared`);
      p.outro('Restart the server - a new conversation will be created on the next message.');
      break;
    }
      
    case 'logout': {
      const { revokeToken } = await import('./auth/oauth.js');
      const { loadTokens, deleteTokens } = await import('./auth/tokens.js');
      const p = await import('@clack/prompts');
      
      p.intro('Logout from Letta Platform');
      
      const tokens = loadTokens();
      if (!tokens) {
        p.log.info('No stored credentials found.');
        break;
      }
      
      const spinner = p.spinner();
      spinner.start('Revoking token...');
      
      // Revoke the refresh token on the server
      if (tokens.refreshToken) {
        await revokeToken(tokens.refreshToken);
      }
      
      // Delete local tokens
      deleteTokens();
      
      spinner.stop('Logged out successfully');
      p.log.info('Note: LETTA_API_KEY in .env was not modified. Remove it manually if needed.');
      p.outro('Goodbye!');
      break;
    }
      
    case 'help':
    case '-h':
    case '--help':
      showHelp();
      break;
      
    case undefined:
      console.log('Usage: lettabot <command>\n');
      console.log('Commands: onboard, server, configure, model, channels, skills, reset-conversation, destroy, help\n');
      console.log('Run "lettabot help" for more information.');
      break;
      
    default:
      console.log(`Unknown command: ${command}`);
      console.log('Run "lettabot help" for usage.');
      process.exit(1);
  }
}

main().catch(console.error);

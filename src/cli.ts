#!/usr/bin/env node
/**
 * LettaBot CLI
 * 
 * Commands:
 *   lettabot onboard    - Onboarding workflow (setup integrations, install skills)
 *   lettabot server     - Run the bot server
 *   lettabot configure  - Configure settings
 */

// Config loaded from lettabot.yaml
import { loadConfig, applyConfigToEnv } from './config/index.js';
const config = loadConfig();
applyConfigToEnv(config);
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import updateNotifier from 'update-notifier';

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
  
  p.intro('🤖 LettaBot Configuration');

  // Show current config from YAML
  const configRows = [
    ['Server Mode', config.server.mode],
    ['API Key', config.server.apiKey ? '✓ Set' : '✗ Not set'],
    ['Agent Name', config.agent.name],
    ['Model', config.agent.model],
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

async function server() {
  const { resolveConfigPath } = await import('./config/index.js');
  const configPath = resolveConfigPath();
  
  // Check if configured
  if (!existsSync(configPath)) {
    console.log(`No config found at ${configPath}. Run "lettabot onboard" first.\n`);
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
  logout               Logout from Letta Platform (revoke OAuth tokens)
  skills               Configure which skills are enabled
  skills status        Show skills status
  destroy              Delete all local data and start fresh
  pairing list <ch>    List pending pairing requests
  pairing approve <ch> <code>   Approve a pairing code
  help                 Show this help message

Examples:
  lettabot onboard                           # First-time setup
  lettabot server                            # Start the bot
  lettabot pairing list telegram             # Show pending Telegram pairings
  lettabot pairing approve telegram ABCD1234 # Approve a pairing code

Environment:
  LETTA_API_KEY           API key from app.letta.com
  TELEGRAM_BOT_TOKEN      Bot token from @BotFather
  TELEGRAM_DM_POLICY      DM access policy (pairing, allowlist, open)
  DISCORD_BOT_TOKEN       Discord bot token
  DISCORD_DM_POLICY       DM access policy (pairing, allowlist, open)
  SLACK_BOT_TOKEN         Slack bot token (xoxb-...)
  SLACK_APP_TOKEN         Slack app token (xapp-...)
  HEARTBEAT_INTERVAL_MIN  Heartbeat interval in minutes
  CRON_ENABLED            Enable cron jobs (true/false)
`);
}

async function main() {
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
      await configure();
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
      
      const workingDir = process.env.WORKING_DIR || '/tmp/lettabot';
      // Agent store is in cwd, not working dir
      const agentJsonPath = join(process.cwd(), 'lettabot-agent.json');
      const skillsDir = join(workingDir, '.skills');
      const cronJobsPath = join(workingDir, 'cron-jobs.json');
      
      p.intro('🗑️  Destroy LettaBot Data');
      
      p.log.warn('This will delete:');
      p.log.message(`  • Agent store: ${agentJsonPath}`);
      p.log.message(`  • Skills: ${skillsDir}`);
      p.log.message(`  • Cron jobs: ${cronJobsPath}`);
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
      
      if (deleted === 0) {
        p.log.info('Nothing to delete');
      }
      
      p.outro('✨ Done! Run `npx lettabot server` to create a fresh agent.');
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
      console.log('Commands: onboard, server, configure, skills, destroy, help\n');
      console.log('Run "lettabot help" for more information.');
      break;
      
    default:
      console.log(`Unknown command: ${command}`);
      console.log('Run "lettabot help" for usage.');
      process.exit(1);
  }
}

main().catch(console.error);

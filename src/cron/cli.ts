#!/usr/bin/env node
/**
 * Cron CLI - Manage scheduled tasks
 * 
 * Usage:
 *   lettabot-schedule list
 *   lettabot-schedule create --name "..." --schedule "..." --message "..."
 *   lettabot-schedule delete <id>
 *   lettabot-schedule enable <id>
 *   lettabot-schedule disable <id>
 *   lettabot-schedule show <id>
 *   lettabot-schedule run <id>

 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getCronLogPath, getCronStorePath, getLegacyCronStorePath } from '../utils/paths.js';
import { loadLastTarget } from '../cli/shared.js';

const VALID_CHANNELS = ['telegram', 'telegram-mtproto', 'slack', 'discord', 'whatsapp', 'signal'];

// Parse ISO datetime string
function parseISODateTime(input: string): Date {
  const date = new Date(input);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid datetime: ${input}. Use ISO format like "2026-01-28T20:15:00Z"`);
  }
  if (date.getTime() <= Date.now()) {
    console.warn(`Warning: "${input}" is in the past`);
  }
  return date;
}

// Types
interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: { kind: 'cron'; expr: string } | { kind: 'at'; date: Date };
  message: string;
  deliver?: {
    channel: string;
    chatId: string;
  };
  silent?: boolean;
  deleteAfterRun?: boolean;
  state: {
    lastRunAt?: string;
    nextRunAt?: string;
    lastStatus?: 'ok' | 'error';
    lastError?: string;
    lastResponse?: string;
  };
}

interface CronStore {
  version: 1;
  jobs: CronJob[];
}

// Store path (CRON_STORE_PATH env var set by bot.ts for per-agent scoping in multi-agent mode)
const STORE_PATH = process.env.CRON_STORE_PATH || getCronStorePath();
const LOG_PATH = getCronLogPath();

function migrateLegacyStoreIfNeeded(): void {
  if (existsSync(STORE_PATH)) return;

  const legacyPath = getLegacyCronStorePath();
  if (legacyPath === STORE_PATH || !existsSync(legacyPath)) return;

  try {
    mkdirSync(dirname(STORE_PATH), { recursive: true });
    copyFileSync(legacyPath, STORE_PATH);
    console.error(`[Cron] store_migrated: ${JSON.stringify({ from: legacyPath, to: STORE_PATH })}`);
  } catch (e) {
    console.error('[Cron] Failed to migrate legacy cron store:', e);
  }
}

function log(event: string, data: Record<string, unknown>): void {
  const entry = {
    timestamp: new Date().toISOString(),
    event,
    ...data,
  };
  
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');
  } catch {
    // Ignore log errors
  }
  
  // Also print to stderr for visibility
  console.error(`[Cron] ${event}: ${JSON.stringify(data)}`);
}

function loadStore(): CronStore {
  migrateLegacyStoreIfNeeded();
  try {
    if (existsSync(STORE_PATH)) {
      return JSON.parse(readFileSync(STORE_PATH, 'utf-8'));
    }
  } catch (e) {
    console.error('Failed to load cron store:', e);
  }
  return { version: 1, jobs: [] };
}

function saveStore(store: CronStore): void {
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

function generateId(): string {
  return `cron-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatDate(dateStr?: string): string {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  return d.toLocaleString();
}

// Commands

function listJobs(): void {
  const store = loadStore();
  
  if (store.jobs.length === 0) {
    console.log('\nNo scheduled tasks.\n');
    console.log('Create one with:');
    console.log('  lettabot-schedule create --name "My Task" --schedule "0 9 * * *" --message "Hello!"');
    return;
  }
  
  const enabled = store.jobs.filter(j => j.enabled).length;
  const disabled = store.jobs.length - enabled;
  
  console.log(`\n📅 Scheduled Tasks: ${enabled} active, ${disabled} disabled\n`);
  
  for (const job of store.jobs) {
    const status = job.enabled ? '✓' : '○';
    const schedule = job.schedule.kind === 'cron' 
      ? job.schedule.expr 
      : job.schedule.kind === 'at' 
        ? `at ${new Date(job.schedule.date).toLocaleString()}`
        : '?';
    const nextRun = job.state.nextRunAt ? formatDate(job.state.nextRunAt) : (job.enabled ? 'pending...' : 'disabled');
    
    console.log(`${status} ${job.name} [${schedule}]`);
    console.log(`    ID: ${job.id}`);
    console.log(`    Next: ${nextRun}`);
    if (job.state.lastRunAt) {
      console.log(`    Last: ${formatDate(job.state.lastRunAt)} (${job.state.lastStatus})`);
    }
    if (job.state.lastStatus === 'error' && job.state.lastError) {
      console.log(`    ⚠ Error: ${job.state.lastError}`);
    }
    if (job.deliver) {
      console.log(`    Deliver: ${job.deliver.channel}:${job.deliver.chatId}`);
    } else if (job.silent) {
      console.log(`    Deliver: silent (no delivery)`);
    } else {
      console.log(`    Deliver: (none -- will use last message target at runtime)`);
    }
  }
  console.log('');
}

function createJob(args: string[]): void {
  let name = '';
  let schedule = '';
  let at = '';  // One-off timer: ISO datetime or relative (e.g., "5m", "1h")
  let message = '';
  let enabled = true;
  let silent = false;
  let deliverChannel = '';
  let deliverChatId = '';
  
  // Parse args
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    
    if ((arg === '--name' || arg === '-n') && next) {
      name = next;
      i++;
    } else if ((arg === '--schedule' || arg === '-s') && next) {
      schedule = next;
      i++;
    } else if ((arg === '--at' || arg === '-a') && next) {
      at = next;
      i++;
    } else if ((arg === '--message' || arg === '-m') && next) {
      message = next;
      i++;
    } else if (arg === '--disabled') {
      enabled = false;
    } else if (arg === '--silent') {
      silent = true;
    } else if ((arg === '--deliver' || arg === '-d') && next) {
      // Format: channel:chatId (e.g., telegram:123456789 or discord:123456789012345678)
      const [ch, ...rest] = next.split(':');
      const id = rest.join(':'); // Rejoin in case chatId contains colons
      if (!VALID_CHANNELS.includes(ch)) {
        console.error(`Error: invalid channel "${ch}". Must be one of: ${VALID_CHANNELS.join(', ')}`);
        process.exit(1);
      }
      if (!id) {
        console.error('Error: --deliver requires format channel:chatId (e.g., telegram:123456789)');
        process.exit(1);
      }
      deliverChannel = ch;
      deliverChatId = id;
      i++;
    }
  }
  
  // Auto-fill deliver from last message target when not explicitly set
  if (!silent && !deliverChannel) {
    const lastTarget = loadLastTarget();
    if (lastTarget) {
      deliverChannel = lastTarget.channel;
      deliverChatId = lastTarget.chatId;
      console.log(`  Delivering to ${deliverChannel}:${deliverChatId} (from last message target)`);
      console.log(`  Use --silent for no delivery, or --deliver channel:chatId to override.`);
    } else {
      console.warn('Warning: No --deliver target and no previous messages found.');
      console.warn('Responses will not be delivered until a user messages the bot.');
      console.warn('Use --deliver channel:chatId to set a target, or --silent for intentional silent mode.');
    }
  }
  
  if (!name || (!schedule && !at) || !message) {
    console.error('Error: --name, (--schedule or --at), and --message are required');
    console.error('');
    console.error('Usage:');
    console.error('  # Recurring schedule (cron expression)');
    console.error('  lettabot-schedule create --name "Daily" --schedule "0 9 * * *" --message "Hello!"');
    console.error('');
    console.error('  # One-off reminder (ISO datetime)');
    console.error('  lettabot-schedule create --name "Reminder" --at "2026-01-28T20:15:00Z" --message "Stand up!"');
    console.error('');
    console.error('To calculate ISO datetime for "X minutes from now":');
    console.error('  new Date(Date.now() + X*60*1000).toISOString()');
    process.exit(1);
  }
  
  const store = loadStore();
  
  // Parse schedule type
  let cronSchedule: CronJob['schedule'];
  let deleteAfterRun = false;
  
  if (at) {
    // One-off reminder at specific datetime
    const date = parseISODateTime(at);
    cronSchedule = { kind: 'at', date };
    deleteAfterRun = true;
    console.log(`⏰ One-off reminder set for: ${date.toISOString()} (${date.toLocaleString()})`);
  } else {
    // Recurring cron
    cronSchedule = { kind: 'cron', expr: schedule };
  }
  
  const job: CronJob = {
    id: generateId(),
    name,
    enabled,
    schedule: cronSchedule,
    message,
    deliver: !silent && deliverChannel && deliverChatId ? { channel: deliverChannel, chatId: deliverChatId } : undefined,
    silent: silent || undefined,
    deleteAfterRun,
    state: {},
  };
  
  store.jobs.push(job);
  saveStore(store);
  
  log('job_created', { id: job.id, name, schedule, enabled });
  
  console.log(`\n✓ Created "${name}"`);
  console.log(`  ID: ${job.id}`);
  console.log(`  Schedule: ${schedule}`);
  if (enabled) {
    console.log(`  Status: Scheduling now...`);
  } else {
    console.log(`  Status: Disabled (use 'lettabot-schedule enable ${job.id}' to activate)`);
  }
}

function deleteJob(id: string): void {
  const store = loadStore();
  const index = store.jobs.findIndex(j => j.id === id);
  
  if (index === -1) {
    console.error(`Error: Job not found: ${id}`);
    process.exit(1);
  }
  
  const job = store.jobs[index];
  store.jobs.splice(index, 1);
  saveStore(store);
  
  log('job_deleted', { id, name: job.name });
  
  console.log(`✓ Deleted "${job.name}"`);
}

function enableJob(id: string): void {
  const store = loadStore();
  const job = store.jobs.find(j => j.id === id);
  
  if (!job) {
    console.error(`Error: Job not found: ${id}`);
    process.exit(1);
  }
  
  job.enabled = true;
  saveStore(store);
  
  log('job_enabled', { id, name: job.name });
  
  console.log(`✓ Enabled "${job.name}" - scheduling now...`);
}

function disableJob(id: string): void {
  const store = loadStore();
  const job = store.jobs.find(j => j.id === id);
  
  if (!job) {
    console.error(`Error: Job not found: ${id}`);
    process.exit(1);
  }
  
  job.enabled = false;
  saveStore(store);
  
  log('job_disabled', { id, name: job.name });
  
  console.log(`✓ Disabled "${job.name}"`);
}

function showJob(id: string): void {
  const store = loadStore();
  const job = store.jobs.find(j => j.id === id);
  
  if (!job) {
    console.error(`Error: Job not found: ${id}`);
    process.exit(1);
  }
  
  console.log(`\n📅 ${job.name}\n`);
  console.log(`ID: ${job.id}`);
  console.log(`Enabled: ${job.enabled}`);
  console.log(`Schedule: ${job.schedule.kind === 'cron' ? job.schedule.expr : JSON.stringify(job.schedule)}`);
  console.log(`Message:\n  ${job.message}`);
  if (job.deliver) {
    console.log(`Deliver: ${job.deliver.channel}:${job.deliver.chatId}`);
  } else if (job.silent) {
    console.log(`Deliver: silent (no delivery)`);
  } else {
    console.log(`Deliver: (none -- will use last message target at runtime)`);
  }
  console.log(`\nState:`);
  console.log(`  Last run: ${formatDate(job.state.lastRunAt)}`);
  console.log(`  Next run: ${formatDate(job.state.nextRunAt)}`);
  console.log(`  Last status: ${job.state.lastStatus || '-'}`);
  if (job.state.lastError) {
    console.log(`  Last error: ${job.state.lastError}`);
  }
}



function updateJob(args: string[]): void {
  const id = args[0];
  if (!id) {
    console.error('Error: Job ID required');
    console.error('Usage: lettabot-schedule update <id> [--name ...] [--message ...] [--schedule ...] [--at ...] [--deliver channel:chatId] [--silent]');
    process.exit(1);
  }
  
  const store = loadStore();
  const job = store.jobs.find(j => j.id === id);
  
  if (!job) {
    console.error(`Error: Job not found: ${id}`);
    process.exit(1);
  }
  
  const updates: string[] = [];
  
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    
    if ((arg === '--name' || arg === '-n') && next) {
      job.name = next;
      updates.push(`name="${next}"`);
      i++;
    } else if ((arg === '--message' || arg === '-m') && next) {
      job.message = next;
      updates.push(`message updated`);
      i++;
    } else if ((arg === '--schedule' || arg === '-s') && next) {
      job.schedule = { kind: 'cron', expr: next };
      job.deleteAfterRun = false;
      updates.push(`schedule="${next}"`);
      i++;
    } else if ((arg === '--at' || arg === '-a') && next) {
      const date = parseISODateTime(next);
      job.schedule = { kind: 'at', date };
      job.deleteAfterRun = true;
      updates.push(`at=${date.toISOString()}`);
      i++;
    } else if ((arg === '--deliver' || arg === '-d') && next) {
      const [ch, ...rest] = next.split(':');
      const chatId = rest.join(':');
      if (!VALID_CHANNELS.includes(ch)) {
        console.error(`Error: invalid channel "${ch}". Must be one of: ${VALID_CHANNELS.join(', ')}`);
        process.exit(1);
      }
      if (!chatId) {
        console.error('Error: --deliver requires format channel:chatId (e.g., telegram:123456789)');
        process.exit(1);
      }
      job.deliver = { channel: ch, chatId };
      job.silent = undefined;
      updates.push(`deliver=${ch}:${chatId}`);
      i++;
    } else if (arg === '--silent') {
      job.deliver = undefined;
      job.silent = true;
      updates.push('silent mode (no delivery)');
    }
  }
  
  if (updates.length === 0) {
    console.error('Error: No updates specified');
    console.error('Usage: lettabot-schedule update <id> [--name ...] [--message ...] [--schedule ...] [--at ...] [--deliver channel:chatId] [--silent]');
    process.exit(1);
  }
  
  saveStore(store);
  
  log('job_updated', { id, name: job.name, updates });
  
  console.log(`✓ Updated "${job.name}": ${updates.join(', ')}`);
}

function showHelp(): void {
  console.log(`
lettabot-schedule - Manage scheduled tasks and reminders

Commands:
  list                    List all scheduled tasks
  create [options]        Create a new task
  update <id> [options]   Update an existing task
  delete <id>             Delete a task
  enable <id>             Enable a task
  disable <id>            Disable a task
  show <id>               Show task details

Create/update options:
  --name, -n <name>       Task name (required for create)
  --schedule, -s <cron>   Cron expression for recurring tasks
  --at, -a <datetime>     ISO datetime for one-off reminder (auto-deletes after)
  --message, -m <msg>     Prompt sent to agent when job fires (required for create)
  --deliver, -d <target>  Deliver response to channel:chatId (defaults to last messaged chat)
  --silent                Do not deliver response (agent must use lettabot-message CLI)
  --disabled              Create in disabled state

  Note: Use 'enable <id>' / 'disable <id>' to toggle job state.

Examples:
  # One-off reminder (calculate ISO: new Date(Date.now() + 5*60*1000).toISOString())
  lettabot-schedule create -n "Standup" --at "2026-01-28T20:15:00Z" -m "Time to stand!"

  # Recurring daily at 8am (delivers to last messaged chat)
  lettabot-schedule create -n "Morning" -s "0 8 * * *" -m "Good morning!"

  # Deliver to specific channel
  lettabot-schedule create -n "Morning" -s "0 8 * * *" -m "Good morning!" -d telegram:123456789

  # Update delivery target on existing job
  lettabot-schedule update <id> --deliver telegram:123456789

  # List and delete
  lettabot-schedule list
  lettabot-schedule delete job-1234567890-abc123
`);
}

// Main
const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'list':
  case 'ls':
    listJobs();
    break;
    
  case 'create':
  case 'add':
    createJob(args.slice(1));
    break;
    
  case 'update':
  case 'edit':
    updateJob(args.slice(1));
    break;
    
  case 'delete':
  case 'rm':
  case 'remove':
    if (!args[1]) {
      console.error('Error: Job ID required');
      process.exit(1);
    }
    deleteJob(args[1]);
    break;
    
  case 'enable':
    if (!args[1]) {
      console.error('Error: Job ID required');
      process.exit(1);
    }
    enableJob(args[1]);
    break;
    
  case 'disable':
    if (!args[1]) {
      console.error('Error: Job ID required');
      process.exit(1);
    }
    disableJob(args[1]);
    break;
    
  case 'show':
  case 'get':
    if (!args[1]) {
      console.error('Error: Job ID required');
      process.exit(1);
    }
    showJob(args[1]);
    break;
    
  case 'help':
  case '--help':
  case '-h':
    showHelp();
    break;
    
  default:
    if (command) {
      console.error(`Unknown command: ${command}`);
    }
    showHelp();
    break;
}

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

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { getDataDir } from '../utils/paths.js';

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

// Store path
const STORE_PATH = resolve(getDataDir(), 'cron-jobs.json');
const LOG_PATH = resolve(getDataDir(), 'cron-log.jsonl');

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
    } else if ((arg === '--deliver' || arg === '-d') && next) {
      // Format: channel:chatId (e.g., telegram:123456789 or discord:123456789012345678)
      const [ch, id] = next.split(':');
      deliverChannel = ch;
      deliverChatId = id;
      i++;
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
    deliver: deliverChannel && deliverChatId ? { channel: deliverChannel, chatId: deliverChatId } : undefined,
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
  console.log(`\nState:`);
  console.log(`  Last run: ${formatDate(job.state.lastRunAt)}`);
  console.log(`  Next run: ${formatDate(job.state.nextRunAt)}`);
  console.log(`  Last status: ${job.state.lastStatus || '-'}`);
  if (job.state.lastError) {
    console.log(`  Last error: ${job.state.lastError}`);
  }
}



function showHelp(): void {
  console.log(`
lettabot-schedule - Manage scheduled tasks and reminders

Commands:
  list                    List all scheduled tasks
  create [options]        Create a new task
  delete <id>             Delete a task
  enable <id>             Enable a task
  disable <id>            Disable a task
  show <id>               Show task details

Create options:
  --name, -n <name>       Task name (required)
  --schedule, -s <cron>   Cron expression for recurring tasks
  --at, -a <datetime>     ISO datetime for one-off reminder (auto-deletes after)
  --message, -m <msg>     Message to send (required)
  --deliver, -d <target>  Delivery target (channel:chatId)
  --disabled              Create in disabled state

Examples:
  # One-off reminder (calculate ISO: new Date(Date.now() + 5*60*1000).toISOString())
  lettabot-schedule create -n "Standup" --at "2026-01-28T20:15:00Z" -m "Time to stand!"

  # Recurring daily at 8am
  lettabot-schedule create -n "Morning" -s "0 8 * * *" -m "Good morning!"

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

#!/usr/bin/env node
/**
 * lettabot-resume - Set or check resume context for post-restart task continuation
 *
 * Usage:
 *   lettabot-resume set --task "Implementing security fixes" [--reason "Self-upgrade"]
 *   lettabot-resume check
 *   lettabot-resume clear
 */

import { setResumeContext, consumeResumeContext, hasResumeContext } from '../core/resume-context.js';

const args = process.argv.slice(2);
const command = args[0];

function getFlag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

switch (command) {
  case 'set': {
    const task = getFlag('task');
    if (!task) {
      console.error('Error: --task is required');
      console.error('Usage: lettabot-resume set --task "What you were doing" [--reason "Why restarting"]');
      process.exit(1);
    }
    setResumeContext({
      task,
      setAt: new Date().toISOString(),
      reason: getFlag('reason'),
    });
    console.log('✓ Resume context set. On next startup, the agent will be prompted to continue this task.');
    break;
  }

  case 'check': {
    if (hasResumeContext()) {
      console.log('Resume context is SET. It will be injected into the next heartbeat.');
    } else {
      console.log('No resume context set.');
    }
    break;
  }

  case 'clear': {
    const ctx = consumeResumeContext();
    if (ctx) {
      console.log(`✓ Resume context cleared (was: ${ctx.task})`);
    } else {
      console.log('No resume context to clear.');
    }
    break;
  }

  default:
    console.log(`lettabot-resume - Set resume context for post-restart task continuation

Commands:
  set [options]    Set resume context before restarting
  check            Check if resume context is set
  clear            Clear resume context without consuming

Set options:
  --task <text>    What you were doing (required)
  --reason <text>  Why the restart is happening (optional)

Examples:
  lettabot-resume set --task "Implementing security fixes for dashboard API" --reason "Self-upgrade PR merge"
  lettabot-resume check
  lettabot-resume clear`);
    if (command) {
      console.error(`\nUnknown command: ${command}`);
      process.exit(1);
    }
}

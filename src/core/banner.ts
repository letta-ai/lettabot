/**
 * Startup banner with LETTABOT block text and community loom ASCII art.
 *
 * Looms are loaded from src/looms/*.txt at startup. One is picked
 * randomly each boot. See src/looms/README.md for contribution guide.
 */

import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { loadRandomLoom } from '../looms/loom-loader.js';

const require = createRequire(import.meta.url);

/** Read version from package.json and git commit hash. */
function getVersionString(): string {
  let version = 'unknown';
  try {
    const pkg = require('../../package.json');
    version = pkg.version || version;
  } catch {}

  let commit = '';
  try {
    commit = execSync('git rev-parse --short HEAD', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {}

  return commit ? `v${version} (${commit})` : `v${version}`;
}

interface BannerAgent {
  name: string;
  agentId?: string | null;
  conversationId?: string | null;
  channels: string[];
  features?: {
    cron?: boolean;
    heartbeatIntervalMin?: number;
  };
}

const BLOCK_TEXT = `
░██         ░██████████ ░██████████ ░██████████   ░███    ░████████     ░██████   ░██████████
░██         ░██             ░██        ░██      ░██░██   ░██    ░██   ░██   ░██      ░██
░██         ░██             ░██        ░██     ░██  ░██  ░██    ░██  ░██     ░██     ░██
░██         ░█████████      ░██        ░██    ░█████████ ░████████   ░██     ░██     ░██
░██         ░██             ░██        ░██    ░██    ░██ ░██     ░██ ░██     ░██     ░██
░██         ░██             ░██        ░██    ░██    ░██ ░██     ░██  ░██   ░██      ░██
░██████████ ░██████████     ░██        ░██    ░██    ░██ ░█████████    ░██████       ░██
`.trim();

const P = '            '; // 12-space prefix for centering the box

export function printStartupBanner(agents: BannerAgent[]): void {
  // Block text
  console.log('');
  console.log(BLOCK_TEXT);
  console.log('');

  // Community loom — randomly selected from src/looms/*.txt
  const loom = loadRandomLoom();
  if (loom) {
    for (const line of loom.lines) {
      console.log(P + line);
    }
    console.log(`${P}  loom: ${loom.metadata.name} by ${loom.metadata.author}`);
  }

  // Status lines
  const versionStr = getVersionString();
  console.log('');
  console.log(`  Version:  ${versionStr}`);
  for (const agent of agents) {
    const ch = agent.channels.length > 0 ? agent.channels.join(', ') : 'none';
    if (agent.agentId) {
      const qs = agent.conversationId ? `?conversation=${agent.conversationId}` : '';
      const url = `https://app.letta.com/agents/${agent.agentId}${qs}`;
      console.log(`  Agent:    ${agent.name} [${ch}]`);
      console.log(`  URL:      ${url}`);
    } else {
      console.log(`  Agent:    ${agent.name} (pending) [${ch}]`);
    }
  }

  const features: string[] = [];
  for (const agent of agents) {
    if (agent.features?.cron) features.push('cron');
    if (agent.features?.heartbeatIntervalMin) {
      features.push(`heartbeat (${agent.features.heartbeatIntervalMin}m)`);
    }
  }
  if (features.length > 0) {
    console.log(`  Features: ${features.join(', ')}`);
  }
  console.log('');
}

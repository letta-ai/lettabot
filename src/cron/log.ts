/**
 * Shared logging utility for cron services
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { getDataDir } from '../utils/paths.js';

/**
 * Log event to file and console
 *
 * @param agentName - Agent name for scoped log file (undefined = global)
 * @param event - Event name
 * @param data - Event data
 * @param prefix - Log prefix (default: 'Cron')
 */
export function logEvent(
  agentName: string | undefined,
  event: string,
  data: Record<string, unknown>,
  prefix = 'Cron'
): void {
  const logFileName = agentName ? `${agentName}-cron-log.jsonl` : 'cron-log.jsonl';
  const logPath = resolve(getDataDir(), logFileName);

  const entry = {
    timestamp: new Date().toISOString(),
    event,
    ...data,
  };

  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, JSON.stringify(entry) + '\n');
  } catch {
    // Ignore log errors
  }

  console.log(`[${prefix}] ${event}:`, JSON.stringify(data));
}

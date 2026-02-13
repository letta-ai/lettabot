import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { traceable } from 'langsmith/traceable';
import { getDataDir } from '../utils/paths.js';

const SWARM_LOG_PATH = resolve(getDataDir(), 'swarm-events.jsonl');

function isLangSmithTracingEnabled(): boolean {
  const raw = process.env.LANGSMITH_TRACING;
  return raw === 'true' || raw === '1';
}

const traceSwarmEvent = traceable(
  async (event: string, data: Record<string, unknown>) => ({ event, ...data }),
  { name: 'lettabot.swarm.event' },
);

/**
 * Logs a structured swarm event locally and emits a LangSmith trace when enabled.
 * This function is intentionally fire-and-forget for tracing so it cannot block
 * message processing or evolution scheduling.
 */
export function logSwarmEvent(event: string, data: Record<string, unknown>): void {
  const entry = {
    timestamp: new Date().toISOString(),
    event,
    ...data,
  };

  try {
    mkdirSync(dirname(SWARM_LOG_PATH), { recursive: true });
    appendFileSync(SWARM_LOG_PATH, JSON.stringify(entry) + '\n');
  } catch {
    // Ignore file logging failures
  }

  console.log(`[Swarm] ${event}:`, JSON.stringify(data));

  if (isLangSmithTracingEnabled()) {
    traceSwarmEvent(event, data).catch((err) => {
      console.warn('[Swarm] LangSmith trace failed:', err instanceof Error ? err.message : err);
    });
  }
}

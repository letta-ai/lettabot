/**
 * Resume Context — allows the agent to set a flag before restarting
 * so that on next startup, it receives a system message to continue
 * its interrupted task(s).
 *
 * The flag is stored as a JSON file in the data directory.
 * It is consumed (deleted) after being injected into the first heartbeat.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDataDir } from '../utils/paths.js';

const RESUME_FILENAME = 'resume-context.json';

export interface ResumeContext {
  /** What the agent was doing before the restart */
  task: string;
  /** When the flag was set (ISO string) */
  setAt: string;
  /** Optional: why the restart happened */
  reason?: string;
}

function getResumePath(): string {
  return resolve(getDataDir(), RESUME_FILENAME);
}

/**
 * Set a resume context flag. The agent calls this before triggering a restart.
 */
export function setResumeContext(context: ResumeContext): void {
  const path = getResumePath();
  writeFileSync(path, JSON.stringify(context, null, 2), 'utf-8');
  console.log(`[Resume] Context saved: ${context.task}`);
}

/**
 * Read and consume the resume context. Returns null if no flag is set.
 * The file is deleted after reading (one-shot).
 */
export function consumeResumeContext(): ResumeContext | null {
  const path = getResumePath();
  if (!existsSync(path)) return null;

  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as ResumeContext;
    unlinkSync(path);
    console.log(`[Resume] Context consumed: ${raw.task}`);
    return raw;
  } catch (err) {
    console.warn('[Resume] Failed to read resume context:', err);
    try { unlinkSync(path); } catch { /* ignore */ }
    return null;
  }
}

/**
 * Check if a resume context exists without consuming it.
 */
export function hasResumeContext(): boolean {
  return existsSync(getResumePath());
}

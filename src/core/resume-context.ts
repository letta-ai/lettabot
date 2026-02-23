/**
 * Resume Context — allows the agent to set a flag before restarting
 * so that on next startup, it receives a system message to continue
 * its interrupted task(s).
 *
 * The flag is stored as a JSON file in the data directory.
 * It is consumed (deleted) after being injected into the first post-restart
 * message (responsive mode, not heartbeat).
 *
 * Also handles message queue persistence: pending user messages are saved
 * before shutdown and replayed on startup so the conversation continues
 * seamlessly.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDataDir } from '../utils/paths.js';

const RESUME_FILENAME = 'resume-context.json';
const MESSAGE_QUEUE_FILENAME = 'pending-messages.json';

export interface ResumeContext {
  /** What the agent was doing before the restart */
  task: string;
  /** When the flag was set (ISO string) */
  setAt: string;
  /** Optional: why the restart happened */
  reason?: string;
}

/**
 * Serializable form of a queued message (InboundMessage with Date as string).
 */
export interface SerializedMessage {
  channel: string;
  chatId: string;
  userId: string;
  userName?: string;
  userHandle?: string;
  messageId?: string;
  text: string;
  timestamp: string; // ISO string
  threadId?: string;
  isGroup?: boolean;
  groupName?: string;
  serverId?: string;
  wasMentioned?: boolean;
}

function getResumePath(): string {
  return resolve(getDataDir(), RESUME_FILENAME);
}

function getMessageQueuePath(): string {
  return resolve(getDataDir(), MESSAGE_QUEUE_FILENAME);
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

// =========================================================================
// Message Queue Persistence
// =========================================================================

/**
 * Save pending messages to disk. Called during graceful shutdown.
 */
export function saveMessageQueue(messages: SerializedMessage[]): void {
  if (messages.length === 0) return;
  const path = getMessageQueuePath();
  writeFileSync(path, JSON.stringify(messages, null, 2), 'utf-8');
  console.log(`[Resume] Saved ${messages.length} pending message(s) to disk`);
}

/**
 * Load and consume saved messages. Returns empty array if none.
 * The file is deleted after reading (one-shot).
 */
export function consumeMessageQueue(): SerializedMessage[] {
  const path = getMessageQueuePath();
  if (!existsSync(path)) return [];

  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as SerializedMessage[];
    unlinkSync(path);
    console.log(`[Resume] Loaded ${raw.length} pending message(s) from disk`);
    return raw;
  } catch (err) {
    console.warn('[Resume] Failed to read message queue:', err);
    try { unlinkSync(path); } catch { /* ignore */ }
    return [];
  }
}

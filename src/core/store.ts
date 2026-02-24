/**
 * Agent Store - Persists agent state with multi-agent support
 *
 * V2 format: { version: 2, agents: { [name]: AgentStore } }
 * V1 format (legacy): { agentId: ..., ... } - auto-migrated to V2
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import type { AgentStore, LastMessageTarget } from './types.js';
import { getDataDir } from '../utils/paths.js';
import { createLogger } from '../logger.js';

const log = createLogger('Store');

const DEFAULT_STORE_PATH = 'lettabot-agent.json';
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

interface StoreV2 {
  version: 2;
  agents: Record<string, AgentStore>;
}

interface ParsedStore {
  data: StoreV2;
  wasV1: boolean;
}

let warnedAboutBusyWait = false;

function sleepSync(ms: number): void {
  if (typeof Atomics.wait === 'function') {
    Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
    return;
  }
  if (!warnedAboutBusyWait) {
    log.warn('Atomics.wait unavailable, falling back to busy-wait for lock retries');
    warnedAboutBusyWait = true;
  }
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Busy-wait fallback -- should not be reached in standard Node.js (v8+)
  }
}

export class Store {
  private readonly storePath: string;
  private readonly lockPath: string;
  private readonly backupPath: string;
  private data: StoreV2;
  private readonly agentName: string;

  constructor(storePath?: string, agentName?: string) {
    this.storePath = resolve(getDataDir(), storePath || DEFAULT_STORE_PATH);
    this.lockPath = `${this.storePath}.lock`;
    this.backupPath = `${this.storePath}.bak`;
    this.agentName = agentName || 'LettaBot';
    this.data = this.load();
  }

  /**
   * Reload store state from disk.
   * Useful before critical operations in long-running multi-instance deployments.
   */
  refresh(): void {
    // Capture file existence before attempting reads so we can distinguish
    // "files don't exist" (safe to reset to empty) from "files exist but are
    // unreadable" (keep current in-memory state as best available data).
    const hasPrimary = existsSync(this.storePath);
    const hasBackup = existsSync(this.backupPath);

    const primary = this.tryReadStore(this.storePath, 'primary');
    if (primary) {
      this.data = primary.data;
      return;
    }

    const backup = this.tryReadStore(this.backupPath, 'backup');
    if (backup) {
      this.data = backup.data;
      // Repair the corrupted/missing primary from backup so the next read
      // doesn't have to fall through again.
      this.persistStore(backup.data);
      log.error(`Recovered in-memory state for ${this.agentName} from backup store.`);
      return;
    }

    if (!hasPrimary && !hasBackup) {
      this.data = { version: 2, agents: {} };
      return;
    }

    // Keep current in-memory state if disk files exist but are unreadable.
    log.error(`Keeping in-memory state for ${this.agentName}; on-disk store could not be read.`);
  }

  private normalizeStore(rawData: any): ParsedStore {
    // V1 -> V2 in-memory migration
    if (!rawData?.version && rawData?.agentId !== undefined) {
      return {
        wasV1: true,
        data: {
          version: 2,
          agents: { [this.agentName]: rawData as AgentStore },
        },
      };
    }

    // V2
    if (rawData?.version === 2 && rawData.agents && typeof rawData.agents === 'object') {
      return { wasV1: false, data: rawData as StoreV2 };
    }

    // Unknown/empty format -> safe empty V2
    return { wasV1: false, data: { version: 2, agents: {} } };
  }

  private readStoreFromPath(filePath: string): ParsedStore | null {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8');
    const rawData = JSON.parse(raw);
    return this.normalizeStore(rawData);
  }

  private tryReadStore(filePath: string, label: string): ParsedStore | null {
    try {
      return this.readStoreFromPath(filePath);
    } catch (error) {
      log.error(`Failed to read ${label} store at ${filePath}:`, error);
      return null;
    }
  }

  private load(): StoreV2 {
    const primary = this.tryReadStore(this.storePath, 'primary');
    if (primary) {
      if (primary.wasV1) {
        this.persistStore(primary.data);
      }
      return primary.data;
    }

    const backup = this.tryReadStore(this.backupPath, 'backup');
    if (backup) {
      log.error(`Recovered agent store from backup: ${this.backupPath}`);
      this.persistStore(backup.data);
      return backup.data;
    }

    // Return empty V2 structure
    return { version: 2, agents: {} };
  }

  private acquireLock(): number {
    const start = Date.now();

    while (true) {
      try {
        const fd = openSync(this.lockPath, 'wx');
        try {
          writeFileSync(fd, `${process.pid}\n`, { encoding: 'utf-8' });
        } catch (error) {
          try {
            closeSync(fd);
          } catch {
            // Best-effort close.
          }
          try {
            unlinkSync(this.lockPath);
          } catch {
            // Best-effort lock cleanup.
          }
          throw error;
        }
        return fd;
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== 'EEXIST') {
          throw error;
        }

        this.maybeClearStaleLock();
        if (Date.now() - start >= LOCK_TIMEOUT_MS) {
          throw new Error(`Timed out waiting for store lock: ${this.lockPath}`);
        }
        sleepSync(LOCK_RETRY_MS);
      }
    }
  }

  private maybeClearStaleLock(): void {
    try {
      const stats = statSync(this.lockPath);
      if (Date.now() - stats.mtimeMs > LOCK_STALE_MS) {
        unlinkSync(this.lockPath);
      }
    } catch {
      // Best-effort stale lock cleanup.
    }
  }

  private releaseLock(fd: number): void {
    try {
      closeSync(fd);
    } catch {
      // Best-effort close.
    }

    try {
      unlinkSync(this.lockPath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        log.error(`Failed to release lock ${this.lockPath}:`, error);
      }
    }
  }

  private withLock<T>(fn: () => T): T {
    const fd = this.acquireLock();
    try {
      return fn();
    } finally {
      this.releaseLock(fd);
    }
  }

  private writeRaw(filePath: string, data: StoreV2): void {
    const tmpPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf-8' });
      renameSync(tmpPath, filePath);
    } catch (error) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // Best-effort cleanup.
      }
      throw error;
    }
  }

  private writeStoreFiles(data: StoreV2): void {
    this.writeRaw(this.storePath, data);
    this.writeRaw(this.backupPath, data);
  }

  private readLatestForSave(): StoreV2 {
    const primary = this.tryReadStore(this.storePath, 'primary');
    if (primary) return primary.data;

    const backup = this.tryReadStore(this.backupPath, 'backup');
    if (backup) {
      log.error(`Using backup store for merge due to unreadable primary store.`);
      return backup.data;
    }

    return { version: 2, agents: {} };
  }

  private persistStore(data: StoreV2): void {
    try {
      this.withLock(() => this.writeStoreFiles(data));
    } catch (error) {
      log.error('Failed to persist agent store:', error);
    }
  }

  private save(): void {
    try {
      this.withLock(() => {
        const current = this.readLatestForSave();
        current.agents[this.agentName] = { ...this.agentData() };
        this.writeStoreFiles(current);
        this.data = current;
      });
    } catch (error) {
      log.error('Failed to save agent store:', error);
    }
  }

  /**
   * Get agent-specific data (creates entry if doesn't exist)
   */
  private agentData(): AgentStore {
    if (!this.data.agents[this.agentName]) {
      this.data.agents[this.agentName] = { agentId: null };
    }
    return this.data.agents[this.agentName];
  }

  get agentId(): string | null {
    // Keep legacy env var override only for default single-agent key.
    // In multi-agent mode, a global LETTA_AGENT_ID would leak across agents.
    if (this.agentName === 'LettaBot') {
      return this.agentData().agentId || process.env.LETTA_AGENT_ID || null;
    }
    return this.agentData().agentId || null;
  }

  set agentId(id: string | null) {
    const agent = this.agentData();
    agent.agentId = id;
    agent.lastUsedAt = new Date().toISOString();
    if (id && !agent.createdAt) {
      agent.createdAt = new Date().toISOString();
    }
    this.save();
  }

  get conversationId(): string | null {
    return this.agentData().conversationId || null;
  }

  set conversationId(id: string | null) {
    this.agentData().conversationId = id;
    this.save();
  }

  // Per-key conversation management (for per-channel mode)

  /**
   * Get conversation ID for a specific key (channel name, "heartbeat", etc.).
   * Falls back to the legacy single conversationId when key is undefined.
   */
  getConversationId(key?: string): string | null {
    if (!key) return this.conversationId;
    return this.agentData().conversations?.[key] || null;
  }

  /**
   * Set conversation ID for a specific key.
   */
  setConversationId(key: string, id: string): void {
    const agent = this.agentData();
    if (!agent.conversations) {
      agent.conversations = {};
    }
    agent.conversations[key] = id;
    this.save();
  }

  /**
   * Clear conversation(s). If key is provided, clears only that key.
   * If key is undefined, clears the legacy conversationId AND all per-key conversations.
   */
  clearConversation(key?: string): void {
    const agent = this.agentData();
    if (key) {
      if (agent.conversations) {
        delete agent.conversations[key];
      }
    } else {
      agent.conversationId = null;
      agent.conversations = undefined;
    }
    this.save();
  }

  get baseUrl(): string | undefined {
    return this.agentData().baseUrl;
  }

  set baseUrl(url: string | undefined) {
    this.agentData().baseUrl = url;
    this.save();
  }

  /**
   * Set agent ID and associated server URL together
   */
  setAgent(id: string | null, baseUrl?: string, conversationId?: string): void {
    const agent = this.agentData();
    agent.agentId = id;
    agent.baseUrl = baseUrl;
    agent.conversationId = conversationId || agent.conversationId;
    agent.lastUsedAt = new Date().toISOString();
    if (id && !agent.createdAt) {
      agent.createdAt = new Date().toISOString();
    }
    this.save();
  }

  /**
   * Check if stored agent matches current server
   */
  isServerMismatch(currentBaseUrl?: string): boolean {
    const agent = this.agentData();
    if (!agent.agentId || !agent.baseUrl) return false;

    // Normalize URLs for comparison
    const stored = agent.baseUrl.replace(/\/$/, '');
    const current = (currentBaseUrl || 'https://api.letta.com').replace(/\/$/, '');

    return stored !== current;
  }

  reset(): void {
    this.data.agents[this.agentName] = { agentId: null };
    this.save();
  }

  getInfo(): AgentStore {
    return { ...this.agentData() };
  }

  get lastMessageTarget(): LastMessageTarget | null {
    return this.agentData().lastMessageTarget || null;
  }

  set lastMessageTarget(target: LastMessageTarget | null) {
    this.agentData().lastMessageTarget = target || undefined;
    this.save();
  }

  // Recovery tracking

  get recoveryAttempts(): number {
    return this.agentData().recoveryAttempts || 0;
  }

  incrementRecoveryAttempts(): number {
    const agent = this.agentData();
    agent.recoveryAttempts = (agent.recoveryAttempts || 0) + 1;
    agent.lastRecoveryAt = new Date().toISOString();
    this.save();
    return agent.recoveryAttempts;
  }

  resetRecoveryAttempts(): void {
    this.agentData().recoveryAttempts = 0;
    this.save();
  }
}

/**
 * Agent Store - Persists agent state
 *
 * Two formats:
 * - v1 (legacy): Single agent in lettabot-agent.json
 * - v2 (multi-agent): Multiple agents in lettabot-agents.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { AgentStore, AgentState, MultiAgentStoreData, LastMessageTarget } from './types.js';
import { getDataDir } from '../utils/paths.js';

const DEFAULT_STORE_PATH = 'lettabot-agent.json';
const MULTI_AGENT_STORE_PATH = 'lettabot-agents.json';

export class Store {
  private storePath: string;
  private data: AgentStore;
  
  constructor(storePath?: string) {
    this.storePath = resolve(getDataDir(), storePath || DEFAULT_STORE_PATH);
    this.data = this.load();
  }
  
  private load(): AgentStore {
    try {
      if (existsSync(this.storePath)) {
        const raw = readFileSync(this.storePath, 'utf-8');
        return JSON.parse(raw) as AgentStore;
      }
    } catch (e) {
      console.error('Failed to load agent store:', e);
    }
    return { agentId: null };
  }
  
  private save(): void {
    try {
      // Ensure directory exists (important for Railway volumes)
      mkdirSync(dirname(this.storePath), { recursive: true });
      writeFileSync(this.storePath, JSON.stringify(this.data, null, 2));
    } catch (e) {
      console.error('Failed to save agent store:', e);
    }
  }
  
  get agentId(): string | null {
    // Allow env var override (useful for local server testing with specific agent)
    return this.data.agentId || process.env.LETTA_AGENT_ID || null;
  }
  
  set agentId(id: string | null) {
    this.data.agentId = id;
    this.data.lastUsedAt = new Date().toISOString();
    if (id && !this.data.createdAt) {
      this.data.createdAt = new Date().toISOString();
    }
    this.save();
  }
  
  get conversationId(): string | null {
    return this.data.conversationId || null;
  }
  
  set conversationId(id: string | null) {
    this.data.conversationId = id;
    this.save();
  }
  
  get baseUrl(): string | undefined {
    return this.data.baseUrl;
  }
  
  set baseUrl(url: string | undefined) {
    this.data.baseUrl = url;
    this.save();
  }
  
  /**
   * Set agent ID and associated server URL together
   */
  setAgent(id: string | null, baseUrl?: string, conversationId?: string): void {
    this.data.agentId = id;
    this.data.baseUrl = baseUrl;
    this.data.conversationId = conversationId || this.data.conversationId;
    this.data.lastUsedAt = new Date().toISOString();
    if (id && !this.data.createdAt) {
      this.data.createdAt = new Date().toISOString();
    }
    this.save();
  }
  
  /**
   * Check if stored agent matches current server
   */
  isServerMismatch(currentBaseUrl?: string): boolean {
    if (!this.data.agentId || !this.data.baseUrl) return false;
    
    // Normalize URLs for comparison
    const stored = this.data.baseUrl.replace(/\/$/, '');
    const current = (currentBaseUrl || 'https://api.letta.com').replace(/\/$/, '');
    
    return stored !== current;
  }
  
  reset(): void {
    this.data = { agentId: null };
    this.save();
  }
  
  getInfo(): AgentStore {
    return { ...this.data };
  }
  
  get lastMessageTarget(): LastMessageTarget | null {
    return this.data.lastMessageTarget || null;
  }

  set lastMessageTarget(target: LastMessageTarget | null) {
    this.data.lastMessageTarget = target || undefined;
    this.save();
  }

  /**
   * Get agent ID or throw if none exists.
   * For CLI commands that require an existing agent.
   */
  static getAgentIdOrThrow(): string {
    const storePath = resolve(getDataDir(), DEFAULT_STORE_PATH);
    if (!existsSync(storePath)) {
      throw new Error('No agent found. Run `lettabot onboard` or `lettabot server` first to create an agent.');
    }
    const data = JSON.parse(readFileSync(storePath, 'utf-8'));
    if (!data.agentId) {
      throw new Error('No agent found. Run `lettabot onboard` or `lettabot server` first to create an agent.');
    }
    return data.agentId;
  }
}

// =============================================================================
// Multi-Agent Store (v2)
// =============================================================================

/**
 * Multi-agent store - supports multiple agents with per-agent state
 */
export class MultiAgentStore {
  private storePath: string;
  private data: MultiAgentStoreData;

  constructor() {
    this.storePath = resolve(getDataDir(), MULTI_AGENT_STORE_PATH);
    this.data = this.load();
  }

  /**
   * Load store, migrating from v1 if necessary
   */
  private load(): MultiAgentStoreData {
    // Try to load existing v2 store
    if (existsSync(this.storePath)) {
      try {
        const raw = readFileSync(this.storePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed.version === 2) {
          return parsed as MultiAgentStoreData;
        }
      } catch (e) {
        console.error('[MultiAgentStore] Failed to load store:', e);
      }
    }

    // Check for v1 store to migrate
    const v1Path = resolve(getDataDir(), DEFAULT_STORE_PATH);
    if (existsSync(v1Path)) {
      try {
        const v1Data = JSON.parse(readFileSync(v1Path, 'utf-8')) as AgentStore;
        if (v1Data.agentId) {
          console.log('[MultiAgentStore] Migrating from v1 store...');

          // Backup v1 store
          const backupPath = resolve(getDataDir(), 'lettabot-agent.v1.backup.json');
          if (!existsSync(backupPath)) {
            copyFileSync(v1Path, backupPath);
            console.log(`[MultiAgentStore] Backed up v1 store to ${backupPath}`);
          }

          // Migrate to v2 with 'default' agent
          const migrated: MultiAgentStoreData = {
            version: 2,
            agents: {
              default: {
                agentId: v1Data.agentId,
                conversationId: v1Data.conversationId || undefined,
                baseUrl: v1Data.baseUrl,
                createdAt: v1Data.createdAt,
                lastUsedAt: v1Data.lastUsedAt,
                lastMessageTarget: v1Data.lastMessageTarget,
              },
            },
          };

          // Save migrated store
          this.saveData(migrated);
          console.log('[MultiAgentStore] Migration complete');
          return migrated;
        }
      } catch (e) {
        console.error('[MultiAgentStore] Failed to migrate v1 store:', e);
      }
    }

    // Return empty v2 store
    return { version: 2, agents: {} };
  }

  private saveData(data: MultiAgentStoreData): void {
    try {
      mkdirSync(dirname(this.storePath), { recursive: true });
      writeFileSync(this.storePath, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error('[MultiAgentStore] Failed to save:', e);
    }
  }

  private save(): void {
    this.saveData(this.data);
  }

  /**
   * Get state for a specific agent
   */
  getAgent(name: string): AgentState | null {
    return this.data.agents[name] || null;
  }

  /**
   * Get agent ID for a specific agent
   */
  getAgentId(name: string): string | null {
    return this.data.agents[name]?.agentId || null;
  }

  /**
   * Set state for a specific agent
   */
  setAgent(name: string, state: Partial<AgentState>): void {
    const existing = this.data.agents[name] || { agentId: null };
    this.data.agents[name] = {
      ...existing,
      ...state,
      lastUsedAt: new Date().toISOString(),
    };
    if (state.agentId && !existing.createdAt) {
      this.data.agents[name].createdAt = new Date().toISOString();
    }
    this.save();
  }

  /**
   * Set agent ID for a specific agent
   */
  setAgentId(name: string, agentId: string, baseUrl?: string): void {
    this.setAgent(name, { agentId, baseUrl });
  }

  /**
   * Check if an agent exists in the store
   */
  hasAgent(name: string): boolean {
    return !!this.data.agents[name]?.agentId;
  }

  /**
   * Get all agent names
   */
  getAgentNames(): string[] {
    return Object.keys(this.data.agents);
  }

  /**
   * Reset a specific agent
   */
  resetAgent(name: string): void {
    delete this.data.agents[name];
    this.save();
  }

  /**
   * Reset all agents
   */
  resetAll(): void {
    this.data = { version: 2, agents: {} };
    this.save();
  }

  /**
   * Get raw data (for debugging)
   */
  getData(): MultiAgentStoreData {
    return { ...this.data };
  }

  /**
   * Get last message target for an agent
   */
  getLastMessageTarget(name: string): LastMessageTarget | null {
    return this.data.agents[name]?.lastMessageTarget || null;
  }

  /**
   * Set last message target for an agent
   */
  setLastMessageTarget(name: string, target: LastMessageTarget | null): void {
    if (!this.data.agents[name]) {
      this.data.agents[name] = { agentId: null };
    }
    this.data.agents[name].lastMessageTarget = target || undefined;
    this.save();
  }
}

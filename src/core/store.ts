/**
 * Agent Store - Persists agent state with multi-agent support
 * 
 * V2 format: { version: 2, agents: { [name]: AgentStore } }
 * V1 format (legacy): { agentId: ..., ... } - auto-migrated to V2
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { AgentStore, LastMessageTarget } from './types.js';
import { getDataDir } from '../utils/paths.js';

const DEFAULT_STORE_PATH = 'lettabot-agent.json';

interface StoreV2 {
  version: 2;
  agents: Record<string, AgentStore>;
}

export class Store {
  private storePath: string;
  private data: StoreV2;
  private agentName: string;
  
  constructor(storePath?: string, agentName?: string) {
    this.storePath = resolve(getDataDir(), storePath || DEFAULT_STORE_PATH);
    this.agentName = agentName || 'LettaBot';
    this.data = this.load();
  }
  
  private load(): StoreV2 {
    try {
      if (existsSync(this.storePath)) {
        const raw = readFileSync(this.storePath, 'utf-8');
        const rawData = JSON.parse(raw) as any;
        
        // V1 -> V2 auto-migration
        if (!rawData.version && rawData.agentId !== undefined) {
          const migrated: StoreV2 = {
            version: 2,
            agents: { [this.agentName]: rawData }
          };
          // Write back migrated data
          this.writeRaw(migrated);
          return migrated;
        }
        
        // Already V2
        if (rawData.version === 2) {
          return rawData as StoreV2;
        }
      }
    } catch (e) {
      console.error('Failed to load agent store:', e);
    }
    
    // Return empty V2 structure
    return { version: 2, agents: {} };
  }
  
  private writeRaw(data: StoreV2): void {
    try {
      // Ensure directory exists (important for Railway volumes)
      mkdirSync(dirname(this.storePath), { recursive: true });
      writeFileSync(this.storePath, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error('Failed to save agent store:', e);
    }
  }
  
  private save(): void {
    // Reload file to get latest data from other Store instances
    const current = existsSync(this.storePath) 
      ? (() => {
          try {
            const raw = readFileSync(this.storePath, 'utf-8');
            const data = JSON.parse(raw);
            return data.version === 2 ? data : { version: 2, agents: {} };
          } catch {
            return { version: 2, agents: {} };
          }
        })()
      : { version: 2, agents: {} };
    
    // Merge our agent's data
    current.agents[this.agentName] = this.data.agents[this.agentName];
    
    // Write merged data
    this.writeRaw(current);
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

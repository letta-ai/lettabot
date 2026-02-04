/**
 * Agent Store - Persists the single agent ID
 * 
 * Since we use dmScope: "main", there's only ONE agent shared across all channels.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { AgentStore, LastMessageTarget } from './types.js';
import { getDataDir } from '../utils/paths.js';

const DEFAULT_STORE_PATH = 'lettabot-agent.json';

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
}

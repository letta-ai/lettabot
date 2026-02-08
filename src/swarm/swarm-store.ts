/**
 * SwarmStore — Multi-Agent Registry
 *
 * Extends the Store pattern (JSON persistence) to support N agents with
 * backward compatibility. mode: 'single' behaves identically to the original Store.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type {
  SwarmRegistry,
  SwarmAgentEntry,
  TeamBlueprint,
  NicheDescriptor,
  SwarmMode,
} from './types.js';

const REGISTRY_FILE = 'swarm-registry.json';
const LEGACY_FILE = 'lettabot-agent.json';

function defaultRegistry(): SwarmRegistry {
  return {
    mode: 'single',
    agents: [],
    blueprints: [],
    generation: 0,
    agentId: null,
    conversationId: null,
  };
}

export class SwarmStore {
  private registryPath: string;
  private data: SwarmRegistry;

  constructor(dataDir: string) {
    this.registryPath = resolve(dataDir, REGISTRY_FILE);
    this.data = this.load(dataDir);
  }

  private load(dataDir: string): SwarmRegistry {
    // Try loading existing registry
    try {
      if (existsSync(this.registryPath)) {
        const raw = readFileSync(this.registryPath, 'utf-8');
        return JSON.parse(raw) as SwarmRegistry;
      }
    } catch (e) {
      console.error('Failed to load swarm registry:', e);
    }

    // Try auto-migrating from legacy lettabot-agent.json
    const legacyPath = resolve(dataDir, LEGACY_FILE);
    try {
      if (existsSync(legacyPath)) {
        const raw = readFileSync(legacyPath, 'utf-8');
        const legacy = JSON.parse(raw);
        const registry = defaultRegistry();
        registry.agentId = legacy.agentId || null;
        registry.conversationId = legacy.conversationId || null;
        registry.baseUrl = legacy.baseUrl;
        registry.createdAt = legacy.createdAt;
        registry.lastUsedAt = legacy.lastUsedAt;
        this.registryPath = resolve(dataDir, REGISTRY_FILE);
        return registry;
      }
    } catch (e) {
      console.error('Failed to migrate legacy store:', e);
    }

    return defaultRegistry();
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.registryPath), { recursive: true });
      writeFileSync(this.registryPath, JSON.stringify(this.data, null, 2));
    } catch (e) {
      console.error('Failed to save swarm registry:', e);
    }
  }

  // ─── Mode ────────────────────────────────────────────────────────────────────

  get mode(): SwarmMode {
    return this.data.mode;
  }

  set mode(m: SwarmMode) {
    this.data.mode = m;
    this.save();
  }

  // ─── Single-mode backward compat (mirrors Store) ────────────────────────────

  get agentId(): string | null {
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

  // ─── Multi-agent registry ───────────────────────────────────────────────────

  get agents(): SwarmAgentEntry[] {
    return this.data.agents;
  }

  get blueprints(): TeamBlueprint[] {
    return this.data.blueprints;
  }

  get generation(): number {
    return this.data.generation;
  }

  set generation(g: number) {
    this.data.generation = g;
    this.save();
  }

  addAgent(entry: SwarmAgentEntry): void {
    this.data.agents.push(entry);
    this.save();
  }

  removeAgent(agentId: string): void {
    this.data.agents = this.data.agents.filter(a => a.agentId !== agentId);
    this.save();
  }

  getAgentForNiche(niche: NicheDescriptor): SwarmAgentEntry | null {
    const match = this.data.agents.find(a => a.nicheKey === niche.key);
    return match || null;
  }

  // ─── Blueprint / Elite management ──────────────────────────────────────────

  setBlueprint(bp: TeamBlueprint): void {
    // Replace existing blueprint for same niche, or add new
    const idx = this.data.blueprints.findIndex(b => b.niche.key === bp.niche.key);
    if (idx >= 0) {
      this.data.blueprints[idx] = bp;
    } else {
      this.data.blueprints.push(bp);
    }
    this.save();
  }

  getElite(niche: NicheDescriptor): TeamBlueprint | null {
    return this.data.blueprints.find(b => b.niche.key === niche.key) || null;
  }

  // ─── Hub identity persistence ──────────────────────────────────────────────

  get hubAgentId(): string | undefined {
    return this.data.hubAgentId;
  }

  set hubAgentId(id: string | undefined) {
    this.data.hubAgentId = id;
    this.save();
  }

  get hubWorkspaceId(): string | undefined {
    return this.data.hubWorkspaceId;
  }

  set hubWorkspaceId(id: string | undefined) {
    this.data.hubWorkspaceId = id;
    this.save();
  }
}

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
    schemaVersion: 1,
    mode: 'single',
    archiveReady: false,
    routeSuccessCount: 0,
    routeFallbackCount: 0,
    routeSuccessByNiche: {},
    routeFallbackByNiche: {},
    unservedNicheCounts: {},
    lastUnservedAt: {},
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
        return this.normalizeRegistry(JSON.parse(raw) as Partial<SwarmRegistry>);
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

  private normalizeRegistry(raw: Partial<SwarmRegistry>): SwarmRegistry {
    const defaults = defaultRegistry();
    return {
      ...defaults,
      ...raw,
      schemaVersion: raw.schemaVersion ?? defaults.schemaVersion,
      archiveReady: raw.archiveReady ?? defaults.archiveReady,
      routeSuccessCount: raw.routeSuccessCount ?? defaults.routeSuccessCount,
      routeFallbackCount: raw.routeFallbackCount ?? defaults.routeFallbackCount,
      routeSuccessByNiche: raw.routeSuccessByNiche ?? defaults.routeSuccessByNiche,
      routeFallbackByNiche: raw.routeFallbackByNiche ?? defaults.routeFallbackByNiche,
      unservedNicheCounts: raw.unservedNicheCounts ?? defaults.unservedNicheCounts,
      lastUnservedAt: raw.lastUnservedAt ?? defaults.lastUnservedAt,
      agents: raw.agents ?? defaults.agents,
      blueprints: raw.blueprints ?? defaults.blueprints,
      generation: raw.generation ?? defaults.generation,
      mode: raw.mode ?? defaults.mode,
      agentId: raw.agentId ?? defaults.agentId,
      conversationId: raw.conversationId ?? defaults.conversationId,
    };
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

  get schemaVersion(): number {
    return this.data.schemaVersion;
  }

  get archiveReady(): boolean {
    return !!this.data.archiveReady;
  }

  set archiveReady(ready: boolean) {
    this.data.archiveReady = ready;
    this.save();
  }

  incrementUnservedNiche(nicheKey: string): number {
    if (!this.data.unservedNicheCounts) {
      this.data.unservedNicheCounts = {};
    }
    if (!this.data.lastUnservedAt) {
      this.data.lastUnservedAt = {};
    }
    const next = (this.data.unservedNicheCounts[nicheKey] || 0) + 1;
    this.data.unservedNicheCounts[nicheKey] = next;
    this.data.lastUnservedAt[nicheKey] = new Date().toISOString();
    this.save();
    return next;
  }

  getUnservedNicheCount(nicheKey: string): number {
    return this.data.unservedNicheCounts?.[nicheKey] || 0;
  }

  getUnservedNicheCounts(): Record<string, number> {
    return { ...(this.data.unservedNicheCounts || {}) };
  }

  incrementRouteSuccess(nicheKey: string): number {
    this.data.routeSuccessCount = (this.data.routeSuccessCount || 0) + 1;
    if (!this.data.routeSuccessByNiche) {
      this.data.routeSuccessByNiche = {};
    }
    this.data.routeSuccessByNiche[nicheKey] = (this.data.routeSuccessByNiche[nicheKey] || 0) + 1;
    this.save();
    return this.data.routeSuccessCount;
  }

  incrementRouteFallback(nicheKey: string): number {
    this.data.routeFallbackCount = (this.data.routeFallbackCount || 0) + 1;
    if (!this.data.routeFallbackByNiche) {
      this.data.routeFallbackByNiche = {};
    }
    this.data.routeFallbackByNiche[nicheKey] = (this.data.routeFallbackByNiche[nicheKey] || 0) + 1;
    this.save();
    return this.data.routeFallbackCount;
  }

  getRouteSuccessCount(): number {
    return this.data.routeSuccessCount || 0;
  }

  getRouteFallbackCount(): number {
    return this.data.routeFallbackCount || 0;
  }

  getRouteStats(): {
    successCount: number;
    fallbackCount: number;
    fallbackRate: number;
    successByNiche: Record<string, number>;
    fallbackByNiche: Record<string, number>;
  } {
    const successCount = this.getRouteSuccessCount();
    const fallbackCount = this.getRouteFallbackCount();
    const total = successCount + fallbackCount;
    return {
      successCount,
      fallbackCount,
      fallbackRate: total > 0 ? fallbackCount / total : 0,
      successByNiche: { ...(this.data.routeSuccessByNiche || {}) },
      fallbackByNiche: { ...(this.data.routeFallbackByNiche || {}) },
    };
  }

  addAgent(entry: SwarmAgentEntry): void {
    this.data.agents.push(entry);
    this.save();
  }

  setAgentForNiche(agentId: string, blueprintId: string, nicheKey: string): void {
    const existingIdx = this.data.agents.findIndex(a => a.nicheKey === nicheKey);
    const createdAt = existingIdx >= 0 ? this.data.agents[existingIdx].createdAt : new Date().toISOString();
    const nextEntry: SwarmAgentEntry = {
      agentId,
      blueprintId,
      nicheKey,
      conversationId: existingIdx >= 0 ? this.data.agents[existingIdx].conversationId : undefined,
      createdAt,
    };
    if (existingIdx >= 0) {
      this.data.agents[existingIdx] = nextEntry;
    } else {
      this.data.agents.push(nextEntry);
    }
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

  getAgentById(agentId: string): SwarmAgentEntry | null {
    return this.data.agents.find(a => a.agentId === agentId) || null;
  }

  getConversationForAgent(agentId: string): string | undefined {
    return this.getAgentById(agentId)?.conversationId;
  }

  setConversationForAgent(agentId: string, conversationId: string | undefined): void {
    const idx = this.data.agents.findIndex(a => a.agentId === agentId);
    if (idx < 0) return;
    this.data.agents[idx] = {
      ...this.data.agents[idx],
      conversationId,
    };
    this.save();
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

  // ─── Reasoning bridge state ──────────────────────────────────────────────────

  get reasoningSessionId(): string | undefined {
    return this.data.reasoningSessionId;
  }

  set reasoningSessionId(id: string | undefined) {
    this.data.reasoningSessionId = id;
    this.save();
  }

  get reasoningWorkspaceId(): string | undefined {
    return this.data.reasoningWorkspaceId;
  }

  set reasoningWorkspaceId(id: string | undefined) {
    this.data.reasoningWorkspaceId = id;
    this.save();
  }

  get reasoningProblemId(): string | undefined {
    return this.data.reasoningProblemId;
  }

  set reasoningProblemId(id: string | undefined) {
    this.data.reasoningProblemId = id;
    this.save();
  }

  getAgentHubId(agentId: string): string | undefined {
    return this.data.agentHubIds?.[agentId];
  }

  setAgentHubId(agentId: string, hubId: string): void {
    if (!this.data.agentHubIds) {
      this.data.agentHubIds = {};
    }
    this.data.agentHubIds[agentId] = hubId;
    this.save();
  }
}

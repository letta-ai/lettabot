/**
 * SwarmStore Tests (M1)
 *
 * Hypothesis: The existing Store pattern (JSON persistence via fs sync to getDataDir())
 * can extend to N agents with backward compatibility — mode: 'single' behaves identically
 * to the original Store.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SwarmStore } from './swarm-store.js';
import type { NicheDescriptor, TeamBlueprint, FitnessScores, SwarmAgentConfig } from './types.js';
import { existsSync, unlinkSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

function makeTmpDir(): string {
  const dir = resolve(tmpdir(), `swarm-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeBlueprint(overrides: Partial<TeamBlueprint> = {}): TeamBlueprint {
  return {
    id: 'bp-1',
    name: 'Test Blueprint',
    generation: 0,
    parentIds: [],
    agents: [{
      role: 'coordinator',
      model: 'anthropic/claude-sonnet-4-5-20250929',
      systemPrompt: 'You are a test agent',
      skills: {},
      memoryBlocks: [],
    }],
    coordinationStrategy: 'sequential',
    niche: { channel: 'telegram', domain: 'coding', key: 'telegram-coding' },
    fitness: {
      composite: 0.8,
      taskCompletion: 0.9,
      reviewScore: 0.7,
      reasoningDepth: 0.6,
      consensusSpeed: 0.8,
      costEfficiency: 0.9,
    },
    hubRefs: { workspaceId: 'ws-1', problemId: 'prob-1' },
    ...overrides,
  };
}

describe('SwarmStore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    // Clean up
    try {
      const file = resolve(tmpDir, 'swarm-registry.json');
      if (existsSync(file)) unlinkSync(file);
    } catch {}
  });

  // T-SS-1
  it('creates default registry with mode=single when no file exists', () => {
    const store = new SwarmStore(tmpDir);
    expect(store.mode).toBe('single');
    expect(store.agents).toEqual([]);
    expect(store.blueprints).toEqual([]);
    expect(store.generation).toBe(0);
  });

  // T-SS-2
  it('loads existing lettabot-agent.json and auto-migrates to SwarmRegistry format', () => {
    // Write a legacy store file
    const legacyPath = resolve(tmpDir, 'lettabot-agent.json');
    const legacyData = {
      agentId: 'agent-legacy',
      conversationId: 'conv-legacy',
      baseUrl: 'https://api.letta.com',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: '2026-02-01T00:00:00.000Z',
    };
    writeFileSync(legacyPath, JSON.stringify(legacyData));

    const store = new SwarmStore(tmpDir);
    expect(store.mode).toBe('single');
    expect(store.agentId).toBe('agent-legacy');
    expect(store.conversationId).toBe('conv-legacy');
    expect(store.baseUrl).toBe('https://api.letta.com');
  });

  // T-SS-3
  it('in single mode, agentId/conversationId/baseUrl behave identically to Store', () => {
    const store = new SwarmStore(tmpDir);
    expect(store.agentId).toBeNull();

    store.agentId = 'agent-1';
    expect(store.agentId).toBe('agent-1');

    store.conversationId = 'conv-1';
    expect(store.conversationId).toBe('conv-1');

    store.baseUrl = 'https://custom.server.com';
    expect(store.baseUrl).toBe('https://custom.server.com');

    // Verify persistence
    const store2 = new SwarmStore(tmpDir);
    expect(store2.agentId).toBe('agent-1');
    expect(store2.conversationId).toBe('conv-1');
    expect(store2.baseUrl).toBe('https://custom.server.com');
  });

  // T-SS-4
  it('addAgent() adds a SwarmAgentEntry and persists', () => {
    const store = new SwarmStore(tmpDir);
    store.addAgent({
      agentId: 'agent-a',
      blueprintId: 'bp-1',
      nicheKey: 'telegram-coding',
      createdAt: new Date().toISOString(),
    });

    expect(store.agents).toHaveLength(1);
    expect(store.agents[0].agentId).toBe('agent-a');

    // Verify persistence
    const store2 = new SwarmStore(tmpDir);
    expect(store2.agents).toHaveLength(1);
    expect(store2.agents[0].agentId).toBe('agent-a');
  });

  // T-SS-5
  it('removeAgent() removes by agentId and persists', () => {
    const store = new SwarmStore(tmpDir);
    store.addAgent({
      agentId: 'agent-a',
      blueprintId: 'bp-1',
      nicheKey: 'telegram-coding',
      createdAt: new Date().toISOString(),
    });
    store.addAgent({
      agentId: 'agent-b',
      blueprintId: 'bp-2',
      nicheKey: 'slack-research',
      createdAt: new Date().toISOString(),
    });

    expect(store.agents).toHaveLength(2);
    store.removeAgent('agent-a');
    expect(store.agents).toHaveLength(1);
    expect(store.agents[0].agentId).toBe('agent-b');

    // Verify persistence
    const store2 = new SwarmStore(tmpDir);
    expect(store2.agents).toHaveLength(1);
  });

  // T-SS-6
  it('getAgentForNiche() returns best agent for a given NicheDescriptor', () => {
    const store = new SwarmStore(tmpDir);
    store.addAgent({
      agentId: 'agent-tel-code',
      blueprintId: 'bp-1',
      nicheKey: 'telegram-coding',
      createdAt: new Date().toISOString(),
    });
    store.addAgent({
      agentId: 'agent-slack-res',
      blueprintId: 'bp-2',
      nicheKey: 'slack-research',
      createdAt: new Date().toISOString(),
    });

    const niche: NicheDescriptor = { channel: 'telegram', domain: 'coding', key: 'telegram-coding' };
    const agent = store.getAgentForNiche(niche);
    expect(agent).not.toBeNull();
    expect(agent!.agentId).toBe('agent-tel-code');

    const noMatch: NicheDescriptor = { channel: 'discord', domain: 'general', key: 'discord-general' };
    expect(store.getAgentForNiche(noMatch)).toBeNull();
  });

  // T-SS-7
  it('setBlueprint() stores a TeamBlueprint, getElite() retrieves by niche', () => {
    const store = new SwarmStore(tmpDir);
    const bp = makeBlueprint();
    store.setBlueprint(bp);

    expect(store.blueprints).toHaveLength(1);

    const niche: NicheDescriptor = { channel: 'telegram', domain: 'coding', key: 'telegram-coding' };
    const elite = store.getElite(niche);
    expect(elite).not.toBeNull();
    expect(elite!.id).toBe('bp-1');
    expect(elite!.fitness.composite).toBe(0.8);

    // Setting a better blueprint replaces
    const bp2 = makeBlueprint({ id: 'bp-2', fitness: { ...bp.fitness, composite: 0.95 } });
    store.setBlueprint(bp2);
    const elite2 = store.getElite(niche);
    expect(elite2!.id).toBe('bp-2');
  });

  // T-SS-8
  it('hubAgentId and hubWorkspaceId persist across save/load cycles', () => {
    const store = new SwarmStore(tmpDir);
    store.hubAgentId = 'hub-agent-123';
    store.hubWorkspaceId = 'hub-ws-456';

    const store2 = new SwarmStore(tmpDir);
    expect(store2.hubAgentId).toBe('hub-agent-123');
    expect(store2.hubWorkspaceId).toBe('hub-ws-456');
  });
});

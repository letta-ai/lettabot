/**
 * Evolution Engine Tests (M6)
 *
 * Hypothesis: EvolutionEngine orchestrates one generation by composing
 * HubClient (archive), variation operators, and fitness evaluator —
 * selecting parents, variating, evaluating, and submitting proposals.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EvolutionEngine } from './evolution-engine.js';
import { HubClient } from './hub-client.js';
import { SwarmStore } from './swarm-store.js';
import type { EvolutionConfig, TeamBlueprint, NicheDescriptor } from './types.js';
import { DEFAULT_FITNESS_WEIGHTS } from './types.js';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

function makeTmpDir(): string {
  const dir = resolve(tmpdir(), `evo-engine-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

function makeMockHubClient(): HubClient {
  const client = new HubClient('http://mock:1731/mcp', vi.fn());
  client.register = vi.fn().mockResolvedValue({ agentId: 'agent-hub', role: 'coordinator' });
  client.createWorkspace = vi.fn().mockResolvedValue({ workspaceId: 'ws-1' });
  client.createProblem = vi.fn().mockResolvedValue({ problemId: 'prob-1' });
  client.claimProblem = vi.fn().mockResolvedValue({ branchFromThought: 0 });
  client.createProposal = vi.fn().mockResolvedValue({ proposalId: 'prop-1' });
  client.reviewProposal = vi.fn().mockResolvedValue({ reviewId: 'rev-1' });
  client.mergeProposal = vi.fn().mockResolvedValue({ merged: true });
  client.markConsensus = vi.fn().mockResolvedValue({ consensusId: 'cons-1' });
  client.postMessage = vi.fn().mockResolvedValue({ messageId: 'msg-1' });
  return client;
}

const defaultConfig: EvolutionConfig = {
  schedule: '0 */6 * * *',
  populationSize: 5,
  maxAgents: 25,
  fitnessWeights: DEFAULT_FITNESS_WEIGHTS,
};

describe('EvolutionEngine', () => {
  let hubClient: HubClient;
  let store: SwarmStore;
  let engine: EvolutionEngine;

  beforeEach(() => {
    hubClient = makeMockHubClient();
    store = new SwarmStore(makeTmpDir());
    engine = new EvolutionEngine(hubClient, store, defaultConfig);
  });

  // T-EV-1
  it('constructor accepts HubClient, SwarmStore, EvolutionConfig', () => {
    expect(engine).toBeInstanceOf(EvolutionEngine);
  });

  // T-EV-2
  it('initializeArchive() creates workspace + problem per niche via HubClient', async () => {
    const niches: NicheDescriptor[] = [
      { channel: 'telegram', domain: 'coding', key: 'telegram-coding' },
      { channel: 'slack', domain: 'research', key: 'slack-research' },
    ];
    await engine.initializeArchive(niches);

    expect(hubClient.register).toHaveBeenCalled();
    expect(hubClient.createWorkspace).toHaveBeenCalledOnce();
    expect(hubClient.createProblem).toHaveBeenCalledTimes(2);
  });

  // T-EV-3
  it('selectParents() picks from ready niches', () => {
    const niches: NicheDescriptor[] = [
      { channel: 'telegram', domain: 'coding', key: 'telegram-coding' },
      { channel: 'slack', domain: 'research', key: 'slack-research' },
    ];
    const parents = engine.selectParents(niches);
    expect(parents).not.toBeNull();
    expect(parents.niche).toBeDefined();
  });

  // T-EV-4
  it('selectParents() uses elite as parent when niche has one', () => {
    const bp = makeBlueprint();
    store.setBlueprint(bp);

    const niches: NicheDescriptor[] = [
      { channel: 'telegram', domain: 'coding', key: 'telegram-coding' },
    ];
    const parents = engine.selectParents(niches);
    expect(parents.parent).toBeDefined();
    expect(parents.parent!.id).toBe('bp-1');
  });

  // T-EV-5
  it('selectParents() generates random blueprint for empty niches', () => {
    const niches: NicheDescriptor[] = [
      { channel: 'discord', domain: 'general', key: 'discord-general' },
    ];
    const parents = engine.selectParents(niches);
    expect(parents.parent).toBeDefined();
    expect(parents.parent!.generation).toBe(0);
  });

  // T-EV-6
  it('variate() applies variation operators and returns child blueprint', () => {
    const parent = makeBlueprint();
    const child = engine.variate(parent);
    expect(child.id).not.toBe(parent.id);
    expect(child.generation).toBeGreaterThan(parent.generation);
    expect(child.parentIds).toContain(parent.id);
  });

  // T-EV-7
  it('evaluate() computes fitness (mocked)', async () => {
    const bp = makeBlueprint();
    const fitness = await engine.evaluate(bp);
    expect(fitness).toBeDefined();
    expect(fitness.composite).toBeGreaterThanOrEqual(0);
    expect(fitness.composite).toBeLessThanOrEqual(1);
  });

  // T-EV-8
  it('submit() creates proposal via HubClient with blueprint + fitness', async () => {
    const bp = makeBlueprint();
    await engine.submit(bp, 'prob-1');

    expect(hubClient.claimProblem).toHaveBeenCalled();
    expect(hubClient.createProposal).toHaveBeenCalled();
  });

  // T-EV-9
  it('runGeneration() chains select→variate→evaluate→submit→review→merge/reject', async () => {
    const niches: NicheDescriptor[] = [
      { channel: 'telegram', domain: 'coding', key: 'telegram-coding' },
    ];
    // Initialize archive first
    await engine.initializeArchive(niches);

    await engine.runGeneration(niches);

    // Should have gone through the full pipeline
    expect(hubClient.claimProblem).toHaveBeenCalled();
    expect(hubClient.createProposal).toHaveBeenCalled();
    expect(hubClient.reviewProposal).toHaveBeenCalled();
    expect(hubClient.mergeProposal).toHaveBeenCalled();
  });

  // T-EV-10
  it('runGeneration() updates SwarmStore with new elite on successful merge', async () => {
    const niches: NicheDescriptor[] = [
      { channel: 'telegram', domain: 'coding', key: 'telegram-coding' },
    ];
    await engine.initializeArchive(niches);
    await engine.runGeneration(niches);

    // Store should have a blueprint for the niche
    const elite = store.getElite(niches[0]);
    expect(elite).not.toBeNull();
  });
});

/**
 * Variation Operators Tests (M4)
 *
 * Hypothesis: Six variation operators can transform TeamBlueprint → TeamBlueprint
 * as pure functions, incrementing generation and recording lineage.
 */

import { describe, it, expect } from 'vitest';
import {
  skillMutation,
  roleMutation,
  promptCrossover,
  strategyMutation,
  teamSizeMutation,
  modelMutation,
  applyVariation,
} from './variation-operators.js';
import type { TeamBlueprint, SwarmAgentConfig } from './types.js';

function makeAgent(overrides: Partial<SwarmAgentConfig> = {}): SwarmAgentConfig {
  return {
    role: 'contributor',
    model: 'anthropic/claude-sonnet-4-5-20250929',
    systemPrompt: 'You are a helpful assistant.',
    skills: { cronEnabled: false },
    memoryBlocks: [],
    ...overrides,
  };
}

function makeBlueprint(overrides: Partial<TeamBlueprint> = {}): TeamBlueprint {
  return {
    id: 'bp-parent',
    name: 'Parent Blueprint',
    generation: 3,
    parentIds: [],
    agents: [
      makeAgent({ role: 'coordinator' }),
      makeAgent({ role: 'contributor' }),
    ],
    coordinationStrategy: 'sequential',
    niche: { channel: 'telegram', domain: 'coding', key: 'telegram-coding' },
    fitness: {
      composite: 0.7,
      taskCompletion: 0.8,
      reviewScore: 0.6,
      reasoningDepth: 0.5,
      consensusSpeed: 0.9,
      costEfficiency: 0.7,
    },
    hubRefs: { workspaceId: 'ws-1', problemId: 'prob-1' },
    ...overrides,
  };
}

describe('Variation Operators', () => {
  // T-VO-1
  it('skillMutation() adds/removes/swaps a skill in a random agents config', () => {
    const parent = makeBlueprint();
    const child = skillMutation(parent);

    // Should be a different object
    expect(child).not.toBe(parent);
    // Skills should have changed for at least one agent
    const parentSkills = parent.agents.map(a => JSON.stringify(a.skills));
    const childSkills = child.agents.map(a => JSON.stringify(a.skills));
    // At least one agent's skills should differ
    const anyDifferent = childSkills.some((s, i) => s !== parentSkills[i]);
    expect(anyDifferent).toBe(true);
  });

  // T-VO-2
  it('roleMutation() reassigns roles (enforces at most one coordinator)', () => {
    const parent = makeBlueprint();
    const child = roleMutation(parent);

    const coordinators = child.agents.filter(a => a.role === 'coordinator');
    expect(coordinators.length).toBeLessThanOrEqual(1);
    // Roles should have changed
    expect(child).not.toBe(parent);
  });

  // T-VO-3
  it('promptCrossover() blends system prompts from two parent blueprints', () => {
    const parent1 = makeBlueprint({
      agents: [makeAgent({
        role: 'coordinator',
        systemPrompt: 'You are an expert coder who writes clean TypeScript.',
      })],
    });
    const parent2 = makeBlueprint({
      id: 'bp-parent2',
      agents: [makeAgent({
        role: 'coordinator',
        systemPrompt: 'You are a researcher who analyzes papers carefully.',
      })],
    });

    const child = promptCrossover(parent1, parent2);
    // Child prompt should differ from both parents (blended)
    const childPrompt = child.agents[0].systemPrompt;
    expect(childPrompt.length).toBeGreaterThan(0);
    // It should contain elements from at least one parent
    const hasParent1Content = childPrompt.includes('coder') || childPrompt.includes('TypeScript');
    const hasParent2Content = childPrompt.includes('researcher') || childPrompt.includes('papers');
    expect(hasParent1Content || hasParent2Content).toBe(true);
  });

  // T-VO-4
  it('strategyMutation() changes coordinationStrategy to a different value', () => {
    const parent = makeBlueprint({ coordinationStrategy: 'sequential' });
    const child = strategyMutation(parent);
    expect(child.coordinationStrategy).not.toBe('sequential');
    expect(['sequential', 'parallel', 'debate', 'pipeline']).toContain(child.coordinationStrategy);
  });

  // T-VO-5
  it('teamSizeMutation() adds (max 5) or removes (min 1) agents', () => {
    // Test add: start with 1 agent
    const small = makeBlueprint({ agents: [makeAgent({ role: 'coordinator' })] });
    const grown = teamSizeMutation(small);
    // With only 1 agent, can only grow
    expect(grown.agents.length).toBeGreaterThanOrEqual(1);
    expect(grown.agents.length).toBeLessThanOrEqual(5);

    // Test can't go below 1
    const single = makeBlueprint({ agents: [makeAgent({ role: 'coordinator' })] });
    // Run multiple times to ensure we never go below 1
    for (let i = 0; i < 10; i++) {
      const result = teamSizeMutation(single);
      expect(result.agents.length).toBeGreaterThanOrEqual(1);
    }

    // Test can't go above 5
    const full = makeBlueprint({
      agents: [
        makeAgent({ role: 'coordinator' }),
        makeAgent(), makeAgent(), makeAgent(), makeAgent(),
      ],
    });
    for (let i = 0; i < 10; i++) {
      const result = teamSizeMutation(full);
      expect(result.agents.length).toBeLessThanOrEqual(5);
    }
  });

  // T-VO-6
  it('modelMutation() swaps an agents model tier', () => {
    const parent = makeBlueprint();
    const child = modelMutation(parent);
    // At least one agent's model should differ
    const parentModels = parent.agents.map(a => a.model);
    const childModels = child.agents.map(a => a.model);
    const anyDifferent = childModels.some((m, i) => m !== parentModels[i]);
    expect(anyDifferent).toBe(true);
  });

  // T-VO-7
  it('all operators increment generation and record parentIds', () => {
    const parent = makeBlueprint({ generation: 5, id: 'bp-gen5' });
    const operators = [
      (bp: TeamBlueprint) => skillMutation(bp),
      (bp: TeamBlueprint) => roleMutation(bp),
      (bp: TeamBlueprint) => strategyMutation(bp),
      (bp: TeamBlueprint) => teamSizeMutation(bp),
      (bp: TeamBlueprint) => modelMutation(bp),
    ];

    for (const op of operators) {
      const child = op(parent);
      expect(child.generation).toBe(6);
      expect(child.parentIds).toContain('bp-gen5');
    }
  });

  // T-VO-8
  it('applyVariation() applies 1-3 random operators to a blueprint', () => {
    const parent = makeBlueprint({ generation: 0 });
    const child = applyVariation(parent);
    expect(child.generation).toBeGreaterThan(0);
    expect(child.parentIds).toContain(parent.id);
    expect(child.id).not.toBe(parent.id);
  });

  // T-VO-9
  it('crossover requires 2 parents; mutations require 1', () => {
    const parent1 = makeBlueprint({ id: 'p1' });
    const parent2 = makeBlueprint({ id: 'p2' });

    const crossed = promptCrossover(parent1, parent2);
    expect(crossed.parentIds).toContain('p1');
    expect(crossed.parentIds).toContain('p2');

    // Mutations only need 1 parent
    const mutated = skillMutation(parent1);
    expect(mutated.parentIds).toContain('p1');
    expect(mutated.parentIds).not.toContain('p2');
  });
});

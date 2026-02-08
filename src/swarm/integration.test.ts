/**
 * Integration Tests (M9)
 *
 * Hypothesis: The full TEAM-Elites lifecycle works end-to-end with
 * mocked SDK and mocked Hub.
 */

import { describe, it, expect, vi } from 'vitest';
import { SwarmStore } from './swarm-store.js';
import { SwarmManager } from './swarm-manager.js';
import { matchNiche } from './niche-matcher.js';
import { EvolutionEngine } from './evolution-engine.js';
import { HubClient } from './hub-client.js';
import type { InboundMessage } from '../core/types.js';
import type { NicheDescriptor, EvolutionConfig } from './types.js';
import { DEFAULT_FITNESS_WEIGHTS } from './types.js';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

function makeTmpDir(): string {
  const dir = resolve(tmpdir(), `integration-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: 'telegram',
    chatId: '123',
    userId: 'user1',
    text: 'Hello world',
    timestamp: new Date(),
    ...overrides,
  };
}

function makeMockFetch() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Map([['mcp-session-id', 'test-session']]),
    json: async () => ({
      jsonrpc: '2.0',
      result: {
        content: [{
          type: 'text',
          text: JSON.stringify({
            agentId: 'hub-agent',
            role: 'coordinator',
            workspaceId: 'ws-1',
            problemId: 'prob-1',
            branchFromThought: 0,
            proposalId: 'prop-1',
            reviewId: 'rev-1',
            merged: true,
            consensusId: 'cons-1',
            messageId: 'msg-1',
          }),
        }],
      },
      id: 1,
    }),
  });
}

describe('TEAM-Elites Integration', () => {
  // T-INT-1
  it('Full routing: SwarmStore + NicheMatcher + SwarmManager routes message to correct agent', () => {
    const store = new SwarmStore(makeTmpDir());
    store.mode = 'swarm';
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

    const manager = new SwarmManager(store, matchNiche);

    // Coding message on telegram → routes to telegram-coding agent
    const codingMsg = createMessage({
      channel: 'telegram',
      text: 'Help me debug this TypeScript function',
    });
    const codingRoute = manager.routeMessage(codingMsg);
    expect(codingRoute).not.toBeNull();
    expect(codingRoute!.agentId).toBe('agent-tel-code');

    // Research message on slack → routes to slack-research agent
    const researchMsg = createMessage({
      channel: 'slack',
      text: 'Research the latest papers on transformers',
    });
    const researchRoute = manager.routeMessage(researchMsg);
    expect(researchRoute).not.toBeNull();
    expect(researchRoute!.agentId).toBe('agent-slack-res');

    // Unmatched niche → returns null
    const noMatch = createMessage({
      channel: 'discord',
      text: 'Hello world',
    });
    const noRoute = manager.routeMessage(noMatch);
    expect(noRoute).toBeNull();
  });

  // T-INT-2
  it('Evolution loop: initArchive→selectParents→variate→evaluate→submit→merge stores elite', async () => {
    const store = new SwarmStore(makeTmpDir());
    const hubClient = new HubClient('http://mock:1731/mcp', makeMockFetch() as unknown as typeof fetch);
    const config: EvolutionConfig = {
      schedule: '0 */6 * * *',
      populationSize: 1,
      maxAgents: 25,
      fitnessWeights: DEFAULT_FITNESS_WEIGHTS,
    };
    const engine = new EvolutionEngine(hubClient, store, config);

    const niches: NicheDescriptor[] = [
      { channel: 'telegram', domain: 'coding', key: 'telegram-coding' },
    ];

    // Full lifecycle
    await engine.initializeArchive(niches);
    expect(store.hubAgentId).toBe('hub-agent');
    expect(store.hubWorkspaceId).toBe('ws-1');

    await engine.runGeneration(niches);

    // Should have stored an elite blueprint
    const elite = store.getElite(niches[0]);
    expect(elite).not.toBeNull();
    expect(elite!.niche.key).toBe('telegram-coding');
    expect(elite!.fitness.composite).toBeGreaterThan(0);
    expect(elite!.generation).toBeGreaterThan(0);
  });

  // T-INT-3
  it('Backward compat: mode=single routes identically to original bot.ts behavior', () => {
    const store = new SwarmStore(makeTmpDir());
    store.mode = 'single';
    store.agentId = 'agent-legacy';

    const manager = new SwarmManager(store, matchNiche);

    // Any message should route to the default agent regardless of content
    const msg1 = createMessage({ text: 'Debug my code' });
    const msg2 = createMessage({ text: 'Research papers' });
    const msg3 = createMessage({ text: 'Hello there' });

    expect(manager.routeMessage(msg1)!.agentId).toBe('agent-legacy');
    expect(manager.routeMessage(msg2)!.agentId).toBe('agent-legacy');
    expect(manager.routeMessage(msg3)!.agentId).toBe('agent-legacy');
  });

  // T-INT-4
  it('Hub identity persistence: hubAgentId survives SwarmStore reload from disk', () => {
    const tmpDir = makeTmpDir();

    // First instance: set hub identity
    const store1 = new SwarmStore(tmpDir);
    store1.hubAgentId = 'coordinator-abc123';
    store1.hubWorkspaceId = 'workspace-def456';
    store1.mode = 'swarm';
    store1.addAgent({
      agentId: 'agent-1',
      blueprintId: 'bp-1',
      nicheKey: 'telegram-coding',
      createdAt: new Date().toISOString(),
    });

    // Second instance: reload from disk
    const store2 = new SwarmStore(tmpDir);
    expect(store2.hubAgentId).toBe('coordinator-abc123');
    expect(store2.hubWorkspaceId).toBe('workspace-def456');
    expect(store2.mode).toBe('swarm');
    expect(store2.agents).toHaveLength(1);
    expect(store2.agents[0].agentId).toBe('agent-1');
  });
});

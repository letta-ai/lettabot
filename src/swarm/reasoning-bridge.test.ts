/**
 * ReasoningBridge Tests
 *
 * Tests the orchestration layer that connects swarm agents
 * to shared Thoughtbox reasoning sessions.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ReasoningBridge } from './reasoning-bridge.js';
import type { GatewayClient, ThoughtEntry } from './gateway-client.js';
import type { HubClient } from './hub-client.js';
import type { SwarmStore } from './swarm-store.js';
import type { SwarmAgentEntry } from './types.js';

function createMockGateway(): GatewayClient {
  return {
    startNew: vi.fn().mockResolvedValue({ sessionId: 'sess-1' }),
    loadContext: vi.fn().mockResolvedValue({ sessionId: 'sess-1' }),
    cipher: vi.fn().mockResolvedValue({ stage: 2 }),
    thought: vi.fn().mockResolvedValue({ thoughtNumber: 1, branchId: 'main', sessionId: 'sess-1' }),
    readThoughts: vi.fn().mockResolvedValue([]),
    getStructure: vi.fn().mockResolvedValue({ sessionId: 'sess-1', branches: [], totalThoughts: 0 }),
  } as unknown as GatewayClient;
}

function createMockHub(): HubClient {
  return {
    register: vi.fn().mockResolvedValue({ agentId: 'hub-agent-1', role: 'coordinator' }),
    createWorkspace: vi.fn().mockResolvedValue({ workspaceId: 'ws-1' }),
    createProblem: vi.fn().mockResolvedValue({ problemId: 'prob-1' }),
    postMessage: vi.fn().mockResolvedValue({ messageId: 'msg-1' }),
    readChannel: vi.fn().mockResolvedValue([]),
    claimProblem: vi.fn().mockResolvedValue({ branchFromThought: 0 }),
    createProposal: vi.fn().mockResolvedValue({ proposalId: 'prop-1' }),
    reviewProposal: vi.fn().mockResolvedValue({ reviewId: 'rev-1' }),
    mergeProposal: vi.fn().mockResolvedValue({ merged: true }),
    markConsensus: vi.fn().mockResolvedValue({ consensusId: 'cons-1' }),
  } as unknown as HubClient;
}

function createMockStore(overrides: Partial<SwarmStore> = {}): SwarmStore {
  const agentHubIds: Record<string, string> = {};
  return {
    agents: [],
    mode: 'swarm',
    hubAgentId: undefined,
    hubWorkspaceId: undefined,
    reasoningSessionId: undefined,
    reasoningWorkspaceId: undefined,
    reasoningProblemId: undefined,
    getAgentHubId: vi.fn((id: string) => agentHubIds[id]),
    setAgentHubId: vi.fn((id: string, hubId: string) => { agentHubIds[id] = hubId; }),
    ...overrides,
  } as unknown as SwarmStore;
}

const testAgents: SwarmAgentEntry[] = [
  { agentId: 'agent-1', blueprintId: 'bp-1', nicheKey: 'telegram-coding', createdAt: '2025-01-01' },
  { agentId: 'agent-2', blueprintId: 'bp-2', nicheKey: 'slack-research', createdAt: '2025-01-01' },
  { agentId: 'agent-3', blueprintId: 'bp-3', nicheKey: 'discord-general', createdAt: '2025-01-01' },
];

describe('ReasoningBridge', () => {
  let gateway: ReturnType<typeof createMockGateway>;
  let hub: ReturnType<typeof createMockHub>;
  let store: ReturnType<typeof createMockStore>;
  let bridge: ReasoningBridge;

  beforeEach(() => {
    gateway = createMockGateway();
    hub = createMockHub();
    store = createMockStore({ agents: testAgents });
    bridge = new ReasoningBridge(gateway, hub, store, { maxContextThoughts: 3 });
  });

  describe('initialize()', () => {
    it('follows correct sequence: startNew → cipher → register → createWorkspace → createProblem → thought', async () => {
      await bridge.initialize(testAgents);

      // Verify sequence
      expect(gateway.startNew).toHaveBeenCalledWith(
        'lettabot-swarm-reasoning',
        ['swarm', 'reasoning'],
      );
      expect(gateway.cipher).toHaveBeenCalled();
      expect(hub.register).toHaveBeenCalledWith('swarm-coordinator', 'coordinator');
      expect(hub.createWorkspace).toHaveBeenCalledWith(
        'lettabot-swarm',
        expect.stringContaining('Shared reasoning'),
      );
      expect(hub.createProblem).toHaveBeenCalledWith(
        'ws-1',
        'shared-reasoning',
        expect.any(String),
      );

      // Register each agent
      expect(hub.register).toHaveBeenCalledTimes(4); // 1 coordinator + 3 agents

      // Initial thought posted
      expect(gateway.thought).toHaveBeenCalledWith(
        expect.objectContaining({
          thought: expect.stringContaining('3 agents'),
          thoughtType: 'initialization',
        }),
      );

      // Session and workspace IDs persisted
      expect(store.reasoningSessionId).toBe('sess-1');
      expect(store.reasoningWorkspaceId).toBe('ws-1');
      expect(store.reasoningProblemId).toBe('prob-1');
    });

    it('is idempotent — second call is a no-op', async () => {
      await bridge.initialize(testAgents);
      await bridge.initialize(testAgents);

      // startNew called only once
      expect(gateway.startNew).toHaveBeenCalledTimes(1);
    });

    it('uses loadContext when existing session ID is stored', async () => {
      store = createMockStore({
        agents: testAgents,
        reasoningSessionId: 'existing-sess',
      });
      bridge = new ReasoningBridge(gateway, hub, store, {});

      await bridge.initialize(testAgents);

      expect(gateway.loadContext).toHaveBeenCalledWith('existing-sess');
      expect(gateway.startNew).not.toHaveBeenCalled();
    });

    it('reuses existing hubAgentId without re-registering coordinator', async () => {
      store = createMockStore({
        agents: testAgents,
        hubAgentId: 'existing-hub-agent',
      });
      bridge = new ReasoningBridge(gateway, hub, store, {});

      await bridge.initialize(testAgents);

      // register called only for agents (not coordinator)
      const registerCalls = (hub.register as any).mock.calls;
      const coordinatorCalls = registerCalls.filter(
        (c: any[]) => c[1] === 'coordinator',
      );
      expect(coordinatorCalls).toHaveLength(0);
    });

    it('reuses existing workspace and problem IDs', async () => {
      store = createMockStore({
        agents: testAgents,
        reasoningWorkspaceId: 'existing-ws',
        reasoningProblemId: 'existing-prob',
      });
      bridge = new ReasoningBridge(gateway, hub, store, {});

      await bridge.initialize(testAgents);

      expect(hub.createWorkspace).not.toHaveBeenCalled();
      expect(hub.createProblem).not.toHaveBeenCalled();
    });
  });

  describe('gatherContext()', () => {
    it('returns XML with thoughts from other agents branches', async () => {
      const mockThoughts: ThoughtEntry[] = [
        {
          thoughtNumber: 5,
          thought: 'User asked about React hooks. Found official docs helpful.',
          thoughtType: 'reasoning',
          branchId: 'slack-research',
          timestamp: '2025-01-01T00:00:00Z',
        },
      ];
      (gateway.readThoughts as any).mockResolvedValue(mockThoughts);

      await bridge.initialize(testAgents);
      const ctx = await bridge.gatherContext('agent-1', 'telegram-coding');

      expect(ctx.xml).toContain('<swarm-context>');
      expect(ctx.xml).toContain('<recent-thoughts');
      expect(ctx.xml).toContain('agent-slack-research');
      expect(ctx.xml).toContain('React hooks');
      expect(ctx.thoughtCount).toBeGreaterThan(0);
    });

    it('returns empty context when agent is the only one', async () => {
      const singleStore = createMockStore({
        agents: [testAgents[0]],
      });
      bridge = new ReasoningBridge(gateway, hub, singleStore, {});
      await bridge.initialize([testAgents[0]]);

      const ctx = await bridge.gatherContext('agent-1', 'telegram-coding');
      expect(ctx).toEqual({ xml: '', thoughtCount: 0, decisionCount: 0 });
    });

    it('returns empty context on error without throwing', async () => {
      (gateway.readThoughts as any).mockRejectedValue(new Error('network error'));
      (hub.readChannel as any).mockRejectedValue(new Error('network error'));

      await bridge.initialize(testAgents);
      const ctx = await bridge.gatherContext('agent-1', 'telegram-coding');

      expect(ctx).toEqual({ xml: '', thoughtCount: 0, decisionCount: 0 });
    });

    it('returns empty context before initialization', async () => {
      const ctx = await bridge.gatherContext('agent-1', 'telegram-coding');
      expect(ctx).toEqual({ xml: '', thoughtCount: 0, decisionCount: 0 });
    });

    it('includes shared decisions from Hub channel', async () => {
      (hub.readChannel as any).mockResolvedValue([
        { content: '[telegram-coding] User prefers TypeScript' },
      ]);

      await bridge.initialize(testAgents);
      const ctx = await bridge.gatherContext('agent-1', 'telegram-coding');

      expect(ctx.xml).toContain('<shared-decisions');
      expect(ctx.xml).toContain('User prefers TypeScript');
      expect(ctx.decisionCount).toBe(1);
    });
  });

  describe('logReasoning()', () => {
    it('posts thought to agent branch (fire-and-forget)', async () => {
      await bridge.initialize(testAgents);

      await bridge.logReasoning('agent-1', 'telegram-coding', {
        inboundMessage: 'How do I use React hooks?',
        response: 'Here is how you use React hooks...',
        channel: 'telegram',
      });

      // Second call to thought (first was initialization)
      expect(gateway.thought).toHaveBeenCalledTimes(2);
      const thoughtCall = (gateway.thought as any).mock.calls[1][0];
      expect(thoughtCall.branchId).toBe('telegram-coding');
      expect(thoughtCall.thought).toContain('telegram');
      expect(thoughtCall.thought).toContain('React hooks');
    });

    it('first thought on a branch includes branchFromThought', async () => {
      await bridge.initialize(testAgents);

      await bridge.logReasoning('agent-1', 'telegram-coding', {
        inboundMessage: 'test',
        response: 'response',
        channel: 'telegram',
      });

      const thoughtCall = (gateway.thought as any).mock.calls[1][0];
      expect(thoughtCall.branchFromThought).toBe(1); // mainChainHead from init
    });

    it('subsequent thoughts on same branch omit branchFromThought', async () => {
      await bridge.initialize(testAgents);

      // First thought
      await bridge.logReasoning('agent-1', 'telegram-coding', {
        inboundMessage: 'first',
        response: 'r1',
        channel: 'telegram',
      });

      // Second thought
      await bridge.logReasoning('agent-1', 'telegram-coding', {
        inboundMessage: 'second',
        response: 'r2',
        channel: 'telegram',
      });

      const secondCall = (gateway.thought as any).mock.calls[2][0];
      expect(secondCall.branchFromThought).toBeUndefined();
    });

    it('does not throw on gateway error', async () => {
      await bridge.initialize(testAgents);

      // Make thought fail on subsequent calls
      (gateway.thought as any).mockRejectedValueOnce(new Error('network error'));

      // Should not throw
      await bridge.logReasoning('agent-1', 'telegram-coding', {
        inboundMessage: 'test',
        response: 'response',
        channel: 'telegram',
      });
    });

    it('is no-op before initialization', async () => {
      await bridge.logReasoning('agent-1', 'telegram-coding', {
        inboundMessage: 'test',
        response: 'response',
        channel: 'telegram',
      });

      expect(gateway.thought).not.toHaveBeenCalled();
    });
  });

  describe('logDecision()', () => {
    it('posts to Hub channel with agent label', async () => {
      await bridge.initialize(testAgents);

      await bridge.logDecision('agent-1', 'User prefers TypeScript');

      expect(hub.postMessage).toHaveBeenCalledWith(
        'ws-1',
        'prob-1',
        '[telegram-coding] User prefers TypeScript',
      );
    });

    it('falls back to agentId when agent not found in store', async () => {
      await bridge.initialize(testAgents);

      await bridge.logDecision('unknown-agent', 'Some decision');

      expect(hub.postMessage).toHaveBeenCalledWith(
        'ws-1',
        'prob-1',
        '[unknown-agent] Some decision',
      );
    });

    it('is no-op before initialization', async () => {
      await bridge.logDecision('agent-1', 'decision');
      expect(hub.postMessage).not.toHaveBeenCalled();
    });
  });
});

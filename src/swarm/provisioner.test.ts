import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DefaultSwarmProvisioner } from './provisioner.js';
import type { TeamBlueprint } from './types.js';

vi.mock('@letta-ai/letta-code-sdk', () => ({
  createAgent: vi.fn().mockResolvedValue('agent-created-1'),
}));

vi.mock('../tools/letta-api.js', () => ({
  findAgentByName: vi.fn(),
  agentExists: vi.fn(),
  ensureNoToolApprovals: vi.fn().mockResolvedValue(undefined),
}));

function makeBlueprint(overrides: Partial<TeamBlueprint> = {}): TeamBlueprint {
  return {
    id: 'bp-1',
    name: 'Blueprint',
    generation: 1,
    parentIds: [],
    agents: [{
      role: 'coordinator',
      model: 'anthropic/claude-sonnet-4-5-20250929',
      systemPrompt: 'You are specialized.',
      skills: {},
      memoryBlocks: [],
    }],
    coordinationStrategy: 'sequential',
    niche: { channel: 'discord', domain: 'coding', key: 'discord-coding' },
    fitness: {
      composite: 0.8,
      taskCompletion: 0.8,
      reviewScore: 0.8,
      reasoningDepth: 0.8,
      consensusSpeed: 0.8,
      costEfficiency: 0.8,
    },
    hubRefs: { workspaceId: 'ws-1', problemId: 'p-1' },
    ...overrides,
  };
}

describe('DefaultSwarmProvisioner', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
  });

  it('reuses an existing niche agent by deterministic name', async () => {
    const lettaApi = await import('../tools/letta-api.js');
    vi.mocked(lettaApi.findAgentByName).mockResolvedValue({ id: 'agent-existing-1', name: 'lettabot-swarm-discord-coding' });
    vi.mocked(lettaApi.agentExists).mockResolvedValue(true);

    const provisioner = new DefaultSwarmProvisioner();
    const agentId = await provisioner.provisionNicheAgent(makeBlueprint());
    expect(agentId).toBe('agent-existing-1');
  });

  it('creates a new niche agent when one does not exist', async () => {
    const lettaApi = await import('../tools/letta-api.js');
    const sdk = await import('@letta-ai/letta-code-sdk');
    vi.mocked(lettaApi.findAgentByName).mockResolvedValue(null);
    vi.mocked(lettaApi.agentExists).mockResolvedValue(false);

    const provisioner = new DefaultSwarmProvisioner({ modelFallback: 'zai/glm-4.7' });
    const agentId = await provisioner.provisionNicheAgent(makeBlueprint());
    expect(agentId).toBe('agent-created-1');
    expect(vi.mocked(sdk.createAgent)).toHaveBeenCalled();
  });
});

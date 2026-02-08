/**
 * HubClient Tests (M3)
 *
 * Hypothesis: A thin HTTP client can call Thoughtbox Hub via JSON-RPC
 * to localhost:1731/mcp, persisting the mcp-session-id header across calls.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HubClient } from './hub-client.js';

function mockFetch(responseBody: unknown, headers?: Record<string, string>) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Map(Object.entries(headers || {})),
    json: async () => ({
      jsonrpc: '2.0',
      result: {
        content: [{ type: 'text', text: JSON.stringify(responseBody) }],
      },
      id: 1,
    }),
  });
}

describe('HubClient', () => {
  let client: HubClient;
  let fetchMock: ReturnType<typeof mockFetch>;

  beforeEach(() => {
    fetchMock = mockFetch({});
    client = new HubClient('http://localhost:1731/mcp', fetchMock as unknown as typeof fetch);
  });

  // T-HC-1
  it('register() sends JSON-RPC tools/call with operation=register, returns agentId', async () => {
    fetchMock = mockFetch({ agentId: 'agent-123', role: 'coordinator' });
    client = new HubClient('http://localhost:1731/mcp', fetchMock as unknown as typeof fetch);

    const result = await client.register('TEAM-Elites-Coordinator', 'coordinator');
    expect(result.agentId).toBe('agent-123');

    const call = fetchMock.mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.method).toBe('tools/call');
    expect(body.params.name).toBe('thoughtbox_hub');
    expect(body.params.arguments.operation).toBe('register');
    expect(body.params.arguments.args.name).toBe('TEAM-Elites-Coordinator');
  });

  // T-HC-2
  it('createWorkspace() sends operation=create_workspace, returns workspaceId', async () => {
    fetchMock = mockFetch({ workspaceId: 'ws-abc' });
    client = new HubClient('http://localhost:1731/mcp', fetchMock as unknown as typeof fetch);

    const result = await client.createWorkspace('team-elites-archive', 'MAP-Elites archive');
    expect(result.workspaceId).toBe('ws-abc');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.params.arguments.operation).toBe('create_workspace');
    expect(body.params.arguments.args.name).toBe('team-elites-archive');
  });

  // T-HC-3
  it('createProblem() sends operation=create_problem with workspaceId', async () => {
    fetchMock = mockFetch({ problemId: 'prob-123' });
    client = new HubClient('http://localhost:1731/mcp', fetchMock as unknown as typeof fetch);

    const result = await client.createProblem('ws-abc', 'niche:telegram-coding', 'Telegram coding niche');
    expect(result.problemId).toBe('prob-123');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.params.arguments.operation).toBe('create_problem');
    expect(body.params.arguments.args.workspaceId).toBe('ws-abc');
  });

  // T-HC-4
  it('claimProblem() sends operation=claim_problem with problemId and branchId', async () => {
    fetchMock = mockFetch({ branchFromThought: 0 });
    client = new HubClient('http://localhost:1731/mcp', fetchMock as unknown as typeof fetch);

    const result = await client.claimProblem('prob-123', 'gen0-branch');
    expect(result.branchFromThought).toBe(0);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.params.arguments.operation).toBe('claim_problem');
    expect(body.params.arguments.args.problemId).toBe('prob-123');
  });

  // T-HC-5
  it('createProposal() sends operation=create_proposal with sourceBranch', async () => {
    fetchMock = mockFetch({ proposalId: 'prop-abc' });
    client = new HubClient('http://localhost:1731/mcp', fetchMock as unknown as typeof fetch);

    const result = await client.createProposal('prob-123', 'Gen-0 candidate', 'gen0-branch', '{}');
    expect(result.proposalId).toBe('prop-abc');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.params.arguments.operation).toBe('create_proposal');
  });

  // T-HC-6
  it('reviewProposal() sends operation=review_proposal with verdict', async () => {
    fetchMock = mockFetch({ reviewId: 'rev-123' });
    client = new HubClient('http://localhost:1731/mcp', fetchMock as unknown as typeof fetch);

    const result = await client.reviewProposal('prop-abc', 'approve', 'LGTM');
    expect(result.reviewId).toBe('rev-123');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.params.arguments.operation).toBe('review_proposal');
    expect(body.params.arguments.args.verdict).toBe('approve');
  });

  // T-HC-7
  it('mergeProposal() sends operation=merge_proposal (coordinator only)', async () => {
    fetchMock = mockFetch({ merged: true });
    client = new HubClient('http://localhost:1731/mcp', fetchMock as unknown as typeof fetch);

    const result = await client.mergeProposal('prop-abc');
    expect(result.merged).toBe(true);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.params.arguments.operation).toBe('merge_proposal');
  });

  // T-HC-8
  it('markConsensus() sends operation=mark_consensus with name and thoughtRef', async () => {
    fetchMock = mockFetch({ consensusId: 'cons-123' });
    client = new HubClient('http://localhost:1731/mcp', fetchMock as unknown as typeof fetch);

    const result = await client.markConsensus('elite-telegram-coding', 5);
    expect(result.consensusId).toBe('cons-123');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.params.arguments.operation).toBe('mark_consensus');
    expect(body.params.arguments.args.name).toBe('elite-telegram-coding');
  });

  // T-HC-9
  it('session ID from first response header persisted in subsequent requests', async () => {
    const sessionId = 'session-xyz-789';
    fetchMock = mockFetch(
      { agentId: 'agent-1' },
      { 'mcp-session-id': sessionId }
    );
    client = new HubClient('http://localhost:1731/mcp', fetchMock as unknown as typeof fetch);

    await client.register('Agent1', 'coordinator');

    // Second call should include the session ID
    fetchMock = mockFetch({ workspaceId: 'ws-1' });
    // Replace fetch but keep the client's session ID
    (client as any).fetchFn = fetchMock;

    await client.createWorkspace('test', 'test workspace');

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['mcp-session-id']).toBe(sessionId);
  });
});

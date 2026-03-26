import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getLatestRunError, recoverOrphanedConversationApproval, isRecoverableConversationId, recoverPendingApprovalsForAgent, approvePendingApproval } from './letta-api.js';

// Mock the Letta client before importing the module under test
const mockConversationsMessagesList = vi.fn();
const mockConversationsMessagesCreate = vi.fn();
const mockRunsRetrieve = vi.fn();
const mockRunsList = vi.fn();
const mockAgentsMessagesCancel = vi.fn();
const mockAgentsMessagesCreate = vi.fn();
const mockAgentsRetrieve = vi.fn();
const mockAgentsMessagesList = vi.fn();

vi.mock('@letta-ai/letta-client', () => {
  return {
    Letta: class MockLetta {
      conversations = {
        messages: {
          list: mockConversationsMessagesList,
          create: mockConversationsMessagesCreate,
        },
      };
      runs = {
        retrieve: mockRunsRetrieve,
        list: mockRunsList,
      };
      agents = {
        retrieve: mockAgentsRetrieve,
        messages: {
          cancel: mockAgentsMessagesCancel,
          create: mockAgentsMessagesCreate,
          list: mockAgentsMessagesList,
        },
      };
    },
  };
});

describe('recoverPendingApprovalsForAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentsRetrieve.mockResolvedValue({ pending_approval: null });
    mockAgentsMessagesList.mockReturnValue(mockPageIterator([]));
    mockAgentsMessagesCancel.mockResolvedValue(undefined);
    mockAgentsMessagesCreate.mockResolvedValue({});
  });

  it('cancels approval-blocked runs when pending approval payload is unavailable', async () => {
    // First runs.list call: getPendingApprovals run scan (no tool calls resolved)
    mockRunsList
      .mockReturnValueOnce(mockPageIterator([
        { id: 'run-stuck', status: 'created', stop_reason: 'requires_approval' },
      ]))
      // Second runs.list call: listAgentApprovalRunIds fallback
      .mockReturnValueOnce(mockPageIterator([
        { id: 'run-stuck', status: 'created', stop_reason: 'requires_approval' },
      ]));

    const result = await recoverPendingApprovalsForAgent('agent-1');

    expect(result.recovered).toBe(true);
    expect(result.details).toContain('Cancelled 1 approval-blocked run(s)');
    expect(mockAgentsMessagesCancel).toHaveBeenCalledWith('agent-1', {
      run_ids: ['run-stuck'],
    });
  });

  it('returns false when no pending approvals and no approval-blocked runs are found', async () => {
    mockRunsList
      .mockReturnValueOnce(mockPageIterator([]))
      .mockReturnValueOnce(mockPageIterator([]));

    const result = await recoverPendingApprovalsForAgent('agent-1');

    expect(result.recovered).toBe(false);
    expect(result.details).toBe('No pending approvals found on agent');
    expect(mockAgentsMessagesCancel).not.toHaveBeenCalled();
  });
});

describe('approvePendingApproval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentsMessagesCreate.mockResolvedValue({});
  });

  it('approves a single tool call', async () => {
    const ok = await approvePendingApproval('agent-1', { toolCallId: 'call-1' });

    expect(ok).toBe(true);
    expect(mockAgentsMessagesCreate).toHaveBeenCalledOnce();
    expect(mockAgentsMessagesCreate).toHaveBeenCalledWith('agent-1', {
      messages: [{
        type: 'approval',
        approvals: [{
          approve: true,
          tool_call_id: 'call-1',
          type: 'approval',
          reason: 'Approved by user from chat command',
        }],
      }],
      streaming: false,
    });
  });

  it('approves multiple tool calls in one request', async () => {
    const ok = await approvePendingApproval('agent-1', [
      { toolCallId: 'call-a' },
      { toolCallId: 'call-b', reason: 'Approved by moderator' },
    ]);

    expect(ok).toBe(true);
    const payload = mockAgentsMessagesCreate.mock.calls[0][1];
    expect(payload.messages[0].approvals).toHaveLength(2);
    expect(payload.messages[0].approvals.map((a: any) => a.tool_call_id)).toEqual(['call-a', 'call-b']);
    expect(payload.messages[0].approvals[1].reason).toBe('Approved by moderator');
  });

  it('returns true when approval is already resolved', async () => {
    mockAgentsMessagesCreate.mockRejectedValue({
      status: 400,
      error: { detail: 'No tool call is currently awaiting approval' },
    });

    const ok = await approvePendingApproval('agent-1', { toolCallId: 'call-1' });
    expect(ok).toBe(true);
  });
});

describe('isRecoverableConversationId', () => {
  it('returns false for aliases and empty values', () => {
    expect(isRecoverableConversationId(undefined)).toBe(false);
    expect(isRecoverableConversationId(null)).toBe(false);
    expect(isRecoverableConversationId('')).toBe(false);
    expect(isRecoverableConversationId('default')).toBe(false);
    expect(isRecoverableConversationId('shared')).toBe(false);
  });

  it('returns true for materialized conversation ids', () => {
    expect(isRecoverableConversationId('conv-123')).toBe(true);
  });
});

// Helper to create a mock async iterable from an array (Letta client returns paginated iterators)
function mockPageIterator<T>(items: T[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const item of items) yield item;
    },
  };
}

describe('recoverOrphanedConversationApproval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunsList.mockReturnValue(mockPageIterator([]));
    mockAgentsRetrieve.mockResolvedValue({ pending_approval: null });
    mockAgentsMessagesList.mockReturnValue(mockPageIterator([]));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns false when no messages in conversation', async () => {
    mockConversationsMessagesList.mockReturnValue(mockPageIterator([]));

    const result = await recoverOrphanedConversationApproval('agent-1', 'conv-1');

    expect(result.recovered).toBe(false);
    expect(result.details).toBe('No messages in conversation');
  });

  it('skips non-recoverable conversation ids like default', async () => {
    const result = await recoverOrphanedConversationApproval('agent-1', 'default');

    expect(result.recovered).toBe(false);
    expect(result.details).toContain('Conversation is not recoverable: default');
    expect(mockConversationsMessagesList).not.toHaveBeenCalled();
  });

  it('returns false when no unresolved approval requests', async () => {
    mockConversationsMessagesList.mockReturnValue(mockPageIterator([
      { message_type: 'assistant_message', content: 'hello' },
    ]));

    const result = await recoverOrphanedConversationApproval('agent-1', 'conv-1');

    expect(result.recovered).toBe(false);
    expect(result.details).toBe('No unresolved approval requests found');
  });

  it('recovers from failed run with unresolved approval', async () => {
    mockConversationsMessagesList.mockReturnValue(mockPageIterator([
      {
        message_type: 'approval_request_message',
        tool_calls: [{ tool_call_id: 'tc-1', name: 'Bash' }],
        run_id: 'run-1',
        id: 'msg-1',
      },
    ]));
    mockRunsRetrieve.mockResolvedValue({ status: 'failed', stop_reason: 'error' });
    mockConversationsMessagesCreate.mockResolvedValue({});
    mockRunsList.mockReturnValue(mockPageIterator([{ id: 'run-denial-1' }]));
    mockAgentsMessagesCancel.mockResolvedValue(undefined);

    // Recovery has a 3s delay after denial; advance fake timers to resolve it
    const resultPromise = recoverOrphanedConversationApproval('agent-1', 'conv-1');
    await vi.advanceTimersByTimeAsync(3000);
    const result = await resultPromise;

    expect(result.recovered).toBe(true);
    expect(result.details).toContain('Denied 1 approval(s) from failed run run-1');
    expect(mockConversationsMessagesCreate).toHaveBeenCalledOnce();
    // Should only cancel runs active in this same conversation
    expect(mockAgentsMessagesCancel).toHaveBeenCalledOnce();
    expect(mockAgentsMessagesCancel).toHaveBeenCalledWith('agent-1', {
      run_ids: ['run-denial-1'],
    });
  });

  it('recovers from stuck running+requires_approval and cancels the run', async () => {
    mockConversationsMessagesList.mockReturnValue(mockPageIterator([
      {
        message_type: 'approval_request_message',
        tool_calls: [{ tool_call_id: 'tc-2', name: 'Grep' }],
        run_id: 'run-2',
        id: 'msg-2',
      },
    ]));
    mockRunsRetrieve.mockResolvedValue({ status: 'running', stop_reason: 'requires_approval' });
    mockConversationsMessagesCreate.mockResolvedValue({});
    mockRunsList.mockReturnValue(mockPageIterator([{ id: 'run-2' }]));
    mockAgentsMessagesCancel.mockResolvedValue(undefined);

    const resultPromise = recoverOrphanedConversationApproval('agent-1', 'conv-1');
    await vi.advanceTimersByTimeAsync(3000);
    const result = await resultPromise;

    expect(result.recovered).toBe(true);
    expect(result.details).toContain('(runs cancelled)');
    // Should send denial
    expect(mockConversationsMessagesCreate).toHaveBeenCalledOnce();
    const createCall = mockConversationsMessagesCreate.mock.calls[0];
    expect(createCall[0]).toBe('conv-1');
    const approvals = createCall[1].messages[0].approvals;
    expect(approvals[0].approve).toBe(false);
    expect(approvals[0].tool_call_id).toBe('tc-2');
    // Should cancel the stuck run
    expect(mockAgentsMessagesCancel).toHaveBeenCalledOnce();
    expect(mockAgentsMessagesCancel).toHaveBeenCalledWith('agent-1', {
      run_ids: ['run-2'],
    });
  });

  it('skips already-resolved approvals', async () => {
    mockConversationsMessagesList.mockReturnValue(mockPageIterator([
      {
        message_type: 'approval_request_message',
        tool_calls: [{ tool_call_id: 'tc-3', name: 'Read' }],
        run_id: 'run-3',
        id: 'msg-3',
      },
      {
        message_type: 'approval_response_message',
        approvals: [{ tool_call_id: 'tc-3' }],
      },
    ]));

    const result = await recoverOrphanedConversationApproval('agent-1', 'conv-1');

    expect(result.recovered).toBe(false);
    expect(result.details).toBe('No unresolved approval requests found');
    expect(mockRunsRetrieve).not.toHaveBeenCalled();
  });

  it('does not recover from healthy running run', async () => {
    mockConversationsMessagesList.mockReturnValue(mockPageIterator([
      {
        message_type: 'approval_request_message',
        tool_calls: [{ tool_call_id: 'tc-4', name: 'Bash' }],
        run_id: 'run-4',
        id: 'msg-4',
      },
    ]));
    // Running but NOT stuck on approval -- normal in-progress run
    mockRunsRetrieve.mockResolvedValue({ status: 'running', stop_reason: null });

    const result = await recoverOrphanedConversationApproval('agent-1', 'conv-1');

    expect(result.recovered).toBe(false);
    expect(result.details).toContain('not orphaned');
    expect(mockConversationsMessagesCreate).not.toHaveBeenCalled();
  });

  it('deduplicates identical tool_call_ids across multiple approval_request_messages', async () => {
    // Simulate the server returning the same tool_call_id in multiple
    // approval_request_messages (the root cause of #359).
    mockConversationsMessagesList.mockReturnValue(mockPageIterator([
      {
        message_type: 'approval_request_message',
        tool_calls: [{ tool_call_id: 'tc-dup', name: 'Bash' }],
        run_id: 'run-dup',
        id: 'msg-dup-1',
      },
      {
        message_type: 'approval_request_message',
        tool_calls: [{ tool_call_id: 'tc-dup', name: 'Bash' }],
        run_id: 'run-dup',
        id: 'msg-dup-2',
      },
      {
        message_type: 'approval_request_message',
        tool_calls: [{ tool_call_id: 'tc-dup', name: 'Bash' }],
        run_id: 'run-dup',
        id: 'msg-dup-3',
      },
    ]));
    mockRunsRetrieve.mockResolvedValue({ status: 'failed', stop_reason: 'error' });
    mockConversationsMessagesCreate.mockResolvedValue({});
    mockRunsList.mockReturnValue(mockPageIterator([]));

    const resultPromise = recoverOrphanedConversationApproval('agent-1', 'conv-1');
    await vi.advanceTimersByTimeAsync(3000);
    const result = await resultPromise;

    expect(result.recovered).toBe(true);
    // Should only send ONE denial despite three identical approval_request_messages
    expect(mockConversationsMessagesCreate).toHaveBeenCalledOnce();
    const approvals = mockConversationsMessagesCreate.mock.calls[0][1].messages[0].approvals;
    expect(approvals).toHaveLength(1);
    expect(approvals[0].tool_call_id).toBe('tc-dup');
  });

  it('batch-denies all parallel tool calls from the same run in a single request', async () => {
    mockConversationsMessagesList.mockReturnValue(mockPageIterator([
      {
        message_type: 'approval_request_message',
        tool_calls: [
          { tool_call_id: 'tc-a', name: 'Bash' },
          { tool_call_id: 'tc-b', name: 'Read' },
          { tool_call_id: 'tc-c', name: 'Grep' },
        ],
        run_id: 'run-parallel',
        id: 'msg-parallel',
      },
    ]));
    mockRunsRetrieve.mockResolvedValue({ status: 'failed', stop_reason: 'error' });
    mockConversationsMessagesCreate.mockResolvedValueOnce({});
    mockRunsList.mockReturnValue(mockPageIterator([]));

    const resultPromise = recoverOrphanedConversationApproval('agent-1', 'conv-1');
    await vi.advanceTimersByTimeAsync(10000);
    const result = await resultPromise;

    expect(result.recovered).toBe(true);
    expect(result.details).toContain('Denied 3 approval(s) from failed run run-parallel');
    // All 3 tool calls sent in a single API request
    expect(mockConversationsMessagesCreate).toHaveBeenCalledTimes(1);
    const approvals = mockConversationsMessagesCreate.mock.calls[0][1].messages[0].approvals;
    expect(approvals).toHaveLength(3);
    expect(approvals.map((a: any) => a.tool_call_id)).toEqual(['tc-a', 'tc-b', 'tc-c']);
  });

  it('continues recovery if batch denial fails for one run', async () => {
    // Two runs with approvals -- first batch denial fails, second should still succeed
    mockConversationsMessagesList.mockReturnValue(mockPageIterator([
      {
        message_type: 'approval_request_message',
        tool_calls: [{ tool_call_id: 'tc-fail', name: 'Bash' }],
        run_id: 'run-fail',
        id: 'msg-fail',
      },
      {
        message_type: 'approval_request_message',
        tool_calls: [{ tool_call_id: 'tc-ok', name: 'Read' }],
        run_id: 'run-ok',
        id: 'msg-ok',
      },
    ]));
    mockRunsRetrieve.mockResolvedValue({ status: 'failed', stop_reason: 'error' });
    mockConversationsMessagesCreate
      .mockRejectedValueOnce(new Error('400 BadRequestError'))
      .mockResolvedValueOnce({});
    mockRunsList.mockReturnValue(mockPageIterator([]));

    const resultPromise = recoverOrphanedConversationApproval('agent-1', 'conv-1');
    await vi.advanceTimersByTimeAsync(10000);
    const result = await resultPromise;

    // Second run still recovered despite first failing
    expect(result.recovered).toBe(true);
    expect(result.details).toContain('Failed to batch-deny');
    expect(result.details).toContain('Denied 1 approval(s) from failed run run-ok');
    expect(mockConversationsMessagesCreate).toHaveBeenCalledTimes(2);
  });

  it('reports cancel failure accurately', async () => {
    mockConversationsMessagesList.mockReturnValue(mockPageIterator([
      {
        message_type: 'approval_request_message',
        tool_calls: [{ tool_call_id: 'tc-5', name: 'Grep' }],
        run_id: 'run-5',
        id: 'msg-5',
      },
    ]));
    mockRunsRetrieve.mockResolvedValue({ status: 'running', stop_reason: 'requires_approval' });
    mockConversationsMessagesCreate.mockResolvedValue({});
    mockRunsList.mockReturnValue(mockPageIterator([{ id: 'run-5' }]));
    // Cancel fails
    mockAgentsMessagesCancel.mockRejectedValue(new Error('cancel failed'));

    const resultPromise = recoverOrphanedConversationApproval('agent-1', 'conv-1');
    await vi.advanceTimersByTimeAsync(3000);
    const result = await resultPromise;

    expect(result.recovered).toBe(true);
    // Cancel failure is logged but doesn't change the suffix anymore
    expect(result.details).toContain('Denied 1 approval(s) from running run run-5');
  });
});

describe('getLatestRunError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('scopes latest run lookup to conversation when provided', async () => {
    mockRunsList.mockReturnValue(mockPageIterator([
      {
        id: 'run-err-1',
        conversation_id: 'conv-1',
        stop_reason: 'error',
        metadata: { error: { detail: 'Another request is currently being processed (conflict)' } },
      },
    ]));

    const result = await getLatestRunError('agent-1', 'conv-1');

    expect(mockRunsList).toHaveBeenCalledWith({
      agent_id: 'agent-1',
      conversation_id: 'conv-1',
      limit: 1,
    });
    expect(result?.message).toContain('conflict');
    expect(result?.stopReason).toBe('error');
  });

  it('returns null when response is for a different conversation', async () => {
    mockRunsList.mockReturnValue(mockPageIterator([
      {
        id: 'run-other',
        conversation_id: 'conv-2',
        stop_reason: 'error',
        metadata: { error: { detail: 'waiting for approval' } },
      },
    ]));

    const result = await getLatestRunError('agent-1', 'conv-1');

    expect(result).toBeNull();
  });

  it('detects approval-stuck run via stop_reason when no metadata error', async () => {
    mockRunsList.mockReturnValue(mockPageIterator([
      {
        id: 'run-stuck',
        conversation_id: 'conv-1',
        status: 'created',
        stop_reason: 'requires_approval',
        metadata: {},
      },
    ]));

    const result = await getLatestRunError('agent-1', 'conv-1');

    expect(result).not.toBeNull();
    expect(result?.isApprovalError).toBe(true);
    expect(result?.message).toContain('stuck waiting for tool approval');
    expect(result?.stopReason).toBe('requires_approval');
  });

  it('returns null for created run with no stop_reason (not an approval issue)', async () => {
    mockRunsList.mockReturnValue(mockPageIterator([
      {
        id: 'run-limbo',
        conversation_id: 'conv-1',
        status: 'created',
        stop_reason: undefined,
        metadata: {},
      },
    ]));

    const result = await getLatestRunError('agent-1', 'conv-1');

    // A created run with no stop_reason could be legitimately new,
    // so we don't treat it as an approval issue.
    expect(result).toBeNull();
  });
});

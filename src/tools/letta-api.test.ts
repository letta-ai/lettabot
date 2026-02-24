import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Letta client before importing the module under test
const mockConversationsMessagesList = vi.fn();
const mockConversationsMessagesCreate = vi.fn();
const mockRunsRetrieve = vi.fn();
const mockAgentsMessagesCancel = vi.fn();
const mockAgentsRetrieve = vi.fn();

vi.mock('@letta-ai/letta-client', () => {
  return {
    Letta: class MockLetta {
      conversations = {
        messages: {
          list: mockConversationsMessagesList,
          create: mockConversationsMessagesCreate,
        },
      };
      runs = { retrieve: mockRunsRetrieve };
      agents = {
        retrieve: mockAgentsRetrieve,
        messages: { cancel: mockAgentsMessagesCancel },
      };
    },
  };
});

import { recoverOrphanedConversationApproval } from './letta-api.js';

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
    // Default: no pending approval on agent (Phase 1 finds nothing)
    mockAgentsRetrieve.mockResolvedValue({});
  });

  it('returns false when no messages in conversation', async () => {
    mockConversationsMessagesList.mockReturnValue(mockPageIterator([]));

    const result = await recoverOrphanedConversationApproval('agent-1', 'conv-1');

    expect(result.recovered).toBe(false);
    expect(result.details).toBe('No messages in conversation');
  });

  it('returns false when no unresolved approval requests', async () => {
    mockConversationsMessagesList.mockReturnValue(mockPageIterator([
      { message_type: 'assistant_message', content: 'hello' },
    ]));

    const result = await recoverOrphanedConversationApproval('agent-1', 'conv-1');

    expect(result.recovered).toBe(false);
    expect(result.details).toBe('No unresolved approval requests found');
  });

  it('recovers via Phase 1 (agent.pending_approval) when available', async () => {
    mockAgentsRetrieve.mockResolvedValue({
      pending_approval: {
        id: 'msg-pa',
        run_id: 'run-pa',
        tool_calls: [{ tool_call_id: 'tc-pa', name: 'Task' }],
      },
    });
    mockConversationsMessagesCreate.mockResolvedValue({});
    mockAgentsMessagesCancel.mockResolvedValue(undefined);

    const result = await recoverOrphanedConversationApproval('agent-1', 'conv-1');

    expect(result.recovered).toBe(true);
    expect(result.details).toContain('Phase 1');
    expect(result.details).toContain('agent.pending_approval');
    expect(mockConversationsMessagesCreate).toHaveBeenCalledOnce();
    // Should NOT need to scan messages (Phase 2)
    expect(mockConversationsMessagesList).not.toHaveBeenCalled();
  });

  it('handles Phase 1 catch-22 (denial rejected) by cancelling run', async () => {
    mockAgentsRetrieve.mockResolvedValue({
      pending_approval: {
        id: 'msg-pa',
        run_id: 'run-stuck',
        tool_calls: [{ tool_call_id: 'tc-stuck', name: 'Task' }],
      },
    });
    // Server rejects the denial (catch-22)
    mockConversationsMessagesCreate.mockRejectedValue(
      new Error('Cannot process approval response: No tool call is currently awaiting approval')
    );
    mockAgentsMessagesCancel.mockResolvedValue(undefined);

    const result = await recoverOrphanedConversationApproval('agent-1', 'conv-1');

    expect(result.recovered).toBe(true);
    expect(result.details).toContain('cancelled stuck run');
    expect(result.details).toContain('denial was rejected');
    expect(mockAgentsMessagesCancel).toHaveBeenCalledOnce();
  });

  it('falls through to Phase 2 when Phase 1 fails completely', async () => {
    // Phase 1 throws (e.g., network error)
    mockAgentsRetrieve.mockRejectedValue(new Error('network error'));
    // Phase 2 finds the orphaned approval
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

    const result = await recoverOrphanedConversationApproval('agent-1', 'conv-1');

    expect(result.recovered).toBe(true);
    expect(result.details).toContain('Denied 1 approval(s) from failed run run-1');
  });

  it('uses descending order when listing messages (Phase 2)', async () => {
    mockConversationsMessagesList.mockReturnValue(mockPageIterator([
      { message_type: 'assistant_message', content: 'hello' },
    ]));

    await recoverOrphanedConversationApproval('agent-1', 'conv-1');

    expect(mockConversationsMessagesList).toHaveBeenCalledWith('conv-1', {
      limit: 50,
      order: 'desc',
    });
  });

  it('recovers from failed run with unresolved approval (Phase 2)', async () => {
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

    const result = await recoverOrphanedConversationApproval('agent-1', 'conv-1');

    expect(result.recovered).toBe(true);
    expect(result.details).toContain('Denied 1 approval(s) from failed run run-1');
    expect(mockConversationsMessagesCreate).toHaveBeenCalled();
    // Should NOT cancel -- run is already terminated
    expect(mockAgentsMessagesCancel).not.toHaveBeenCalled();
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
    mockAgentsMessagesCancel.mockResolvedValue(undefined);

    const result = await recoverOrphanedConversationApproval('agent-1', 'conv-1');

    expect(result.recovered).toBe(true);
    expect(result.details).toContain('(cancelled)');
    // Should send denial
    expect(mockConversationsMessagesCreate).toHaveBeenCalled();
    const createCalls = mockConversationsMessagesCreate.mock.calls;
    // Find the Phase 2 call (may be second if Phase 1 also called it)
    const phase2Call = createCalls.find((c: unknown[]) => {
      const msg = (c[1] as { messages: Array<{ approvals?: Array<{ tool_call_id: string }> }> }).messages[0];
      return msg.approvals?.[0]?.tool_call_id === 'tc-2';
    });
    expect(phase2Call).toBeDefined();
    // Should cancel the stuck run
    expect(mockAgentsMessagesCancel).toHaveBeenCalled();
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
    // Should not have tried to create any approval messages
    // (Phase 1 may have called create if pending_approval was set, but Phase 2 should not)
    expect(mockConversationsMessagesCreate).not.toHaveBeenCalled();
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
    // Cancel fails
    mockAgentsMessagesCancel.mockRejectedValue(new Error('cancel failed'));

    const result = await recoverOrphanedConversationApproval('agent-1', 'conv-1');

    expect(result.recovered).toBe(true);
    expect(result.details).toContain('(cancel failed)');
  });

  it('handles Phase 2 catch-22 (denial rejected) by cancelling run', async () => {
    mockConversationsMessagesList.mockReturnValue(mockPageIterator([
      {
        message_type: 'approval_request_message',
        tool_calls: [{ tool_call_id: 'tc-6', name: 'Task' }],
        run_id: 'run-6',
        id: 'msg-6',
      },
    ]));
    mockRunsRetrieve.mockResolvedValue({ status: 'completed', stop_reason: 'requires_approval' });
    // Denial rejected (catch-22)
    mockConversationsMessagesCreate.mockRejectedValue(
      new Error('Cannot process approval response')
    );
    mockAgentsMessagesCancel.mockResolvedValue(undefined);

    const result = await recoverOrphanedConversationApproval('agent-1', 'conv-1');

    expect(result.recovered).toBe(true);
    expect(result.details).toContain('catch-22');
    expect(result.details).toContain('Cancelled run run-6');
  });
});

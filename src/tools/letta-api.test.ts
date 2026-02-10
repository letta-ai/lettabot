import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Letta client before importing the module under test
const mockConversationsMessagesList = vi.fn();
const mockConversationsMessagesCreate = vi.fn();
const mockRunsRetrieve = vi.fn();
const mockAgentsMessagesCancel = vi.fn();

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
      agents = { messages: { cancel: mockAgentsMessagesCancel } };
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

    const result = await recoverOrphanedConversationApproval('agent-1', 'conv-1');

    expect(result.recovered).toBe(true);
    expect(result.details).toContain('Denied 1 approval(s) from failed run run-1');
    expect(mockConversationsMessagesCreate).toHaveBeenCalledOnce();
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
    expect(mockConversationsMessagesCreate).toHaveBeenCalledOnce();
    const createCall = mockConversationsMessagesCreate.mock.calls[0];
    expect(createCall[0]).toBe('conv-1');
    const approvals = createCall[1].messages[0].approvals;
    expect(approvals[0].approve).toBe(false);
    expect(approvals[0].tool_call_id).toBe('tc-2');
    // Should cancel the stuck run
    expect(mockAgentsMessagesCancel).toHaveBeenCalledOnce();
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
});

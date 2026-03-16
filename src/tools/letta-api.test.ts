import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the Letta client before importing the module under test
const mockConversationsMessagesList = vi.fn();
const mockConversationsMessagesCreate = vi.fn();
const mockRunsRetrieve = vi.fn();
const mockRunsList = vi.fn();
const mockAgentsMessagesCancel = vi.fn();
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
          list: mockAgentsMessagesList,
        },
      };
    },
  };
});

import { getLatestRunError } from './letta-api.js';

// Helper to create a mock async iterable from an array (Letta client returns paginated iterators)
function mockPageIterator<T>(items: T[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const item of items) yield item;
    },
  };
}

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

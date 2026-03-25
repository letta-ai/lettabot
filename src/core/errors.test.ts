import { describe, expect, it } from 'vitest';
import {
  formatApiErrorForUser,
  isAgentMissingFromInitError,
  isApprovalConflictError,
  isConversationMissingError,
  isInvalidToolCallIdsError,
} from './errors.js';

describe('isApprovalConflictError', () => {
  it('returns true for approval conflict message and 409 status', () => {
    expect(isApprovalConflictError(new Error('Run is waiting for approval'))).toBe(true);
    expect(isApprovalConflictError({ status: 409 })).toBe(true);
  });

  it('returns false for non-conflict errors', () => {
    expect(isApprovalConflictError(new Error('network timeout'))).toBe(false);
  });
});

describe('isConversationMissingError', () => {
  it('returns true for missing conversation/agent message and 404 status', () => {
    expect(isConversationMissingError(new Error('conversation does not exist'))).toBe(true);
    expect(isConversationMissingError(new Error('agent not found'))).toBe(true);
    expect(isConversationMissingError({ status: 404 })).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isConversationMissingError(new Error('unauthorized'))).toBe(false);
  });
});

describe('isAgentMissingFromInitError', () => {
  it('matches known agent-missing patterns', () => {
    expect(isAgentMissingFromInitError(new Error('failed: unknown agent in config'))).toBe(true);
    expect(isAgentMissingFromInitError(new Error('stderr: agent_not_found'))).toBe(true);
    expect(isAgentMissingFromInitError(new Error('Agent abc was not found by server'))).toBe(true);
  });

  it('does not match generic init failures', () => {
    expect(isAgentMissingFromInitError(new Error('no init message received from subprocess'))).toBe(false);
    expect(isAgentMissingFromInitError({ status: 404 })).toBe(false);
  });
});

describe('isInvalidToolCallIdsError', () => {
  it('matches invalid tool call IDs details case-insensitively', () => {
    expect(isInvalidToolCallIdsError(
      "Failed to deny 1 approval(s) from run run-1: Invalid tool call IDs. Expected '['call_a']', but received '['call_b']'"
    )).toBe(true);
    expect(isInvalidToolCallIdsError('invalid tool call id mismatch')).toBe(true);
  });

  it('returns false for unrelated details', () => {
    expect(isInvalidToolCallIdsError('No unresolved approval requests found')).toBe(false);
    expect(isInvalidToolCallIdsError('Failed to check run run-1')).toBe(false);
  });
});

describe('formatApiErrorForUser', () => {
  it('maps out-of-credits messages', () => {
    const msg = formatApiErrorForUser({
      message: 'Request failed: out of credits',
      stopReason: 'error',
    });
    expect(msg).toContain('Out of credits');
  });

  it('maps premium usage exceeded rate limits', () => {
    const msg = formatApiErrorForUser({
      message: '429 rate limit',
      stopReason: 'error',
      apiError: { reasons: ['premium-usage-exceeded'] },
    });
    expect(msg).toContain('usage limit has been exceeded');
  });

  it('maps generic rate limits with reason details', () => {
    const msg = formatApiErrorForUser({
      message: '429 rate limit',
      stopReason: 'error',
      apiError: { reasons: ['burst', 'per-minute'] },
    });
    expect(msg).toBe('(Rate limited: burst, per-minute. Try again in a moment.)');
  });

  it('maps auth, not found, conflict, and server errors', () => {
    expect(formatApiErrorForUser({ message: '401 unauthorized', stopReason: 'error' }))
      .toContain('Authentication failed');
    expect(formatApiErrorForUser({ message: '404 not found', stopReason: 'error' }))
      .toContain('not found');
    expect(formatApiErrorForUser({ message: '409 conflict', stopReason: 'error' }))
      .toBeNull();
    expect(formatApiErrorForUser({ message: '503 internal server error', stopReason: 'error' }))
      .toContain('server error');
  });

  it('maps approval-specific 409 conflict to stuck-approval guidance', () => {
    const msg = formatApiErrorForUser({
      message: 'CONFLICT: Cannot send a new message: The agent is waiting for approval on a tool call.',
      stopReason: 'error',
    });
    expect(msg).toContain('stuck tool approval');
    expect(msg).toContain('/reset');
    // Should NOT match the generic conflict message
    expect(msg).not.toContain('Another request is still processing');
  });

  it('maps pending_approval variant to stuck-approval guidance', () => {
    const msg = formatApiErrorForUser({
      message: '409 pending_approval: run is waiting for approval',
      stopReason: 'error',
    });
    expect(msg).toContain('stuck tool approval');
  });

  it('maps requires_approval stop_reason enrichment message to stuck-approval guidance', () => {
    const msg = formatApiErrorForUser({
      message: 'Run run-stuck stuck waiting for tool approval (status=created)',
      stopReason: 'requires_approval',
    });
    expect(msg).toContain('stuck tool approval');
    expect(msg).toContain('/reset');
  });

  it('falls back to sanitized original message when no mapping matches', () => {
    const msg = formatApiErrorForUser({
      message: `${'x'.repeat(205)}.   `,
      stopReason: 'error',
    });
    const match = msg?.match(/^\(Agent error: (.+)\. Try sending your message again\.\)$/);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe('x'.repeat(200));
  });
});

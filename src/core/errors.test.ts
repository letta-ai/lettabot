import { describe, expect, it } from 'vitest';
import {
  formatApiErrorForUser,
  isAgentMissingFromInitError,
  isApprovalConflictError,
  isConversationMissingError,
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
      .toContain('Another request is still processing');
    expect(formatApiErrorForUser({ message: '503 internal server error', stopReason: 'error' }))
      .toContain('server error');
  });

  it('falls back to sanitized original message when no mapping matches', () => {
    const msg = formatApiErrorForUser({
      message: `${'x'.repeat(205)}.   `,
      stopReason: 'error',
    });
    const match = msg.match(/^\(Agent error: (.+)\. Try sending your message again\.\)$/);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe('x'.repeat(200));
  });
});

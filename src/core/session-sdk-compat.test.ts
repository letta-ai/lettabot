import { describe, it, expect, vi } from 'vitest';
import { recoverPendingApprovalsWithSdk } from './session-sdk-compat.js';
import type { Session } from '@letta-ai/letta-code-sdk';

describe('recoverPendingApprovalsWithSdk', () => {
  it('returns recovered:true when SDK method succeeds', async () => {
    const session = {
      recoverPendingApprovals: vi.fn(async () => ({ recovered: true, detail: 'denied 1' })),
    } as unknown as Session;

    const result = await recoverPendingApprovalsWithSdk(session, 5000);

    expect(result).toEqual({ recovered: true, detail: 'denied 1' });
    expect((session as any).recoverPendingApprovals).toHaveBeenCalledWith({ timeoutMs: 5000 });
  });

  it('returns recovered:false when SDK method is unavailable', async () => {
    const session = {} as unknown as Session;

    const result = await recoverPendingApprovalsWithSdk(session);

    expect(result.recovered).toBe(false);
    expect(result.detail).toContain('unavailable');
  });

  it('returns recovered:false when SDK method throws', async () => {
    const session = {
      recoverPendingApprovals: vi.fn(async () => { throw new Error('timeout exceeded'); }),
    } as unknown as Session;

    const result = await recoverPendingApprovalsWithSdk(session, 5000);

    expect(result.recovered).toBe(false);
    expect(result.detail).toBe('timeout exceeded');
  });

  it('passes default timeoutMs of 10000', async () => {
    const session = {
      recoverPendingApprovals: vi.fn(async () => ({ recovered: true })),
    } as unknown as Session;

    await recoverPendingApprovalsWithSdk(session);

    expect((session as any).recoverPendingApprovals).toHaveBeenCalledWith({ timeoutMs: 10_000 });
  });
});

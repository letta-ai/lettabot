import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { 
  computeBackoff, 
  createReconnectManager, 
  sleepWithAbort,
  DEFAULT_RECONNECT_POLICY,
  type BackoffPolicy,
  type ReconnectPolicy,
} from './backoff.js';

describe('computeBackoff', () => {
  const policy: BackoffPolicy = {
    initialMs: 1000,
    maxMs: 10000,
    factor: 2,
    jitter: 0, // No jitter for predictable tests
  };

  it('returns initialMs for first attempt', () => {
    const delay = computeBackoff(policy, 1);
    expect(delay).toBe(1000);
  });

  it('doubles delay for each attempt (factor=2)', () => {
    expect(computeBackoff(policy, 1)).toBe(1000);
    expect(computeBackoff(policy, 2)).toBe(2000);
    expect(computeBackoff(policy, 3)).toBe(4000);
    expect(computeBackoff(policy, 4)).toBe(8000);
  });

  it('caps at maxMs', () => {
    const delay = computeBackoff(policy, 10); // Would be 512000 without cap
    expect(delay).toBe(10000);
  });

  it('handles attempt 0 same as attempt 1', () => {
    expect(computeBackoff(policy, 0)).toBe(1000);
  });

  it('handles negative attempts', () => {
    expect(computeBackoff(policy, -1)).toBe(1000);
  });

  describe('with jitter', () => {
    const jitterPolicy: BackoffPolicy = {
      initialMs: 1000,
      maxMs: 10000,
      factor: 2,
      jitter: 0.25,
    };

    it('adds jitter within expected range', () => {
      // Run multiple times to check jitter range
      const delays = Array.from({ length: 100 }, () => computeBackoff(jitterPolicy, 1));
      
      // All delays should be between 1000 and 1250 (1000 + 25% jitter)
      delays.forEach(delay => {
        expect(delay).toBeGreaterThanOrEqual(1000);
        expect(delay).toBeLessThanOrEqual(1250);
      });

      // Should have some variation (not all same value)
      const uniqueDelays = new Set(delays);
      expect(uniqueDelays.size).toBeGreaterThan(1);
    });
  });

  describe('with DEFAULT_RECONNECT_POLICY', () => {
    it('starts at 2000ms', () => {
      // With jitter, first delay is 2000 + up to 25% jitter
      const delay = computeBackoff(DEFAULT_RECONNECT_POLICY, 1);
      expect(delay).toBeGreaterThanOrEqual(2000);
      expect(delay).toBeLessThanOrEqual(2500);
    });

    it('caps at 30000ms', () => {
      const delay = computeBackoff(DEFAULT_RECONNECT_POLICY, 20);
      expect(delay).toBeLessThanOrEqual(30000);
    });
  });
});

describe('createReconnectManager', () => {
  const policy: ReconnectPolicy = {
    initialMs: 1000,
    maxMs: 10000,
    factor: 2,
    jitter: 0,
    maxAttempts: 5,
  };

  it('starts with 0 attempts', () => {
    const manager = createReconnectManager(policy);
    expect(manager.getAttempts()).toBe(0);
  });

  it('increments attempt counter', () => {
    const manager = createReconnectManager(policy);
    expect(manager.increment()).toBe(1);
    expect(manager.increment()).toBe(2);
    expect(manager.getAttempts()).toBe(2);
  });

  it('resets attempt counter', () => {
    const manager = createReconnectManager(policy);
    manager.increment();
    manager.increment();
    manager.reset();
    expect(manager.getAttempts()).toBe(0);
  });

  it('detects exhausted attempts', () => {
    const manager = createReconnectManager(policy);
    expect(manager.isExhausted()).toBe(false);
    
    for (let i = 0; i < 5; i++) {
      manager.increment();
    }
    
    expect(manager.isExhausted()).toBe(true);
  });

  it('nextDelay increments and returns delay', () => {
    const manager = createReconnectManager(policy);
    
    const delay1 = manager.nextDelay();
    expect(manager.getAttempts()).toBe(1);
    expect(delay1).toBe(1000);

    const delay2 = manager.nextDelay();
    expect(manager.getAttempts()).toBe(2);
    expect(delay2).toBe(2000);
  });

  it('returns policy', () => {
    const manager = createReconnectManager(policy);
    expect(manager.getPolicy()).toBe(policy);
  });
});

describe('sleepWithAbort', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves after specified time', async () => {
    const promise = sleepWithAbort(1000);
    
    vi.advanceTimersByTime(999);
    // Promise should still be pending
    
    vi.advanceTimersByTime(1);
    await expect(promise).resolves.toBeUndefined();
  });

  it('rejects when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    
    await expect(sleepWithAbort(1000, controller.signal)).rejects.toThrow('Aborted');
  });

  it('rejects when signal is aborted during sleep', async () => {
    const controller = new AbortController();
    const promise = sleepWithAbort(5000, controller.signal);
    
    vi.advanceTimersByTime(1000);
    controller.abort();
    
    await expect(promise).rejects.toThrow('Aborted');
  });

  it('works without abort signal', async () => {
    const promise = sleepWithAbort(100);
    vi.advanceTimersByTime(100);
    await expect(promise).resolves.toBeUndefined();
  });
});

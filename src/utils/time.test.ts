import { describe, expect, it } from 'vitest';
import { sleep, sleepSync } from './time.js';

describe('sleep', () => {
  it('waits asynchronously', async () => {
    const start = Date.now();
    await sleep(10);
    expect(Date.now() - start).toBeGreaterThanOrEqual(8);
  });
});

describe('sleepSync', () => {
  it('does not throw for zero delay', () => {
    expect(() => sleepSync(0)).not.toThrow();
  });
});

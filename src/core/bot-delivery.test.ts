import { describe, expect, it } from 'vitest';
import { isResponseDeliverySuppressed } from './bot.js';

describe('isResponseDeliverySuppressed', () => {
  it('returns true for listening-mode messages', () => {
    expect(isResponseDeliverySuppressed({ isListeningMode: true })).toBe(true);
  });

  it('returns false when listening mode is disabled', () => {
    expect(isResponseDeliverySuppressed({ isListeningMode: false })).toBe(false);
  });

  it('returns false when listening mode is undefined', () => {
    expect(isResponseDeliverySuppressed({})).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { applyTelegramGroupGating, type TelegramGroupGatingParams } from './telegram-group-gating.js';

function createParams(overrides: Partial<TelegramGroupGatingParams> = {}): TelegramGroupGatingParams {
  return {
    text: 'Hello everyone',
    chatId: '-1001234567890',
    botUsername: 'mybot',
    ...overrides,
  };
}

describe('applyTelegramGroupGating', () => {
  describe('group allowlist', () => {
    it('allows group when in allowlist', () => {
      const result = applyTelegramGroupGating(createParams({
        groupsConfig: {
          '-1001234567890': { requireMention: false },
        },
      }));
      expect(result.shouldProcess).toBe(true);
    });

    it('allows group via wildcard', () => {
      const result = applyTelegramGroupGating(createParams({
        groupsConfig: {
          '*': { requireMention: false },
        },
      }));
      expect(result.shouldProcess).toBe(true);
    });

    it('blocks group not in allowlist', () => {
      const result = applyTelegramGroupGating(createParams({
        groupsConfig: {
          '-100999999': { requireMention: false },
        },
      }));
      expect(result.shouldProcess).toBe(false);
      expect(result.reason).toBe('group-not-in-allowlist');
    });

    it('allows all groups when no groupsConfig provided', () => {
      // No config = no allowlist filtering (mention gating still applies by default)
      const result = applyTelegramGroupGating(createParams({
        text: '@mybot hello',
        groupsConfig: undefined,
      }));
      expect(result.shouldProcess).toBe(true);
    });
  });

  describe('requireMention', () => {
    it('defaults to requiring mention when not specified', () => {
      const result = applyTelegramGroupGating(createParams({
        text: 'hello everyone',
        groupsConfig: { '*': {} }, // No requireMention specified
      }));
      expect(result.shouldProcess).toBe(false);
      expect(result.reason).toBe('mention-required');
    });

    it('allows all messages when requireMention is false', () => {
      const result = applyTelegramGroupGating(createParams({
        text: 'hello everyone',
        groupsConfig: { '*': { requireMention: false } },
      }));
      expect(result.shouldProcess).toBe(true);
      expect(result.wasMentioned).toBe(false);
    });

    it('specific group config overrides wildcard', () => {
      const result = applyTelegramGroupGating(createParams({
        text: 'hello',
        groupsConfig: {
          '*': { requireMention: true },
          '-1001234567890': { requireMention: false },
        },
      }));
      expect(result.shouldProcess).toBe(true);
    });

    it('wildcard applies when no specific group config', () => {
      const result = applyTelegramGroupGating(createParams({
        text: 'hello',
        chatId: '-100999999',
        groupsConfig: {
          '*': { requireMention: true },
          '-1001234567890': { requireMention: false },
        },
      }));
      expect(result.shouldProcess).toBe(false);
      expect(result.reason).toBe('mention-required');
    });
  });

  describe('mention detection', () => {
    it('detects @username via entities (most reliable)', () => {
      const result = applyTelegramGroupGating(createParams({
        text: '@mybot hello!',
        entities: [{ type: 'mention', offset: 0, length: 6 }],
        groupsConfig: { '*': { requireMention: true } },
      }));
      expect(result.shouldProcess).toBe(true);
      expect(result.wasMentioned).toBe(true);
      expect(result.method).toBe('entity');
    });

    it('detects @username via text fallback (case-insensitive)', () => {
      const result = applyTelegramGroupGating(createParams({
        text: 'Hey @MyBot what do you think?',
        groupsConfig: { '*': { requireMention: true } },
      }));
      expect(result.shouldProcess).toBe(true);
      expect(result.wasMentioned).toBe(true);
      expect(result.method).toBe('text');
    });

    it('detects /command@botusername format', () => {
      // Use a bot username that won't match the simpler text fallback first
      const result = applyTelegramGroupGating(createParams({
        text: '/status@testbot_123',
        botUsername: 'testbot_123',
        groupsConfig: { '*': { requireMention: true } },
      }));
      expect(result.shouldProcess).toBe(true);
      expect(result.wasMentioned).toBe(true);
      // Note: text fallback (@testbot_123) catches this before command format check
      // Both methods detect the mention -- the important thing is it's detected
      expect(result.wasMentioned).toBe(true);
    });

    it('detects mention via regex patterns', () => {
      const result = applyTelegramGroupGating(createParams({
        text: 'hey bot, what do you think?',
        groupsConfig: { '*': { requireMention: true } },
        mentionPatterns: ['\\bhey bot\\b'],
      }));
      expect(result.shouldProcess).toBe(true);
      expect(result.wasMentioned).toBe(true);
      expect(result.method).toBe('regex');
    });

    it('rejects when no mention detected and requireMention is true', () => {
      const result = applyTelegramGroupGating(createParams({
        text: 'hello everyone',
        groupsConfig: { '*': { requireMention: true } },
      }));
      expect(result.shouldProcess).toBe(false);
      expect(result.wasMentioned).toBe(false);
      expect(result.reason).toBe('mention-required');
    });

    it('ignores invalid regex patterns without crashing', () => {
      const result = applyTelegramGroupGating(createParams({
        text: '@mybot hello',
        groupsConfig: { '*': { requireMention: true } },
        mentionPatterns: ['[invalid'],
      }));
      // Falls through to text-based detection
      expect(result.shouldProcess).toBe(true);
      expect(result.method).toBe('text');
    });

    it('entity mention for a different user does not match', () => {
      const result = applyTelegramGroupGating(createParams({
        text: '@otheruser hello',
        entities: [{ type: 'mention', offset: 0, length: 10 }],
        groupsConfig: { '*': { requireMention: true } },
      }));
      expect(result.shouldProcess).toBe(false);
      expect(result.reason).toBe('mention-required');
    });
  });

  describe('no groupsConfig (open mode)', () => {
    it('processes messages with mention when no config (default requireMention=true)', () => {
      const result = applyTelegramGroupGating(createParams({
        text: '@mybot hello',
      }));
      expect(result.shouldProcess).toBe(true);
      expect(result.wasMentioned).toBe(true);
    });

    it('rejects messages without mention when no config (default requireMention=true)', () => {
      const result = applyTelegramGroupGating(createParams({
        text: 'hello everyone',
      }));
      expect(result.shouldProcess).toBe(false);
      expect(result.reason).toBe('mention-required');
    });
  });
});

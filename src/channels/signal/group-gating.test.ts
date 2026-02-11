import { describe, expect, it } from 'vitest';
import { applySignalGroupGating } from './group-gating.js';

describe('applySignalGroupGating', () => {
  const selfPhoneNumber = '+15551234567';
  const selfUuid = 'abc-123-uuid';

  describe('open mode (default)', () => {
    it('allows messages without mention', () => {
      const result = applySignalGroupGating({
        text: 'Hello everyone!',
        groupId: 'test-group',
        selfPhoneNumber,
      });

      expect(result.shouldProcess).toBe(true);
      expect(result.mode).toBe('open');
    });

    it('allows messages with native mention matching phone', () => {
      const result = applySignalGroupGating({
        text: 'Hey @bot',
        groupId: 'test-group',
        mentions: [{ number: '+15551234567', start: 4, length: 4 }],
        selfPhoneNumber,
      });

      expect(result.shouldProcess).toBe(true);
      expect(result.wasMentioned).toBe(true);
      expect(result.method).toBe('native');
    });

    it('allows messages with native mention matching UUID', () => {
      const result = applySignalGroupGating({
        text: 'Hey @bot',
        groupId: 'test-group',
        mentions: [{ uuid: selfUuid, start: 4, length: 4 }],
        selfPhoneNumber,
        selfUuid,
      });

      expect(result.shouldProcess).toBe(true);
      expect(result.method).toBe('native');
    });

    it('still allows when mentions exist for others', () => {
      const result = applySignalGroupGating({
        text: 'Hey @alice',
        groupId: 'test-group',
        mentions: [{ number: '+19998887777', start: 4, length: 6 }],
        selfPhoneNumber,
      });

      expect(result.shouldProcess).toBe(true);
      expect(result.wasMentioned).toBe(false);
    });

    it('allows messages matching regex pattern', () => {
      const result = applySignalGroupGating({
        text: '@lettabot what time is it?',
        groupId: 'test-group',
        selfPhoneNumber,
        mentionPatterns: ['@lettabot', '@bot'],
      });

      expect(result.shouldProcess).toBe(true);
      expect(result.method).toBe('regex');
    });

    it('allows replies to bot', () => {
      const result = applySignalGroupGating({
        text: 'Thanks for that!',
        groupId: 'test-group',
        quote: { author: '+15551234567', text: 'Previous message' },
        selfPhoneNumber,
      });

      expect(result.shouldProcess).toBe(true);
      expect(result.method).toBe('reply');
    });

    it('allows messages containing phone number (E.164 fallback)', () => {
      const result = applySignalGroupGating({
        text: 'Hey 15551234567 check this out',
        groupId: 'test-group',
        selfPhoneNumber,
      });

      expect(result.shouldProcess).toBe(true);
      expect(result.method).toBe('e164');
    });
  });

  describe('legacy requireMention mapping', () => {
    it('maps requireMention=false to open mode', () => {
      const result = applySignalGroupGating({
        text: 'Hello everyone!',
        groupId: 'test-group',
        selfPhoneNumber,
        groupsConfig: {
          'test-group': { requireMention: false },
        },
      });

      expect(result.shouldProcess).toBe(true);
      expect(result.mode).toBe('open');
      expect(result.wasMentioned).toBe(false);
    });

    it('maps wildcard requireMention=false to open mode', () => {
      const result = applySignalGroupGating({
        text: 'Hello everyone!',
        groupId: 'random-group',
        selfPhoneNumber,
        groupsConfig: {
          '*': { requireMention: false },
        },
      });

      expect(result.shouldProcess).toBe(true);
      expect(result.mode).toBe('open');
    });

    it('specific group config overrides wildcard', () => {
      const result = applySignalGroupGating({
        text: 'Hello everyone!',
        groupId: 'special-group',
        selfPhoneNumber,
        groupsConfig: {
          '*': { requireMention: false },
          'special-group': { requireMention: true },
        },
      });

      expect(result.shouldProcess).toBe(false);
      expect(result.reason).toBe('mention-required');
    });

    it('blocks all messages in disabled mode', () => {
      const result = applySignalGroupGating({
        text: 'Hello everyone!',
        groupId: 'test-group',
        selfPhoneNumber,
        mentions: [{ number: selfPhoneNumber, start: 0, length: 5 }],
        groupsConfig: {
          '*': { mode: 'disabled' },
        },
      });
      expect(result.shouldProcess).toBe(false);
      expect(result.mode).toBe('disabled');
      expect(result.reason).toBe('groups-disabled');
    });

    it('supports listen mode', () => {
      const result = applySignalGroupGating({
        text: 'Hello everyone!',
        groupId: 'special-group',
        selfPhoneNumber,
        groupsConfig: {
          'special-group': { mode: 'listen' },
        },
      });

      expect(result.shouldProcess).toBe(true);
      expect(result.mode).toBe('listen');
      expect(result.wasMentioned).toBe(false);
    });
  });

  describe('per-group allowedUsers', () => {
    it('allows user in the allowedUsers list', () => {
      const result = applySignalGroupGating({
        text: 'Hello',
        groupId: 'test-group',
        senderId: '+19876543210',
        selfPhoneNumber,
        groupsConfig: {
          '*': { mode: 'open', allowedUsers: ['+19876543210'] },
        },
      });
      expect(result.shouldProcess).toBe(true);
    });

    it('blocks user not in the allowedUsers list', () => {
      const result = applySignalGroupGating({
        text: 'Hello',
        groupId: 'test-group',
        senderId: '+10000000000',
        selfPhoneNumber,
        groupsConfig: {
          '*': { mode: 'open', allowedUsers: ['+19876543210'] },
        },
      });
      expect(result.shouldProcess).toBe(false);
      expect(result.reason).toBe('user-not-allowed');
    });

    it('allows all users when no allowedUsers configured', () => {
      const result = applySignalGroupGating({
        text: 'Hello',
        groupId: 'test-group',
        senderId: '+10000000000',
        selfPhoneNumber,
        groupsConfig: {
          '*': { mode: 'open' },
        },
      });
      expect(result.shouldProcess).toBe(true);
    });

    it('skips user check when senderId is undefined', () => {
      const result = applySignalGroupGating({
        text: 'Hello',
        groupId: 'test-group',
        selfPhoneNumber,
        groupsConfig: {
          '*': { mode: 'open', allowedUsers: ['+19876543210'] },
        },
      });
      expect(result.shouldProcess).toBe(true);
    });
  });

  describe('group allowlist', () => {
    it('filters messages from groups not in allowlist', () => {
      const result = applySignalGroupGating({
        text: '@bot hello',
        groupId: 'unknown-group',
        selfPhoneNumber,
        groupsConfig: {
          'allowed-group': { requireMention: true },
        },
        mentionPatterns: ['@bot'],
      });

      expect(result.shouldProcess).toBe(false);
      expect(result.reason).toBe('group-not-in-allowlist');
    });

    it('allows messages from groups in allowlist', () => {
      const result = applySignalGroupGating({
        text: '@bot hello',
        groupId: 'allowed-group',
        selfPhoneNumber,
        groupsConfig: {
          'allowed-group': { requireMention: true },
        },
        mentionPatterns: ['@bot'],
      });

      expect(result.shouldProcess).toBe(true);
    });

    it('wildcard allows all groups', () => {
      const result = applySignalGroupGating({
        text: '@bot hello',
        groupId: 'any-group',
        selfPhoneNumber,
        groupsConfig: {
          '*': { requireMention: true },
        },
        mentionPatterns: ['@bot'],
      });

      expect(result.shouldProcess).toBe(true);
    });
  });
});

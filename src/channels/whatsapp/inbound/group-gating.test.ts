import { describe, expect, it } from 'vitest';
import { applyGroupGating, type GroupGatingParams } from './group-gating.js';
import type { WebInboundMessage } from './types.js';

// Helper to create base message
function createMessage(overrides: Partial<WebInboundMessage> = {}): WebInboundMessage {
  return {
    id: 'msg123',
    from: '+19876543210',
    to: '+15551234567',
    chatId: '120363123456@g.us',
    body: 'Hello group',
    timestamp: new Date(),
    chatType: 'group',
    selfJid: '15551234567@s.whatsapp.net',
    selfE164: '+15551234567',
    ...overrides,
  };
}

// Base params for tests
function createParams(overrides: Partial<GroupGatingParams> = {}): GroupGatingParams {
  const { msg: msgOverrides, ...restOverrides } = overrides;
  return {
    msg: createMessage(msgOverrides as Partial<WebInboundMessage> | undefined),
    groupJid: '120363123456@g.us',
    selfJid: '15551234567@s.whatsapp.net',
    selfLid: null,
    selfE164: '+15551234567',
    mentionPatterns: ['@?bot'],
    ...restOverrides,
  };
}

describe('applyGroupGating', () => {
  describe('group allowlist', () => {
    it('allows group when in allowlist', () => {
      const result = applyGroupGating(createParams({
        groupsConfig: {
          '120363123456@g.us': { requireMention: false },
        },
      }));

      expect(result.shouldProcess).toBe(true);
    });

    it('allows group when wildcard is in allowlist', () => {
      const result = applyGroupGating(createParams({
        groupsConfig: {
          '*': { requireMention: false },
        },
      }));

      expect(result.shouldProcess).toBe(true);
    });

    it('blocks group when not in allowlist (and allowlist exists)', () => {
      const result = applyGroupGating(createParams({
        groupsConfig: {
          'other-group@g.us': { requireMention: true },
        },
      }));

      expect(result.shouldProcess).toBe(false);
      expect(result.reason).toBe('group-not-in-allowlist');
    });

    it('allows group when no allowlist configured', () => {
      const result = applyGroupGating(createParams({
        groupsConfig: undefined,
        msg: createMessage({
          mentionedJids: ['15551234567@s.whatsapp.net'],
        }),
      }));

      // No allowlist = allowed (open mode)
      expect(result.shouldProcess).toBe(true);
    });
  });

  describe('per-group allowedUsers', () => {
    it('allows sender in the allowedUsers list', () => {
      const result = applyGroupGating(createParams({
        senderId: '+19876543210',
        groupsConfig: {
          '*': { mode: 'open', allowedUsers: ['+19876543210'] },
        },
      }));
      expect(result.shouldProcess).toBe(true);
    });

    it('blocks sender not in the allowedUsers list', () => {
      const result = applyGroupGating(createParams({
        senderId: '+10000000000',
        groupsConfig: {
          '*': { mode: 'open', allowedUsers: ['+19876543210'] },
        },
      }));
      expect(result.shouldProcess).toBe(false);
      expect(result.reason).toBe('user-not-allowed');
    });

    it('allows all senders when no allowedUsers configured', () => {
      const result = applyGroupGating(createParams({
        senderId: '+10000000000',
        groupsConfig: {
          '*': { mode: 'open' },
        },
      }));
      expect(result.shouldProcess).toBe(true);
    });

    it('uses specific group allowedUsers over wildcard', () => {
      const result = applyGroupGating(createParams({
        senderId: 'vip-user',
        groupsConfig: {
          '*': { mode: 'open', allowedUsers: ['owner'] },
          '120363123456@g.us': { mode: 'open', allowedUsers: ['vip-user'] },
        },
      }));
      expect(result.shouldProcess).toBe(true);
    });

    it('skips user check when senderId is undefined', () => {
      const result = applyGroupGating(createParams({
        senderId: undefined,
        groupsConfig: {
          '*': { mode: 'open', allowedUsers: ['someone'] },
        },
      }));
      expect(result.shouldProcess).toBe(true);
    });
  });

  describe('mode resolution', () => {
    it('allows when mentioned and requireMention=true', () => {
      const result = applyGroupGating(createParams({
        groupsConfig: { '*': { requireMention: true } },
        msg: createMessage({
          body: '@bot hello',
          mentionedJids: ['15551234567@s.whatsapp.net'],
        }),
      }));

      expect(result.shouldProcess).toBe(true);
      expect(result.wasMentioned).toBe(true);
    });

    it('blocks when not mentioned and requireMention=true', () => {
      const result = applyGroupGating(createParams({
        groupsConfig: { '*': { requireMention: true } },
        msg: createMessage({
          body: 'hello everyone',
        }),
      }));

      expect(result.shouldProcess).toBe(false);
      expect(result.wasMentioned).toBe(false);
      expect(result.reason).toBe('mention-required');
    });

    it('allows without mention when requireMention=false', () => {
      const result = applyGroupGating(createParams({
        groupsConfig: { '*': { requireMention: false } },
        msg: createMessage({
          body: 'hello everyone',
        }),
      }));

      expect(result.shouldProcess).toBe(true);
      expect(result.wasMentioned).toBe(false);
    });

    it('defaults to mention-only when group entry has no mode', () => {
      const result = applyGroupGating(createParams({
        groupsConfig: { '*': {} }, // No requireMention specified
        msg: createMessage({
          body: 'hello everyone',
        }),
      }));

      expect(result.shouldProcess).toBe(false);
      expect(result.mode).toBe('mention-only');
      expect(result.reason).toBe('mention-required');
    });

    it('blocks all messages in disabled mode', () => {
      const result = applyGroupGating(createParams({
        groupsConfig: { '*': { mode: 'disabled' } },
        msg: createMessage({
          body: '@bot hello',
          mentionedJids: ['15551234567@s.whatsapp.net'],
        }),
      }));
      expect(result.shouldProcess).toBe(false);
      expect(result.mode).toBe('disabled');
      expect(result.reason).toBe('groups-disabled');
    });

    it('supports listen mode', () => {
      const result = applyGroupGating(createParams({
        groupsConfig: { '*': { mode: 'listen' } },
        msg: createMessage({
          body: 'hello everyone',
        }),
      }));

      expect(result.shouldProcess).toBe(true);
      expect(result.mode).toBe('listen');
      expect(result.wasMentioned).toBe(false);
    });
  });

  describe('config priority', () => {
    it('uses specific group config over wildcard', () => {
      const result = applyGroupGating(createParams({
        groupsConfig: {
          '*': { requireMention: true },
          '120363123456@g.us': { requireMention: false }, // Specific override
        },
        msg: createMessage({
          body: 'hello', // No mention
        }),
      }));

      expect(result.shouldProcess).toBe(true); // Uses specific config
    });

    it('falls back to wildcard when no specific config', () => {
      const result = applyGroupGating(createParams({
        groupsConfig: {
          '*': { requireMention: false },
          'other-group@g.us': { requireMention: true },
        },
        msg: createMessage({
          body: 'hello',
        }),
      }));

      expect(result.shouldProcess).toBe(true); // Uses wildcard
    });
  });

  describe('mention detection methods', () => {
    it('detects regex pattern mention', () => {
      const result = applyGroupGating(createParams({
        groupsConfig: { '*': { requireMention: true } },
        mentionPatterns: ['@?bot'],
        msg: createMessage({
          body: '@bot help me',
        }),
      }));

      expect(result.shouldProcess).toBe(true);
      expect(result.wasMentioned).toBe(true);
    });

    it('detects reply-to-bot as implicit mention', () => {
      const result = applyGroupGating(createParams({
        groupsConfig: { '*': { requireMention: true } },
        mentionPatterns: [],
        msg: createMessage({
          body: 'thanks',
          replyContext: {
            senderJid: '15551234567@s.whatsapp.net',
          },
        }),
      }));

      expect(result.shouldProcess).toBe(true);
      expect(result.wasMentioned).toBe(true);
    });
  });
});

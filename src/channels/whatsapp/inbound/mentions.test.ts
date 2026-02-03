import { describe, expect, it } from 'vitest';
import { detectMention, type MentionConfig } from './mentions.js';

const baseConfig: MentionConfig = {
  mentionPatterns: ['@?bot', '@?lettabot'],
  selfE164: '+15551234567',
  selfJid: '15551234567@s.whatsapp.net',
  selfLid: '214542927831175@lid',
};

describe('detectMention', () => {
  describe('native @mentions (mentionedJids)', () => {
    it('detects mention when selfJid is in mentionedJids', () => {
      const result = detectMention({
        body: '@15551234567 hello',
        mentionedJids: ['15551234567@s.whatsapp.net'],
        config: baseConfig,
      });

      expect(result.wasMentioned).toBe(true);
      expect(result.implicitMention).toBe(false);
      expect(result.method).toBe('jid');
    });

    it('detects mention when selfLid is in mentionedJids', () => {
      const result = detectMention({
        body: '@bot hello',
        mentionedJids: ['214542927831175@lid'],
        config: baseConfig,
      });

      expect(result.wasMentioned).toBe(true);
      expect(result.method).toBe('jid');
    });

    it('normalizes JID with device suffix', () => {
      const result = detectMention({
        body: '@bot hello',
        mentionedJids: ['15551234567:25@s.whatsapp.net'], // With device suffix
        config: baseConfig,
      });

      expect(result.wasMentioned).toBe(true);
      expect(result.method).toBe('jid');
    });

    it('returns false when other users mentioned (not bot)', () => {
      const result = detectMention({
        body: '@john hello',
        mentionedJids: ['9876543210@s.whatsapp.net'], // Different user
        config: baseConfig,
      });

      expect(result.wasMentioned).toBe(false);
    });
  });

  describe('regex pattern matching', () => {
    it('matches @bot pattern', () => {
      const result = detectMention({
        body: '@bot what time is it?',
        config: baseConfig,
      });

      expect(result.wasMentioned).toBe(true);
      expect(result.method).toBe('regex');
    });

    it('matches bot without @ (pattern: @?bot)', () => {
      const result = detectMention({
        body: 'hey bot, help me',
        config: baseConfig,
      });

      expect(result.wasMentioned).toBe(true);
      expect(result.method).toBe('regex');
    });

    it('matches case insensitively', () => {
      const result = detectMention({
        body: '@BOT hello',
        config: baseConfig,
      });

      expect(result.wasMentioned).toBe(true);
      expect(result.method).toBe('regex');
    });

    it('matches @lettabot pattern', () => {
      const result = detectMention({
        body: '@lettabot help',
        config: baseConfig,
      });

      expect(result.wasMentioned).toBe(true);
      expect(result.method).toBe('regex');
    });

    it('handles invalid regex pattern gracefully', () => {
      const result = detectMention({
        body: 'hello world',
        config: {
          ...baseConfig,
          mentionPatterns: ['[invalid(regex'],
        },
      });

      // Should not crash, just return no mention
      expect(result.wasMentioned).toBe(false);
    });
  });

  describe('E.164 phone number fallback', () => {
    it('detects bot phone number in message', () => {
      const result = detectMention({
        body: 'call 15551234567 for help',
        config: {
          ...baseConfig,
          mentionPatterns: [], // No regex patterns
        },
      });

      expect(result.wasMentioned).toBe(true);
      expect(result.method).toBe('e164');
    });

    it('ignores partial phone matches', () => {
      const result = detectMention({
        body: 'call 555123 for help', // Partial match
        config: {
          ...baseConfig,
          mentionPatterns: [],
        },
      });

      expect(result.wasMentioned).toBe(false);
    });
  });

  describe('implicit mention (reply to bot)', () => {
    it('detects reply to bot via JID', () => {
      const result = detectMention({
        body: 'thanks for that',
        replyToSenderJid: '15551234567@s.whatsapp.net',
        config: {
          ...baseConfig,
          mentionPatterns: [],
        },
      });

      expect(result.wasMentioned).toBe(true);
      expect(result.implicitMention).toBe(true);
      expect(result.method).toBe('reply');
    });

    it('detects reply to bot via LID', () => {
      const result = detectMention({
        body: 'thanks',
        replyToSenderJid: '214542927831175@lid',
        config: {
          ...baseConfig,
          mentionPatterns: [],
        },
      });

      expect(result.wasMentioned).toBe(true);
      expect(result.implicitMention).toBe(true);
      expect(result.method).toBe('reply');
    });

    it('detects reply to bot via E.164', () => {
      const result = detectMention({
        body: 'thanks',
        replyToSenderE164: '+15551234567',
        config: {
          ...baseConfig,
          mentionPatterns: [],
        },
      });

      expect(result.wasMentioned).toBe(true);
      expect(result.implicitMention).toBe(true);
      expect(result.method).toBe('reply');
    });
  });

  describe('no mention', () => {
    it('returns false when no mention detected', () => {
      const result = detectMention({
        body: 'hello everyone',
        config: {
          ...baseConfig,
          mentionPatterns: [],
          selfE164: null,
        },
      });

      expect(result.wasMentioned).toBe(false);
      expect(result.implicitMention).toBe(false);
      expect(result.method).toBeUndefined();
    });
  });
});

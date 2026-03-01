import { describe, it, expect } from 'vitest';
import { redactOutbound } from './redact.js';

describe('redactOutbound', () => {
  describe('secret patterns (default: enabled)', () => {
    it('redacts OpenAI-style API keys', () => {
      expect(redactOutbound('My key is sk-abc123def456ghi789jkl012mno345')).toContain('[REDACTED]');
      expect(redactOutbound('My key is sk-abc123def456ghi789jkl012mno345')).not.toContain('sk-');
    });

    it('redacts GitHub tokens', () => {
      expect(redactOutbound('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl')).toContain('[REDACTED]');
      expect(redactOutbound('ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl')).toContain('[REDACTED]');
      expect(redactOutbound('github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZab')).toContain('[REDACTED]');
    });

    it('redacts Slack tokens', () => {
      expect(redactOutbound('Token: xoxb-123456789-abcdefghij')).toContain('[REDACTED]');
      expect(redactOutbound('xoxp-999-888-777-abcdef')).toContain('[REDACTED]');
    });

    it('redacts AWS access keys', () => {
      expect(redactOutbound('AKIAIOSFODNN7EXAMPLE')).toContain('[REDACTED]');
    });

    it('redacts bearer tokens', () => {
      expect(redactOutbound('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')).toContain('[REDACTED]');
      expect(redactOutbound('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')).not.toContain('eyJ');
    });

    it('redacts URLs with embedded credentials', () => {
      const url = 'https://admin:s3cretP4ss@database.example.com:5432/mydb';
      expect(redactOutbound(url)).toContain('[REDACTED]');
      expect(redactOutbound(url)).not.toContain('s3cretP4ss');
    });

    it('redacts key=value patterns near sensitive keywords', () => {
      expect(redactOutbound('api_key=abcdef1234567890abcdef1234567890')).toContain('[REDACTED]');
      expect(redactOutbound('token: "aBcDeFgHiJkLmNoPqRsTuVwXyZ012345"')).toContain('[REDACTED]');
      expect(redactOutbound('secret = AAAAABBBBBCCCCCDDDDDEEEEEFFFFF00')).toContain('[REDACTED]');
    });

    it('leaves normal text untouched', () => {
      const text = 'Hello! How are you doing today? The weather is nice.';
      expect(redactOutbound(text)).toBe(text);
    });

    it('leaves short tokens and common words alone', () => {
      const text = 'The key to success is perseverance.';
      expect(redactOutbound(text)).toBe(text);
    });

    it('handles empty and null-ish input', () => {
      expect(redactOutbound('')).toBe('');
      expect(redactOutbound(undefined as unknown as string)).toBe(undefined);
    });
  });

  describe('PII patterns (default: disabled)', () => {
    it('does not redact emails by default', () => {
      expect(redactOutbound('Contact me at user@example.com')).toContain('user@example.com');
    });

    it('redacts emails when PII enabled', () => {
      expect(redactOutbound('Contact me at user@example.com', { pii: true })).not.toContain('user@example.com');
      expect(redactOutbound('Contact me at user@example.com', { pii: true })).toContain('[REDACTED]');
    });

    it('redacts phone numbers when PII enabled', () => {
      expect(redactOutbound('Call me at 555-123-4567', { pii: true })).toContain('[REDACTED]');
      expect(redactOutbound('Call me at (555) 123-4567', { pii: true })).toContain('[REDACTED]');
      expect(redactOutbound('Call me at +1 555 123 4567', { pii: true })).toContain('[REDACTED]');
    });
  });

  describe('config behavior', () => {
    it('secrets enabled by default (no config)', () => {
      expect(redactOutbound('sk-abc123def456ghi789jkl012mno345')).toContain('[REDACTED]');
    });

    it('secrets can be explicitly disabled', () => {
      const text = 'sk-abc123def456ghi789jkl012mno345';
      expect(redactOutbound(text, { secrets: false })).toBe(text);
    });

    it('both layers work together', () => {
      const text = 'Key: sk-abc123def456ghi789jkl012mno345 and email: user@example.com';
      const result = redactOutbound(text, { secrets: true, pii: true });
      expect(result).not.toContain('sk-');
      expect(result).not.toContain('user@example.com');
    });
  });

  describe('multiple matches in one message', () => {
    it('redacts all occurrences', () => {
      const text = 'Keys: sk-aaabbbcccdddeeefffggghhhiiijjjkkk and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl';
      const result = redactOutbound(text);
      expect(result).not.toContain('sk-');
      expect(result).not.toContain('ghp_');
      expect(result.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(2);
    });
  });
});

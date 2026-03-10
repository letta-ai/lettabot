import { beforeEach, describe, expect, it } from 'vitest';
import { isGroupAllowed, isGroupUserAllowed, resolveGroupAllowedUsers, resolveGroupMode, resolveReceiveBotMessages, resolveDailyLimits, checkDailyLimit, resetDailyLimitCounters, type GroupsConfig } from './group-mode.js';

describe('group-mode helpers', () => {
  describe('isGroupAllowed', () => {
    it('rejects when groups config is missing (no config = no groups)', () => {
      expect(isGroupAllowed(undefined, ['group-1'])).toBe(false);
    });

    it('rejects when groups config is empty (explicit empty allowlist)', () => {
      expect(isGroupAllowed({}, ['group-1'])).toBe(false);
    });

    it('allows via wildcard', () => {
      const groups: GroupsConfig = { '*': { mode: 'mention-only' } };
      expect(isGroupAllowed(groups, ['group-1'])).toBe(true);
    });

    it('allows when any provided key matches', () => {
      const groups: GroupsConfig = { 'server-1': { mode: 'open' } };
      expect(isGroupAllowed(groups, ['chat-1', 'server-1'])).toBe(true);
    });

    it('rejects when no keys match and no wildcard', () => {
      const groups: GroupsConfig = { 'group-2': { mode: 'open' } };
      expect(isGroupAllowed(groups, ['group-1'])).toBe(false);
    });
  });

  describe('resolveGroupMode', () => {
    it('returns fallback when groups config is missing', () => {
      expect(resolveGroupMode(undefined, ['group-1'], 'open')).toBe('open');
    });

    it('uses specific key before wildcard', () => {
      const groups: GroupsConfig = {
        '*': { mode: 'mention-only' },
        'group-1': { mode: 'open' },
      };
      expect(resolveGroupMode(groups, ['group-1'], 'open')).toBe('open');
    });

    it('uses wildcard when no specific key matches', () => {
      const groups: GroupsConfig = { '*': { mode: 'listen' } };
      expect(resolveGroupMode(groups, ['group-1'], 'open')).toBe('listen');
    });

    it('resolves disabled mode', () => {
      const groups: GroupsConfig = { '*': { mode: 'disabled' } };
      expect(resolveGroupMode(groups, ['group-1'], 'open')).toBe('disabled');
    });

    it('maps legacy requireMention=true to mention-only', () => {
      const groups: GroupsConfig = { 'group-1': { requireMention: true } };
      expect(resolveGroupMode(groups, ['group-1'], 'open')).toBe('mention-only');
    });

    it('maps legacy requireMention=false to open', () => {
      const groups: GroupsConfig = { 'group-1': { requireMention: false } };
      expect(resolveGroupMode(groups, ['group-1'], 'mention-only')).toBe('open');
    });

    it('defaults to mention-only for explicit empty group entries', () => {
      const groups: GroupsConfig = { 'group-1': {} };
      expect(resolveGroupMode(groups, ['group-1'], 'open')).toBe('mention-only');
    });

    it('defaults to mention-only for wildcard empty entry', () => {
      const groups: GroupsConfig = { '*': {} };
      expect(resolveGroupMode(groups, ['group-1'], 'open')).toBe('mention-only');
    });

    it('uses first matching key in priority order', () => {
      const groups: GroupsConfig = {
        'chat-1': { mode: 'listen' },
        'server-1': { mode: 'open' },
      };
      expect(resolveGroupMode(groups, ['chat-1', 'server-1'], 'mention-only')).toBe('listen');
      expect(resolveGroupMode(groups, ['chat-2', 'server-1'], 'mention-only')).toBe('open');
    });
  });

  describe('resolveGroupAllowedUsers', () => {
    it('returns undefined when groups config is missing', () => {
      expect(resolveGroupAllowedUsers(undefined, ['group-1'])).toBeUndefined();
    });

    it('returns undefined when no allowedUsers configured', () => {
      const groups: GroupsConfig = { 'group-1': { mode: 'open' } };
      expect(resolveGroupAllowedUsers(groups, ['group-1'])).toBeUndefined();
    });

    it('returns allowedUsers from specific key', () => {
      const groups: GroupsConfig = {
        'group-1': { mode: 'open', allowedUsers: ['user-a', 'user-b'] },
      };
      expect(resolveGroupAllowedUsers(groups, ['group-1'])).toEqual(['user-a', 'user-b']);
    });

    it('returns allowedUsers from wildcard', () => {
      const groups: GroupsConfig = {
        '*': { mode: 'mention-only', allowedUsers: ['user-a'] },
      };
      expect(resolveGroupAllowedUsers(groups, ['group-1'])).toEqual(['user-a']);
    });

    it('prefers specific key over wildcard', () => {
      const groups: GroupsConfig = {
        '*': { mode: 'mention-only', allowedUsers: ['wildcard-user'] },
        'group-1': { mode: 'open', allowedUsers: ['specific-user'] },
      };
      expect(resolveGroupAllowedUsers(groups, ['group-1'])).toEqual(['specific-user']);
    });

    it('uses first matching key in priority order', () => {
      const groups: GroupsConfig = {
        'chat-1': { mode: 'open', allowedUsers: ['chat-user'] },
        'server-1': { mode: 'open', allowedUsers: ['server-user'] },
      };
      expect(resolveGroupAllowedUsers(groups, ['chat-1', 'server-1'])).toEqual(['chat-user']);
      expect(resolveGroupAllowedUsers(groups, ['chat-2', 'server-1'])).toEqual(['server-user']);
    });
  });

  describe('resolveReceiveBotMessages', () => {
    it('returns false when groups config is missing', () => {
      expect(resolveReceiveBotMessages(undefined, ['group-1'])).toBe(false);
    });

    it('returns false when receiveBotMessages is not configured', () => {
      const groups: GroupsConfig = { 'group-1': { mode: 'listen' } };
      expect(resolveReceiveBotMessages(groups, ['group-1'])).toBe(false);
    });

    it('returns true when receiveBotMessages is enabled on specific key', () => {
      const groups: GroupsConfig = {
        'group-1': { mode: 'listen', receiveBotMessages: true },
      };
      expect(resolveReceiveBotMessages(groups, ['group-1'])).toBe(true);
    });

    it('returns false when receiveBotMessages is explicitly disabled', () => {
      const groups: GroupsConfig = {
        'group-1': { mode: 'listen', receiveBotMessages: false },
      };
      expect(resolveReceiveBotMessages(groups, ['group-1'])).toBe(false);
    });

    it('uses wildcard as fallback', () => {
      const groups: GroupsConfig = {
        '*': { mode: 'listen', receiveBotMessages: true },
      };
      expect(resolveReceiveBotMessages(groups, ['group-1'])).toBe(true);
    });

    it('prefers specific key over wildcard', () => {
      const groups: GroupsConfig = {
        '*': { mode: 'listen', receiveBotMessages: true },
        'group-1': { mode: 'listen', receiveBotMessages: false },
      };
      expect(resolveReceiveBotMessages(groups, ['group-1'])).toBe(false);
    });

    it('uses first matching key in priority order', () => {
      const groups: GroupsConfig = {
        'chat-1': { mode: 'listen', receiveBotMessages: true },
        'server-1': { mode: 'listen', receiveBotMessages: false },
      };
      expect(resolveReceiveBotMessages(groups, ['chat-1', 'server-1'])).toBe(true);
      expect(resolveReceiveBotMessages(groups, ['chat-2', 'server-1'])).toBe(false);
    });
  });

  describe('isGroupUserAllowed', () => {
    it('allows all users when no groups config', () => {
      expect(isGroupUserAllowed(undefined, ['group-1'], 'any-user')).toBe(true);
    });

    it('allows all users when no allowedUsers configured', () => {
      const groups: GroupsConfig = { 'group-1': { mode: 'open' } };
      expect(isGroupUserAllowed(groups, ['group-1'], 'any-user')).toBe(true);
    });

    it('allows user in the list', () => {
      const groups: GroupsConfig = {
        'group-1': { mode: 'open', allowedUsers: ['user-a', 'user-b'] },
      };
      expect(isGroupUserAllowed(groups, ['group-1'], 'user-a')).toBe(true);
      expect(isGroupUserAllowed(groups, ['group-1'], 'user-b')).toBe(true);
    });

    it('rejects user not in the list', () => {
      const groups: GroupsConfig = {
        'group-1': { mode: 'open', allowedUsers: ['user-a'] },
      };
      expect(isGroupUserAllowed(groups, ['group-1'], 'user-c')).toBe(false);
    });

    it('uses wildcard allowedUsers as fallback', () => {
      const groups: GroupsConfig = {
        '*': { mode: 'mention-only', allowedUsers: ['owner'] },
      };
      expect(isGroupUserAllowed(groups, ['group-1'], 'owner')).toBe(true);
      expect(isGroupUserAllowed(groups, ['group-1'], 'stranger')).toBe(false);
    });

    it('specific group overrides wildcard allowedUsers', () => {
      const groups: GroupsConfig = {
        '*': { mode: 'mention-only', allowedUsers: ['owner'] },
        'open-group': { mode: 'open', allowedUsers: ['guest'] },
      };
      // open-group has its own list
      expect(isGroupUserAllowed(groups, ['open-group'], 'guest')).toBe(true);
      expect(isGroupUserAllowed(groups, ['open-group'], 'owner')).toBe(false);
      // other groups fall back to wildcard
      expect(isGroupUserAllowed(groups, ['other-group'], 'owner')).toBe(true);
      expect(isGroupUserAllowed(groups, ['other-group'], 'guest')).toBe(false);
    });
  });

  describe('resolveDailyLimits', () => {
    it('returns empty when groups config is missing', () => {
      expect(resolveDailyLimits(undefined, ['group-1'])).toEqual({});
    });

    it('returns empty when no daily limits configured', () => {
      const groups: GroupsConfig = { 'group-1': { mode: 'open' } };
      expect(resolveDailyLimits(groups, ['group-1'])).toEqual({});
    });

    it('resolves dailyLimit from specific key', () => {
      const groups: GroupsConfig = {
        'group-1': { mode: 'open', dailyLimit: 50 },
      };
      expect(resolveDailyLimits(groups, ['group-1'])).toEqual({ dailyLimit: 50, dailyUserLimit: undefined, matchedKey: 'group-1' });
    });

    it('resolves dailyUserLimit from specific key', () => {
      const groups: GroupsConfig = {
        'group-1': { mode: 'open', dailyUserLimit: 10 },
      };
      expect(resolveDailyLimits(groups, ['group-1'])).toEqual({ dailyLimit: undefined, dailyUserLimit: 10, matchedKey: 'group-1' });
    });

    it('resolves both limits together', () => {
      const groups: GroupsConfig = {
        'group-1': { mode: 'open', dailyLimit: 100, dailyUserLimit: 20 },
      };
      expect(resolveDailyLimits(groups, ['group-1'])).toEqual({ dailyLimit: 100, dailyUserLimit: 20, matchedKey: 'group-1' });
    });

    it('uses wildcard as fallback', () => {
      const groups: GroupsConfig = {
        '*': { mode: 'open', dailyLimit: 30 },
      };
      expect(resolveDailyLimits(groups, ['group-1'])).toEqual({ dailyLimit: 30, dailyUserLimit: undefined, matchedKey: '*' });
    });

    it('prefers specific key over wildcard', () => {
      const groups: GroupsConfig = {
        '*': { mode: 'open', dailyLimit: 100 },
        'group-1': { mode: 'open', dailyLimit: 10 },
      };
      expect(resolveDailyLimits(groups, ['group-1'])).toEqual({ dailyLimit: 10, dailyUserLimit: undefined, matchedKey: 'group-1' });
    });

    it('uses first matching key in priority order', () => {
      const groups: GroupsConfig = {
        'chat-1': { mode: 'open', dailyLimit: 5 },
        'server-1': { mode: 'open', dailyLimit: 50 },
      };
      expect(resolveDailyLimits(groups, ['chat-1', 'server-1'])).toEqual({ dailyLimit: 5, dailyUserLimit: undefined, matchedKey: 'chat-1' });
      expect(resolveDailyLimits(groups, ['chat-2', 'server-1'])).toEqual({ dailyLimit: 50, dailyUserLimit: undefined, matchedKey: 'server-1' });
    });

    it('inherits undefined fields from wildcard', () => {
      const groups: GroupsConfig = {
        '*': { mode: 'open', dailyUserLimit: 10 },
        'channel-123': { mode: 'open', dailyLimit: 50 },
      };
      // channel-123 sets dailyLimit, wildcard provides dailyUserLimit
      expect(resolveDailyLimits(groups, ['channel-123'])).toEqual({
        dailyLimit: 50,
        dailyUserLimit: 10,
        matchedKey: 'channel-123',
      });
    });

    it('specific key overrides wildcard for the same field', () => {
      const groups: GroupsConfig = {
        '*': { mode: 'open', dailyLimit: 100, dailyUserLimit: 20 },
        'group-1': { mode: 'open', dailyLimit: 10 },
      };
      // group-1 overrides dailyLimit, inherits dailyUserLimit from wildcard
      expect(resolveDailyLimits(groups, ['group-1'])).toEqual({
        dailyLimit: 10,
        dailyUserLimit: 20,
        matchedKey: 'group-1',
      });
    });
  });

  describe('checkDailyLimit', () => {
    beforeEach(() => {
      resetDailyLimitCounters();
    });

    it('allows when no limits configured', () => {
      const result = checkDailyLimit('test:group', 'user-1', {});
      expect(result).toEqual({ allowed: true });
    });

    it('enforces dailyLimit (group-wide total)', () => {
      const limits = { dailyLimit: 3 };
      expect(checkDailyLimit('test:group', 'user-1', limits).allowed).toBe(true);
      expect(checkDailyLimit('test:group', 'user-2', limits).allowed).toBe(true);
      expect(checkDailyLimit('test:group', 'user-3', limits).allowed).toBe(true);
      // 4th message exceeds group-wide limit regardless of user
      const result = checkDailyLimit('test:group', 'user-4', limits);
      expect(result).toEqual({ allowed: false, reason: 'daily-limit' });
    });

    it('enforces dailyUserLimit (per-user)', () => {
      const limits = { dailyUserLimit: 2 };
      expect(checkDailyLimit('test:group', 'user-1', limits).allowed).toBe(true);
      expect(checkDailyLimit('test:group', 'user-1', limits).allowed).toBe(true);
      // user-1 is blocked
      const result = checkDailyLimit('test:group', 'user-1', limits);
      expect(result).toEqual({ allowed: false, reason: 'daily-user-limit' });
      // user-2 is still allowed
      expect(checkDailyLimit('test:group', 'user-2', limits).allowed).toBe(true);
    });

    it('checks group limit before user limit', () => {
      const limits = { dailyLimit: 2, dailyUserLimit: 5 };
      expect(checkDailyLimit('test:group', 'user-1', limits).allowed).toBe(true);
      expect(checkDailyLimit('test:group', 'user-2', limits).allowed).toBe(true);
      // Group limit hit -- reason should be daily-limit, not daily-user-limit
      const result = checkDailyLimit('test:group', 'user-3', limits);
      expect(result).toEqual({ allowed: false, reason: 'daily-limit' });
    });

    it('isolates counters between different groups', () => {
      const limits = { dailyLimit: 1 };
      expect(checkDailyLimit('discord:group-a', 'user-1', limits).allowed).toBe(true);
      expect(checkDailyLimit('discord:group-b', 'user-1', limits).allowed).toBe(true);
      // group-a is full, group-b is full, but they're independent
      expect(checkDailyLimit('discord:group-a', 'user-1', limits).allowed).toBe(false);
      expect(checkDailyLimit('discord:group-b', 'user-1', limits).allowed).toBe(false);
    });

    it('does not increment counters when denied', () => {
      const limits = { dailyLimit: 2 };
      expect(checkDailyLimit('test:group', 'user-1', limits).allowed).toBe(true);  // count=1
      expect(checkDailyLimit('test:group', 'user-1', limits).allowed).toBe(true);  // count=2
      expect(checkDailyLimit('test:group', 'user-1', limits).allowed).toBe(false); // denied, count stays 2
      expect(checkDailyLimit('test:group', 'user-1', limits).allowed).toBe(false); // still denied, count stays 2
    });
  });
});

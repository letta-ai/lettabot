import { describe, expect, it } from 'vitest';
import { isGroupAllowed, isGroupUserAllowed, resolveGroupAllowedUsers, resolveGroupMode, type GroupsConfig } from './group-mode.js';

describe('group-mode helpers', () => {
  describe('isGroupAllowed', () => {
    it('allows when groups config is missing', () => {
      expect(isGroupAllowed(undefined, ['group-1'])).toBe(true);
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
});

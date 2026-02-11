import { describe, expect, it } from 'vitest';
import { isGroupAllowed, resolveGroupMode, type GroupsConfig } from './group-mode.js';

describe('group-mode helpers', () => {
  describe('isGroupAllowed', () => {
    it('allows when groups config is missing', () => {
      expect(isGroupAllowed(undefined, ['group-1'])).toBe(true);
    });

    it('allows when groups config is empty', () => {
      expect(isGroupAllowed({}, ['group-1'])).toBe(true);
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
});

import { describe, it, expect } from 'vitest';
import { parseCommand, COMMANDS, HELP_TEXT } from './commands.js';

describe('parseCommand', () => {
  describe('valid commands', () => {
    it('returns "status" for /status', () => {
      expect(parseCommand('/status')).toBe('status');
    });

    it('returns "heartbeat" for /heartbeat', () => {
      expect(parseCommand('/heartbeat')).toBe('heartbeat');
    });

    it('returns "help" for /help', () => {
      expect(parseCommand('/help')).toBe('help');
    });

    it('returns "start" for /start', () => {
      expect(parseCommand('/start')).toBe('start');
    });
  });

  describe('invalid input', () => {
    it('returns null for non-slash messages', () => {
      expect(parseCommand('hello')).toBeNull();
      expect(parseCommand('status')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(parseCommand('')).toBeNull();
    });

    it('returns null for null/undefined', () => {
      expect(parseCommand(null)).toBeNull();
      expect(parseCommand(undefined)).toBeNull();
    });

    it('returns null for unknown commands', () => {
      expect(parseCommand('/unknown')).toBeNull();
      expect(parseCommand('/foo')).toBeNull();
      expect(parseCommand('/stats')).toBeNull(); // Similar but not exact
    });
  });

  describe('command parsing', () => {
    it('handles commands with extra text after', () => {
      expect(parseCommand('/status please')).toBe('status');
      expect(parseCommand('/help me')).toBe('help');
    });

    it('is case insensitive', () => {
      expect(parseCommand('/STATUS')).toBe('status');
      expect(parseCommand('/Help')).toBe('help');
      expect(parseCommand('/HEARTBEAT')).toBe('heartbeat');
    });

    it('handles commands with leading/trailing whitespace in args', () => {
      expect(parseCommand('/status   ')).toBe('status');
    });
  });
});

describe('COMMANDS', () => {
  it('contains all expected commands', () => {
    expect(COMMANDS).toContain('status');
    expect(COMMANDS).toContain('heartbeat');
    expect(COMMANDS).toContain('help');
    expect(COMMANDS).toContain('start');
  });

  it('has exactly 4 commands', () => {
    expect(COMMANDS).toHaveLength(4);
  });
});

describe('HELP_TEXT', () => {
  it('contains command descriptions', () => {
    expect(HELP_TEXT).toContain('/status');
    expect(HELP_TEXT).toContain('/heartbeat');
    expect(HELP_TEXT).toContain('/help');
  });

  it('contains LettaBot branding', () => {
    expect(HELP_TEXT).toContain('LettaBot');
  });
});

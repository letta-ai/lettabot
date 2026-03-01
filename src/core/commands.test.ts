import { describe, it, expect } from 'vitest';
import { parseCommand, COMMANDS, HELP_TEXT } from './commands.js';

describe('parseCommand', () => {
  describe('valid commands', () => {
    it('returns { command, args } for /status', () => {
      expect(parseCommand('/status')).toEqual({ command: 'status', args: '' });
    });

    it('returns { command, args } for /heartbeat', () => {
      expect(parseCommand('/heartbeat')).toEqual({ command: 'heartbeat', args: '' });
    });

    it('returns { command, args } for /help', () => {
      expect(parseCommand('/help')).toEqual({ command: 'help', args: '' });
    });

    it('returns { command, args } for /start', () => {
      expect(parseCommand('/start')).toEqual({ command: 'start', args: '' });
    });

    it('returns { command, args } for /reset', () => {
      expect(parseCommand('/reset')).toEqual({ command: 'reset', args: '' });
    });

    it('returns { command, args } for /model', () => {
      expect(parseCommand('/model')).toEqual({ command: 'model', args: '' });
    });

    it('returns { command, args } for /cancel', () => {
      expect(parseCommand('/cancel')).toEqual({ command: 'cancel', args: '' });
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
    it('captures trailing text as args', () => {
      expect(parseCommand('/status please')).toEqual({ command: 'status', args: 'please' });
      expect(parseCommand('/help me')).toEqual({ command: 'help', args: 'me' });
    });

    it('is case insensitive', () => {
      expect(parseCommand('/STATUS')).toEqual({ command: 'status', args: '' });
      expect(parseCommand('/Help')).toEqual({ command: 'help', args: '' });
      expect(parseCommand('/HEARTBEAT')).toEqual({ command: 'heartbeat', args: '' });
    });

    it('handles commands with trailing whitespace', () => {
      expect(parseCommand('/status   ')).toEqual({ command: 'status', args: '' });
    });

    it('parses /model with a handle argument', () => {
      expect(parseCommand('/model anthropic/claude-sonnet-4-5-20250929')).toEqual({
        command: 'model',
        args: 'anthropic/claude-sonnet-4-5-20250929',
      });
    });

    it('preserves multi-word args', () => {
      expect(parseCommand('/model some handle with spaces')).toEqual({
        command: 'model',
        args: 'some handle with spaces',
      });
    });
  });
});

describe('COMMANDS', () => {
  it('contains all expected commands', () => {
    expect(COMMANDS).toContain('status');
    expect(COMMANDS).toContain('heartbeat');
    expect(COMMANDS).toContain('reset');
    expect(COMMANDS).toContain('help');
    expect(COMMANDS).toContain('start');
    expect(COMMANDS).toContain('model');
  });

  it('has exactly 6 commands', () => {
    expect(COMMANDS).toHaveLength(7);
  });
});

describe('HELP_TEXT', () => {
  it('contains command descriptions', () => {
    expect(HELP_TEXT).toContain('/status');
    expect(HELP_TEXT).toContain('/heartbeat');
    expect(HELP_TEXT).toContain('/help');
    expect(HELP_TEXT).toContain('/model');
  });

  it('contains LettaBot branding', () => {
    expect(HELP_TEXT).toContain('LettaBot');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseChannelArgs, resolveAgentConfig } from './group-listing.js';

// ── parseChannelArgs ─────────────────────────────────────────────────────────

describe('parseChannelArgs', () => {
  it('returns empty result for no args', () => {
    expect(parseChannelArgs([])).toEqual({});
  });

  it('parses --channel flag', () => {
    expect(parseChannelArgs(['--channel', 'discord'])).toEqual({ channel: 'discord' });
  });

  it('parses -c shorthand', () => {
    expect(parseChannelArgs(['-c', 'slack'])).toEqual({ channel: 'slack' });
  });

  it('lowercases the channel value', () => {
    expect(parseChannelArgs(['--channel', 'Discord'])).toEqual({ channel: 'discord' });
  });

  it('parses --agent flag', () => {
    expect(parseChannelArgs(['--agent', 'MyAgent'])).toEqual({ agent: 'MyAgent' });
  });

  it('parses --channel and --agent together', () => {
    expect(parseChannelArgs(['--channel', 'discord', '--agent', 'MyAgent'])).toEqual({
      channel: 'discord',
      agent: 'MyAgent',
    });
  });

  it('accepts a bare positional as channel shorthand', () => {
    expect(parseChannelArgs(['discord'])).toEqual({ channel: 'discord' });
  });

  it('returns error for --channel with no value', () => {
    expect(parseChannelArgs(['--channel'])).toEqual({ error: 'Missing value for --channel' });
  });

  it('returns error for -c with no value', () => {
    expect(parseChannelArgs(['-c'])).toEqual({ error: 'Missing value for --channel' });
  });

  it('returns error for --agent with no value', () => {
    expect(parseChannelArgs(['--agent'])).toEqual({ error: 'Missing value for --agent' });
  });

  it('returns error for unexpected extra positional argument', () => {
    const result = parseChannelArgs(['discord', 'slack']);
    expect(result.error).toMatch(/unexpected argument/i);
  });
});

// ── resolveAgentConfig ───────────────────────────────────────────────────────

describe('resolveAgentConfig', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns undefined when no agentName provided', async () => {
    const { resolveAgentConfig: resolve } = await import('./group-listing.js');
    expect(resolve(undefined)).toBeUndefined();
    expect(resolve('')).toBeUndefined();
  });

  it('finds agent by exact name', async () => {
    vi.doMock('../config/index.js', () => ({
      loadAppConfigOrExit: () => ({}),
      normalizeAgents: () => [
        { name: 'Muninn', channels: { discord: { token: 'tok' } } },
        { name: 'Other', channels: {} },
      ],
    }));
    const { resolveAgentConfig: resolve } = await import('./group-listing.js');
    const result = resolve('Muninn');
    expect(result).toBeDefined();
    expect(result!.name).toBe('Muninn');
  });

  it('finds agent case-insensitively', async () => {
    vi.doMock('../config/index.js', () => ({
      loadAppConfigOrExit: () => ({}),
      normalizeAgents: () => [{ name: 'Muninn', channels: {} }],
    }));
    const { resolveAgentConfig: resolve } = await import('./group-listing.js');
    const result = resolve('muninn');
    expect(result).toBeDefined();
    expect(result!.name).toBe('Muninn');
  });

  it('exits with error when agent not found', async () => {
    vi.doMock('../config/index.js', () => ({
      loadAppConfigOrExit: () => ({}),
      normalizeAgents: () => [{ name: 'Other', channels: {} }],
    }));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    const { resolveAgentConfig: resolve } = await import('./group-listing.js');
    resolve('NonExistent');

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('NonExistent'));
    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

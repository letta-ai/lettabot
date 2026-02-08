import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchDiscordHistory, fetchHistory, isValidLimit, loadLastTarget, parseFetchArgs } from './history-core.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('parseFetchArgs', () => {
  it('parses fetch args with flags', () => {
    const parsed = parseFetchArgs([
      '--limit', '25',
      '--channel', 'discord',
      '--chat', '123',
      '--before', '456',
    ]);

    expect(parsed).toEqual({
      channel: 'discord',
      chatId: '123',
      before: '456',
      limit: 25,
    });
  });
});

describe('isValidLimit', () => {
  it('accepts positive integers only', () => {
    expect(isValidLimit(1)).toBe(true);
    expect(isValidLimit(50)).toBe(true);
    expect(isValidLimit(0)).toBe(false);
    expect(isValidLimit(-1)).toBe(false);
    expect(isValidLimit(1.5)).toBe(false);
    expect(isValidLimit(Number.NaN)).toBe(false);
  });
});

describe('loadLastTarget', () => {
  it('loads the last message target from the store path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lettabot-history-'));
    const storePath = join(dir, 'lettabot-agent.json');
    writeFileSync(
      storePath,
      JSON.stringify({ lastMessageTarget: { channel: 'slack', chatId: 'C123' } }),
      'utf-8'
    );

    const target = loadLastTarget(storePath);
    expect(target).toEqual({ channel: 'slack', chatId: 'C123' });

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('fetchDiscordHistory', () => {
  it('formats Discord history responses', async () => {
    process.env.DISCORD_BOT_TOKEN = 'test-token';

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ([
        {
          id: '111',
          content: 'Hello',
          author: { username: 'alice', discriminator: '1234' },
          timestamp: '2026-01-01T00:00:00Z',
        },
      ]),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const output = await fetchDiscordHistory('999', 10, '888');
    const parsed = JSON.parse(output) as {
      count: number;
      messages: Array<{ messageId: string; author: string; content: string; timestamp?: string }>;
    };

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://discord.com/api/v10/channels/999/messages?limit=10&before=888',
      expect.objectContaining({ method: 'GET' })
    );
    expect(parsed.count).toBe(1);
    expect(parsed.messages[0]).toEqual({
      messageId: '111',
      author: 'alice#1234',
      content: 'Hello',
      timestamp: '2026-01-01T00:00:00Z',
    });
  });
});

describe('fetchHistory', () => {
  it('rejects unsupported channels', async () => {
    await expect(fetchHistory('unknown', '1', 1)).rejects.toThrow('Unknown channel');
  });
});

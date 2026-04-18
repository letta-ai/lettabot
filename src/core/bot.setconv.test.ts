import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockChannelAdapter } from '../test/mock-channel.js';
import { LettaBot } from './bot.js';

describe('LettaBot /setconv command', () => {
  let dataDir: string;
  let workingDir: string;
  const originalDataDir = process.env.DATA_DIR;
  const originalBaseUrl = process.env.LETTA_BASE_URL;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'lettabot-data-'));
    workingDir = mkdtempSync(join(tmpdir(), 'lettabot-work-'));
    process.env.DATA_DIR = dataDir;
    delete process.env.LETTA_BASE_URL;
  });

  afterEach(() => {
    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDir;
    }
    if (originalBaseUrl === undefined) {
      delete process.env.LETTA_BASE_URL;
    } else {
      process.env.LETTA_BASE_URL = originalBaseUrl;
    }
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workingDir, { recursive: true, force: true });
  });

  function createBot(): { bot: LettaBot; adapter: MockChannelAdapter } {
    writeFileSync(
      join(dataDir, 'lettabot-agent.json'),
      JSON.stringify(
        {
          version: 2,
          agents: {
            LettaBot: {
              agentId: 'agent-test-123',
              conversationId: 'conv-old',
              createdAt: '2026-01-01T00:00:00.000Z',
              lastUsedAt: '2026-01-01T00:00:01.000Z',
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const bot = new LettaBot({
      workingDir,
      allowedTools: [],
      memfs: false,
    });
    const adapter = new MockChannelAdapter();
    bot.registerChannel(adapter);
    return { bot, adapter };
  }

  it('shows usage when called without args', async () => {
    const { adapter } = createBot();
    const response = await adapter.simulateMessage('/setconv');
    expect(response).toContain('Usage:');
    expect(response).toContain('/setconv <conversation-id>');
  });

  it('rejects too-short conversation IDs', async () => {
    const { adapter } = createBot();
    const response = await adapter.simulateMessage('/setconv ab');
    expect(response).toContain('Invalid conversation ID');
  });

  it('sets conversation ID in shared mode', async () => {
    const { adapter, bot } = createBot();
    const response = await adapter.simulateMessage('/setconv conv-new-123');

    expect(response).toContain('conv-new-123');
    expect(response).toContain('Conversation set to');

    // Verify store was updated
    expect(bot.store.conversationId).toBe('conv-new-123');
  });

  it('overwrites previous conversation ID', async () => {
    const { adapter, bot } = createBot();

    // First set
    await adapter.simulateMessage('/setconv conv-first');
    expect(bot.store.conversationId).toBe('conv-first');

    // Overwrite
    const response = await adapter.simulateMessage('/setconv conv-second');
    expect(response).toContain('conv-second');
    expect(bot.store.conversationId).toBe('conv-second');
  });

  it('trims whitespace from conversation ID', async () => {
    const { adapter, bot } = createBot();
    const response = await adapter.simulateMessage('/setconv   conv-trimmed   ');

    expect(response).toContain('conv-trimmed');
    expect(bot.store.conversationId).toBe('conv-trimmed');
  });
});

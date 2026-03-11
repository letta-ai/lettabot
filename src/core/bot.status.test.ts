import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockChannelAdapter } from '../test/mock-channel.js';
import { LettaBot } from './bot.js';

describe('LettaBot /status command', () => {
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

  it('includes conversation and runtime fields', async () => {
    writeFileSync(
      join(dataDir, 'lettabot-agent.json'),
      JSON.stringify(
        {
          version: 2,
          agents: {
            LettaBot: {
              agentId: 'agent-test-123',
              conversationId: 'conv-shared-123',
              conversations: {
                telegram: 'conv-tg-1',
              },
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
      memfs: true,
    });
    const adapter = new MockChannelAdapter();
    bot.registerChannel(adapter);

    const response = await adapter.simulateMessage('/status');

    expect(response).toContain('Agent ID: `agent-test-123`');
    expect(response).toContain('Conversation ID: `conv-shared-123`');
    expect(response).toContain('Conversation keys: telegram');
    expect(response).toContain('Memfs: on');
    expect(response).toContain('Server: https://api.letta.com');
    expect(response).toContain('Channels: mock');
  });
});

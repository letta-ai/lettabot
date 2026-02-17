import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('@letta-ai/letta-code-sdk', () => ({
  createAgent: vi.fn(),
  createSession: vi.fn(),
  resumeSession: vi.fn(),
  imageFromFile: vi.fn(),
  imageFromURL: vi.fn(),
}));

import { createSession, resumeSession } from '@letta-ai/letta-code-sdk';
import { LettaBot } from './bot.js';

describe('SDK session contract', () => {
  let dataDir: string;
  let originalDataDir: string | undefined;
  let originalAgentId: string | undefined;
  let originalRailwayMount: string | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'lettabot-sdk-contract-'));
    originalDataDir = process.env.DATA_DIR;
    originalAgentId = process.env.LETTA_AGENT_ID;
    originalRailwayMount = process.env.RAILWAY_VOLUME_MOUNT_PATH;

    process.env.DATA_DIR = dataDir;
    process.env.LETTA_AGENT_ID = 'agent-contract-test';
    delete process.env.RAILWAY_VOLUME_MOUNT_PATH;

    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;

    if (originalAgentId === undefined) delete process.env.LETTA_AGENT_ID;
    else process.env.LETTA_AGENT_ID = originalAgentId;

    if (originalRailwayMount === undefined) delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
    else process.env.RAILWAY_VOLUME_MOUNT_PATH = originalRailwayMount;

    rmSync(dataDir, { recursive: true, force: true });
  });

  it('reuses the same SDK session across follow-up sendToAgent calls', async () => {
    const mockSession = {
      initialize: vi.fn(async () => undefined),
      send: vi.fn(async (_message: unknown) => undefined),
      stream: vi.fn(() =>
        (async function* () {
          yield { type: 'assistant', content: 'ack' };
          yield { type: 'result', success: true };
        })()
      ),
      close: vi.fn(() => undefined),
      agentId: 'agent-contract-test',
      conversationId: 'conversation-contract-test',
    };

    vi.mocked(createSession).mockReturnValue(mockSession as never);
    vi.mocked(resumeSession).mockReturnValue(mockSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
    });

    await bot.sendToAgent('first message');
    await bot.sendToAgent('second message');

    expect(vi.mocked(resumeSession)).not.toHaveBeenCalled();
    expect(vi.mocked(createSession)).toHaveBeenCalledTimes(1);
    expect(mockSession.initialize).toHaveBeenCalledTimes(1);
    expect(mockSession.send).toHaveBeenCalledTimes(2);
    expect(mockSession.send).toHaveBeenNthCalledWith(1, 'first message');
    expect(mockSession.send).toHaveBeenNthCalledWith(2, 'second message');
    expect(mockSession.stream).toHaveBeenCalledTimes(2);
  });
});

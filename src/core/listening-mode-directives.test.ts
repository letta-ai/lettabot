import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LettaBot } from './bot.js';
import type { InboundMessage } from './types.js';

describe('listening mode directive safety', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'lettabot-listening-directives-'));
    const outboundDir = join(workDir, 'data', 'outbound');
    mkdirSync(outboundDir, { recursive: true });
    writeFileSync(join(outboundDir, 'report.txt'), 'ok');
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('skips send-file directives when message is in listening mode', async () => {
    const bot = new LettaBot({
      workingDir: workDir,
      allowedTools: [],
    });

    const adapter = {
      id: 'mock',
      name: 'Mock',
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      isRunning: vi.fn(() => true),
      sendMessage: vi.fn(async () => ({ messageId: 'msg-1' })),
      editMessage: vi.fn(async () => {}),
      sendTypingIndicator: vi.fn(async () => {}),
      stopTypingIndicator: vi.fn(async () => {}),
      supportsEditing: vi.fn(() => false),
      sendFile: vi.fn(async () => ({ messageId: 'file-1' })),
    };

    (bot as any).runSession = vi.fn(async () => ({
      session: { abort: vi.fn(async () => {}) },
      stream: async function* () {
        yield {
          type: 'assistant',
          content: '<actions><send-file path="data/outbound/report.txt" /></actions>',
        };
        yield { type: 'result', success: true };
      },
    }));

    const msg: InboundMessage = {
      channel: 'discord',
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'observe only',
      timestamp: new Date(),
      isListeningMode: true,
    };

    await (bot as any).processMessage(msg, adapter);

    expect(adapter.sendFile).not.toHaveBeenCalled();
    expect(adapter.sendMessage).not.toHaveBeenCalled();
  });
});

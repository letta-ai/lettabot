import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LettaBot } from './bot.js';
import type { OutboundMessage } from './types.js';
import type { ChannelAdapter } from '../channels/types.js';

describe('channel redaction wrapping', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'lettabot-channel-redaction-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('applies pii redaction when secrets are disabled', async () => {
    const bot = new LettaBot({
      workingDir: workDir,
      allowedTools: [],
      redaction: { secrets: false, pii: true },
    });

    const sendSpy = vi.fn(async (_msg: OutboundMessage) => ({ messageId: 'sent-1' }));

    const adapter: ChannelAdapter = {
      id: 'mock',
      name: 'Mock',
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      isRunning: vi.fn(() => true),
      sendMessage: sendSpy,
      editMessage: vi.fn(async () => {}),
      sendTypingIndicator: vi.fn(async () => {}),
    };

    bot.registerChannel(adapter);

    const text = 'Email user@example.com and key sk-abc123def456ghi789jkl012mno345';
    await adapter.sendMessage({ chatId: 'chat-1', text });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const sent = sendSpy.mock.calls[0][0];
    expect(sent.text).toContain('[REDACTED]');
    expect(sent.text).not.toContain('user@example.com');
    expect(sent.text).toContain('sk-abc123def456ghi789jkl012mno345');
  });
});

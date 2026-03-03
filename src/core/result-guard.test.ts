import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LettaBot } from './bot.js';
import type { InboundMessage, OutboundMessage } from './types.js';

describe('result divergence guard', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'lettabot-result-guard-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('does not resend full result text when streamed content was already flushed', async () => {
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
      sendMessage: vi.fn(async (_msg: OutboundMessage) => ({ messageId: 'msg-1' })),
      editMessage: vi.fn(async () => {}),
      sendTypingIndicator: vi.fn(async () => {}),
      stopTypingIndicator: vi.fn(async () => {}),
      supportsEditing: vi.fn(() => false),
      sendFile: vi.fn(async () => ({ messageId: 'file-1' })),
    };

    (bot as any).sessionManager.runSession = vi.fn(async () => ({
      session: { abort: vi.fn(async () => {}) },
      stream: async function* () {
        // Assistant text is flushed when tool_call arrives.
        yield { type: 'assistant', content: 'first segment' };
        yield { type: 'tool_call', toolCallId: 'tc-1', toolName: 'Bash', toolInput: { command: 'echo hi' } };
        // Result repeats the same text; this must not cause a duplicate send.
        yield { type: 'result', success: true, result: 'first segment' };
      },
    }));

    const msg: InboundMessage = {
      channel: 'discord',
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'hello',
      timestamp: new Date(),
    };

    await (bot as any).processMessage(msg, adapter);

    const sentTexts = adapter.sendMessage.mock.calls.map(([payload]) => payload.text);
    expect(sentTexts).toEqual(['first segment']);
  });

  it('prefers streamed assistant text when result text diverges after flush', async () => {
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
      sendMessage: vi.fn(async (_msg: OutboundMessage) => ({ messageId: 'msg-1' })),
      editMessage: vi.fn(async () => {}),
      sendTypingIndicator: vi.fn(async () => {}),
      stopTypingIndicator: vi.fn(async () => {}),
      supportsEditing: vi.fn(() => false),
      sendFile: vi.fn(async () => ({ messageId: 'file-1' })),
    };

    (bot as any).sessionManager.runSession = vi.fn(async () => ({
      session: { abort: vi.fn(async () => {}) },
      stream: async function* () {
        yield { type: 'assistant', content: 'streamed-segment' };
        yield { type: 'tool_call', toolCallId: 'tc-1', toolName: 'Bash', toolInput: { command: 'echo hi' } };
        // Divergent stale result should not replace or resend streamed content.
        yield { type: 'result', success: true, result: 'stale-result-segment' };
      },
    }));

    const msg: InboundMessage = {
      channel: 'discord',
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'hello',
      timestamp: new Date(),
    };

    await (bot as any).processMessage(msg, adapter);

    const sentTexts = adapter.sendMessage.mock.calls.map(([payload]) => payload.text);
    expect(sentTexts).toEqual(['streamed-segment']);
  });
});

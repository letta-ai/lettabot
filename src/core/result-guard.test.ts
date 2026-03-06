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

  it('does not deliver reasoning text from error results as the response', async () => {
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
        // Reproduce the exact bug path: reasoning tokens only, then an error
        // result whose result field contains the leaked reasoning text.
        yield { type: 'reasoning', content: '**Evaluating response protocol**\n\nI\'m trying to figure out how to respond...' };
        yield {
          type: 'result',
          success: false,
          error: 'error',
          stopReason: 'llm_api_error',
          result: '**Evaluating response protocol**\n\nI\'m trying to figure out how to respond...',
        };
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
    // Must show a formatted error message, never the raw reasoning text.
    expect(sentTexts.length).toBeGreaterThanOrEqual(1);
    const lastSent = sentTexts[sentTexts.length - 1];
    expect(lastSent).not.toContain('Evaluating response protocol');
    expect(lastSent).toMatch(/\(.*\)/); // Parenthesized system message
  });

  it('ignores non-foreground result events and waits for the foreground result', async () => {
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
        yield { type: 'assistant', content: 'main ', runId: 'run-main' };
        yield { type: 'assistant', content: 'background', runId: 'run-bg' };
        yield { type: 'result', success: true, result: 'background final', runIds: ['run-bg'] };
        yield { type: 'assistant', content: 'reply', runId: 'run-main' };
        yield { type: 'result', success: true, result: 'main reply', runIds: ['run-main'] };
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
    expect(sentTexts).toEqual(['main reply']);
  });

  it('buffers pre-foreground run-scoped display events and drops non-foreground buffers', async () => {
    const bot = new LettaBot({
      workingDir: workDir,
      allowedTools: [],
      display: { showReasoning: true, showToolCalls: true },
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
        yield { type: 'reasoning', content: 'background-thinking', runId: 'run-bg' };
        yield { type: 'tool_call', toolCallId: 'tc-bg', toolName: 'Bash', toolInput: { command: 'echo leak' }, runId: 'run-bg' };
        yield { type: 'assistant', content: 'main reply', runId: 'run-main' };
        yield { type: 'result', success: true, result: 'main reply', runIds: ['run-main'] };
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
    expect(sentTexts).toEqual(['main reply']);
  });

  it('retries once when a competing result arrives before any foreground terminal result', async () => {
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

    const runSession = vi.fn();
    runSession.mockResolvedValueOnce({
      session: { abort: vi.fn(async () => {}) },
      stream: async function* () {
        yield { type: 'assistant', content: 'partial foreground', runId: 'run-main' };
        yield { type: 'result', success: true, result: 'background final', runIds: ['run-bg'] };
      },
    });
    runSession.mockResolvedValueOnce({
      session: { abort: vi.fn(async () => {}) },
      stream: async function* () {
        yield { type: 'assistant', content: 'main reply', runId: 'run-main' };
        yield { type: 'result', success: true, result: 'main reply', runIds: ['run-main'] };
      },
    });
    (bot as any).sessionManager.runSession = runSession;

    const msg: InboundMessage = {
      channel: 'discord',
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'hello',
      timestamp: new Date(),
    };

    await (bot as any).processMessage(msg, adapter);

    expect(runSession).toHaveBeenCalledTimes(2);
    const sentTexts = adapter.sendMessage.mock.calls.map(([payload]) => payload.text);
    expect(sentTexts).toEqual(['main reply']);
  });
});

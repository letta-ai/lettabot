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

  it('stops after repeated failing lettabot CLI bash calls', async () => {
    const bot = new LettaBot({
      workingDir: workDir,
      allowedTools: [],
      maxToolCalls: 100,
    });

    const abort = vi.fn(async () => {});
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
      session: { abort },
      stream: async function* () {
        yield { type: 'tool_call', toolCallId: 'tc-1', toolName: 'Bash', toolInput: { command: 'lettabot bluesky post --text "hi" --agent Bot' } };
        yield { type: 'tool_result', toolCallId: 'tc-1', isError: true, content: 'Unknown command: bluesky' };
        yield { type: 'tool_call', toolCallId: 'tc-2', toolName: 'Bash', toolInput: { command: 'lettabot bluesky post --text "hi" --agent Bot' } };
        yield { type: 'tool_result', toolCallId: 'tc-2', isError: true, content: 'Unknown command: bluesky' };
        yield { type: 'tool_call', toolCallId: 'tc-3', toolName: 'Bash', toolInput: { command: 'lettabot bluesky post --text "hi" --agent Bot' } };
        yield { type: 'tool_result', toolCallId: 'tc-3', isError: true, content: 'Unknown command: bluesky' };
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

    expect(abort).toHaveBeenCalled();
    const sentTexts = adapter.sendMessage.mock.calls.map(([payload]) => payload.text as string);
    expect(sentTexts.some(text => text.includes('repeated CLI command failures'))).toBe(true);
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

  it('rebinds foreground run on post-tool-call assistant events with new run ID (#527)', async () => {
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

    // Server assigns run-2 after tool call -- both runs are part of the same turn
    (bot as any).sessionManager.runSession = vi.fn(async () => ({
      session: { abort: vi.fn(async () => {}) },
      stream: async function* () {
        yield { type: 'assistant', content: 'Before tool. ', runId: 'run-1' };
        yield { type: 'tool_call', toolCallId: 'tc-1', toolName: 'Bash', toolInput: { command: 'echo ok' }, runId: 'run-1' };
        yield { type: 'tool_result', content: 'ok', isError: false, runId: 'run-1' };
        yield { type: 'assistant', content: 'After tool.', runId: 'run-2' };
        yield { type: 'result', success: true, result: 'Before tool. After tool.', runIds: ['run-2'] };
      },
    }));

    const msg: InboundMessage = {
      channel: 'discord',
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'run a command',
      timestamp: new Date(),
    };

    await (bot as any).processMessage(msg, adapter);

    const sentTexts = adapter.sendMessage.mock.calls.map(([payload]) => payload.text);
    // Pre-tool and post-tool text are separate messages (finalized on type change)
    expect(sentTexts).toEqual(['Before tool. ', 'After tool.']);
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

  it('treats <no-reply/> as intentional silence and does not deliver a visible message', async () => {
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
        yield { type: 'assistant', content: '<no-reply/>' };
        yield { type: 'result', success: true, result: '<no-reply/>' };
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

    expect(adapter.sendMessage).not.toHaveBeenCalled();
    expect(adapter.editMessage).not.toHaveBeenCalled();
  });

  it('skips all post-stream delivery when message processing is cancelled', async () => {
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
        yield { type: 'assistant', content: 'this should never be delivered' };
        yield { type: 'result', success: true, result: 'this should never be delivered' };
      },
    }));

    const msg: InboundMessage = {
      channel: 'discord',
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'hello',
      timestamp: new Date(),
    };

    (bot as any).cancelledKeys.add('shared');
    await (bot as any).processMessage(msg, adapter);

    expect(adapter.sendMessage).not.toHaveBeenCalled();
    expect(adapter.editMessage).not.toHaveBeenCalled();
  });
});

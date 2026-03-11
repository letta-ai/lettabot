import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const loggerSpies = vi.hoisted(() => ({
  fatal: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  createLogger: () => ({
    ...loggerSpies,
    pino: {},
  }),
}));

import { LettaBot } from './bot.js';
import type { InboundMessage, OutboundMessage } from './types.js';

describe('stream logging levels', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'lettabot-bot-logging-'));
    Object.values(loggerSpies).forEach((spy) => spy.mockClear());
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('keeps per-event non-foreground and raw preview logging at trace level', async () => {
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
        yield { type: 'reasoning', content: 'bg-think', runId: 'run-bg' };
        yield { type: 'tool_call', toolCallId: 'tc-bg', toolName: 'Bash', toolInput: { command: 'echo bg' }, runId: 'run-bg' };
        yield { type: 'assistant', content: 'main reply', runId: 'run-main' };
        yield { type: 'reasoning', content: 'bg-post-foreground', runId: 'run-bg' };
        yield { type: 'tool_call', toolCallId: 'tc-main', toolName: 'Bash', toolInput: { command: 'echo main' }, runId: 'run-main' };
        yield { type: 'tool_result', content: 'ok', toolCallId: 'tc-main', runId: 'run-main', isError: false };
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

    const debugMessages = loggerSpies.debug.mock.calls.map(([message]) => String(message));
    const infoMessages = loggerSpies.info.mock.calls.map(([message]) => String(message));
    const traceMessages = loggerSpies.trace.mock.calls.map(([message]) => String(message));

    expect(debugMessages.some((m) => m.includes('Buffering run-scoped pre-foreground display event'))).toBe(false);
    expect(debugMessages.some((m) => m.includes('Deferring run-scoped pre-foreground event'))).toBe(false);
    expect(debugMessages.some((m) => m.includes('Skipping non-foreground stream event'))).toBe(false);

    expect(infoMessages.some((m) => m.includes('type=tool_call'))).toBe(false);
    expect(infoMessages.some((m) => m.includes('type=tool_result'))).toBe(false);

    expect(traceMessages.some((m) => m.includes('Buffering run-scoped pre-foreground display event'))).toBe(true);
    expect(traceMessages.some((m) => m.includes('Skipping non-foreground stream event'))).toBe(true);
    expect(traceMessages.some((m) => m.includes('type=tool_call'))).toBe(true);
    expect(traceMessages.some((m) => m.includes('type=tool_result'))).toBe(true);

    expect(infoMessages.some((m) => m.includes('Filtered') && m.includes('non-foreground event(s)'))).toBe(true);
  });
});
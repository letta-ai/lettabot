import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

describe('message hooks', () => {
  let dataDir: string;
  let originalDataDir: string | undefined;
  let originalAgentId: string | undefined;
  let originalRailwayMount: string | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'lettabot-hooks-'));
    originalDataDir = process.env.DATA_DIR;
    originalAgentId = process.env.LETTA_AGENT_ID;
    originalRailwayMount = process.env.RAILWAY_VOLUME_MOUNT_PATH;

    process.env.DATA_DIR = dataDir;
    process.env.LETTA_AGENT_ID = 'agent-hooks-test';
    delete process.env.RAILWAY_VOLUME_MOUNT_PATH;

    (globalThis as any).__hookEvents = [];
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

  function makeSession() {
    return {
      initialize: vi.fn(async () => undefined),
      send: vi.fn(async (_message: unknown) => undefined),
      stream: vi.fn(() =>
        (async function* () {
          yield { type: 'assistant', content: 'ack' };
          yield { type: 'result', success: true };
        })()
      ),
      close: vi.fn(() => undefined),
      agentId: 'agent-hooks-test',
      conversationId: 'conversation-hooks-test',
    };
  }

  async function waitFor(condition: () => boolean, timeoutMs = 200): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (condition()) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Timed out waiting for condition');
  }

  it('uses preMessage hook to override sendToAgent payload', async () => {
    const hookDir = mkdtempSync(join(tmpdir(), 'lettabot-hook-module-'));
    const hookPath = join(hookDir, 'hooks.mjs');
    writeFileSync(
      hookPath,
      [
        'export async function preMessage(ctx) {',
        "  return `${ctx.message} [hooked]`;",
        '}',
      ].join('\n'),
      'utf-8',
    );

    const mockSession = makeSession();
    vi.mocked(createSession).mockReturnValue(mockSession as never);
    vi.mocked(resumeSession).mockReturnValue(mockSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
      hooks: {
        preMessage: { file: './hooks.mjs', mode: 'await' },
      },
      hooksDir: hookDir,
    });

    await bot.sendToAgent('hello');

    expect(mockSession.send).toHaveBeenCalledWith('hello [hooked]');
  });

  it('invokes postMessage hook with response text', async () => {
    const hookDir = mkdtempSync(join(tmpdir(), 'lettabot-hook-module-'));
    const hookPath = join(hookDir, 'hooks.mjs');
    writeFileSync(
      hookPath,
      [
        'globalThis.__hookEvents = globalThis.__hookEvents || [];',
        'export async function postMessage(ctx) {',
        '  globalThis.__hookEvents.push({',
        "    stage: 'post',",
        '    response: ctx.response,',
        '    delivered: ctx.delivered,',
        '    error: ctx.error,',
        '  });',
        '}',
      ].join('\n'),
      'utf-8',
    );

    const mockSession = makeSession();
    vi.mocked(createSession).mockReturnValue(mockSession as never);
    vi.mocked(resumeSession).mockReturnValue(mockSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
      hooks: {
        postMessage: { file: './hooks.mjs', mode: 'await' },
      },
      hooksDir: hookDir,
    });

    await bot.sendToAgent('ping');

    const events = (globalThis as any).__hookEvents as Array<{ response?: string; delivered?: boolean }>;
    expect(events).toHaveLength(1);
    expect(events[0].response).toBe('ack');
    expect(events[0].delivered).toBe(false);
  });

  it('allows postMessage hook to override sendToAgent response', async () => {
    const hookDir = mkdtempSync(join(tmpdir(), 'lettabot-hook-module-'));
    const hookPath = join(hookDir, 'hooks.mjs');
    writeFileSync(
      hookPath,
      [
        'export async function postMessage(ctx) {',
        "  return `${ctx.response} [post]`;",
        '}',
      ].join('\n'),
      'utf-8',
    );

    const mockSession = makeSession();
    vi.mocked(createSession).mockReturnValue(mockSession as never);
    vi.mocked(resumeSession).mockReturnValue(mockSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
      hooks: {
        postMessage: { file: './hooks.mjs', mode: 'await' },
      },
      hooksDir: hookDir,
    });

    const response = await bot.sendToAgent('ping');

    expect(response).toBe('ack [post]');
  });

  it('marks heartbeat triggers in hook context', async () => {
    const hookDir = mkdtempSync(join(tmpdir(), 'lettabot-hook-module-'));
    const hookPath = join(hookDir, 'hooks.mjs');
    writeFileSync(
      hookPath,
      [
        'globalThis.__hookEvents = globalThis.__hookEvents || [];',
        'export async function preMessage(ctx) {',
        '  globalThis.__hookEvents.push({ isHeartbeat: ctx.isHeartbeat });',
        '}',
      ].join('\n'),
      'utf-8',
    );

    const mockSession = makeSession();
    vi.mocked(createSession).mockReturnValue(mockSession as never);
    vi.mocked(resumeSession).mockReturnValue(mockSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
      hooks: {
        preMessage: { file: './hooks.mjs', mode: 'await' },
      },
      hooksDir: hookDir,
    });

    await bot.sendToAgent('heartbeat ping', { type: 'heartbeat', outputMode: 'silent' });

    const events = (globalThis as any).__hookEvents as Array<{ isHeartbeat?: boolean }>;
    expect(events).toHaveLength(1);
    expect(events[0].isHeartbeat).toBe(true);
  });

  it('flags suppressed delivery in postMessage hook without blocking', async () => {
    const hookDir = mkdtempSync(join(tmpdir(), 'lettabot-hook-module-'));
    const hookPath = join(hookDir, 'hooks.mjs');
    writeFileSync(
      hookPath,
      [
        'globalThis.__hookEvents = globalThis.__hookEvents || [];',
        'export async function postMessage(ctx) {',
        '  await new Promise(resolve => setTimeout(resolve, 10));',
        '  globalThis.__hookEvents.push({ suppressDelivery: ctx.suppressDelivery });',
        '}',
      ].join('\n'),
      'utf-8',
    );

    const mockSession = makeSession();
    vi.mocked(createSession).mockReturnValue(mockSession as never);
    vi.mocked(resumeSession).mockReturnValue(mockSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
      hooks: {
        postMessage: { file: './hooks.mjs', mode: 'await' },
      },
      hooksDir: hookDir,
    });

    const adapter = {
      id: 'telegram',
      name: 'Telegram',
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      isRunning: vi.fn(() => true),
      sendMessage: vi.fn(async () => ({ messageId: '1' })),
      editMessage: vi.fn(async () => undefined),
      sendTypingIndicator: vi.fn(async () => undefined),
      stopTypingIndicator: vi.fn(async () => undefined),
      supportsEditing: () => true,
    };

    const message = {
      channel: 'telegram',
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'hello',
      timestamp: new Date(),
      isListeningMode: true,
    };

    await (bot as any).processMessage(message, adapter);

    await waitFor(() => (globalThis as any).__hookEvents.length === 1);
    const events = (globalThis as any).__hookEvents as Array<{ suppressDelivery?: boolean }>;
    expect(events[0].suppressDelivery).toBe(true);
  });
});

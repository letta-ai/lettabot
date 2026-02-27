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

vi.mock('../tools/letta-api.js', () => ({
  updateAgentName: vi.fn(),
  getPendingApprovals: vi.fn(),
  rejectApproval: vi.fn(),
  cancelRuns: vi.fn(),
  recoverOrphanedConversationApproval: vi.fn(),
  getLatestRunError: vi.fn().mockResolvedValue(null),
}));

vi.mock('../skills/loader.js', () => ({
  installSkillsToAgent: vi.fn(),
  withAgentSkillsOnPath: vi.fn((_id: string, fn: () => unknown) => fn()),
  getAgentSkillExecutableDirs: vi.fn().mockReturnValue([]),
  isVoiceMemoConfigured: vi.fn().mockReturnValue(false),
}));

vi.mock('./memory.js', () => ({
  loadMemoryBlocks: vi.fn().mockReturnValue([]),
}));

vi.mock('./system-prompt.js', () => ({
  SYSTEM_PROMPT: 'test system prompt',
}));

import { createAgent, createSession, resumeSession } from '@letta-ai/letta-code-sdk';
import { getLatestRunError } from '../tools/letta-api.js';
import { LettaBot } from './bot.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('SDK session contract', () => {
  let dataDir: string;
  let originalDataDir: string | undefined;
  let originalAgentId: string | undefined;
  let originalRailwayMount: string | undefined;
  let originalSessionTimeout: string | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'lettabot-sdk-contract-'));
    originalDataDir = process.env.DATA_DIR;
    originalAgentId = process.env.LETTA_AGENT_ID;
    originalRailwayMount = process.env.RAILWAY_VOLUME_MOUNT_PATH;
    originalSessionTimeout = process.env.LETTA_SESSION_TIMEOUT_MS;

    process.env.DATA_DIR = dataDir;
    process.env.LETTA_AGENT_ID = 'agent-contract-test';
    delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
    delete process.env.LETTA_SESSION_TIMEOUT_MS;

    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;

    if (originalAgentId === undefined) delete process.env.LETTA_AGENT_ID;
    else process.env.LETTA_AGENT_ID = originalAgentId;

    if (originalRailwayMount === undefined) delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
    else process.env.RAILWAY_VOLUME_MOUNT_PATH = originalRailwayMount;

    if (originalSessionTimeout === undefined) delete process.env.LETTA_SESSION_TIMEOUT_MS;
    else process.env.LETTA_SESSION_TIMEOUT_MS = originalSessionTimeout;

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

  it('accumulates tool_call arguments when continuation chunks omit toolCallId', async () => {
    const mockSession = {
      initialize: vi.fn(async () => undefined),
      send: vi.fn(async (_message: unknown) => undefined),
      stream: vi.fn(() =>
        (async function* () {
          yield { type: 'tool_call', toolCallId: 'tc-1', toolName: 'Bash', rawArguments: '{"command":"ec' };
          yield { type: 'tool_call', toolName: 'Bash', rawArguments: 'ho hi"}' };
          yield { type: 'assistant', content: 'done' };
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

    const chunks: Array<Record<string, unknown>> = [];
    for await (const msg of bot.streamToAgent('test')) {
      chunks.push(msg as Record<string, unknown>);
    }

    const toolCalls = chunks.filter((m) => m.type === 'tool_call');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].toolCallId).toBe('tc-1');
    expect(toolCalls[0].toolInput).toEqual({ command: 'echo hi' });
  });

  it('closes session if initialize times out before first send', async () => {
    process.env.LETTA_SESSION_TIMEOUT_MS = '5';

    const mockSession = {
      initialize: vi.fn(() => new Promise<never>(() => {})),
      send: vi.fn(async (_message: unknown) => undefined),
      stream: vi.fn(() =>
        (async function* () {
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

    await expect(bot.sendToAgent('will timeout')).rejects.toThrow('Session initialize (key=shared) timed out after 5ms');
    expect(mockSession.close).toHaveBeenCalledTimes(1);
  });

  it('invalidates retry session when fallback send fails after conversation-missing error', async () => {
    const missingConversation = new Error('conversation not found');
    const retryFailure = new Error('network down');

    const firstSession = {
      initialize: vi.fn(async () => undefined),
      send: vi.fn(async () => {
        throw missingConversation;
      }),
      stream: vi.fn(() =>
        (async function* () {
          yield { type: 'result', success: true };
        })()
      ),
      close: vi.fn(() => undefined),
      agentId: 'agent-contract-test',
      conversationId: 'conversation-contract-test-1',
    };

    const secondSession = {
      initialize: vi.fn(async () => undefined),
      send: vi.fn(async () => {
        throw retryFailure;
      }),
      stream: vi.fn(() =>
        (async function* () {
          yield { type: 'result', success: true };
        })()
      ),
      close: vi.fn(() => undefined),
      agentId: 'agent-contract-test',
      conversationId: 'conversation-contract-test-2',
    };

    vi.mocked(createSession)
      .mockReturnValueOnce(firstSession as never)
      .mockReturnValueOnce(secondSession as never);
    vi.mocked(resumeSession).mockReturnValue(firstSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
    });

    await expect(bot.sendToAgent('trigger fallback')).rejects.toThrow('network down');
    expect(firstSession.close).toHaveBeenCalledTimes(1);
    expect(secondSession.close).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createSession)).toHaveBeenCalledTimes(2);
  });

  it('reset ignores stale in-flight warm session and creates a fresh one', async () => {
    const init = deferred<void>();

    const warmSession = {
      initialize: vi.fn(() => init.promise),
      bootstrapState: vi.fn(async () => ({ hasPendingApproval: false, conversationId: 'conv-old' })),
      send: vi.fn(async (_message: unknown) => undefined),
      stream: vi.fn(() =>
        (async function* () {
          yield { type: 'result', success: true };
        })()
      ),
      close: vi.fn(() => undefined),
      agentId: 'agent-contract-test',
      conversationId: 'conv-old',
    };

    const resetSession = {
      initialize: vi.fn(async () => undefined),
      bootstrapState: vi.fn(async () => ({ hasPendingApproval: false, conversationId: 'conv-new' })),
      send: vi.fn(async (_message: unknown) => undefined),
      stream: vi.fn(() =>
        (async function* () {
          yield { type: 'result', success: true };
        })()
      ),
      close: vi.fn(() => undefined),
      agentId: 'agent-contract-test',
      conversationId: 'conv-new',
    };

    vi.mocked(resumeSession).mockReturnValue(warmSession as never);
    vi.mocked(createSession).mockReturnValue(resetSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
    });

    // Simulate an existing shared conversation being pre-warmed.
    bot.setAgentId('agent-contract-test');
    const botInternal = bot as unknown as {
      store: { conversationId: string | null };
      handleCommand: (command: string, channelId?: string) => Promise<string | null>;
    };
    botInternal.store.conversationId = 'conv-old';

    const warmPromise = bot.warmSession();
    await Promise.resolve();

    const resetPromise = botInternal.handleCommand('reset');

    init.resolve();
    await warmPromise;
    const resetMessage = await resetPromise;

    expect(resetMessage).toContain('New conversation: conv-new');
    expect(warmSession.close).toHaveBeenCalledTimes(1);
    expect(resetSession.initialize).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createSession)).toHaveBeenCalledTimes(1);
  });

  it('does not pre-warm a shared session in per-chat mode', async () => {
    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
      conversationMode: 'per-chat',
    });
    bot.setAgentId('agent-contract-test');

    await bot.warmSession();

    expect(vi.mocked(createSession)).not.toHaveBeenCalled();
    expect(vi.mocked(resumeSession)).not.toHaveBeenCalled();
  });

  it('passes memfs: true to createSession when config sets memfs true', async () => {
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

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
      memfs: true,
    });

    await bot.sendToAgent('test');

    const opts = vi.mocked(createSession).mock.calls[0][1];
    expect(opts).toHaveProperty('memfs', true);
  });

  it('passes memfs: false to createSession when config sets memfs false', async () => {
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

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
      memfs: false,
    });

    await bot.sendToAgent('test');

    const opts = vi.mocked(createSession).mock.calls[0][1];
    expect(opts).toHaveProperty('memfs', false);
  });

  it('omits memfs key from createSession options when config memfs is undefined', async () => {
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

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
      // memfs intentionally omitted
    });

    await bot.sendToAgent('test');

    const opts = vi.mocked(createSession).mock.calls[0][1];
    expect(opts).not.toHaveProperty('memfs');
  });

  it('restarts a keyed queue after non-shared lock release when backlog exists', async () => {
    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
    });
    const botInternal = bot as any;

    botInternal.processingKeys.add('slack');
    botInternal.keyedQueues.set('slack', [
      {
        msg: {
          userId: 'u1',
          channel: 'slack',
          chatId: 'C123',
          text: 'queued while locked',
          timestamp: new Date(),
          isGroup: false,
        },
        adapter: {},
      },
    ]);

    const processSpy = vi.spyOn(botInternal, 'processKeyedQueue').mockResolvedValue(undefined);
    botInternal.releaseLock('slack', true);

    expect(botInternal.processingKeys.has('slack')).toBe(false);
    expect(processSpy).toHaveBeenCalledWith('slack');
  });

  it('LRU eviction in per-chat mode does not close active keys', async () => {
    const createdSession = {
      initialize: vi.fn(async () => undefined),
      send: vi.fn(async (_message: unknown) => undefined),
      stream: vi.fn(() =>
        (async function* () {
          yield { type: 'result', success: true };
        })()
      ),
      close: vi.fn(() => undefined),
      agentId: 'agent-contract-test',
      conversationId: 'conv-new',
    };
    vi.mocked(createSession).mockReturnValue(createdSession as never);

    const activeSession = {
      close: vi.fn(() => undefined),
    };
    const idleSession = {
      close: vi.fn(() => undefined),
    };

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
      conversationMode: 'per-chat',
      maxSessions: 2,
    });
    bot.setAgentId('agent-contract-test');

    const botInternal = bot as any;
    botInternal.sessions.set('telegram:active', activeSession);
    botInternal.sessions.set('telegram:idle', idleSession);
    botInternal.sessionLastUsed.set('telegram:active', 1);
    botInternal.sessionLastUsed.set('telegram:idle', 2);
    botInternal.processingKeys.add('telegram:active');

    await botInternal._createSessionForKey('telegram:new', true, 0);

    expect(activeSession.close).not.toHaveBeenCalled();
    expect(idleSession.close).toHaveBeenCalledTimes(1);
    expect(botInternal.sessions.has('telegram:active')).toBe(true);
    expect(botInternal.sessions.has('telegram:idle')).toBe(false);
    expect(botInternal.sessions.has('telegram:new')).toBe(true);
  });

  it('enriches opaque error via stream error event in sendToAgent', async () => {
    const mockSession = {
      initialize: vi.fn(async () => undefined),
      send: vi.fn(async (_message: unknown) => undefined),
      stream: vi.fn(() =>
        (async function* () {
          yield { type: 'error', message: 'Bad request to Anthropic: context too long', stopReason: 'llm_api_error' };
          yield { type: 'result', success: false, error: 'error' };
        })()
      ),
      close: vi.fn(() => undefined),
      agentId: 'agent-contract-test',
      conversationId: 'conversation-contract-test',
    };

    vi.mocked(createSession).mockReturnValue(mockSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
    });

    await expect(bot.sendToAgent('trigger error')).rejects.toThrow(
      'Bad request to Anthropic: context too long'
    );
  });

  it('enriches error from run metadata when stream error is opaque', async () => {
    const mockSession = {
      initialize: vi.fn(async () => undefined),
      send: vi.fn(async (_message: unknown) => undefined),
      stream: vi.fn(() =>
        (async function* () {
          yield { type: 'result', success: false, error: 'error', conversationId: 'conv-123' };
        })()
      ),
      close: vi.fn(() => undefined),
      agentId: 'agent-contract-test',
      conversationId: 'conv-123',
    };

    vi.mocked(createSession).mockReturnValue(mockSession as never);
    vi.mocked(getLatestRunError).mockResolvedValueOnce({
      message: 'INTERNAL_SERVER_ERROR: Bad request to Anthropic: Error code: 400',
      stopReason: 'llm_api_error',
      isApprovalError: false,
    });

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
    });

    await expect(bot.sendToAgent('trigger error')).rejects.toThrow(
      'INTERNAL_SERVER_ERROR: Bad request to Anthropic: Error code: 400'
    );
    expect(getLatestRunError).toHaveBeenCalledWith('agent-contract-test', 'conv-123');
  });

  it('falls back to msg.error when no enrichment is available', async () => {
    const mockSession = {
      initialize: vi.fn(async () => undefined),
      send: vi.fn(async (_message: unknown) => undefined),
      stream: vi.fn(() =>
        (async function* () {
          yield { type: 'result', success: false, error: 'timeout' };
        })()
      ),
      close: vi.fn(() => undefined),
      agentId: 'agent-contract-test',
      conversationId: 'conversation-contract-test',
    };

    vi.mocked(createSession).mockReturnValue(mockSession as never);
    vi.mocked(getLatestRunError).mockResolvedValueOnce(null);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
    });

    await expect(bot.sendToAgent('trigger error')).rejects.toThrow(
      'Agent run failed: timeout'
    );
  });

  it('passes tags: [origin:lettabot] to createAgent when creating a new agent', async () => {
    delete process.env.LETTA_AGENT_ID;

    vi.mocked(createAgent).mockResolvedValue('agent-new-tagged');

    const mockSession = {
      initialize: vi.fn(async () => undefined),
      send: vi.fn(async (_message: unknown) => undefined),
      stream: vi.fn(() =>
        (async function* () {
          yield { type: 'assistant', content: 'hello' };
          yield { type: 'result', success: true };
        })()
      ),
      close: vi.fn(() => undefined),
      agentId: 'agent-new-tagged',
      conversationId: 'conversation-new-tagged',
    };

    vi.mocked(createSession).mockReturnValue(mockSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
    });

    await bot.sendToAgent('first message');

    expect(vi.mocked(createAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createAgent)).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: ['origin:lettabot'],
      })
    );
  });

  it('does not leak stale stream events between consecutive sendToAgent calls', async () => {
    // Simulates the real SDK behavior prior to 0.1.8: the shared streamQueue
    // retains events that arrive after the result message. When the next
    // stream() call starts, it reads these stale events first, causing the
    // N-1 desync and silent-mode heartbeat leak.
    const sharedQueue: Array<{ type: string; content?: string; success?: boolean }> = [];
    let sendCount = 0;

    const mockSession = {
      initialize: vi.fn(async () => undefined),
      send: vi.fn(async () => {
        // SDK 0.1.8 fix: clear stale events from previous run on every send().
        // Without this line, stale events from run A leak into run B's stream.
        sharedQueue.length = 0;

        if (sendCount === 0) {
          // First run: response A, result, then trailing stale events that
          // arrive in the background pump AFTER the result has been yielded.
          sharedQueue.push(
            { type: 'assistant', content: 'response-A' },
            { type: 'result', success: true },
            // Stale event that would leak into next stream() without the fix:
            { type: 'assistant', content: 'stale-heartbeat-text' },
          );
        } else {
          // Second run: response B
          sharedQueue.push(
            { type: 'assistant', content: 'response-B' },
            { type: 'result', success: true },
          );
        }
        sendCount++;
      }),
      stream: vi.fn(() =>
        (async function* () {
          while (sharedQueue.length > 0) {
            const msg = sharedQueue.shift()!;
            yield msg;
            if (msg.type === 'result') break;
          }
        })()
      ),
      close: vi.fn(() => undefined),
      agentId: 'agent-queue-leak-test',
      conversationId: 'conversation-queue-leak-test',
    };

    vi.mocked(createSession).mockReturnValue(mockSession as never);
    vi.mocked(resumeSession).mockReturnValue(mockSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
    });

    const responseA = await bot.sendToAgent('first message');
    expect(responseA).toBe('response-A');

    const responseB = await bot.sendToAgent('second message');
    // Before the SDK 0.1.8 fix, responseB would be 'stale-heartbeat-text'
    // because the sharedQueue still had the trailing event from run A.
    // With the fix (queue cleared on send), responseB is 'response-B'.
    expect(responseB).toBe('response-B');
  });
});

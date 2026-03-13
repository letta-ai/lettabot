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
  updateAgentName: vi.fn().mockResolvedValue(undefined),
  getPendingApprovals: vi.fn(),
  rejectApproval: vi.fn(),
  cancelRuns: vi.fn(),
  recoverOrphanedConversationApproval: vi.fn(),
  recoverPendingApprovalsForAgent: vi.fn(),
  isRecoverableConversationId: vi.fn((conversationId?: string | null) => (
    typeof conversationId === 'string' && conversationId.length > 0
      && conversationId !== 'default'
      && conversationId !== 'shared'
  )),
  getLatestRunError: vi.fn().mockResolvedValue(null),
}));

vi.mock('../skills/loader.js', () => ({
  installSkillsToAgent: vi.fn(),
  prependSkillDirsToPath: vi.fn(),
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
import { getLatestRunError, recoverOrphanedConversationApproval, recoverPendingApprovalsForAgent } from '../tools/letta-api.js';
import { LettaBot } from './bot.js';
import { SessionManager } from './session-manager.js';
import { Store } from './store.js';

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
    vi.mocked(recoverPendingApprovalsForAgent).mockResolvedValue({
      recovered: false,
      details: 'No pending approvals found on agent',
    });
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

    vi.mocked(resumeSession).mockReturnValue(mockSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
    });

    await bot.sendToAgent('first message');
    await bot.sendToAgent('second message');

    expect(vi.mocked(createSession)).not.toHaveBeenCalled();
    expect(vi.mocked(resumeSession)).toHaveBeenCalledTimes(1);
    expect(mockSession.initialize).toHaveBeenCalledTimes(1);
    expect(mockSession.send).toHaveBeenCalledTimes(2);
    expect(mockSession.send).toHaveBeenNthCalledWith(1, 'first message');
    expect(mockSession.send).toHaveBeenNthCalledWith(2, 'second message');
    expect(mockSession.stream).toHaveBeenCalledTimes(2);
  });

  it('does not include reasoning chunks in sendToAgent responses', async () => {
    const mockSession = {
      initialize: vi.fn(async () => undefined),
      send: vi.fn(async (_message: unknown) => undefined),
      stream: vi.fn(() =>
        (async function* () {
          yield { type: 'reasoning', content: 'internal-thought-1' };
          yield { type: 'assistant', content: 'public-response' };
          yield { type: 'reasoning', content: 'internal-thought-2' };
          yield { type: 'assistant', content: ' continues' };
          yield { type: 'result', success: true };
        })()
      ),
      close: vi.fn(() => undefined),
      agentId: 'agent-contract-test',
      conversationId: 'conversation-contract-test',
    };

    vi.mocked(resumeSession).mockReturnValue(mockSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
    });

    const response = await bot.sendToAgent('test message');

    expect(response).toBe('public-response continues');
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

  it('recreates agent after explicit agent-not-found initialize error', async () => {
    delete process.env.LETTA_AGENT_ID;

    const staleSession = {
      initialize: vi.fn(async () => {
        throw new Error('No init message received from subprocess. stderr: {"detail":"Agent agent-contract-test not found"}');
      }),
      send: vi.fn(async (_message: unknown) => undefined),
      stream: vi.fn(() =>
        (async function* () {
          yield { type: 'result', success: true };
        })()
      ),
      close: vi.fn(() => undefined),
      agentId: 'agent-contract-test',
      conversationId: 'conv-stale',
    };

    const recoveredSession = {
      initialize: vi.fn(async () => undefined),
      send: vi.fn(async (_message: unknown) => undefined),
      stream: vi.fn(() =>
        (async function* () {
          yield { type: 'assistant', content: 'fresh response' };
          yield { type: 'result', success: true };
        })()
      ),
      close: vi.fn(() => undefined),
      agentId: 'agent-recreated',
      conversationId: 'conv-recreated',
    };

    vi.mocked(createAgent).mockResolvedValue('agent-recreated');
    // First call: agentId exists, no convId → resumeSession(agentId)
    vi.mocked(resumeSession).mockReturnValueOnce(staleSession as never);
    // After clearAgent + createAgent → createSession(newAgentId)
    vi.mocked(createSession).mockReturnValueOnce(recoveredSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
      agentName: 'ContractBot',
    });
    bot.setAgentId('agent-contract-test');

    const response = await bot.sendToAgent('recover me');
    expect(response).toBe('fresh response');
    expect(staleSession.close).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(resumeSession).mock.calls[0][0]).toBe('agent-contract-test');
    expect(vi.mocked(createSession).mock.calls[0][0]).toBe('agent-recreated');
  });

  it('does not clear agent state on generic initialize failures', async () => {
    const initFailure = new Error('No init message received from subprocess');
    const failingSession = {
      initialize: vi.fn(async () => {
        throw initFailure;
      }),
      send: vi.fn(async (_message: unknown) => undefined),
      stream: vi.fn(() =>
        (async function* () {
          yield { type: 'result', success: true };
        })()
      ),
      close: vi.fn(() => undefined),
      agentId: 'agent-contract-test',
      conversationId: 'conv-keep',
    };

    vi.mocked(resumeSession).mockReturnValue(failingSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
    });
    bot.setAgentId('agent-contract-test');
    const botInternal = bot as unknown as { store: { conversationId: string | null } };
    botInternal.store.conversationId = 'conv-keep';

    await expect(bot.sendToAgent('should fail')).rejects.toThrow('No init message received from subprocess');
    expect(failingSession.close).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createAgent)).not.toHaveBeenCalled();
    expect(vi.mocked(createSession)).not.toHaveBeenCalled();
    expect(vi.mocked(resumeSession)).toHaveBeenCalledTimes(1);
    expect(bot.getStatus().agentId).toBe('agent-contract-test');
    expect(bot.getStatus().conversationId).toBe('conv-keep');
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

    vi.mocked(resumeSession)
      .mockReturnValueOnce(firstSession as never)
      .mockReturnValueOnce(secondSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
    });

    await expect(bot.sendToAgent('trigger fallback')).rejects.toThrow('network down');
    expect(firstSession.close).toHaveBeenCalledTimes(1);
    expect(secondSession.close).toHaveBeenCalledTimes(1);
    expect(vi.mocked(resumeSession)).toHaveBeenCalledTimes(2);
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

    vi.mocked(resumeSession)
      .mockReturnValueOnce(warmSession as never)
      .mockReturnValueOnce(resetSession as never);

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
    expect(vi.mocked(resumeSession)).toHaveBeenCalledTimes(2);
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

  it('uses agent-level proactive recovery when bootstrap conversation id is default alias', async () => {
    const initialSession = {
      initialize: vi.fn(async () => undefined),
      bootstrapState: vi.fn(async () => ({ hasPendingApproval: true, conversationId: 'default' })),
      send: vi.fn(async (_message: unknown) => undefined),
      stream: vi.fn(() =>
        (async function* () {
          yield { type: 'result', success: true };
        })()
      ),
      close: vi.fn(() => undefined),
      agentId: 'agent-contract-test',
      conversationId: 'default',
    };

    const recoveredSession = {
      initialize: vi.fn(async () => undefined),
      bootstrapState: vi.fn(async () => ({ hasPendingApproval: false, conversationId: 'default' })),
      send: vi.fn(async (_message: unknown) => undefined),
      stream: vi.fn(() =>
        (async function* () {
          yield { type: 'assistant', content: 'ok' };
          yield { type: 'result', success: true };
        })()
      ),
      close: vi.fn(() => undefined),
      agentId: 'agent-contract-test',
      conversationId: 'default',
    };

    vi.mocked(recoverPendingApprovalsForAgent).mockResolvedValueOnce({
      recovered: true,
      details: 'Rejected 1 pending approval(s) and cancelled 1 run(s)',
    });

    vi.mocked(resumeSession)
      .mockReturnValueOnce(initialSession as never)
      .mockReturnValueOnce(recoveredSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
    });

    const response = await bot.sendToAgent('hello');

    expect(response).toBe('ok');
    expect(vi.mocked(resumeSession)).toHaveBeenCalledTimes(2);
    expect(recoverOrphanedConversationApproval).not.toHaveBeenCalled();
    expect(recoverPendingApprovalsForAgent).toHaveBeenCalledWith('agent-contract-test');
    expect(initialSession.close).toHaveBeenCalledTimes(1);
  });

  it('keeps shared conversation during proactive recovery when details include invalid tool call IDs', async () => {
    const initialSession = {
      initialize: vi.fn(async () => undefined),
      bootstrapState: vi.fn(async () => ({ hasPendingApproval: true, conversationId: 'conv-stuck' })),
      send: vi.fn(async (_message: unknown) => undefined),
      stream: vi.fn(() =>
        (async function* () {
          yield { type: 'result', success: true };
        })()
      ),
      close: vi.fn(() => undefined),
      agentId: 'agent-contract-test',
      conversationId: 'conv-stuck',
    };

    const recoveredSession = {
      initialize: vi.fn(async () => undefined),
      bootstrapState: vi.fn(async () => ({ hasPendingApproval: false, conversationId: 'conv-fresh' })),
      send: vi.fn(async (_message: unknown) => undefined),
      stream: vi.fn(() =>
        (async function* () {
          yield { type: 'assistant', content: 'proactive recovered' };
          yield { type: 'result', success: true };
        })()
      ),
      close: vi.fn(() => undefined),
      agentId: 'agent-contract-test',
      conversationId: 'conv-fresh',
    };

    vi.mocked(recoverOrphanedConversationApproval).mockResolvedValueOnce({
      recovered: true,
      details: "Denied 1 approval(s) from failed run run-ok; Failed to deny 1 approval(s) from run run-stuck: Invalid tool call IDs. Expected '['call_a']', but received '['call_b']'",
    });

    vi.mocked(resumeSession)
      .mockReturnValueOnce(initialSession as never)
      .mockReturnValueOnce(recoveredSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
    });
    bot.setAgentId('agent-contract-test');
    const botInternal = bot as unknown as { store: { conversationId: string | null } };
    botInternal.store.conversationId = 'conv-stuck';

    const response = await bot.sendToAgent('hello');

    expect(response).toBe('proactive recovered');
    expect(recoverOrphanedConversationApproval).toHaveBeenCalledWith(
      'agent-contract-test',
      'conv-stuck',
      true
    );
    expect(vi.mocked(resumeSession)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(resumeSession).mock.calls[0][0]).toBe('conv-stuck');
    expect(vi.mocked(resumeSession).mock.calls[1][0]).toBe('conv-stuck');
    expect(initialSession.close).toHaveBeenCalledTimes(1);
  });

  it('passes memfs: true to resumeSession when config sets memfs true', async () => {
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

    vi.mocked(resumeSession).mockReturnValue(mockSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
      memfs: true,
    });

    await bot.sendToAgent('test');

    const opts = vi.mocked(resumeSession).mock.calls[0][1];
    expect(opts).toHaveProperty('memfs', true);
  });

  it('passes memfs: false to resumeSession when config sets memfs false', async () => {
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

    vi.mocked(resumeSession).mockReturnValue(mockSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
      memfs: false,
    });

    await bot.sendToAgent('test');

    const opts = vi.mocked(resumeSession).mock.calls[0][1];
    expect(opts).toHaveProperty('memfs', false);
  });

  it('omits memfs key from resumeSession options when config memfs is undefined', async () => {
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

    vi.mocked(resumeSession).mockReturnValue(mockSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
      // memfs intentionally omitted
    });

    await bot.sendToAgent('test');

    const opts = vi.mocked(resumeSession).mock.calls[0][1];
    expect(opts).not.toHaveProperty('memfs');
  });

  it('passes sleeptime options to resumeSession when configured', async () => {
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

    vi.mocked(resumeSession).mockReturnValue(mockSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
      sleeptime: {
        trigger: 'step-count',
        behavior: 'reminder',
        stepCount: 25,
      },
    });

    await bot.sendToAgent('test');

    const opts = vi.mocked(resumeSession).mock.calls[0][1];
    expect(opts).toHaveProperty('sleeptime');
    expect((opts as Record<string, unknown>).sleeptime).toEqual({
      trigger: 'step-count',
      behavior: 'reminder',
      stepCount: 25,
    });
  });

  it('omits sleeptime key from resumeSession options when config sleeptime is undefined', async () => {
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

    vi.mocked(resumeSession).mockReturnValue(mockSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
    });

    await bot.sendToAgent('test');

    const opts = vi.mocked(resumeSession).mock.calls[0][1];
    expect(opts).not.toHaveProperty('sleeptime');
  });

  it('keeps canUseTool callbacks isolated for concurrent keyed sessions', async () => {
    const store = new Store(undefined, 'LettaBot');
    store.setAgent('agent-contract-test', 'https://api.letta.com');

    const allowCallbackDispatch = deferred<void>();
    const bothSendsStarted = deferred<void>();
    const callbackResults: Array<{ sessionName: string; answer: string | undefined }> = [];
    let createdSessions = 0;
    let startedSends = 0;

    vi.mocked(createSession).mockImplementation((_id, opts) => {
      const sessionName = createdSessions++ === 0 ? 'chat-a' : 'chat-b';
      return {
        initialize: vi.fn(async () => undefined),
        bootstrapState: vi.fn(async () => ({ hasPendingApproval: false })),
        send: vi.fn(async (_message: unknown) => {
          startedSends += 1;
          if (startedSends === 2) {
            bothSendsStarted.resolve();
          }
          await bothSendsStarted.promise;
          await allowCallbackDispatch.promise;

          const canUseTool = opts?.canUseTool;
          if (!canUseTool) {
            throw new Error('Expected mocked session options to include canUseTool');
          }

          const result = await canUseTool('AskUserQuestion', { sessionName });
          const updatedInput = 'updatedInput' in result
            ? result.updatedInput as Record<string, unknown> | undefined
            : undefined;
          callbackResults.push({
            sessionName,
            answer: typeof updatedInput?.answer === 'string'
              ? updatedInput.answer
              : undefined,
          });
        }),
        stream: vi.fn(() =>
          (async function* () {
            yield { type: 'result', success: true };
          })()
        ),
        close: vi.fn(() => undefined),
        agentId: 'agent-contract-test',
        conversationId: `${sessionName}-conversation`,
      } as never;
    });

    const canUseToolA = vi.fn(async () => ({
      behavior: 'allow' as const,
      updatedInput: { answer: 'from-chat-a' },
    }));
    const canUseToolB = vi.fn(async () => ({
      behavior: 'allow' as const,
      updatedInput: { answer: 'from-chat-b' },
    }));

    const sessionManager = new SessionManager(
      store,
      {
        workingDir: join(dataDir, 'working'),
        allowedTools: [],
        conversationMode: 'per-chat',
      },
      new Set<string>(),
      new Map<string, string>(),
    );

    const runA = sessionManager.runSession('message-a', {
      convKey: 'slack:C123',
      canUseTool: canUseToolA,
    });
    const runB = sessionManager.runSession('message-b', {
      convKey: 'discord:C456',
      canUseTool: canUseToolB,
    });

    await bothSendsStarted.promise;
    allowCallbackDispatch.resolve();
    await Promise.all([runA, runB]);

    expect(canUseToolA).toHaveBeenCalledTimes(1);
    expect(canUseToolB).toHaveBeenCalledTimes(1);
    expect(callbackResults).toEqual([
      { sessionName: 'chat-a', answer: 'from-chat-a' },
      { sessionName: 'chat-b', answer: 'from-chat-b' },
    ]);
  });

  it('treats dedicated heartbeat sends as a keyed lock target', async () => {
    vi.useFakeTimers();
    try {
      const bot = new LettaBot({
        workingDir: join(dataDir, 'working'),
        allowedTools: [],
        heartbeatConversation: 'dedicated',
      });
      const botInternal = bot as any;

      const acquiredFirst = await botInternal.acquireLock('heartbeat');
      let secondResolved = false;
      const secondAcquire = botInternal.acquireLock('heartbeat').then((value: boolean) => {
        secondResolved = true;
        return value;
      });

      await Promise.resolve();

      expect(acquiredFirst).toBe(true);
      expect(botInternal.processingKeys.has('heartbeat')).toBe(true);
      expect(secondResolved).toBe(false);

      botInternal.releaseLock('heartbeat', acquiredFirst);
      await vi.advanceTimersByTimeAsync(1000);

      expect(await secondAcquire).toBe(true);
      botInternal.releaseLock('heartbeat', true);
    } finally {
      vi.useRealTimers();
    }
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
    const sm = botInternal.sessionManager;
    sm.sessions.set('telegram:active', activeSession);
    sm.sessions.set('telegram:idle', idleSession);
    sm.sessionLastUsed.set('telegram:active', 1);
    sm.sessionLastUsed.set('telegram:idle', 2);
    botInternal.processingKeys.add('telegram:active');

    await sm._createSessionForKey('telegram:new', true, 0);

    expect(activeSession.close).not.toHaveBeenCalled();
    expect(idleSession.close).toHaveBeenCalledTimes(1);
    expect(sm.sessions.has('telegram:active')).toBe(true);
    expect(sm.sessions.has('telegram:idle')).toBe(false);
    expect(sm.sessions.has('telegram:new')).toBe(true);
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

    vi.mocked(resumeSession).mockReturnValue(mockSession as never);

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

    vi.mocked(resumeSession).mockReturnValue(mockSession as never);
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

    vi.mocked(resumeSession).mockReturnValue(mockSession as never);
    vi.mocked(getLatestRunError).mockResolvedValueOnce(null);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
    });

    await expect(bot.sendToAgent('trigger error')).rejects.toThrow(
      'Agent run failed: timeout'
    );
  });

  it('retries sendToAgent once after approval-stuck result error and succeeds', async () => {
    let streamCall = 0;
    const mockSession = {
      initialize: vi.fn(async () => undefined),
      send: vi.fn(async (_message: unknown) => undefined),
      stream: vi.fn(() => {
        const call = streamCall++;
        return (async function* () {
          if (call === 0) {
            yield { type: 'result', success: false, error: 'error', conversationId: 'conv-approval' };
            return;
          }
          yield { type: 'assistant', content: 'recovered response' };
          yield { type: 'result', success: true, result: 'done', conversationId: 'conv-approval' };
        })();
      }),
      close: vi.fn(() => undefined),
      agentId: 'agent-contract-test',
      conversationId: 'conv-approval',
    };

    vi.mocked(resumeSession).mockReturnValue(mockSession as never);
    vi.mocked(getLatestRunError).mockResolvedValueOnce({
      message: 'Run run-stuck stuck waiting for tool approval (status=created)',
      stopReason: 'requires_approval',
      isApprovalError: true,
    });

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
    });

    const response = await bot.sendToAgent('trigger approval retry');
    expect(response).toBe('recovered response');
    expect(mockSession.send).toHaveBeenCalledTimes(2);
    expect(getLatestRunError).toHaveBeenCalledWith('agent-contract-test', 'conv-approval');
  });

  it('retries processMessage once after approval conflict even when orphan scan finds nothing', async () => {
    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
    });

    let runCall = 0;
    (bot as any).sessionManager.runSession = vi.fn(async () => ({
      session: { abort: vi.fn(async () => undefined) },
      stream: async function* () {
        if (runCall++ === 0) {
          yield { type: 'result', success: false, error: 'error', conversationId: 'conv-approval' };
          return;
        }
        yield { type: 'assistant', content: 'after retry' };
        yield { type: 'result', success: true, result: 'after retry', conversationId: 'conv-approval' };
      },
    }));

    vi.mocked(getLatestRunError).mockResolvedValueOnce({
      message: 'Run run-stuck stuck waiting for tool approval (status=created)',
      stopReason: 'requires_approval',
      isApprovalError: true,
    });
    vi.mocked(recoverOrphanedConversationApproval).mockResolvedValueOnce({
      recovered: false,
      details: 'No unresolved approval requests found',
    });

    const adapter = {
      id: 'mock',
      name: 'Mock',
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      isRunning: vi.fn(() => true),
      sendMessage: vi.fn(async (_payload: unknown) => ({ messageId: 'msg-1' })),
      editMessage: vi.fn(async () => {}),
      sendTypingIndicator: vi.fn(async () => {}),
      stopTypingIndicator: vi.fn(async () => {}),
      supportsEditing: vi.fn(() => false),
      sendFile: vi.fn(async () => ({ messageId: 'file-1' })),
    };

    const msg = {
      channel: 'discord',
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'hello',
      timestamp: new Date(),
    };

    await (bot as any).processMessage(msg, adapter);

    expect((bot as any).sessionManager.runSession).toHaveBeenCalledTimes(2);
    expect(recoverOrphanedConversationApproval).toHaveBeenCalledWith(
      'agent-contract-test',
      'conv-approval',
      true
    );
    const sentTexts = adapter.sendMessage.mock.calls.map((call) => {
      const payload = call[0] as { text?: string };
      return payload.text;
    });
    expect(sentTexts).toContain('after retry');
  });

  it('filters pre-foreground errors so they do not trigger false approval recovery', async () => {
    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
    });

    let runCall = 0;
    (bot as any).sessionManager.runSession = vi.fn(async () => ({
      session: { abort: vi.fn(async () => undefined) },
      stream: async function* () {
        if (runCall++ === 0) {
          // Pre-foreground error is filtered by the pipeline -- it never
          // reaches processMessage, so lastErrorDetail stays null and
          // isApprovalConflict cannot fire.
          yield {
            type: 'error',
            runId: 'run-bg',
            message: 'CONFLICT: Cannot send a new message: waiting for approval',
            stopReason: 'error',
          };
          yield { type: 'result', success: false, error: 'error', conversationId: 'conv-approval', runIds: ['run-main'] };
          return;
        }
        // Retry succeeds
        yield { type: 'assistant', content: 'after retry' };
        yield { type: 'result', success: true, result: 'after retry', conversationId: 'conv-approval', runIds: ['run-main-2'] };
      },
    }));

    vi.mocked(recoverOrphanedConversationApproval).mockResolvedValueOnce({
      recovered: false,
      details: 'No unresolved approval requests found',
    });

    const adapter = {
      id: 'mock',
      name: 'Mock',
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      isRunning: vi.fn(() => true),
      sendMessage: vi.fn(async (_payload: unknown) => ({ messageId: 'msg-1' })),
      editMessage: vi.fn(async () => {}),
      sendTypingIndicator: vi.fn(async () => {}),
      stopTypingIndicator: vi.fn(async () => {}),
      supportsEditing: vi.fn(() => false),
      sendFile: vi.fn(async () => ({ messageId: 'file-1' })),
    };

    const msg = {
      channel: 'discord',
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'hello',
      timestamp: new Date(),
    };

    await (bot as any).processMessage(msg, adapter);

    // The pre-foreground error is filtered, so lastErrorDetail is null.
    // The result (success=false, nothing delivered) triggers shouldRetryForErrorResult,
    // NOT isApprovalConflict. The retry goes through the error-result path with
    // orphaned approval recovery, then retries and succeeds.
    expect((bot as any).sessionManager.runSession).toHaveBeenCalledTimes(2);
    // Approval recovery should have been attempted via the error-result path
    expect(recoverOrphanedConversationApproval).toHaveBeenCalledWith(
      'agent-contract-test',
      'conv-approval',
    );
    const sentTexts = adapter.sendMessage.mock.calls.map((call) => {
      const payload = call[0] as { text?: string };
      return payload.text;
    });
    expect(sentTexts).toContain('after retry');
  });

  it('uses agent-level recovery for default conversation alias on terminal approval conflict', async () => {
    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
    });

    let runCall = 0;
    (bot as any).sessionManager.runSession = vi.fn(async () => ({
      session: { abort: vi.fn(async () => undefined) },
      stream: async function* () {
        if (runCall++ === 0) {
          yield { type: 'result', success: false, error: 'error', conversationId: 'default' };
          return;
        }
        yield { type: 'assistant', content: 'after default recovery' };
        yield { type: 'result', success: true, result: 'after default recovery', conversationId: 'default' };
      },
    }));

    vi.mocked(getLatestRunError).mockResolvedValueOnce({
      message: 'CONFLICT: Cannot send a new message: The agent is waiting for approval on a tool call.',
      stopReason: 'error',
      isApprovalError: true,
    });
    vi.mocked(recoverPendingApprovalsForAgent).mockResolvedValueOnce({
      recovered: true,
      details: 'Rejected 1 pending approval(s) and cancelled 1 run(s)',
    });

    const adapter = {
      id: 'mock',
      name: 'Mock',
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      isRunning: vi.fn(() => true),
      sendMessage: vi.fn(async (_payload: unknown) => ({ messageId: 'msg-1' })),
      editMessage: vi.fn(async () => {}),
      sendTypingIndicator: vi.fn(async () => {}),
      stopTypingIndicator: vi.fn(async () => {}),
      supportsEditing: vi.fn(() => false),
      sendFile: vi.fn(async () => ({ messageId: 'file-1' })),
    };

    const msg = {
      channel: 'discord',
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'hello',
      timestamp: new Date(),
    };

    await (bot as any).processMessage(msg, adapter);

    expect((bot as any).sessionManager.runSession).toHaveBeenCalledTimes(2);
    expect(recoverOrphanedConversationApproval).not.toHaveBeenCalled();
    expect(recoverPendingApprovalsForAgent).toHaveBeenCalledWith('agent-contract-test');
    const sentTexts = adapter.sendMessage.mock.calls.map((call) => {
      const payload = call[0] as { text?: string };
      return payload.text;
    });
    expect(sentTexts).toContain('after default recovery');
  });

  it('keeps shared conversation during reactive conflict recovery when details include invalid tool call IDs', async () => {
    const conflictError = new Error(
      'CONFLICT: Cannot send a new message: The agent is waiting for approval on a tool call.'
    );

    const stuckSession = {
      initialize: vi.fn(async () => undefined),
      bootstrapState: vi.fn(async () => ({ hasPendingApproval: false, conversationId: 'conv-stuck' })),
      send: vi.fn(async () => {
        throw conflictError;
      }),
      stream: vi.fn(() =>
        (async function* () {
          yield { type: 'result', success: true };
        })()
      ),
      close: vi.fn(() => undefined),
      agentId: 'agent-contract-test',
      conversationId: 'conv-stuck',
    };

    const recoveredSession = {
      initialize: vi.fn(async () => undefined),
      bootstrapState: vi.fn(async () => ({ hasPendingApproval: false, conversationId: 'conv-fresh' })),
      send: vi.fn(async (_message: unknown) => undefined),
      stream: vi.fn(() =>
        (async function* () {
          yield { type: 'assistant', content: 'reactive recovered' };
          yield { type: 'result', success: true };
        })()
      ),
      close: vi.fn(() => undefined),
      agentId: 'agent-contract-test',
      conversationId: 'conv-fresh',
    };

    vi.mocked(recoverOrphanedConversationApproval).mockResolvedValueOnce({
      recovered: true,
      details: "Denied 1 approval(s) from failed run run-ok; Failed to deny 1 approval(s) from run run-stuck: Invalid tool call IDs. Expected '['call_a']', but received '['call_b']'",
    });

    vi.mocked(resumeSession)
      .mockReturnValueOnce(stuckSession as never)
      .mockReturnValueOnce(recoveredSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
    });
    bot.setAgentId('agent-contract-test');
    const botInternal = bot as unknown as { store: { conversationId: string | null } };
    botInternal.store.conversationId = 'conv-stuck';

    const response = await bot.sendToAgent('hello');

    expect(response).toBe('reactive recovered');
    expect(recoverOrphanedConversationApproval).toHaveBeenCalledWith('agent-contract-test', 'conv-stuck');
    expect(vi.mocked(resumeSession)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(resumeSession).mock.calls[0][0]).toBe('conv-stuck');
    expect(vi.mocked(resumeSession).mock.calls[1][0]).toBe('conv-stuck');
    expect(stuckSession.close).toHaveBeenCalledTimes(1);
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
      memfs: true,
      sleeptime: {
        trigger: 'compaction-event',
        behavior: 'auto-launch',
      },
    });

    await bot.sendToAgent('first message');

    expect(vi.mocked(createAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createAgent)).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: ['origin:lettabot'],
        sleeptime: {
          trigger: 'compaction-event',
          behavior: 'auto-launch',
        },
      })
    );
  });

  it('retries sendToAgent when SDK result runIds repeat the previous run', async () => {
    let streamCall = 0;

    const mockSession = {
      initialize: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
      stream: vi.fn(() => {
        const call = streamCall++;
        return (async function* () {
          if (call === 0) {
            yield { type: 'assistant', content: 'response-A' };
            yield { type: 'result', success: true, runIds: ['run-A'] };
            return;
          }
          if (call === 1) {
            // Stale replay of the previous run; bot should retry once.
            yield { type: 'assistant', content: 'stale-A' };
            yield { type: 'result', success: true, runIds: ['run-A'] };
            return;
          }
          yield { type: 'assistant', content: 'response-B' };
          yield { type: 'result', success: true, runIds: ['run-B'] };
        })();
      }),
      close: vi.fn(() => undefined),
      agentId: 'agent-runid-test',
      conversationId: 'conversation-runid-test',
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
    expect(responseB).toBe('response-B');

    expect(mockSession.send).toHaveBeenCalledTimes(3);
    expect(mockSession.send).toHaveBeenNthCalledWith(1, 'first message');
    expect(mockSession.send).toHaveBeenNthCalledWith(2, 'second message');
    expect(mockSession.send).toHaveBeenNthCalledWith(3, 'second message');
    expect(mockSession.close).toHaveBeenCalledTimes(1);
  });

  it('invalidates background sessions when reuseSession is false', async () => {
    const mockSession = {
      initialize: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
      stream: vi.fn(() =>
        (async function* () {
          yield { type: 'assistant', content: 'ok' };
          // Keep this fixture aligned with current SDK output where runIds is
          // often absent; this test validates reuseSession behavior only.
          yield { type: 'result', success: true };
        })()
      ),
      close: vi.fn(() => undefined),
      agentId: 'agent-reuse-false',
      conversationId: 'conversation-reuse-false',
    };

    vi.mocked(createSession).mockReturnValue(mockSession as never);
    vi.mocked(resumeSession).mockReturnValue(mockSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
      reuseSession: false,
    });

    await bot.sendToAgent('first background trigger');
    await bot.sendToAgent('second background trigger');

    expect(mockSession.close).toHaveBeenCalledTimes(2);
  });

  it('executes only targeted directives in sendToAgent when source adapter is unavailable', async () => {
    const mockSession = {
      initialize: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
      stream: vi.fn(() =>
        (async function* () {
          yield {
            type: 'assistant',
            content: '<actions><send-file path="data/outbound/report.txt" /><send-message channel="slack" chat="C123">Job done</send-message></actions>',
          };
          yield { type: 'result', success: true };
        })()
      ),
      close: vi.fn(() => undefined),
      agentId: 'agent-background-directives',
      conversationId: 'conversation-background-directives',
    };

    vi.mocked(createSession).mockReturnValue(mockSession as never);
    vi.mocked(resumeSession).mockReturnValue(mockSession as never);

    const bot = new LettaBot({
      workingDir: join(dataDir, 'working'),
      allowedTools: [],
    });

    const sendMessageMock = vi.fn(async () => ({ messageId: 'msg-1' }));
    const sendFileMock = vi.fn(async () => ({ messageId: 'file-1' }));

    bot.registerChannel({
      id: 'slack',
      name: 'Slack',
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      isRunning: vi.fn(() => true),
      sendMessage: sendMessageMock,
      editMessage: vi.fn(async () => {}),
      sendTypingIndicator: vi.fn(async () => {}),
      sendFile: sendFileMock,
      getFormatterHints: vi.fn(() => ({ supportsReactions: true, supportsFiles: true })),
    });

    const response = await bot.sendToAgent('background trigger', {
      type: 'feed',
      outputMode: 'silent',
      sourceChannel: 'gmail',
      sourceChatId: 'account@example.com',
    });

    expect(response).toBe('');
    expect(sendMessageMock).toHaveBeenCalledWith({
      chatId: 'C123',
      text: 'Job done',
    });
    expect(sendFileMock).not.toHaveBeenCalled();
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

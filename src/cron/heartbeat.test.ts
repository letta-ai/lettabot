import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, unlinkSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { HeartbeatService, type HeartbeatConfig } from './heartbeat.js';
import { buildCustomHeartbeatPrompt, SILENT_MODE_PREFIX } from '../core/prompts.js';
import type { AgentSession } from '../core/interfaces.js';
import { addTodo } from '../todo/store.js';

// ── buildCustomHeartbeatPrompt ──────────────────────────────────────────

describe('buildCustomHeartbeatPrompt', () => {
  it('includes silent mode prefix', () => {
    const result = buildCustomHeartbeatPrompt('Do something', '12:00 PM', 'UTC', 60);
    expect(result).toContain(SILENT_MODE_PREFIX);
  });

  it('includes time and interval metadata', () => {
    const result = buildCustomHeartbeatPrompt('Do something', '3:30 PM', 'America/Los_Angeles', 45);
    expect(result).toContain('TIME: 3:30 PM (America/Los_Angeles)');
    expect(result).toContain('NEXT HEARTBEAT: in 45 minutes');
  });

  it('includes custom prompt text in body', () => {
    const result = buildCustomHeartbeatPrompt('Check your todo list.', '12:00 PM', 'UTC', 60);
    expect(result).toContain('Check your todo list.');
  });

  it('includes lettabot-message instructions', () => {
    const result = buildCustomHeartbeatPrompt('Custom task', '12:00 PM', 'UTC', 60);
    expect(result).toContain('lettabot-message send --text');
  });

  it('does NOT include default body text', () => {
    const result = buildCustomHeartbeatPrompt('Custom task', '12:00 PM', 'UTC', 60);
    expect(result).not.toContain('This is your time');
    expect(result).not.toContain('Pursue curiosities');
  });
});

// ── HeartbeatService prompt resolution ──────────────────────────────────

function createMockBot(): AgentSession {
  return {
    registerChannel: vi.fn(),
    setGroupBatcher: vi.fn(),
    processGroupBatch: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    sendToAgent: vi.fn().mockResolvedValue('ok'),
    streamToAgent: vi.fn().mockReturnValue((async function* () { yield { type: 'result', success: true }; })()),
    deliverToChannel: vi.fn(),
    getStatus: vi.fn().mockReturnValue({ agentId: 'test', conversationId: null, channels: [] }),
    setAgentId: vi.fn(),
    reset: vi.fn(),
    getLastMessageTarget: vi.fn().mockReturnValue(null),
    getLastUserMessageTime: vi.fn().mockReturnValue(null),
    getPendingMessages: vi.fn().mockReturnValue([]),
    injectMessage: vi.fn(),
  };
}

function createConfig(overrides: Partial<HeartbeatConfig> = {}): HeartbeatConfig {
  return {
    enabled: true,
    intervalMinutes: 30,
    workingDir: tmpdir(),
    agentKey: 'test-agent',
    ...overrides,
  };
}

describe('HeartbeatService prompt resolution', () => {
  let tmpDir: string;
  let originalDataDir: string | undefined;

  beforeEach(() => {
    tmpDir = resolve(tmpdir(), `heartbeat-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = tmpDir;
  });

  afterEach(() => {
    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDir;
    }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('uses default prompt when no custom prompt is set', async () => {
    const bot = createMockBot();
    const service = new HeartbeatService(bot, createConfig({ workingDir: tmpDir }));

    await service.trigger();

    const sentMessage = (bot.sendToAgent as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sentMessage).toContain('This is your time');
    expect(sentMessage).toContain(SILENT_MODE_PREFIX);
  });

  it('uses inline prompt when set', async () => {
    const bot = createMockBot();
    const service = new HeartbeatService(bot, createConfig({
      workingDir: tmpDir,
      prompt: 'Check your todo list and work on the top item.',
    }));

    await service.trigger();

    const sentMessage = (bot.sendToAgent as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sentMessage).toContain('Check your todo list and work on the top item.');
    expect(sentMessage).not.toContain('This is your time');
    expect(sentMessage).toContain(SILENT_MODE_PREFIX);
  });

  it('uses promptFile when no inline prompt is set', async () => {
    const promptPath = resolve(tmpDir, 'heartbeat-prompt.txt');
    writeFileSync(promptPath, 'Research quantum computing papers.');

    const bot = createMockBot();
    const service = new HeartbeatService(bot, createConfig({
      workingDir: tmpDir,
      promptFile: 'heartbeat-prompt.txt',
    }));

    await service.trigger();

    const sentMessage = (bot.sendToAgent as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sentMessage).toContain('Research quantum computing papers.');
    expect(sentMessage).not.toContain('This is your time');
  });

  it('inline prompt takes precedence over promptFile', async () => {
    const promptPath = resolve(tmpDir, 'heartbeat-prompt.txt');
    writeFileSync(promptPath, 'FROM FILE');

    const bot = createMockBot();
    const service = new HeartbeatService(bot, createConfig({
      workingDir: tmpDir,
      prompt: 'FROM INLINE',
      promptFile: 'heartbeat-prompt.txt',
    }));

    await service.trigger();

    const sentMessage = (bot.sendToAgent as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sentMessage).toContain('FROM INLINE');
    expect(sentMessage).not.toContain('FROM FILE');
  });

  it('re-reads promptFile on each tick (live reload)', async () => {
    const promptPath = resolve(tmpDir, 'heartbeat-prompt.txt');
    writeFileSync(promptPath, 'Version 1');

    const bot = createMockBot();
    const service = new HeartbeatService(bot, createConfig({
      workingDir: tmpDir,
      promptFile: 'heartbeat-prompt.txt',
    }));

    // First tick
    await service.trigger();
    const firstMessage = (bot.sendToAgent as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(firstMessage).toContain('Version 1');

    // Update file
    writeFileSync(promptPath, 'Version 2');

    // Second tick
    await service.trigger();
    const secondMessage = (bot.sendToAgent as ReturnType<typeof vi.fn>).mock.calls[1][0] as string;
    expect(secondMessage).toContain('Version 2');
    expect(secondMessage).not.toContain('Version 1');
  });

  it('falls back to default when promptFile does not exist', async () => {
    const bot = createMockBot();
    const service = new HeartbeatService(bot, createConfig({
      workingDir: tmpDir,
      promptFile: 'nonexistent.txt',
    }));

    await service.trigger();

    const sentMessage = (bot.sendToAgent as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    // Should fall back to default since file doesn't exist
    expect(sentMessage).toContain('This is your time');
  });

  it('falls back to default when promptFile is empty', async () => {
    const promptPath = resolve(tmpDir, 'empty.txt');
    writeFileSync(promptPath, '   \n  ');

    const bot = createMockBot();
    const service = new HeartbeatService(bot, createConfig({
      workingDir: tmpDir,
      promptFile: 'empty.txt',
    }));

    await service.trigger();

    const sentMessage = (bot.sendToAgent as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    // Empty/whitespace file should fall back to default
    expect(sentMessage).toContain('This is your time');
  });

  it('injects actionable todos into default heartbeat prompt', async () => {
    addTodo('test', {
      text: 'Deliver morning report',
      due: '2026-02-13T08:00:00.000Z',
      recurring: 'daily 8am',
    });

    const bot = createMockBot();
    const service = new HeartbeatService(bot, createConfig({ workingDir: tmpDir }));

    await service.trigger();

    const sentMessage = (bot.sendToAgent as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sentMessage).toContain('PENDING TO-DOS:');
    expect(sentMessage).toContain('Deliver morning report');
    expect(sentMessage).toContain('recurring: daily 8am');
    expect(sentMessage).toContain('manage_todo');
  });

  it('does not include snoozed todos that are not actionable yet', async () => {
    addTodo('test', {
      text: 'Follow up after trip',
      snoozed_until: '2099-01-01T00:00:00.000Z',
    });

    const bot = createMockBot();
    const service = new HeartbeatService(bot, createConfig({ workingDir: tmpDir }));

    await service.trigger();

    const sentMessage = (bot.sendToAgent as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sentMessage).not.toContain('Follow up after trip');
  });

  it('skips automatic heartbeat when user messaged within skip window', async () => {
    const bot = createMockBot();
    (bot.getLastUserMessageTime as ReturnType<typeof vi.fn>).mockReturnValue(
      new Date(Date.now() - 2 * 60 * 1000),
    );

    const service = new HeartbeatService(bot, createConfig({
      workingDir: tmpDir,
      skipRecentUserMinutes: 5,
    }));

    await (service as any).runHeartbeat(false);

    expect(bot.sendToAgent).not.toHaveBeenCalled();
  });

  it('does not skip automatic heartbeat when skipRecentUserMinutes is 0', async () => {
    const bot = createMockBot();
    (bot.getLastUserMessageTime as ReturnType<typeof vi.fn>).mockReturnValue(
      new Date(Date.now() - 1 * 60 * 1000),
    );

    const service = new HeartbeatService(bot, createConfig({
      workingDir: tmpDir,
      skipRecentUserMinutes: 0,
    }));

    await (service as any).runHeartbeat(false);

    expect(bot.sendToAgent).toHaveBeenCalledTimes(1);
  });
});

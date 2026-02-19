import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LettaGateway } from './gateway.js';
import type { AgentSession } from './interfaces.js';

function createMockSession(channels: string[] = ['telegram']): AgentSession {
  return {
    registerChannel: vi.fn(),
    setGroupBatcher: vi.fn(),
    processGroupBatch: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sendToAgent: vi.fn().mockResolvedValue('response'),
    streamToAgent: vi.fn().mockReturnValue((async function* () { yield { type: 'result', success: true }; })()),
    deliverToChannel: vi.fn().mockResolvedValue('msg-123'),
    getStatus: vi.fn().mockReturnValue({ agentId: 'agent-123', conversationId: null, channels }),
    setAgentId: vi.fn(),
    reset: vi.fn(),
    getLastMessageTarget: vi.fn().mockReturnValue(null),
    getLastUserMessageTime: vi.fn().mockReturnValue(null),
  };
}

describe('LettaGateway', () => {
  let gateway: LettaGateway;

  beforeEach(() => {
    gateway = new LettaGateway();
  });

  it('adds and retrieves agents', () => {
    const session = createMockSession();
    gateway.addAgent('test', session);
    expect(gateway.getAgent('test')).toBe(session);
    expect(gateway.getAgentNames()).toEqual(['test']);
    expect(gateway.size).toBe(1);
  });

  it('rejects empty agent names', () => {
    expect(() => gateway.addAgent('', createMockSession())).toThrow('empty');
  });

  it('rejects duplicate agent names', () => {
    gateway.addAgent('test', createMockSession());
    expect(() => gateway.addAgent('test', createMockSession())).toThrow('already exists');
  });

  it('starts all agents', async () => {
    const s1 = createMockSession();
    const s2 = createMockSession();
    gateway.addAgent('a', s1);
    gateway.addAgent('b', s2);
    await gateway.start();
    expect(s1.start).toHaveBeenCalled();
    expect(s2.start).toHaveBeenCalled();
  });

  it('stops all agents', async () => {
    const s1 = createMockSession();
    const s2 = createMockSession();
    gateway.addAgent('a', s1);
    gateway.addAgent('b', s2);
    await gateway.stop();
    expect(s1.stop).toHaveBeenCalled();
    expect(s2.stop).toHaveBeenCalled();
  });

  it('routes deliverToChannel to correct agent', async () => {
    const s1 = createMockSession(['telegram']);
    const s2 = createMockSession(['discord']);
    gateway.addAgent('a', s1);
    gateway.addAgent('b', s2);

    await gateway.deliverToChannel('discord', 'chat-1', { text: 'hello' });
    expect(s2.deliverToChannel).toHaveBeenCalledWith('discord', 'chat-1', { text: 'hello' });
    expect(s1.deliverToChannel).not.toHaveBeenCalled();
  });

  it('throws when no agent owns channel', async () => {
    gateway.addAgent('a', createMockSession(['telegram']));
    await expect(gateway.deliverToChannel('slack', 'ch-1', { text: 'hi' })).rejects.toThrow('No agent owns channel');
  });

  it('handles start failures gracefully', async () => {
    const good = createMockSession();
    const bad = createMockSession();
    (bad.start as any).mockRejectedValue(new Error('boom'));
    gateway.addAgent('good', good);
    gateway.addAgent('bad', bad);
    // Should not throw -- uses Promise.allSettled
    await gateway.start();
    expect(good.start).toHaveBeenCalled();
  });

  describe('sendToAgent', () => {
    it('routes by agent name', async () => {
      const s1 = createMockSession();
      const s2 = createMockSession();
      gateway.addAgent('alpha', s1);
      gateway.addAgent('beta', s2);

      await gateway.sendToAgent('beta', 'hello', { type: 'webhook', outputMode: 'silent' });
      expect(s2.sendToAgent).toHaveBeenCalledWith('hello', { type: 'webhook', outputMode: 'silent' });
      expect(s1.sendToAgent).not.toHaveBeenCalled();
    });

    it('defaults to first agent when name is undefined', async () => {
      const s1 = createMockSession();
      gateway.addAgent('only', s1);

      await gateway.sendToAgent(undefined, 'hi');
      expect(s1.sendToAgent).toHaveBeenCalledWith('hi', undefined);
    });

    it('throws when agent name not found', async () => {
      gateway.addAgent('a', createMockSession());
      await expect(gateway.sendToAgent('nope', 'hi')).rejects.toThrow('Agent not found: nope');
    });

    it('throws when no agents configured', async () => {
      await expect(gateway.sendToAgent(undefined, 'hi')).rejects.toThrow('No agents configured');
    });
  });

  describe('streamToAgent', () => {
    it('routes by agent name and yields stream chunks', async () => {
      const chunks = [
        { type: 'assistant', content: 'hello' },
        { type: 'result', success: true },
      ];
      const s1 = createMockSession();
      (s1.streamToAgent as any) = async function* () { for (const c of chunks) yield c; };
      gateway.addAgent('bot', s1);

      const collected = [];
      for await (const msg of gateway.streamToAgent('bot', 'test')) {
        collected.push(msg);
      }
      expect(collected).toEqual(chunks);
    });

    it('defaults to first agent when name is undefined', async () => {
      const s1 = createMockSession();
      (s1.streamToAgent as any) = async function* () { yield { type: 'result', success: true }; };
      gateway.addAgent('default', s1);

      const collected = [];
      for await (const msg of gateway.streamToAgent(undefined, 'test')) {
        collected.push(msg);
      }
      expect(collected).toHaveLength(1);
      expect(collected[0].type).toBe('result');
    });
  });
});

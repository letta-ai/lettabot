/**
 * SwarmManager Tests (M7)
 *
 * Hypothesis: SwarmManager routes messages to the best-fit agent via
 * NicheMatcher + SwarmStore, using per-agent queues instead of the single
 * processing mutex, while falling back to single-agent behavior in mode: 'single'.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SwarmManager } from './swarm-manager.js';
import { SwarmStore } from './swarm-store.js';
import { matchNiche } from './niche-matcher.js';
import type { InboundMessage } from '../core/types.js';
import type { NicheDescriptor } from './types.js';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

function makeTmpDir(): string {
  const dir = resolve(tmpdir(), `swarm-mgr-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: 'telegram',
    chatId: '123',
    userId: 'user1',
    text: 'Hello world',
    timestamp: new Date(),
    ...overrides,
  };
}

describe('SwarmManager', () => {
  let store: SwarmStore;
  let manager: SwarmManager;

  beforeEach(() => {
    store = new SwarmStore(makeTmpDir());
    manager = new SwarmManager(store, matchNiche);
  });

  // T-SM-1
  it('constructor accepts SwarmStore and NicheMatcher', () => {
    expect(manager).toBeInstanceOf(SwarmManager);
  });

  // T-SM-2
  it('routeMessage() classifies message and returns agentId from store', () => {
    store.mode = 'swarm';
    store.addAgent({
      agentId: 'agent-tel-code',
      blueprintId: 'bp-1',
      nicheKey: 'telegram-coding',
      createdAt: new Date().toISOString(),
    });

    const msg = createMessage({ text: 'Help me debug this function' });
    const result = manager.routeMessage(msg);
    expect(result).not.toBeNull();
    expect(result!.agentId).toBe('agent-tel-code');
  });

  // T-SM-3
  it('routeMessage() returns default agent when mode=single', () => {
    store.mode = 'single';
    store.agentId = 'agent-default';

    const msg = createMessage();
    const result = manager.routeMessage(msg);
    expect(result).not.toBeNull();
    expect(result!.agentId).toBe('agent-default');
  });

  // T-SM-4
  it('routeMessage() returns null when no agent exists for niche', () => {
    store.mode = 'swarm';
    const msg = createMessage({ text: 'Hello world' });
    const result = manager.routeMessage(msg);
    expect(result).toBeNull();
  });

  // T-SM-5
  it('enqueueMessage() adds to per-agent queue (not global queue)', () => {
    const msg = createMessage();
    manager.enqueueMessage('agent-1', msg);
    manager.enqueueMessage('agent-2', msg);
    manager.enqueueMessage('agent-1', msg);

    const queues = manager.getQueueSizes();
    expect(queues.get('agent-1')).toBe(2);
    expect(queues.get('agent-2')).toBe(1);
  });

  // T-SM-6
  it('processQueues() processes one message per agent concurrently', async () => {
    const processed: string[] = [];
    const processor = vi.fn().mockImplementation(async (agentId: string, _msg: InboundMessage) => {
      processed.push(agentId);
    });
    manager.setProcessor(processor);

    manager.enqueueMessage('agent-1', createMessage({ text: 'msg1' }));
    manager.enqueueMessage('agent-2', createMessage({ text: 'msg2' }));

    await manager.processQueues();

    expect(processed).toContain('agent-1');
    expect(processed).toContain('agent-2');
    expect(processor).toHaveBeenCalledTimes(2);
  });

  // T-SM-7
  it('processQueues() does not block other agents while one processes', async () => {
    const order: string[] = [];
    const processor = vi.fn().mockImplementation(async (agentId: string) => {
      order.push(`start-${agentId}`);
      // Simulate varying processing times
      await new Promise(r => setTimeout(r, agentId === 'slow' ? 50 : 10));
      order.push(`end-${agentId}`);
    });
    manager.setProcessor(processor);

    manager.enqueueMessage('slow', createMessage());
    manager.enqueueMessage('fast', createMessage());

    await manager.processQueues();

    // Fast agent should finish before slow agent
    const fastEnd = order.indexOf('end-fast');
    const slowEnd = order.indexOf('end-slow');
    expect(fastEnd).toBeLessThan(slowEnd);
  });

  // T-SM-8
  it('createAgentForNiche() creates entry and registers in SwarmStore', () => {
    const niche: NicheDescriptor = { channel: 'telegram', domain: 'coding', key: 'telegram-coding' };
    const agentId = 'new-agent-1';

    manager.createAgentForNiche(agentId, 'bp-1', niche);

    const agent = store.getAgentForNiche(niche);
    expect(agent).not.toBeNull();
    expect(agent!.agentId).toBe(agentId);
    expect(agent!.blueprintId).toBe('bp-1');
  });
});

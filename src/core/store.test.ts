import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from './store.js';
import { existsSync, unlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentStore } from './types.js';

describe('Store', () => {
  const testDir = join(tmpdir(), 'lettabot-test-' + Date.now() + '-' + Math.random().toString(36).substring(7));
  const testStorePath = join(testDir, 'test-store.json');
  let originalLettaAgentId: string | undefined;

  beforeEach(() => {
    // Create test directory
    mkdirSync(testDir, { recursive: true });
    
    // Clear LETTA_AGENT_ID env var to avoid interference
    originalLettaAgentId = process.env.LETTA_AGENT_ID;
    delete process.env.LETTA_AGENT_ID;
  });

  afterEach(() => {
    // Clean up test files
    if (existsSync(testStorePath)) {
      unlinkSync(testStorePath);
    }
    
    // Restore LETTA_AGENT_ID env var
    if (originalLettaAgentId !== undefined) {
      process.env.LETTA_AGENT_ID = originalLettaAgentId;
    }
  });

  it('should auto-migrate v1 format to v2', () => {
    // Write v1 format store
    const v1Data: AgentStore = {
      agentId: 'agent-123',
      conversationId: 'conv-456',
      baseUrl: 'http://localhost:8283',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: '2026-01-02T00:00:00.000Z',
    };
    writeFileSync(testStorePath, JSON.stringify(v1Data, null, 2));

    // Load store (should trigger migration)
    const store = new Store(testStorePath);

    // Verify data is accessible
    expect(store.agentId).toBe('agent-123');
    expect(store.conversationId).toBe('conv-456');
    expect(store.baseUrl).toBe('http://localhost:8283');

    // Verify file was migrated to v2
    const fs = require('node:fs');
    const migrated = JSON.parse(fs.readFileSync(testStorePath, 'utf-8'));
    expect(migrated.version).toBe(2);
    expect(migrated.agents.LettaBot).toBeDefined();
    expect(migrated.agents.LettaBot.agentId).toBe('agent-123');
  });

  it('should load v2 format correctly', () => {
    // Write v2 format store
    const v2Data = {
      version: 2,
      agents: {
        TestBot: {
          agentId: 'agent-789',
          conversationId: 'conv-abc',
          baseUrl: 'http://localhost:8283',
        },
      },
    };
    writeFileSync(testStorePath, JSON.stringify(v2Data, null, 2));

    // Load store with agent name
    const store = new Store(testStorePath, 'TestBot');

    // Verify data is accessible
    expect(store.agentId).toBe('agent-789');
    expect(store.conversationId).toBe('conv-abc');
  });

  it('should isolate per-agent state', () => {
    // Create two stores with different agent names
    const store1 = new Store(testStorePath, 'Bot1');
    const store2 = new Store(testStorePath, 'Bot2');

    // Set different data for each
    store1.agentId = 'agent-1';
    store1.conversationId = 'conv-1';

    store2.agentId = 'agent-2';
    store2.conversationId = 'conv-2';

    // Verify isolation
    expect(store1.agentId).toBe('agent-1');
    expect(store2.agentId).toBe('agent-2');
    expect(store1.conversationId).toBe('conv-1');
    expect(store2.conversationId).toBe('conv-2');

    // Reload and verify persistence
    const store1Reloaded = new Store(testStorePath, 'Bot1');
    const store2Reloaded = new Store(testStorePath, 'Bot2');

    expect(store1Reloaded.agentId).toBe('agent-1');
    expect(store2Reloaded.agentId).toBe('agent-2');
  });

  it('should maintain backward compatibility with no agent name', () => {
    // Create store without agent name (legacy mode)
    const store = new Store(testStorePath);

    // Set data
    store.agentId = 'legacy-agent';
    store.conversationId = 'legacy-conv';

    // Verify it works
    expect(store.agentId).toBe('legacy-agent');
    expect(store.conversationId).toBe('legacy-conv');

    // Verify it uses default agent name 'LettaBot'
    const fs = require('node:fs');
    const data = JSON.parse(fs.readFileSync(testStorePath, 'utf-8'));
    expect(data.agents.LettaBot).toBeDefined();
    expect(data.agents.LettaBot.agentId).toBe('legacy-agent');
  });

  it('should handle empty store initialization', () => {
    const store = new Store(testStorePath, 'NewBot');

    expect(store.agentId).toBeNull();
    expect(store.conversationId).toBeNull();
    expect(store.recoveryAttempts).toBe(0);
  });

  it('should track recovery attempts per agent', () => {
    const store1 = new Store(testStorePath, 'Bot1');
    const store2 = new Store(testStorePath, 'Bot2');

    // Increment for Bot1
    store1.incrementRecoveryAttempts();
    store1.incrementRecoveryAttempts();

    // Increment for Bot2
    store2.incrementRecoveryAttempts();

    // Verify isolation
    expect(store1.recoveryAttempts).toBe(2);
    expect(store2.recoveryAttempts).toBe(1);

    // Reset Bot1
    store1.resetRecoveryAttempts();
    expect(store1.recoveryAttempts).toBe(0);
    expect(store2.recoveryAttempts).toBe(1);
  });

  it('should handle lastMessageTarget per agent', () => {
    const store1 = new Store(testStorePath, 'Bot1');
    const store2 = new Store(testStorePath, 'Bot2');

    const target1 = {
      channel: 'telegram' as const,
      chatId: 'chat1',
      updatedAt: new Date().toISOString(),
    };

    const target2 = {
      channel: 'slack' as const,
      chatId: 'chat2',
      updatedAt: new Date().toISOString(),
    };

    store1.lastMessageTarget = target1;
    store2.lastMessageTarget = target2;

    expect(store1.lastMessageTarget?.chatId).toBe('chat1');
    expect(store2.lastMessageTarget?.chatId).toBe('chat2');
  });

  it('should handle reset() per agent', () => {
    const store1 = new Store(testStorePath, 'Bot1');
    const store2 = new Store(testStorePath, 'Bot2');

    // Set data for both
    store1.agentId = 'agent-1';
    store2.agentId = 'agent-2';

    // Reset only Bot1
    store1.reset();

    expect(store1.agentId).toBeNull();
    expect(store2.agentId).toBe('agent-2');
  });

  it('should handle setAgent() per agent', () => {
    const store = new Store(testStorePath, 'TestBot');

    store.setAgent('agent-xyz', 'http://localhost:8283', 'conv-123');

    expect(store.agentId).toBe('agent-xyz');
    expect(store.baseUrl).toBe('http://localhost:8283');
    expect(store.conversationId).toBe('conv-123');

    const info = store.getInfo();
    expect(info.agentId).toBe('agent-xyz');
    expect(info.createdAt).toBeDefined();
    expect(info.lastUsedAt).toBeDefined();
  });

  it('should handle isServerMismatch() per agent', () => {
    const store = new Store(testStorePath, 'TestBot');

    store.setAgent('agent-123', 'http://localhost:8283');

    expect(store.isServerMismatch('http://localhost:8283')).toBe(false);
    expect(store.isServerMismatch('http://localhost:8284')).toBe(true);
    expect(store.isServerMismatch('https://api.letta.com')).toBe(true);
  });

  it('should not apply LETTA_AGENT_ID override to non-default agent keys', () => {
    process.env.LETTA_AGENT_ID = 'global-agent';
    const defaultStore = new Store(testStorePath, 'LettaBot');
    const namedStore = new Store(testStorePath, 'Bot2');

    expect(defaultStore.agentId).toBe('global-agent');
    expect(namedStore.agentId).toBeNull();
  });
});

/**
 * E2E Tests for LettaBot
 * 
 * These tests use a real Letta API agent to verify the full message flow.
 * Requires LETTA_API_KEY and LETTA_E2E_AGENT_ID environment variables.
 * 
 * Run with: npm run test:e2e
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LettaBot } from '../src/core/bot.js';
import { MockChannelAdapter } from '../src/test/mock-channel.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Skip if no API key (local dev without secrets)
const SKIP_E2E = !process.env.LETTA_API_KEY || !process.env.LETTA_E2E_AGENT_ID;

describe.skipIf(SKIP_E2E)('e2e: LettaBot with Letta API', () => {
  let bot: LettaBot;
  let mockAdapter: MockChannelAdapter;
  let tempDir: string;

  beforeAll(async () => {
    // Create temp directory for test data
    tempDir = mkdtempSync(join(tmpdir(), 'lettabot-e2e-'));
    
    // Set agent ID from secrets
    process.env.LETTA_AGENT_ID = process.env.LETTA_E2E_AGENT_ID;
    
    // Initialize bot with test config
    bot = new LettaBot({
      workingDir: tempDir,
      agentName: 'e2e-test',
    });
    
    // Register mock channel
    mockAdapter = new MockChannelAdapter();
    bot.registerChannel(mockAdapter);
    
    console.log('[E2E] Bot initialized with agent:', process.env.LETTA_E2E_AGENT_ID);
  }, 30000); // 30s timeout for setup

  afterAll(async () => {
    // Cleanup temp directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('responds to a simple message', async () => {
    const response = await mockAdapter.simulateMessage('Say "E2E TEST OK" and nothing else.');
    
    expect(response).toBeTruthy();
    expect(response.length).toBeGreaterThan(0);
    // The agent should respond with something containing our test phrase
    expect(response.toUpperCase()).toContain('E2E TEST OK');
  }, 60000); // 60s timeout

  it('handles /status command', async () => {
    const response = await mockAdapter.simulateMessage('/status');
    
    expect(response).toBeTruthy();
    // Status should contain agent info
    expect(response).toMatch(/agent|status/i);
  }, 30000);

  it('handles /help command', async () => {
    const response = await mockAdapter.simulateMessage('/help');
    
    expect(response).toBeTruthy();
    expect(response).toContain('LettaBot');
    expect(response).toContain('/status');
  }, 10000);

  it('maintains conversation context', async () => {
    // First message - set context
    await mockAdapter.simulateMessage('Remember this number: 42424242');
    
    // Clear messages but keep session
    mockAdapter.clearMessages();
    
    // Second message - recall context
    const response = await mockAdapter.simulateMessage('What number did I just tell you to remember?');
    
    expect(response).toContain('42424242');
  }, 120000); // 2 min timeout for multi-turn
});

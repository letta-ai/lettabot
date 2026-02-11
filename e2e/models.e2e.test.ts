/**
 * E2E Tests for Model API
 * 
 * Tests model listing and retrieval against Letta API.
 * Requires LETTA_API_KEY and LETTA_E2E_AGENT_ID environment variables.
 * 
 * Run with: npm run test:e2e
 */

import { describe, it, expect } from 'vitest';
import { listModels, getAgentModel } from '../src/tools/letta-api.js';

const SKIP_E2E = !process.env.LETTA_API_KEY || !process.env.LETTA_E2E_AGENT_ID;

describe.skipIf(SKIP_E2E)('e2e: Model API', () => {
  it('lists available models from Letta API', async () => {
    const models = await listModels();
    expect(models.length).toBeGreaterThan(0);
    // Known providers should always exist on Letta API
    const handles = models.map(m => m.handle);
    expect(handles.some(h => h.includes('anthropic') || h.includes('openai'))).toBe(true);
  }, 30000);

  it('retrieves the current agent model', async () => {
    const agentId = process.env.LETTA_E2E_AGENT_ID!;
    const model = await getAgentModel(agentId);
    expect(model).toBeTruthy();
    expect(typeof model).toBe('string');
  }, 30000);
});

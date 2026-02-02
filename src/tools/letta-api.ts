/**
 * Letta API Client
 *
 * Uses the official @letta-ai/letta-client SDK for all API interactions.
 */

import { Letta } from '@letta-ai/letta-client';

const LETTA_BASE_URL = process.env.LETTA_BASE_URL || 'https://api.letta.com';

function getClient(): Letta {
  const apiKey = process.env.LETTA_API_KEY;
  // Local servers may not require an API key
  return new Letta({ 
    apiKey: apiKey || '', 
    baseURL: LETTA_BASE_URL,
    defaultHeaders: { "X-Letta-Source": "lettabot" },
  });
}

/**
 * Test connection to Letta server (silent, no error logging)
 */
export async function testConnection(): Promise<boolean> {
  try {
    const client = getClient();
    // Use a simple endpoint that doesn't have pagination issues
    await client.agents.list({ limit: 1 });
    return true;
  } catch {
    return false;
  }
}

// Re-export types that callers use
export type LettaTool = Awaited<ReturnType<Letta['tools']['upsert']>>;

/**
 * Upsert a tool to the Letta API
 */
export async function upsertTool(params: {
  source_code: string;
  description?: string;
  tags?: string[];
}): Promise<LettaTool> {
  const client = getClient();
  return client.tools.upsert({
    source_code: params.source_code,
    description: params.description,
    tags: params.tags,
  });
}

/**
 * List all tools
 */
export async function listTools(): Promise<LettaTool[]> {
  const client = getClient();
  const page = await client.tools.list();
  const tools: LettaTool[] = [];
  for await (const tool of page) {
    tools.push(tool);
  }
  return tools;
}

/**
 * Get a tool by name
 */
export async function getToolByName(name: string): Promise<LettaTool | null> {
  try {
    const client = getClient();
    const page = await client.tools.list({ name });
    for await (const tool of page) {
      if (tool.name === name) return tool;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Add a tool to an agent
 */
export async function addToolToAgent(agentId: string, toolId: string): Promise<void> {
  const client = getClient();
  await client.agents.tools.attach(toolId, { agent_id: agentId });
}

/**
 * Check if an agent exists
 */
export async function agentExists(agentId: string): Promise<boolean> {
  try {
    const client = getClient();
    await client.agents.retrieve(agentId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Update an agent's name
 */
export async function updateAgentName(agentId: string, name: string): Promise<boolean> {
  try {
    const client = getClient();
    await client.agents.update(agentId, { name });
    return true;
  } catch (e) {
    console.error('[Letta API] Failed to update agent name:', e);
    return false;
  }
}

/**
 * List available models
 */
export async function listModels(options?: { providerName?: string; providerCategory?: 'base' | 'byok' }): Promise<Array<{ handle: string; name: string; display_name?: string; tier?: string }>> {
  try {
    const client = getClient();
    const params: Record<string, unknown> = {};
    if (options?.providerName) params.provider_name = options.providerName;
    if (options?.providerCategory) params.provider_category = [options.providerCategory];
    const page = await client.models.list(Object.keys(params).length > 0 ? params : undefined);
    const models: Array<{ handle: string; name: string; display_name?: string; tier?: string }> = [];
    for await (const model of page) {
      if (model.handle && model.name) {
        models.push({ 
          handle: model.handle, 
          name: model.name,
          display_name: model.display_name ?? undefined,
          tier: (model as { tier?: string }).tier ?? undefined,
        });
      }
    }
    return models;
  } catch (e) {
    console.error('[Letta API] Failed to list models:', e);
    return [];
  }
}

/**
 * Get the most recent run time for an agent
 */
export async function getLastRunTime(agentId: string): Promise<Date | null> {
  try {
    const client = getClient();
    const page = await client.runs.list({ agent_id: agentId, limit: 1 });
    for await (const run of page) {
      if (run.created_at) {
        return new Date(run.created_at);
      }
    }
    return null;
  } catch (e) {
    console.error('[Letta API] Failed to get last run time:', e);
    return null;
  }
}

/**
 * List agents, optionally filtered by name search
 */
export async function listAgents(query?: string): Promise<Array<{ id: string; name: string; description?: string | null; created_at?: string | null }>> {
  try {
    const client = getClient();
    const page = await client.agents.list({ query_text: query, limit: 50 });
    const agents: Array<{ id: string; name: string; description?: string | null; created_at?: string | null }> = [];
    for await (const agent of page) {
      agents.push({
        id: agent.id,
        name: agent.name,
        description: agent.description,
        created_at: agent.created_at,
      });
    }
    return agents;
  } catch (e) {
    console.error('[Letta API] Failed to list agents:', e);
    return [];
  }
}

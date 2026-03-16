/**
 * Letta API Client
 *
 * Uses the official @letta-ai/letta-client SDK for all API interactions.
 */

import { Letta } from '@letta-ai/letta-client';

import { createLogger } from '../logger.js';
import { loadManagedMemoryBlock } from '../core/memory.js';

const log = createLogger('Letta-api');
const LETTA_BASE_URL = process.env.LETTA_BASE_URL || 'https://api.letta.com';
const DIRECTIVES_BLOCK_LABEL = 'system/directives';
const DIRECTIVES_HASH_LENGTH = 12;

function getClient(): Letta {
  const apiKey = process.env.LETTA_API_KEY;
  // Local servers may not require an API key
  return new Letta({ 
    apiKey: apiKey || '', 
    baseURL: LETTA_BASE_URL,
    defaultHeaders: { "X-Letta-Source": "lettabot" },
  });
}


interface VersionedDirectivesBlock {
  baseLabel: string;
  versionedLabel: string;
  hash: string;
  value: string;
  description?: string;
  limit?: number;
}

function buildVersionedDirectivesBlock(agentName = 'LettaBot'): VersionedDirectivesBlock | null {
  const directives = loadManagedMemoryBlock(DIRECTIVES_BLOCK_LABEL, agentName);
  if (!directives) {
    log.warn(`Managed directives block '${DIRECTIVES_BLOCK_LABEL}' not found`);
    return null;
  }

  const hash = createHash('sha256')
    .update(directives.value)
    .digest('hex')
    .slice(0, DIRECTIVES_HASH_LENGTH);

  return {
    baseLabel: directives.label,
    versionedLabel: `${directives.label}@${hash}`,
    hash,
    value: directives.value,
    description: directives.description,
    limit: directives.limit,
  };
}

/**
 * Ensure the current directives memory block version is attached to the agent.
 * Creates a shared versioned block if needed and detaches stale versions.
 */
export async function ensureDirectivesBlockOnAgent(
  agentId: string,
  agentName = 'LettaBot',
): Promise<boolean> {
  try {
    const directives = buildVersionedDirectivesBlock(agentName);
    if (!directives) return false;

    const client = getClient();
    let directivesBlockId: string | null = null;

    const matchingBlocks = await client.blocks.list({ label: directives.versionedLabel, limit: 5 });
    for await (const block of matchingBlocks) {
      if (block.label === directives.versionedLabel) {
        directivesBlockId = block.id;
        break;
      }
    }

    if (!directivesBlockId) {
      const created = await client.blocks.create({
        label: directives.versionedLabel,
        value: directives.value,
        description: directives.description,
        limit: directives.limit,
        metadata: {
          source: 'lettabot',
          block_type: 'directives',
          directives_hash: directives.hash,
        },
      });
      directivesBlockId = created.id;
      log.info(`Created directives block ${directives.versionedLabel} (${directivesBlockId})`);
    }

    const attachedBlocksPage = await client.agents.blocks.list(agentId, { limit: 200 });
    const attachedBlocks: Array<{ id: string; label: string | null }> = [];
    for await (const block of attachedBlocksPage) {
      attachedBlocks.push({
        id: block.id,
        label: block.label || null,
      });
    }

    const hasCurrentVersionAttached = attachedBlocks.some((b) => b.id === directivesBlockId);
    if (!hasCurrentVersionAttached) {
      await client.agents.blocks.attach(directivesBlockId, { agent_id: agentId });
      log.info(`Attached directives block ${directives.versionedLabel} to ${agentId}`);
    }

    const staleBlocks = attachedBlocks.filter((block) => {
      if (!block.label || block.id === directivesBlockId) return false;
      if (block.label === directives.baseLabel) return true;
      return block.label.startsWith(`${directives.baseLabel}@`);
    });

    for (const stale of staleBlocks) {
      try {
        await client.agents.blocks.detach(stale.id, { agent_id: agentId });
      } catch (err) {
        log.warn(
          `Failed to detach stale directives block ${stale.label || stale.id} from ${agentId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    return true;
  } catch (e) {
    log.warn(
      `Failed to ensure directives block on agent ${agentId}:`,
      e instanceof Error ? e.message : e,
    );
    return false;
  }
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
 * Get an agent's current model handle
 */
export async function getAgentModel(agentId: string): Promise<string | null> {
  try {
    const client = getClient();
    const agent = await client.agents.retrieve(agentId);
    return agent.model ?? null;
  } catch (e) {
    log.error('Failed to get agent model:', e);
    return null;
  }
}

/**
 * Update an agent's model
 */
export async function updateAgentModel(agentId: string, model: string): Promise<boolean> {
  try {
    const client = getClient();
    await client.agents.update(agentId, { model });
    return true;
  } catch (e) {
    log.error('Failed to update agent model:', e);
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
    log.error('Failed to update agent name:', e);
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
    log.error('Failed to list models:', e);
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
    log.error('Failed to get last run time:', e);
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
    log.error('Failed to list agents:', e);
    return [];
  }
}

/**
 * Find an agent by exact name match
 * Returns the most recently created agent if multiple match
 */
export async function findAgentByName(name: string): Promise<{ id: string; name: string } | null> {
  try {
    const client = getClient();
    const page = await client.agents.list({ query_text: name, limit: 50 });
    let bestMatch: { id: string; name: string; created_at?: string | null } | null = null;
    
    for await (const agent of page) {
      // Exact name match only
      if (agent.name === name) {
        // Keep the most recently created if multiple match
        if (!bestMatch || (agent.created_at && bestMatch.created_at && agent.created_at > bestMatch.created_at)) {
          bestMatch = { id: agent.id, name: agent.name, created_at: agent.created_at };
        }
      }
    }
    
    return bestMatch ? { id: bestMatch.id, name: bestMatch.name } : null;
  } catch (e) {
    log.error('Failed to find agent by name:', e);
    return null;
  }
}

// ============================================================================
// Tool Approval Management
// ============================================================================

/**
 * Cancel active runs for a specific conversation.
 * Scoped to a single conversation -- won't affect other channels/conversations.
 */
export async function cancelConversation(
  conversationId: string
): Promise<boolean> {
  try {
    const client = getClient();
    await client.conversations.cancel(conversationId);
    log.info(`Cancelled runs for conversation ${conversationId}`);
    return true;
  } catch (e) {
    // 409 "No active runs to cancel" is expected when cancel fires before run starts
    const err = e as { status?: number };
    if (err?.status === 409) {
      log.info(`No active runs to cancel for conversation ${conversationId} (409)`);
      return true;
    }
    log.error(`Failed to cancel conversation ${conversationId}:`, e);
    return false;
  }
}

/**
 * Fetch the error detail from the latest failed run on an agent.
 * Returns the actual error detail from run metadata (which is more
 * descriptive than the opaque `stop_reason=error` wire message).
 * Single API call -- fast enough to use on every error.
 */
export async function getLatestRunError(
  agentId: string,
  conversationId?: string
): Promise<{ message: string; stopReason: string; isApprovalError: boolean } | null> {
  try {
    const client = getClient();
    const runs = await client.runs.list({
      agent_id: agentId,
      conversation_id: conversationId,
      limit: 1,
    });
    const runsArray: Array<Record<string, unknown>> = [];
    for await (const run of runs) {
      runsArray.push(run as unknown as Record<string, unknown>);
      break; // Only need the first one
    }
    const run = runsArray[0];
    if (!run) return null;

    if (conversationId
      && typeof run.conversation_id === 'string'
      && run.conversation_id !== conversationId) {
      log.warn('Latest run lookup returned a different conversation, skipping enrichment');
      return null;
    }

    const meta = run.metadata as Record<string, unknown> | undefined;
    const err = meta?.error as Record<string, unknown> | undefined;
    const detail = typeof err?.detail === 'string' ? err.detail : '';
    const stopReason = typeof run.stop_reason === 'string' ? run.stop_reason : 'error';

    // Run has no metadata error but is stuck waiting for approval.
    // This happens when the 409 prevents a new run from starting --
    // the latest run is the one blocking, and it has no error, just a
    // stop_reason indicating it needs approval.
    const status = typeof run.status === 'string' ? run.status : '';
    if (!detail && stopReason === 'requires_approval') {
      const runId = typeof run.id === 'string' ? run.id : 'unknown';
      log.info(`Latest run stuck on approval: run=${runId} status=${status} stop_reason=${stopReason}`);
      return {
        message: `Run ${runId} stuck waiting for tool approval (status=${status})`,
        stopReason,
        isApprovalError: true,
      };
    }

    if (!detail) return null;

    const isApprovalError = detail.toLowerCase().includes('waiting for approval')
      || detail.toLowerCase().includes('approve or deny');

    log.info(`Latest run error: ${detail.slice(0, 150)}${isApprovalError ? ' [approval]' : ''}`);
    return { message: detail, stopReason, isApprovalError };
  } catch (e) {
    log.warn('Failed to fetch latest run error:', e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Disable tool approval requirement for a specific tool on an agent.
 * This sets requires_approval: false at the server level.
 */
export async function disableToolApproval(
  agentId: string,
  toolName: string
): Promise<boolean> {
  try {
    const client = getClient();
    // Note: API expects 'requires_approval' but client types say 'body_requires_approval'
    // This is a bug in @letta-ai/letta-client - filed issue, using workaround
    await client.agents.tools.updateApproval(toolName, {
      agent_id: agentId,
      requires_approval: false,
    } as unknown as Parameters<typeof client.agents.tools.updateApproval>[1]);
    log.info(`Disabled approval requirement for tool ${toolName} on agent ${agentId}`);
    return true;
  } catch (e) {
    log.error(`Failed to disable tool approval for ${toolName}:`, e);
    return false;
  }
}

/**
 * Get tools attached to an agent with their approval settings.
 */
export async function getAgentTools(agentId: string): Promise<Array<{
  name: string;
  id: string;
  requiresApproval?: boolean;
}>> {
  try {
    const client = getClient();
    const toolsPage = await client.agents.tools.list(agentId);
    const tools: Array<{ name: string; id: string; requiresApproval?: boolean }> = [];
    
    for await (const tool of toolsPage) {
      tools.push({
        name: tool.name ?? 'unknown',
        id: tool.id,
        // Note: The API might not return this field directly on list
        // We may need to check each tool individually
        requiresApproval: (tool as { requires_approval?: boolean }).requires_approval,
      });
    }
    
    return tools;
  } catch (e) {
    log.error('Failed to get agent tools:', e);
    return [];
  }
}

/**
 * Ensure no tools on the agent require approval.
 * Call on startup to proactively prevent stuck approval states.
 */
export async function ensureNoToolApprovals(agentId: string): Promise<void> {
  try {
    const tools = await getAgentTools(agentId);
    const approvalTools = tools.filter(t => t.requiresApproval);
    if (approvalTools.length > 0) {
      log.info(`Found ${approvalTools.length} tool(s) requiring approval: ${approvalTools.map(t => t.name).join(', ')}`);
      log.info('Disabling tool approvals for headless operation...');
      await disableAllToolApprovals(agentId);
    }
  } catch (e) {
    log.warn('Failed to check/disable tool approvals:', e);
  }
}

/**
 * Disable approval requirement for ALL tools on an agent.
 * Useful for ensuring a headless deployment doesn't get stuck.
 */
export async function disableAllToolApprovals(agentId: string): Promise<number> {
  try {
    const tools = await getAgentTools(agentId);
    let disabled = 0;
    
    for (const tool of tools) {
      const success = await disableToolApproval(agentId, tool.name);
      if (success) disabled++;
    }
    
    log.info(`Disabled approval for ${disabled}/${tools.length} tools on agent ${agentId}`);
    return disabled;
  } catch (e) {
    log.error('Failed to disable all tool approvals:', e);
    return 0;
  }
}

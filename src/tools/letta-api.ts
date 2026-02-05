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
    console.error('[Letta API] Failed to find agent by name:', e);
    return null;
  }
}

// ============================================================================
// Tool Approval Management
// ============================================================================

export interface PendingApproval {
  runId: string;
  toolCallId: string;
  toolName: string;
  messageId: string;
}

/**
 * Check for pending approval requests on an agent's conversation.
 * Returns details of any tool calls waiting for approval.
 */
export async function getPendingApprovals(
  agentId: string,
  conversationId?: string
): Promise<PendingApproval[]> {
  try {
    const client = getClient();

    // Prefer agent-level pending approval to avoid scanning stale history.
    try {
      const agentState = await client.agents.retrieve(agentId);
      if ('pending_approval' in agentState) {
        const pending = (agentState as { pending_approval?: { id: string; run_id?: string | null; tool_calls?: Array<{ tool_call_id: string; name: string }>; tool_call?: { tool_call_id: string; name: string } } | null }).pending_approval;
        if (!pending) {
          return [];
        }
        const toolCalls = pending.tool_calls || (pending.tool_call ? [pending.tool_call] : []);
        const seen = new Set<string>();
        const approvals: PendingApproval[] = [];
        for (const tc of toolCalls) {
          if (!tc?.tool_call_id || seen.has(tc.tool_call_id)) {
            continue;
          }
          seen.add(tc.tool_call_id);
          approvals.push({
            runId: pending.run_id || 'unknown',
            toolCallId: tc.tool_call_id,
            toolName: tc.name || 'unknown',
            messageId: pending.id,
          });
        }
        return approvals;
      }
    } catch (e) {
      console.warn('[Letta API] Failed to retrieve agent pending_approval, falling back to run scan:', e);
    }
    
    // First, check for runs with 'requires_approval' stop reason
    const runsPage = await client.runs.list({
      agent_id: agentId,
      conversation_id: conversationId,
      stop_reason: 'requires_approval',
      limit: 10,
    });
    
    const pendingApprovals: PendingApproval[] = [];
    
    for await (const run of runsPage) {
      if (run.status === 'running' || run.stop_reason === 'requires_approval') {
        // Get recent messages to find approval_request_message
        const messagesPage = await client.agents.messages.list(agentId, {
          conversation_id: conversationId,
          limit: 100,
        });
        
        const messages: Array<{ message_type?: string }> = [];
        for await (const msg of messagesPage) {
          messages.push(msg as { message_type?: string });
        }
        
        const resolvedToolCalls = new Set<string>();
        for (const msg of messages) {
          if ('message_type' in msg && msg.message_type === 'approval_response_message') {
            const approvalMsg = msg as {
              approvals?: Array<{ tool_call_id?: string | null }>;
            };
            const approvals = approvalMsg.approvals || [];
            for (const approval of approvals) {
              if (approval.tool_call_id) {
                resolvedToolCalls.add(approval.tool_call_id);
              }
            }
          }
        }
        
        const seenToolCalls = new Set<string>();
        for (const msg of messages) {
          // Check for approval_request_message type
          if ('message_type' in msg && msg.message_type === 'approval_request_message') {
            const approvalMsg = msg as {
              id: string;
              tool_calls?: Array<{ tool_call_id: string; name: string }>;
              tool_call?: { tool_call_id: string; name: string };
              run_id?: string;
            };
            
            // Extract tool call info
            const toolCalls = approvalMsg.tool_calls || (approvalMsg.tool_call ? [approvalMsg.tool_call] : []);
            for (const tc of toolCalls) {
              if (resolvedToolCalls.has(tc.tool_call_id)) {
                continue;
              }
              if (seenToolCalls.has(tc.tool_call_id)) {
                continue;
              }
              seenToolCalls.add(tc.tool_call_id);
              pendingApprovals.push({
                runId: approvalMsg.run_id || run.id,
                toolCallId: tc.tool_call_id,
                toolName: tc.name,
                messageId: approvalMsg.id,
              });
            }
          }
        }
      }
    }
    
    return pendingApprovals;
  } catch (e) {
    console.error('[Letta API] Failed to get pending approvals:', e);
    return [];
  }
}

/**
 * Reject a pending tool approval request.
 * Sends an approval response with approve: false.
 */
export async function rejectApproval(
  agentId: string,
  approval: {
    toolCallId: string;
    reason?: string;
  },
  conversationId?: string
): Promise<boolean> {
  try {
    const client = getClient();
    
    // Send approval response via messages.create
    await client.agents.messages.create(agentId, {
      messages: [{
        type: 'approval',
        approvals: [{
          approve: false,
          tool_call_id: approval.toolCallId,
          type: 'approval',
          reason: approval.reason || 'Session was interrupted - please retry your request',
        }],
      }],
      streaming: false,
    });
    
    console.log(`[Letta API] Rejected approval for tool call ${approval.toolCallId}`);
    return true;
  } catch (e) {
    const err = e as { status?: number; error?: { detail?: string } };
    const detail = err?.error?.detail || '';
    if (err?.status === 400 && detail.includes('No tool call is currently awaiting approval')) {
      console.warn(`[Letta API] Approval already resolved for tool call ${approval.toolCallId}`);
      return true;
    }
    console.error('[Letta API] Failed to reject approval:', e);
    return false;
  }
}

/**
 * Cancel active runs for an agent.
 * Optionally specify specific run IDs to cancel.
 * Note: Requires Redis on the server for canceling active runs.
 */
export async function cancelRuns(
  agentId: string,
  runIds?: string[]
): Promise<boolean> {
  try {
    const client = getClient();
    await client.agents.messages.cancel(agentId, {
      run_ids: runIds,
    });
    console.log(`[Letta API] Cancelled runs for agent ${agentId}${runIds ? ` (${runIds.join(', ')})` : ''}`);
    return true;
  } catch (e) {
    console.error('[Letta API] Failed to cancel runs:', e);
    return false;
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
    console.log(`[Letta API] Disabled approval requirement for tool ${toolName} on agent ${agentId}`);
    return true;
  } catch (e) {
    console.error(`[Letta API] Failed to disable tool approval for ${toolName}:`, e);
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
    console.error('[Letta API] Failed to get agent tools:', e);
    return [];
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
    
    console.log(`[Letta API] Disabled approval for ${disabled}/${tools.length} tools on agent ${agentId}`);
    return disabled;
  } catch (e) {
    console.error('[Letta API] Failed to disable all tool approvals:', e);
    return 0;
  }
}

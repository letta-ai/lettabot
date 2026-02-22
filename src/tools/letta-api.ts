/**
 * Letta API Client
 *
 * Uses the official @letta-ai/letta-client SDK for all API interactions.
 */

import { Letta, NotFoundError, APIConnectionError } from '@letta-ai/letta-client';

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
 * Check if an agent exists on the Letta server.
 *
 * IMPORTANT: Only returns false when the server confirms the agent does not
 * exist (404). Connection errors and other transient failures are re-thrown
 * so the caller can retry or wait — never silently treated as "not found".
 * This prevents accidental agent recreation when the server is temporarily
 * unreachable (e.g. during a restart).
 */
export async function agentExists(agentId: string): Promise<boolean> {
  const client = getClient();
  try {
    await client.agents.retrieve(agentId);
    return true;
  } catch (err) {
    if (err instanceof NotFoundError) {
      return false;
    }
    // Connection errors, timeouts, 500s, etc. — don't assume agent is gone
    throw err;
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
    console.error('[Letta API] Failed to get agent model:', e);
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
    console.error('[Letta API] Failed to update agent model:', e);
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
    // IMPORTANT: Must include 'agent.pending_approval' or the field won't be returned.
    try {
      const agentState = await client.agents.retrieve(agentId, {
        include: ['agent.pending_approval'],
      });
      if ('pending_approval' in agentState) {
        const pending = agentState.pending_approval;
        if (!pending) {
          console.log('[Letta API] No pending approvals on agent');
          return [];
        }
        console.log(`[Letta API] Found pending approval: ${pending.id}, run_id=${pending.run_id}`);
        
        // Extract tool calls - handle both Array<ToolCall> and ToolCallDelta formats
        const rawToolCalls = pending.tool_calls;
        const toolCallsList: Array<{ tool_call_id: string; name: string }> = [];
        
        if (Array.isArray(rawToolCalls)) {
          for (const tc of rawToolCalls) {
            if (tc && 'tool_call_id' in tc && tc.tool_call_id) {
              toolCallsList.push({ tool_call_id: tc.tool_call_id, name: tc.name || 'unknown' });
            }
          }
        } else if (rawToolCalls && typeof rawToolCalls === 'object' && 'tool_call_id' in rawToolCalls && rawToolCalls.tool_call_id) {
          // ToolCallDelta case
          toolCallsList.push({ tool_call_id: rawToolCalls.tool_call_id, name: rawToolCalls.name || 'unknown' });
        }
        
        // Fallback to deprecated singular tool_call field
        if (toolCallsList.length === 0 && pending.tool_call) {
          const tc = pending.tool_call;
          if ('tool_call_id' in tc && tc.tool_call_id) {
            toolCallsList.push({ tool_call_id: tc.tool_call_id, name: tc.name || 'unknown' });
          }
        }
        
        const seen = new Set<string>();
        const approvals: PendingApproval[] = [];
        for (const tc of toolCallsList) {
          if (seen.has(tc.tool_call_id)) continue;
          seen.add(tc.tool_call_id);
          approvals.push({
            runId: pending.run_id || 'unknown',
            toolCallId: tc.tool_call_id,
            toolName: tc.name || 'unknown',
            messageId: pending.id,
          });
        }
        console.log(`[Letta API] Extracted ${approvals.length} pending approval(s): ${approvals.map(a => a.toolName).join(', ')}`);
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
 * Ensure no tools on the agent require approval.
 * Call on startup to proactively prevent stuck approval states.
 */
export async function ensureNoToolApprovals(agentId: string): Promise<void> {
  try {
    const tools = await getAgentTools(agentId);
    const approvalTools = tools.filter(t => t.requiresApproval);
    if (approvalTools.length > 0) {
      console.log(`[Letta API] Found ${approvalTools.length} tool(s) requiring approval: ${approvalTools.map(t => t.name).join(', ')}`);
      console.log('[Letta API] Disabling tool approvals for headless operation...');
      await disableAllToolApprovals(agentId);
    }
  } catch (e) {
    console.warn('[Letta API] Failed to check/disable tool approvals:', e);
  }
}

/**
 * Disable approval requirement for ALL tools on an agent.
 * Useful for ensuring a headless deployment doesn't get stuck.
 */
/**
 * Recover from orphaned approval_request_messages by directly inspecting the conversation.
 * 
 * Unlike getPendingApprovals() which relies on agent.pending_approval or run stop_reason,
 * this function looks at the actual conversation messages to find unresolved approval requests
 * from terminated (failed/cancelled) runs.
 * 
 * Returns { recovered: true } if orphaned approvals were found and resolved.
 */
export async function recoverOrphanedConversationApproval(
  agentId: string,
  conversationId: string
): Promise<{ recovered: boolean; details: string }> {
  try {
    const client = getClient();
    
    // List recent messages from the conversation to find orphaned approvals
    const messagesPage = await client.conversations.messages.list(conversationId, { limit: 50 });
    const messages: Array<Record<string, unknown>> = [];
    for await (const msg of messagesPage) {
      messages.push(msg as unknown as Record<string, unknown>);
    }
    
    if (messages.length === 0) {
      return { recovered: false, details: 'No messages in conversation' };
    }
    
    // Build set of tool_call_ids that already have approval responses
    const resolvedToolCalls = new Set<string>();
    for (const msg of messages) {
      if (msg.message_type === 'approval_response_message') {
        const approvals = (msg.approvals as Array<{ tool_call_id?: string }>) || [];
        for (const a of approvals) {
          if (a.tool_call_id) resolvedToolCalls.add(a.tool_call_id);
        }
      }
    }
    
    // Find unresolved approval_request_messages
    interface UnresolvedApproval {
      toolCallId: string;
      toolName: string;
      runId: string;
    }
    const unresolvedByRun = new Map<string, UnresolvedApproval[]>();
    
    for (const msg of messages) {
      if (msg.message_type !== 'approval_request_message') continue;
      
      const toolCalls = (msg.tool_calls as Array<{ tool_call_id: string; name: string }>) 
        || (msg.tool_call ? [msg.tool_call as { tool_call_id: string; name: string }] : []);
      const runId = msg.run_id as string | undefined;
      
      for (const tc of toolCalls) {
        if (!tc.tool_call_id || resolvedToolCalls.has(tc.tool_call_id)) continue;
        
        const key = runId || 'unknown';
        if (!unresolvedByRun.has(key)) unresolvedByRun.set(key, []);
        unresolvedByRun.get(key)!.push({
          toolCallId: tc.tool_call_id,
          toolName: tc.name || 'unknown',
          runId: key,
        });
      }
    }
    
    if (unresolvedByRun.size === 0) {
      return { recovered: false, details: 'No unresolved approval requests found' };
    }
    
    // Check each run's status - only resolve orphaned approvals from terminated runs
    let recoveredCount = 0;
    const details: string[] = [];
    
    for (const [runId, approvals] of unresolvedByRun) {
      if (runId === 'unknown') {
        // No run_id on the approval message - can't verify, skip
        details.push(`Skipped ${approvals.length} approval(s) with no run_id`);
        continue;
      }
      
      try {
        const run = await client.runs.retrieve(runId);
        const status = run.status;
        const stopReason = run.stop_reason;
        const isTerminated = status === 'failed' || status === 'cancelled';
        const isAbandonedApproval = status === 'completed' && stopReason === 'requires_approval';
        // Active runs stuck on approval block the entire conversation.
        // No client is going to approve them -- reject and cancel so
        // lettabot can proceed.
        const isStuckApproval = status === 'running' && stopReason === 'requires_approval';
        
        if (isTerminated || isAbandonedApproval || isStuckApproval) {
          console.log(`[Letta API] Found ${approvals.length} blocking approval(s) from ${status}/${stopReason} run ${runId}`);
          
          // Send denial for each unresolved tool call
          const approvalResponses = approvals.map(a => ({
            approve: false as const,
            tool_call_id: a.toolCallId,
            type: 'approval' as const,
            reason: `Auto-denied: originating run was ${status}/${stopReason}`,
          }));
          
          await client.conversations.messages.create(conversationId, {
            messages: [{
              type: 'approval',
              approvals: approvalResponses,
            }],
            streaming: false,
          });
          
          // Cancel active stuck runs after rejecting their approvals
          let cancelled = false;
          if (isStuckApproval) {
            cancelled = await cancelRuns(agentId, [runId]);
            if (cancelled) {
              console.log(`[Letta API] Cancelled stuck run ${runId}`);
            } else {
              console.warn(`[Letta API] Failed to cancel stuck run ${runId}`);
            }
          }
          
          recoveredCount += approvals.length;
          const suffix = isStuckApproval ? (cancelled ? ' (cancelled)' : ' (cancel failed)') : '';
          details.push(`Denied ${approvals.length} approval(s) from ${status} run ${runId}${suffix}`);
        } else {
          details.push(`Run ${runId} is ${status}/${stopReason} - not orphaned`);
        }
      } catch (runError) {
        console.warn(`[Letta API] Failed to check run ${runId}:`, runError);
        details.push(`Failed to check run ${runId}`);
      }
    }
    
    const detailStr = details.join('; ');
    if (recoveredCount > 0) {
      console.log(`[Letta API] Recovered ${recoveredCount} orphaned approval(s): ${detailStr}`);
      return { recovered: true, details: detailStr };
    }
    
    return { recovered: false, details: detailStr };
  } catch (e) {
    console.error('[Letta API] Failed to recover orphaned conversation approval:', e);
    return { recovered: false, details: `Error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

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

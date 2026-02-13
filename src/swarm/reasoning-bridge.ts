/**
 * ReasoningBridge — Shared Reasoning Memory for Swarm Agents
 *
 * Orchestrates Thoughtbox Gateway + Hub to let swarm agents:
 * - Log their reasoning to per-niche branches in a shared session
 * - Read each other's recent reasoning before processing messages
 * - Post key decisions to a shared Hub channel
 */

import type { GatewayClient, ThoughtEntry } from './gateway-client.js';
import type { HubClient } from './hub-client.js';
import type { SwarmStore } from './swarm-store.js';
import type { SwarmAgentEntry } from './types.js';

export interface ReasoningContext {
  xml: string;
  thoughtCount: number;
  decisionCount: number;
}

export interface LogReasoningInput {
  inboundMessage: string;
  response: string;
  channel: string;
}

export interface ReasoningBridgeOptions {
  maxContextThoughts?: number;
  maxThoughtLength?: number;
}

const EMPTY_CONTEXT: ReasoningContext = { xml: '', thoughtCount: 0, decisionCount: 0 };
const SESSION_TITLE = 'lettabot-swarm-reasoning';
const WORKSPACE_NAME = 'lettabot-swarm';
const PROBLEM_TITLE = 'shared-reasoning';

export class ReasoningBridge {
  private gateway: GatewayClient;
  private hub: HubClient;
  private store: SwarmStore;
  private maxContextThoughts: number;
  private maxThoughtLength: number;
  private initialized = false;

  /** Maps nicheKey → whether first thought has been posted (needs branchFromThought) */
  private branchInitialized = new Map<string, boolean>();

  /** Track the main chain's latest thought number for branching */
  private mainChainHead: number | null = null;

  constructor(
    gateway: GatewayClient,
    hub: HubClient,
    store: SwarmStore,
    options: ReasoningBridgeOptions = {},
  ) {
    this.gateway = gateway;
    this.hub = hub;
    this.store = store;
    this.maxContextThoughts = options.maxContextThoughts ?? 5;
    this.maxThoughtLength = options.maxThoughtLength ?? 200;
  }

  /**
   * Initialize the reasoning bridge:
   * 1. Start or resume a Thoughtbox session
   * 2. Advance to Stage 2 (cipher)
   * 3. Create Hub workspace + problem for shared decisions
   * 4. Post initial thought on main chain
   */
  async initialize(agents: SwarmAgentEntry[]): Promise<void> {
    if (this.initialized) return;

    // 1. Start or resume session
    const existingSessionId = this.store.reasoningSessionId;
    if (existingSessionId) {
      await this.gateway.loadContext(existingSessionId);
    } else {
      const { sessionId } = await this.gateway.startNew(SESSION_TITLE, ['swarm', 'reasoning']);
      this.store.reasoningSessionId = sessionId;
    }

    // 2. Advance to Stage 2
    await this.gateway.cipher();

    // 3. Register coordinator with Hub (reuse existing hubAgentId)
    if (!this.store.hubAgentId) {
      const { agentId } = await this.hub.register('swarm-coordinator', 'coordinator');
      this.store.hubAgentId = agentId;
    }

    // 4. Create workspace if needed
    if (!this.store.reasoningWorkspaceId) {
      const { workspaceId } = await this.hub.createWorkspace(
        WORKSPACE_NAME,
        'Shared reasoning workspace for lettabot swarm agents',
      );
      this.store.reasoningWorkspaceId = workspaceId;
    }

    // 5. Create problem (channel) if needed
    if (!this.store.reasoningProblemId) {
      const { problemId } = await this.hub.createProblem(
        this.store.reasoningWorkspaceId!,
        PROBLEM_TITLE,
        'Cross-agent reasoning and shared decisions',
      );
      this.store.reasoningProblemId = problemId;
    }

    // 6. Register each agent in Hub if not already registered
    for (const agent of agents) {
      if (!this.store.getAgentHubId(agent.agentId)) {
        const { agentId: hubId } = await this.hub.register(
          `agent-${agent.nicheKey}`,
          'contributor',
        );
        this.store.setAgentHubId(agent.agentId, hubId);
      }
    }

    // 7. Post initial thought on main chain
    const result = await this.gateway.thought({
      thought: `Swarm reasoning session initialized with ${agents.length} agents: ${agents.map(a => a.nicheKey).join(', ')}`,
      thoughtType: 'initialization',
    });
    this.mainChainHead = result.thoughtNumber;

    this.initialized = true;
  }

  /**
   * Gather context from other agents' reasoning before processing a message.
   * Returns XML block to inject into message text.
   * Never throws — returns empty context on any error.
   */
  async gatherContext(agentId: string, nicheKey: string): Promise<ReasoningContext> {
    if (!this.initialized) return EMPTY_CONTEXT;

    try {
      const agents = this.store.agents;

      // Get thoughts from OTHER agents' branches
      const otherAgents = agents.filter(a => a.agentId !== agentId);
      if (otherAgents.length === 0) return EMPTY_CONTEXT;

      const thoughtPromises = otherAgents.map(a =>
        this.gateway.readThoughts({
          branchId: a.nicheKey,
          last: this.maxContextThoughts,
        }).catch(() => [] as ThoughtEntry[]),
      );

      // Read shared decisions from Hub channel
      const decisionsPromise = this.hub.readChannel(
        this.store.reasoningWorkspaceId!,
        this.store.reasoningProblemId!,
      ).catch(() => [] as any[]);

      const [thoughtResults, decisions] = await Promise.all([
        Promise.all(thoughtPromises),
        decisionsPromise,
      ]);

      // Flatten and limit thoughts
      const allThoughts: Array<ThoughtEntry & { fromAgent: string }> = [];
      for (let i = 0; i < otherAgents.length; i++) {
        const thoughts = thoughtResults[i];
        for (const t of thoughts) {
          allThoughts.push({ ...t, fromAgent: otherAgents[i].nicheKey });
        }
      }

      // Take the most recent N thoughts across all agents
      const recentThoughts = allThoughts
        .sort((a, b) => (b.thoughtNumber ?? 0) - (a.thoughtNumber ?? 0))
        .slice(0, this.maxContextThoughts);

      // Take the most recent N decisions
      const recentDecisions = Array.isArray(decisions)
        ? decisions.slice(-this.maxContextThoughts)
        : [];

      if (recentThoughts.length === 0 && recentDecisions.length === 0) {
        return EMPTY_CONTEXT;
      }

      // Build XML
      const xml = this.buildContextXml(recentThoughts, recentDecisions);
      return {
        xml,
        thoughtCount: recentThoughts.length,
        decisionCount: recentDecisions.length,
      };
    } catch {
      return EMPTY_CONTEXT;
    }
  }

  /**
   * Log reasoning after processing a message (fire-and-forget).
   */
  async logReasoning(
    agentId: string,
    nicheKey: string,
    input: LogReasoningInput,
  ): Promise<void> {
    if (!this.initialized) return;

    try {
      const thoughtInput: Record<string, unknown> = {
        thought: `[${input.channel}] Q: ${this.truncate(input.inboundMessage, 100)} → A: ${this.truncate(input.response, 100)}`,
        thoughtType: 'reasoning',
        branchId: nicheKey,
        agentId: this.store.getAgentHubId(agentId),
      };

      // First thought on a branch needs branchFromThought to fork from main chain
      if (!this.branchInitialized.get(nicheKey) && this.mainChainHead !== null) {
        thoughtInput.branchFromThought = this.mainChainHead;
        this.branchInitialized.set(nicheKey, true);
      }

      await this.gateway.thought(thoughtInput as any);
    } catch (err) {
      // Fire-and-forget: log but don't propagate
      console.error(`[ReasoningBridge] Failed to log reasoning for ${nicheKey}:`, err);
    }
  }

  /**
   * Post a key decision to the shared Hub channel.
   */
  async logDecision(agentId: string, summary: string): Promise<void> {
    if (!this.initialized) return;

    try {
      const agent = this.store.agents.find(a => a.agentId === agentId);
      const label = agent ? agent.nicheKey : agentId;
      await this.hub.postMessage(
        this.store.reasoningWorkspaceId!,
        this.store.reasoningProblemId!,
        `[${label}] ${summary}`,
      );
    } catch (err) {
      console.error(`[ReasoningBridge] Failed to log decision:`, err);
    }
  }

  private buildContextXml(
    thoughts: Array<ThoughtEntry & { fromAgent: string }>,
    decisions: any[],
  ): string {
    const parts: string[] = ['<swarm-context>'];

    if (thoughts.length > 0) {
      parts.push(`  <recent-thoughts count="${thoughts.length}">`);
      for (const t of thoughts) {
        const content = this.truncate(t.thought, this.maxThoughtLength);
        parts.push(
          `    <thought agent="agent-${t.fromAgent}" branch="${t.fromAgent}" t="${t.thoughtNumber}">`
        );
        parts.push(`      ${content}`);
        parts.push('    </thought>');
      }
      parts.push('  </recent-thoughts>');
    }

    if (decisions.length > 0) {
      parts.push(`  <shared-decisions count="${decisions.length}">`);
      for (const d of decisions) {
        const content = typeof d === 'string' ? d : d.content || JSON.stringify(d);
        parts.push(`    <decision>${this.truncate(content, this.maxThoughtLength)}</decision>`);
      }
      parts.push('  </shared-decisions>');
    }

    parts.push('</swarm-context>');
    return parts.join('\n');
  }

  private truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen - 3) + '...';
  }
}

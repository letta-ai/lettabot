/**
 * SwarmManager — Top-Level Orchestrator
 *
 * Routes messages to the best-fit agent via NicheMatcher + SwarmStore,
 * using per-agent queues instead of the single processing mutex.
 * Falls back to single-agent behavior in mode: 'single'.
 */

import type { InboundMessage } from '../core/types.js';
import type { ChannelAdapter } from '../channels/types.js';
import type { SwarmStore } from './swarm-store.js';
import type { NicheDescriptor, SwarmAgentEntry } from './types.js';
import type { ReasoningBridge } from './reasoning-bridge.js';

type NicheMatcherFn = (msg: InboundMessage) => NicheDescriptor;
type ProcessorFn = (agentId: string, msg: InboundMessage, adapter: ChannelAdapter) => Promise<void>;
type QueuedMessage = { msg: InboundMessage; adapter: ChannelAdapter };

export class SwarmManager {
  private store: SwarmStore;
  private matchNiche: NicheMatcherFn;
  private queues: Map<string, QueuedMessage[]> = new Map();
  private processor: ProcessorFn | null = null;
  private reasoningBridge: ReasoningBridge | null = null;

  constructor(store: SwarmStore, matchNiche: NicheMatcherFn) {
    this.store = store;
    this.matchNiche = matchNiche;
  }

  /**
   * Set the message processor function (called for each agent+message pair).
   */
  setProcessor(fn: ProcessorFn): void {
    this.processor = fn;
  }

  /**
   * Set the reasoning bridge for cross-agent context sharing.
   */
  setReasoningBridge(bridge: ReasoningBridge): void {
    this.reasoningBridge = bridge;
  }

  /**
   * Classify a message into a niche descriptor.
   */
  classifyMessage(msg: InboundMessage): NicheDescriptor {
    return this.matchNiche(msg);
  }

  /**
   * Route a message to the appropriate agent.
   * Returns the agent entry or null if no agent is available.
   */
  routeMessage(msg: InboundMessage): { agentId: string; niche?: NicheDescriptor } | null {
    if (this.store.mode === 'single') {
      const agentId = this.store.agentId;
      if (!agentId) return null;
      return { agentId };
    }

    // Swarm mode: classify and route
    const niche = this.classifyMessage(msg);
    const agent = this.store.getAgentForNiche(niche);
    if (!agent) {
      this.store.incrementUnservedNiche(niche.key);
      this.store.incrementRouteFallback(niche.key);
      return null;
    }
    this.store.incrementRouteSuccess(niche.key);

    return { agentId: agent.agentId, niche };
  }

  /**
   * Add a message to an agent's queue.
   */
  enqueueMessage(agentId: string, msg: InboundMessage, adapter: ChannelAdapter): void {
    if (!this.queues.has(agentId)) {
      this.queues.set(agentId, []);
    }
    this.queues.get(agentId)!.push({ msg, adapter });
  }

  /**
   * Process all queues concurrently — one message per agent at a time.
   * When a reasoning bridge is attached, gathers cross-agent context before
   * processing and logs reasoning after (fire-and-forget).
   */
  async processQueues(): Promise<void> {
    if (!this.processor) return;

    const promises: Promise<void>[] = [];

    for (const [agentId, queue] of this.queues.entries()) {
      if (queue.length === 0) continue;

      const queued = queue.shift()!;
      const msg = queued.msg;
      const adapter = queued.adapter;
      const nicheKey = this.resolveNicheKey(agentId);
      const bridge = this.reasoningBridge;

      promises.push(
        (async () => {
          // PRE: gather cross-agent context
          let enrichedMsg = msg;
          if (bridge && nicheKey) {
            try {
              const ctx = await bridge.gatherContext(agentId, nicheKey);
              if (ctx.xml) {
                enrichedMsg = { ...msg, text: `${msg.text}\n\n${ctx.xml}` };
              }
            } catch {
              // Never block message processing
            }
          }

          // PROCESS: existing behavior
          await this.processor!(agentId, enrichedMsg, adapter);

          // POST: log reasoning (fire-and-forget)
          if (bridge && nicheKey) {
            bridge.logReasoning(agentId, nicheKey, {
              inboundMessage: msg.text,
              response: '(processed)',
              channel: msg.channel,
            }).catch(() => {});
          }
        })()
      );
    }

    await Promise.all(promises);

    // Clean up empty queues
    for (const [agentId, queue] of this.queues.entries()) {
      if (queue.length === 0) {
        this.queues.delete(agentId);
      }
    }
  }

  /**
   * Resolve the niche key for an agent from the store.
   */
  private resolveNicheKey(agentId: string): string | null {
    const agent = this.store.agents.find(a => a.agentId === agentId);
    return agent?.nicheKey ?? null;
  }

  /**
   * Get queue sizes for all agents (for monitoring/testing).
   */
  getQueueSizes(): Map<string, number> {
    const sizes = new Map<string, number>();
    for (const [agentId, queue] of this.queues.entries()) {
      sizes.set(agentId, queue.length);
    }
    return sizes;
  }

  /**
   * Get tracked unserved count for a niche.
   */
  getUnservedNicheCount(nicheKey: string): number {
    return this.store.getUnservedNicheCount(nicheKey);
  }

  /**
   * Create an agent entry for a niche and register in SwarmStore.
   */
  createAgentForNiche(agentId: string, blueprintId: string, niche: NicheDescriptor): void {
    this.store.setAgentForNiche(agentId, blueprintId, niche.key);
  }
}

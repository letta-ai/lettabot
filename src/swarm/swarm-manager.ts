/**
 * SwarmManager — Top-Level Orchestrator
 *
 * Routes messages to the best-fit agent via NicheMatcher + SwarmStore,
 * using per-agent queues instead of the single processing mutex.
 * Falls back to single-agent behavior in mode: 'single'.
 */

import type { InboundMessage } from '../core/types.js';
import type { SwarmStore } from './swarm-store.js';
import type { NicheDescriptor, SwarmAgentEntry } from './types.js';

type NicheMatcherFn = (msg: InboundMessage) => NicheDescriptor;
type ProcessorFn = (agentId: string, msg: InboundMessage) => Promise<void>;

export class SwarmManager {
  private store: SwarmStore;
  private matchNiche: NicheMatcherFn;
  private queues: Map<string, InboundMessage[]> = new Map();
  private processor: ProcessorFn | null = null;

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
    const niche = this.matchNiche(msg);
    const agent = this.store.getAgentForNiche(niche);
    if (!agent) return null;

    return { agentId: agent.agentId, niche };
  }

  /**
   * Add a message to an agent's queue.
   */
  enqueueMessage(agentId: string, msg: InboundMessage): void {
    if (!this.queues.has(agentId)) {
      this.queues.set(agentId, []);
    }
    this.queues.get(agentId)!.push(msg);
  }

  /**
   * Process all queues concurrently — one message per agent at a time.
   */
  async processQueues(): Promise<void> {
    if (!this.processor) return;

    const promises: Promise<void>[] = [];

    for (const [agentId, queue] of this.queues.entries()) {
      if (queue.length === 0) continue;

      const msg = queue.shift()!;
      promises.push(this.processor(agentId, msg));
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
   * Create an agent entry for a niche and register in SwarmStore.
   */
  createAgentForNiche(agentId: string, blueprintId: string, niche: NicheDescriptor): void {
    this.store.addAgent({
      agentId,
      blueprintId,
      nicheKey: niche.key,
      createdAt: new Date().toISOString(),
    });
  }
}

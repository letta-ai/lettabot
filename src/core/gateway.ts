/**
 * LettaGateway - Orchestrates multiple agent sessions.
 *
 * In multi-agent mode, the gateway manages multiple AgentSession instances,
 * each with their own channels, message queue, and state.
 *
 * See: docs/multi-agent-architecture.md
 */

import type { AgentSession, MessageDeliverer } from './interfaces.js';

export class LettaGateway implements MessageDeliverer {
  private agents: Map<string, AgentSession> = new Map();

  /**
   * Add a named agent session to the gateway.
   * @throws if name is empty or already exists
   */
  addAgent(name: string, session: AgentSession): void {
    if (!name?.trim()) {
      throw new Error('Agent name cannot be empty');
    }
    if (this.agents.has(name)) {
      throw new Error(`Agent "${name}" already exists`);
    }
    this.agents.set(name, session);
    console.log(`[Gateway] Added agent: ${name}`);
  }

  /** Get an agent session by name */
  getAgent(name: string): AgentSession | undefined {
    return this.agents.get(name);
  }

  /** Get all agent names */
  getAgentNames(): string[] {
    return Array.from(this.agents.keys());
  }

  /** Get agent count */
  get size(): number {
    return this.agents.size;
  }

  /** Start all agents */
  async start(): Promise<void> {
    console.log(`[Gateway] Starting ${this.agents.size} agent(s)...`);
    const results = await Promise.allSettled(
      Array.from(this.agents.entries()).map(async ([name, session]) => {
        await session.start();
        console.log(`[Gateway] Started: ${name}`);
      })
    );
    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length > 0) {
      console.error(`[Gateway] ${failed.length} agent(s) failed to start`);
    }
    console.log(`[Gateway] ${results.length - failed.length}/${results.length} agents started`);
  }

  /** Stop all agents */
  async stop(): Promise<void> {
    console.log(`[Gateway] Stopping all agents...`);
    for (const [name, session] of this.agents) {
      try {
        await session.stop();
        console.log(`[Gateway] Stopped: ${name}`);
      } catch (e) {
        console.error(`[Gateway] Failed to stop ${name}:`, e);
      }
    }
  }

  /**
   * Deliver a message to a channel.
   * Finds the agent that owns the channel and delegates.
   */
  async deliverToChannel(
    channelId: string,
    chatId: string,
    options: { text?: string; filePath?: string; kind?: 'image' | 'file' }
  ): Promise<string | undefined> {
    // Try each agent until one owns the channel
    for (const [name, session] of this.agents) {
      const status = session.getStatus();
      if (status.channels.includes(channelId)) {
        return session.deliverToChannel(channelId, chatId, options);
      }
    }
    throw new Error(`No agent owns channel: ${channelId}`);
  }
}

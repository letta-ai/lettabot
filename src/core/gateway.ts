/**
 * LettaGateway - Orchestrates multiple agent sessions.
 *
 * In multi-agent mode, the gateway manages multiple AgentSession instances,
 * each with their own channels, message queue, and state.
 *
 * See: docs/multi-agent-architecture.md
 */

import type { AgentSession, AgentRouter } from './interfaces.js';
import type { TriggerContext } from './types.js';
import type { StreamMsg } from './bot.js';

import { createLogger } from '../logger.js';

const log = createLogger('Gateway');
export class LettaGateway implements AgentRouter {
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
    log.info(`Added agent: ${name}`);
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
    log.info(`Starting ${this.agents.size} agent(s)...`);
    const results = await Promise.allSettled(
      Array.from(this.agents.entries()).map(async ([name, session]) => {
        await session.start();
        log.info(`Started: ${name}`);
      })
    );
    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length > 0) {
      log.error(`${failed.length} agent(s) failed to start`);
    }
    log.info(`${results.length - failed.length}/${results.length} agents started`);
  }

  /** Stop all agents */
  async stop(): Promise<void> {
    log.info(`Stopping all agents...`);
    for (const [name, session] of this.agents) {
      try {
        await session.stop();
        log.info(`Stopped: ${name}`);
      } catch (e) {
        log.error(`Failed to stop ${name}:`, e);
      }
    }
  }

  /**
   * Send a message to a named agent and return the response.
   * If no name is given, routes to the first registered agent.
   */
  async sendToAgent(agentName: string | undefined, text: string, context?: TriggerContext): Promise<string> {
    const agent = this.resolveAgent(agentName);
    return agent.sendToAgent(text, context);
  }

  /**
   * Stream a message to a named agent, yielding chunks as they arrive.
   */
  async *streamToAgent(agentName: string | undefined, text: string, context?: TriggerContext): AsyncGenerator<StreamMsg> {
    const agent = this.resolveAgent(agentName);
    yield* agent.streamToAgent(text, context);
  }

  /**
   * Resolve an agent by name, defaulting to the first registered agent.
   */
  private resolveAgent(name?: string): AgentSession {
    if (!name) {
      const first = this.agents.values().next().value;
      if (!first) throw new Error('No agents configured');
      return first;
    }
    const agent = this.agents.get(name);
    if (!agent) throw new Error(`Agent not found: ${name}`);
    return agent;
  }

  /**
   * Deliver a message to a channel.
   * Finds the agent that owns the channel and delegates.
   */
  async deliverToChannel(
    channelId: string,
    chatId: string,
    options: { text?: string; filePath?: string; kind?: 'image' | 'file' | 'audio' }
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

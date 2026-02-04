/**
 * LettaGateway - Orchestrates multiple agent sessions
 *
 * In multi-agent mode, the gateway:
 * - Creates AgentSession for each configured agent
 * - Routes channel adapters to the correct agent
 * - Coordinates startup/shutdown
 *
 * See: https://github.com/letta-ai/lettabot/issues/109
 */

import { AgentSession, type AgentSessionConfig } from "./agent-session.js";
import { MultiAgentStore } from "./store.js";
import type { ChannelAdapter } from "../channels/types.js";
import type { MultiAgentEntry, AgentChannelBinding } from "../config/types.js";
import type { TriggerContext } from "./types.js";

export interface GatewayConfig {
  /** Working directory for all agents */
  workingDir: string;
  /** Allowed tools for all agents */
  allowedTools: string[];
  /** Default model (can be overridden per-agent) */
  defaultModel?: string;
}

export class LettaGateway {
  private store: MultiAgentStore;
  private config: GatewayConfig;
  private agents: Map<string, AgentSession> = new Map();

  constructor(config: GatewayConfig) {
    this.config = config;
    this.store = new MultiAgentStore();
    console.log("[Gateway] Initialized");
  }

  /**
   * Add an agent to the gateway
   * @throws Error if agent name is empty or already exists
   */
  addAgent(entry: MultiAgentEntry): AgentSession {
    // Validate agent name
    if (!entry.name || !entry.name.trim()) {
      throw new Error('Agent name cannot be empty');
    }

    // Check for duplicate names
    if (this.agents.has(entry.name)) {
      throw new Error(`Agent name "${entry.name}" already exists. Agent names must be unique.`);
    }

    const sessionConfig: AgentSessionConfig = {
      workingDir: this.config.workingDir,
      allowedTools: this.config.allowedTools,
      model: entry.model || this.config.defaultModel,
      agentName: entry.name,
      existingAgentId: entry.id,
      cronEnabled: entry.features?.cron,
      googleEnabled: entry.features?.polling?.gmail?.enabled ?? false,
    };

    const session = new AgentSession(sessionConfig, this.store);
    this.agents.set(entry.name, session);
    console.log(`[Gateway] Added agent: ${entry.name}`);
    return session;
  }

  /**
   * Get an agent session by name
   */
  getAgent(name: string): AgentSession | undefined {
    return this.agents.get(name);
  }

  /**
   * Get all agent names
   */
  getAgentNames(): string[] {
    return Array.from(this.agents.keys());
  }

  /**
   * Register a channel adapter for a specific agent
   */
  registerChannel(agentName: string, adapter: ChannelAdapter): void {
    const session = this.agents.get(agentName);
    if (!session) {
      throw new Error(`Agent not found: ${agentName}`);
    }
    session.registerChannel(adapter);
  }

  /**
   * Start all agents
   */
  async start(): Promise<void> {
    console.log(`[Gateway] Starting ${this.agents.size} agent(s)...`);

    const startPromises = Array.from(this.agents.entries()).map(
      async ([name, session]) => {
        try {
          await session.start();
          console.log(`[Gateway] Agent started: ${name}`);
        } catch (e) {
          console.error(`[Gateway] Failed to start agent ${name}:`, e);
        }
      },
    );

    await Promise.all(startPromises);
    console.log("[Gateway] All agents started");
  }

  /**
   * Stop all agents
   */
  async stop(): Promise<void> {
    console.log("[Gateway] Stopping all agents...");

    for (const [name, session] of this.agents) {
      try {
        await session.stop();
        console.log(`[Gateway] Agent stopped: ${name}`);
      } catch (e) {
        console.error(`[Gateway] Failed to stop agent ${name}:`, e);
      }
    }
  }

  /**
   * Send a message to a specific agent
   */
  async sendToAgent(
    agentName: string,
    text: string,
    context?: TriggerContext,
  ): Promise<string> {
    const session = this.agents.get(agentName);
    if (!session) {
      throw new Error(`Agent not found: ${agentName}`);
    }
    return session.sendToAgent(text, context);
  }

  /**
   * Deliver a message to a channel (finds the agent that owns the channel)
   */
  async deliverToChannel(
    channelId: string,
    chatId: string,
    options: { text?: string; filePath?: string; kind?: "image" | "file" },
  ): Promise<string | undefined> {
    // Find the agent that has this channel
    for (const session of this.agents.values()) {
      if (session.getChannelIds().includes(channelId)) {
        return session.deliverToChannel(channelId, chatId, options);
      }
    }
    throw new Error(`No agent has channel: ${channelId}`);
  }

  /**
   * Get status for all agents
   */
  getStatus(): {
    agents: Array<{ name: string; agentId: string | null; channels: string[] }>;
  } {
    const agents = Array.from(this.agents.entries()).map(([name, session]) => ({
      name,
      agentId: session.agentId,
      channels: session.getChannelIds(),
    }));
    return { agents };
  }

  /**
   * Set heartbeat trigger callback for an agent
   */
  setHeartbeatTrigger(agentName: string, callback: () => Promise<void>): void {
    const session = this.agents.get(agentName);
    if (session) {
      session.onTriggerHeartbeat = callback;
    }
  }

  /**
   * Get the store (for external access)
   */
  getStore(): MultiAgentStore {
    return this.store;
  }
}

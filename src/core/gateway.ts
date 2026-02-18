/**
 * Gateway - Message routing layer between channels and agents
 * 
 * This replaces the direct bot->channel connection with a router
 * that can direct messages to different agents based on bindings.
 */

import type { ChannelAdapter } from '../channels/types.js';
import type { InboundMessage } from './types.js';
import type { NormalizedConfig } from '../config/types.js';
import { AgentManager, createAgentManager } from './agent-manager.js';
import { MessageRouter, createRouter, type RoutingContext } from '../routing/router.js';

/**
 * Gateway manages channel adapters and routes messages to agents
 */
export class Gateway {
  private config: NormalizedConfig;
  private agentManager: AgentManager;
  private router: MessageRouter;
  private channels: Map<string, ChannelAdapter> = new Map();
  
  constructor(config: NormalizedConfig) {
    this.config = config;
    this.agentManager = createAgentManager(config);
    this.router = createRouter(config.bindings, this.agentManager.getDefaultAgentId());
  }
  
  /**
   * Register a channel adapter
   */
  registerChannel(adapter: ChannelAdapter): void {
    const key = `${adapter.id}:${adapter.accountId}`;
    this.channels.set(key, adapter);
    
    // Wire up message handler with routing
    adapter.onMessage = async (msg: InboundMessage) => {
      await this.handleMessage(msg, adapter);
    };
    
    console.log(`[Gateway] Registered channel: ${adapter.name} (${key})`);
  }
  
  /**
   * Get a channel adapter by ID and account
   */
  getChannel(channelId: string, accountId: string = 'default'): ChannelAdapter | undefined {
    return this.channels.get(`${channelId}:${accountId}`);
  }
  
  /**
   * Get all registered channels
   */
  getChannels(): ChannelAdapter[] {
    return Array.from(this.channels.values());
  }
  
  /**
   * Get the agent manager
   */
  getAgentManager(): AgentManager {
    return this.agentManager;
  }
  
  /**
   * Start all channels
   */
  async start(): Promise<void> {
    // Verify agents exist on server
    await this.agentManager.verifyAgents();
    
    // Start all channels
    for (const adapter of this.channels.values()) {
      try {
        await adapter.start();
        console.log(`[Gateway] Started channel: ${adapter.name}`);
      } catch (error) {
        console.error(`[Gateway] Failed to start ${adapter.name}:`, error);
      }
    }
  }
  
  /**
   * Stop all channels
   */
  async stop(): Promise<void> {
    for (const adapter of this.channels.values()) {
      try {
        await adapter.stop();
      } catch (error) {
        console.error(`[Gateway] Error stopping ${adapter.name}:`, error);
      }
    }
  }
  
  /**
   * Handle an incoming message - route to appropriate agent
   */
  private async handleMessage(msg: InboundMessage, adapter: ChannelAdapter): Promise<void> {
    // Build routing context
    const ctx: RoutingContext = {
      channel: msg.channel,
      accountId: msg.accountId || adapter.accountId,
      peerId: msg.chatId,
      peerKind: msg.isGroup ? 'group' : 'dm',
    };
    
    // Route to agent
    const result = this.router.route(ctx);
    const routeDesc = this.router.describeRoute(ctx);
    console.log(`[Gateway] Routing ${msg.channel}:${msg.chatId} ${routeDesc}`);
    
    // Get agent and process
    const agent = this.agentManager.getAgent(result.agentId);
    if (!agent) {
      console.error(`[Gateway] Agent not found: ${result.agentId}`);
      await adapter.sendMessage({
        chatId: msg.chatId,
        text: `Error: Agent "${result.agentId}" not found`,
        threadId: msg.threadId,
      });
      return;
    }
    
    // Process with agent
    await agent.processMessage(msg, adapter);
  }
  
  /**
   * Get status summary
   */
  getStatus(): {
    channels: string[];
    agents: ReturnType<AgentManager['getStatus']>;
    bindings: number;
  } {
    return {
      channels: Array.from(this.channels.keys()),
      agents: this.agentManager.getStatus(),
      bindings: this.config.bindings.length,
    };
  }
}

/**
 * Create a gateway from normalized config
 */
export function createGateway(config: NormalizedConfig): Gateway {
  return new Gateway(config);
}

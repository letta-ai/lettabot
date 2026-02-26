/**
 * AgentSession interface - the contract for agent communication.
 *
 * Consumers (cron, heartbeat, polling, API server) depend on this interface,
 * not the concrete LettaBot class. This enables multi-agent orchestration
 * via LettaGateway without changing consumer code.
 */

import type { ChannelAdapter } from '../channels/types.js';
import type { InboundMessage, TriggerContext } from './types.js';
import type { GroupBatcher } from './group-batcher.js';
import type { StreamMsg } from './bot.js';

export interface AgentSession {
  /** Register a channel adapter */
  registerChannel(adapter: ChannelAdapter): void;

  /** Configure group message batching */
  setGroupBatcher(batcher: GroupBatcher, intervals: Map<string, number>, instantGroupIds?: Set<string>, listeningGroupIds?: Set<string>): void;

  /** Process a batched group message */
  processGroupBatch(msg: InboundMessage, adapter: ChannelAdapter): void;

  /** Start all registered channels */
  start(): Promise<void>;

  /** Stop all channels */
  stop(): Promise<void>;

  /** Send a message to the agent (used by cron, heartbeat, polling) */
  sendToAgent(text: string, context?: TriggerContext): Promise<string>;

  /** Stream a message to the agent, yielding chunks as they arrive */
  streamToAgent(text: string, context?: TriggerContext): AsyncGenerator<StreamMsg>;

  /** Deliver a message/file to a specific channel */
  deliverToChannel(channelId: string, chatId: string, options: {
    text?: string;
    filePath?: string;
    kind?: 'image' | 'file' | 'audio';
  }): Promise<string | undefined>;

  /** Get agent status */
  getStatus(): { agentId: string | null; conversationId: string | null; channels: string[] };

  /** Set agent ID (for container deploys) */
  setAgentId(agentId: string): void;

  /** Reset agent state */
  reset(): void;

  /** Get the last message target (for heartbeat delivery) */
  getLastMessageTarget(): { channel: string; chatId: string } | null;

  /** Get the time of the last user message (for heartbeat skip logic) */
  getLastUserMessageTime(): Date | null;

  /** Callback to trigger heartbeat */
  onTriggerHeartbeat?: () => Promise<void>;
}

/**
 * Minimal interface for message delivery.
 * Satisfied by both AgentSession and LettaGateway.
 */
export interface MessageDeliverer {
  deliverToChannel(channelId: string, chatId: string, options: {
    text?: string;
    filePath?: string;
    kind?: 'image' | 'file' | 'audio';
  }): Promise<string | undefined>;
}

/**
 * Extended interface for the API server.
 * Supports both outbound delivery (to channels) and inbound chat (to agents).
 * Satisfied by LettaGateway.
 */
export interface AgentRouter extends MessageDeliverer {
  /** Send a message to a named agent and return the response text */
  sendToAgent(agentName: string | undefined, text: string, context?: TriggerContext): Promise<string>;
  /** Stream a message to a named agent, yielding chunks as they arrive */
  streamToAgent(agentName: string | undefined, text: string, context?: TriggerContext): AsyncGenerator<StreamMsg>;
  /** Get all registered agent names */
  getAgentNames(): string[];
}

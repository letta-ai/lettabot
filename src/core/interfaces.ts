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

export interface AgentSession {
  /** Register a channel adapter */
  registerChannel(adapter: ChannelAdapter): void;

  /** Configure group message batching */
  setGroupBatcher(batcher: GroupBatcher, intervals: Map<string, number>, instantGroupIds?: Set<string>): void;

  /** Process a batched group message */
  processGroupBatch(msg: InboundMessage, adapter: ChannelAdapter): void;

  /** Start all registered channels */
  start(): Promise<void>;

  /** Stop all channels */
  stop(): Promise<void>;

  /** Send a message to the agent (used by cron, heartbeat, polling) */
  sendToAgent(text: string, context?: TriggerContext): Promise<string>;

  /** Deliver a message/file to a specific channel */
  deliverToChannel(channelId: string, chatId: string, options: {
    text?: string;
    filePath?: string;
    kind?: 'image' | 'file';
  }): Promise<string | undefined>;

  /** Get agent status */
  getStatus(): { agentId: string | null; channels: string[] };

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

import { Store } from '../core/store.js';

export interface LastTarget {
  channel: string;
  chatId: string;
  messageId?: string;
}

/**
 * Get the agent name from environment or config.
 * Mirrors the logic in src/config/types.ts
 */
function getAgentName(): string {
  return process.env.LETTA_AGENT_NAME || process.env.AGENT_NAME || 'LettaBot';
}

/**
 * Load the last message target from the agent store.
 * Uses Store class which handles both v1 and v2 formats transparently.
 * Respects AGENT_NAME/LETTA_AGENT_NAME environment variables.
 */
export function loadLastTarget(): LastTarget | null {
  const agentName = getAgentName();
  const store = new Store('lettabot-agent.json', agentName);
  return store.lastMessageTarget || null;
}

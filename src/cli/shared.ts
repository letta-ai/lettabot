import { Store } from '../core/store.js';

export interface LastTarget {
  channel: string;
  chatId: string;
  messageId?: string;
}

/**
 * Load the last message target from the agent store.
 * Uses Store class which handles both v1 and v2 formats transparently.
 */
export function loadLastTarget(): LastTarget | null {
  const store = new Store('lettabot-agent.json');
  return store.lastMessageTarget || null;
}

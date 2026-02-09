import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDataDir } from '../utils/paths.js';

export interface LastTarget {
  channel: string;
  chatId: string;
  messageId?: string;
}

interface AgentStore {
  agentId?: string;
  lastMessageTarget?: LastTarget;
}

export const STORE_PATH = resolve(getDataDir(), 'lettabot-agent.json');

export function loadLastTarget(storePath: string = STORE_PATH): LastTarget | null {
  try {
    if (existsSync(storePath)) {
      const store: AgentStore = JSON.parse(readFileSync(storePath, 'utf-8'));
      return store.lastMessageTarget || null;
    }
  } catch {
    // Ignore
  }
  return null;
}

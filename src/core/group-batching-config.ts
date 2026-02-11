import type { AgentConfig } from '../config/types.js';

type DebounceConfig = { groupDebounceSec?: number; groupPollIntervalMin?: number };
type GroupBatchingConfig = DebounceConfig & {
  instantGroups?: string[];
  listeningGroups?: string[];
};

/**
 * Resolve group debounce value to milliseconds.
 * Prefers groupDebounceSec, falls back to deprecated groupPollIntervalMin.
 * Default: 5 seconds (5000ms).
 */
export function resolveDebounceMs(channel: DebounceConfig): number {
  if (channel.groupDebounceSec !== undefined) return channel.groupDebounceSec * 1000;
  if (channel.groupPollIntervalMin !== undefined) return channel.groupPollIntervalMin * 60 * 1000;
  return 5000;
}

/**
 * Build per-channel group batching configuration for an agent.
 */
export function collectGroupBatchingConfig(
  channels: AgentConfig['channels'],
): { intervals: Map<string, number>; instantIds: Set<string>; listeningIds: Set<string> } {
  const intervals = new Map<string, number>();
  const instantIds = new Set<string>();
  const listeningIds = new Set<string>();

  const addChannel = (channel: string, config?: GroupBatchingConfig): void => {
    if (!config) return;
    intervals.set(channel, resolveDebounceMs(config));
    for (const id of config.instantGroups || []) {
      instantIds.add(`${channel}:${id}`);
    }
    for (const id of config.listeningGroups || []) {
      listeningIds.add(`${channel}:${id}`);
    }
  };

  addChannel('telegram', channels.telegram);

  const mtprotoConfig = channels['telegram-mtproto'];
  if (mtprotoConfig) {
    // MTProto does not currently support listeningGroups, only instant/debounce behavior.
    intervals.set('telegram-mtproto', resolveDebounceMs(mtprotoConfig));
    for (const id of mtprotoConfig.instantGroups || []) {
      instantIds.add(`telegram-mtproto:${id}`);
    }
  }

  addChannel('slack', channels.slack);
  addChannel('whatsapp', channels.whatsapp);
  addChannel('signal', channels.signal);
  addChannel('discord', channels.discord);

  return { intervals, instantIds, listeningIds };
}

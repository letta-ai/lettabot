/**
 * Shared group mode helpers across channel adapters.
 */

export type GroupMode = 'open' | 'listen' | 'mention-only' | 'disabled';

export interface GroupModeConfig {
  mode?: GroupMode;
  /** Only process group messages from these user IDs. Omit to allow all users. */
  allowedUsers?: string[];
  /** Process messages from other bots instead of dropping them. Default: false. */
  receiveBotMessages?: boolean;
  /** Maximum total bot triggers per day in this group. Omit for unlimited. */
  dailyLimit?: number;
  /** Maximum bot triggers per user per day in this group. Omit for unlimited. */
  dailyUserLimit?: number;
  /**
   * @deprecated Use mode: "mention-only" (true) or "open" (false).
   */
  requireMention?: boolean;
}

export type GroupsConfig = Record<string, GroupModeConfig>;

function coerceMode(config?: GroupModeConfig): GroupMode | undefined {
  if (!config) return undefined;
  if (config.mode === 'open' || config.mode === 'listen' || config.mode === 'mention-only' || config.mode === 'disabled') {
    return config.mode;
  }
  if (typeof config.requireMention === 'boolean') {
    return config.requireMention ? 'mention-only' : 'open';
  }
  // For explicitly configured group entries with no mode, default safely.
  return 'mention-only';
}

/**
 * Whether a group/channel is allowed by groups config.
 *
 * If no groups config exists, this returns true (open allowlist).
 */
export function isGroupAllowed(groups: GroupsConfig | undefined, keys: string[]): boolean {
  if (!groups) return false; // No groups config = don't participate in groups
  if (Object.keys(groups).length === 0) return false;
  if (Object.hasOwn(groups, '*')) return true;
  return keys.some((key) => Object.hasOwn(groups, key));
}

/**
 * Resolve the effective allowedUsers list for a group/channel.
 *
 * Priority:
 * 1. First matching key in provided order
 * 2. Wildcard "*"
 * 3. undefined (no user filtering)
 */
export function resolveGroupAllowedUsers(
  groups: GroupsConfig | undefined,
  keys: string[],
): string[] | undefined {
  if (groups) {
    for (const key of keys) {
      if (groups[key]?.allowedUsers) return groups[key].allowedUsers;
    }
    if (groups['*']?.allowedUsers) return groups['*'].allowedUsers;
  }
  return undefined;
}

/**
 * Check whether a user is allowed to trigger the bot in a group.
 *
 * Returns true when no allowedUsers list is configured (open to all).
 */
export function isGroupUserAllowed(
  groups: GroupsConfig | undefined,
  keys: string[],
  userId: string,
): boolean {
  const allowed = resolveGroupAllowedUsers(groups, keys);
  if (!allowed) return true;
  return allowed.includes(userId);
}

/**
 * Resolve whether bot messages should be processed for a group/channel.
 *
 * Priority:
 * 1. First matching key in provided order
 * 2. Wildcard "*"
 * 3. false (default: bot messages dropped)
 */
export function resolveReceiveBotMessages(
  groups: GroupsConfig | undefined,
  keys: string[],
): boolean {
  if (groups) {
    for (const key of keys) {
      if (groups[key]?.receiveBotMessages !== undefined) return !!groups[key].receiveBotMessages;
    }
    if (groups['*']?.receiveBotMessages !== undefined) return !!groups['*'].receiveBotMessages;
  }
  return false;
}

/**
 * Resolve effective mode for a group/channel.
 *
 * Priority:
 * 1. First matching key in provided order
 * 2. Wildcard "*"
 * 3. Fallback (default: "open")
 */
export function resolveGroupMode(
  groups: GroupsConfig | undefined,
  keys: string[],
  fallback: GroupMode = 'open',
): GroupMode {
  if (groups) {
    for (const key of keys) {
      const mode = coerceMode(groups[key]);
      if (mode) return mode;
    }
    const wildcardMode = coerceMode(groups['*']);
    if (wildcardMode) return wildcardMode;
  }
  return fallback;
}

export interface ResolvedDailyLimits {
  dailyLimit?: number;
  dailyUserLimit?: number;
  /** The config key that provided the limits (e.g. channelId, guildId, or "*"). */
  matchedKey?: string;
}

/**
 * Resolve the effective daily limit config for a group/channel.
 *
 * Priority for each field independently:
 * 1. First matching key in provided order
 * 2. Wildcard "*"
 * 3. undefined (no limit)
 *
 * Fields are merged: a specific key can set `dailyLimit` while wildcard
 * provides `dailyUserLimit` (or vice versa).
 *
 * Returns `matchedKey` (the most specific key that contributed any limit)
 * so callers can scope counters to the config level.
 */
export function resolveDailyLimits(
  groups: GroupsConfig | undefined,
  keys: string[],
): ResolvedDailyLimits {
  if (!groups) return {};

  const wildcard = groups['*'];

  // Find the first specific key that has any limit
  let matched: { config: GroupModeConfig; key: string } | undefined;
  for (const key of keys) {
    const config = groups[key];
    if (config && (config.dailyLimit !== undefined || config.dailyUserLimit !== undefined)) {
      matched = { config, key };
      break;
    }
  }

  if (!matched) {
    // No specific key -- use wildcard only
    if (wildcard && (wildcard.dailyLimit !== undefined || wildcard.dailyUserLimit !== undefined)) {
      return { dailyLimit: wildcard.dailyLimit, dailyUserLimit: wildcard.dailyUserLimit, matchedKey: '*' };
    }
    return {};
  }

  // Merge: specific key takes priority, wildcard fills in undefined fields
  return {
    dailyLimit: matched.config.dailyLimit ?? wildcard?.dailyLimit,
    dailyUserLimit: matched.config.dailyUserLimit ?? wildcard?.dailyUserLimit,
    matchedKey: matched.key,
  };
}

// ---------------------------------------------------------------------------
// In-memory daily rate limit counters
// ---------------------------------------------------------------------------

interface DailyCounter {
  date: string;
  total: number;
  users: Map<string, number>;
}

/** keyed by "channel:groupId" */
const counters = new Map<string, DailyCounter>();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

let lastEvictionDate = '';

function getCounter(counterKey: string): DailyCounter {
  const d = today();

  // Evict stale entries once per day (on first access after midnight)
  if (d !== lastEvictionDate) {
    for (const [key, entry] of counters) {
      if (entry.date !== d) counters.delete(key);
    }
    lastEvictionDate = d;
  }

  let counter = counters.get(counterKey);
  if (!counter || counter.date !== d) {
    counter = { date: d, total: 0, users: new Map() };
    counters.set(counterKey, counter);
  }
  return counter;
}

export interface DailyLimitResult {
  allowed: boolean;
  reason?: 'daily-limit' | 'daily-user-limit';
}

/**
 * Check and increment daily rate limit counters for a group message.
 *
 * Returns whether the message is allowed. Increments counters only when allowed.
 *
 * @param counterKey - Unique key for the group, typically "channel:chatId"
 * @param userId - Sender's user ID (for per-user limits)
 * @param limits - Resolved daily limits from config
 */
export function checkDailyLimit(
  counterKey: string,
  userId: string,
  limits: { dailyLimit?: number; dailyUserLimit?: number },
): DailyLimitResult {
  if (limits.dailyLimit === undefined && limits.dailyUserLimit === undefined) {
    return { allowed: true };
  }

  const counter = getCounter(counterKey);

  // Check group-wide limit first
  if (limits.dailyLimit !== undefined && counter.total >= limits.dailyLimit) {
    return { allowed: false, reason: 'daily-limit' };
  }

  // Check per-user limit
  if (limits.dailyUserLimit !== undefined) {
    const userCount = counter.users.get(userId) ?? 0;
    if (userCount >= limits.dailyUserLimit) {
      return { allowed: false, reason: 'daily-user-limit' };
    }
  }

  // Both checks passed -- increment
  counter.total++;
  counter.users.set(userId, (counter.users.get(userId) ?? 0) + 1);
  return { allowed: true };
}

/** Reset all counters. Exported for testing. */
export function resetDailyLimitCounters(): void {
  counters.clear();
  lastEvictionDate = '';
}

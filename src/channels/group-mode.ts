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
  if (!groups) return true;
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

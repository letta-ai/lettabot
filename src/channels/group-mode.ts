/**
 * Shared group mode helpers across channel adapters.
 */

export type GroupMode = 'open' | 'listen' | 'mention-only';

export interface GroupModeConfig {
  mode?: GroupMode;
  /**
   * @deprecated Use mode: "mention-only" (true) or "open" (false).
   */
  requireMention?: boolean;
}

export type GroupsConfig = Record<string, GroupModeConfig>;

function coerceMode(config?: GroupModeConfig): GroupMode | undefined {
  if (!config) return undefined;
  if (config.mode === 'open' || config.mode === 'listen' || config.mode === 'mention-only') {
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
  if (Object.keys(groups).length === 0) return true;
  if (Object.hasOwn(groups, '*')) return true;
  return keys.some((key) => Object.hasOwn(groups, key));
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

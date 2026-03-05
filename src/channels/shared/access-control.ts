/**
 * Shared DM access control logic for channel adapters.
 *
 * Centralizes the dmPolicy enforcement that was previously
 * copy-pasted across Discord, Telegram, Signal, etc.
 */

import type { DmPolicy } from '../../pairing/types.js';
import { isUserAllowed } from '../../pairing/store.js';

/**
 * Check if a user is authorized based on dmPolicy.
 *
 * @param channel   - Channel name (e.g. 'discord', 'telegram', 'signal')
 * @param userId    - User identifier (channel-specific format)
 * @param policy    - DM policy from config (defaults to 'pairing')
 * @param allowedUsers - Config-level allowlist
 * @returns 'allowed' | 'blocked' | 'pairing'
 */
export async function checkDmAccess(
  channel: string,
  userId: string,
  policy: DmPolicy | undefined,
  allowedUsers?: string[],
): Promise<'allowed' | 'blocked' | 'pairing'> {
  const effectivePolicy = policy || 'pairing';

  // Open policy: everyone allowed
  if (effectivePolicy === 'open') {
    return 'allowed';
  }

  // Check if already allowed (config or pairing store)
  const allowed = await isUserAllowed(channel, userId, allowedUsers);
  if (allowed) {
    return 'allowed';
  }

  // Allowlist policy: not allowed if not in list
  if (effectivePolicy === 'allowlist') {
    return 'blocked';
  }

  // Pairing policy: needs pairing
  return 'pairing';
}

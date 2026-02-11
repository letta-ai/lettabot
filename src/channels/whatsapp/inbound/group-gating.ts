/**
 * WhatsApp Group Gating
 *
 * Applies group-specific access control and mention gating.
 * Based on OpenClaw's group gating patterns.
 */

import { detectMention } from './mentions.js';
import type { WebInboundMessage } from './types.js';
import { isGroupAllowed, resolveGroupMode, type GroupMode, type GroupModeConfig } from '../../group-mode.js';

export interface GroupGatingParams {
  /** Extracted message */
  msg: WebInboundMessage;

  /** Group JID */
  groupJid: string;

  /** Bot's JID */
  selfJid: string | null;

  /** Bot's Linked Device ID (for Business/multi-device mentions) */
  selfLid: string | null;

  /** Bot's E.164 number */
  selfE164: string | null;

  /** Per-group configuration */
  groupsConfig?: Record<string, GroupModeConfig>;

  /** Mention patterns from config */
  mentionPatterns?: string[];
}

export interface GroupGatingResult {
  /** Whether message should be processed */
  shouldProcess: boolean;

  /** Effective mode for this group */
  mode: GroupMode;

  /** Whether bot was mentioned */
  wasMentioned?: boolean;

  /** Reason for filtering (if shouldProcess=false) */
  reason?: string;
}

/**
 * Apply group-specific gating logic.
 *
 * Steps:
 * 1. Check group allowlist (if groups config exists)
 * 2. Resolve group mode
 * 3. Detect mentions (JID, regex, E.164, reply)
 * 4. Apply mode gating
 *
 * @param params - Gating parameters
 * @returns Gating decision
 *
 * @example
 * const result = applyGroupGating({
 *   msg: inboundMessage,
 *   groupJid: "12345@g.us",
 *   selfJid: "555@s.whatsapp.net",
 *   selfE164: "+15551234567",
 *   groupsConfig: { "*": { mode: "mention-only" } },
 *   mentionPatterns: ["@?bot"]
 * });
 *
 * if (!result.shouldProcess) {
 *   console.log(`Skipped: ${result.reason}`);
 *   return;
 * }
 */
export function applyGroupGating(params: GroupGatingParams): GroupGatingResult {
  const { msg, groupJid, selfJid, selfLid, selfE164, groupsConfig, mentionPatterns } = params;

  // Step 1: Check group allowlist (if groups config exists)
  if (!isGroupAllowed(groupsConfig, [groupJid])) {
    return {
      shouldProcess: false,
      mode: 'open',
      reason: 'group-not-in-allowlist',
    };
  }

  // Step 2: Resolve mode (default: open)
  const mode = resolveGroupMode(groupsConfig, [groupJid], 'open');

  // Step 3: Detect mentions
  const mentionResult = detectMention({
    body: msg.body,
    mentionedJids: msg.mentionedJids,
    replyToSenderJid: msg.replyContext?.senderJid,
    replyToSenderE164: msg.replyContext?.senderE164,
    config: {
      mentionPatterns: mentionPatterns ?? [],
      selfE164,
      selfJid,
      selfLid,
    },
  });

  // Step 4: Apply mode
  if (mode === 'mention-only' && !mentionResult.wasMentioned) {
    return {
      shouldProcess: false,
      mode,
      wasMentioned: false,
      reason: 'mention-required',
    };
  }

  return {
    shouldProcess: true,
    mode,
    wasMentioned: mentionResult.wasMentioned,
  };
}

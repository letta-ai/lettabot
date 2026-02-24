/**
 * WhatsApp Access Control
 *
 * Handles pairing, allowlists, and DM policy enforcement.
 * Based on OpenClaw's access-control.ts pattern.
 */

import { isUserAllowed, upsertPairingRequest } from "../../../pairing/store.js";
import type { DmPolicy } from "../../../pairing/types.js";
import { normalizePhoneForStorage } from "../../../utils/phone.js";

import { createLogger } from '../../../logger.js';

const log = createLogger('WhatsApp');
/**
 * Parameters for access control check
 */
export interface AccessCheckParams {
  /** Remote JID (for sending pairing messages) */
  remoteJid: string;

  /** User ID (normalized E.164 with +) */
  userId: string;

  /** User's display name */
  pushName?: string;

  /** Whether this is a group message */
  isGroup: boolean;

  /** Whether this is a self-chat message */
  isSelfChat: boolean;

  /** DM policy */
  dmPolicy: DmPolicy;

  /** Allowed users list */
  allowedUsers?: string[];

  /** Self-chat mode enabled */
  selfChatMode?: boolean;

  /** Socket for sending messages */
  sock: {
    sendMessage: (jid: string, content: any) => Promise<any>;
  };

  /** Group sender E.164 (for group allowlist check) */
  senderE164?: string;

  /** Group policy */
  groupPolicy?: 'open' | 'disabled' | 'allowlist';

  /** Group sender allowlist */
  groupAllowFrom?: string[];
}

/**
 * Result of access control check
 */
export interface AccessControlResult {
  /** Whether user is allowed to message the bot */
  allowed: boolean;

  /** Whether to send pairing message */
  sendPairingMsg?: boolean;

  /** Pairing code (if sendPairingMsg=true) */
  pairingCode?: string;

  /** Reason for result */
  reason?: "allowed" | "pairing" | "blocked" | "self-chat-mode" | "group" | "self" | "group-disabled" | "group-no-allowlist" | "group-sender-blocked";
}

/**
 * Format pairing message for WhatsApp
 */
function formatPairingMessage(code: string): string {
  return `Hi! This bot requires pairing.

Your pairing code: *${code}*

Ask the bot owner to approve with:
\`lettabot pairing approve whatsapp ${code}\``;
}

/**
 * Check if user is allowed to message the bot.
 *
 * Access control logic:
 * 1. Groups and self-chat always allowed
 * 2. If selfChatMode enabled, ONLY self-chat allowed (silently ignore others)
 * 3. If dmPolicy="open", everyone allowed
 * 4. Check allowlist or pairing store
 * 5. If dmPolicy="allowlist", block if not in list
 * 6. If dmPolicy="pairing", create pairing request
 *
 * @param params - Access check parameters
 * @returns Access control result with allowed status and optional pairing code
 *
 * @example
 * const access = await checkInboundAccess({
 *   remoteJid: '1234567890@s.whatsapp.net',
 *   userId: '+1234567890',
 *   pushName: 'John',
 *   isGroup: false,
 *   isSelfChat: false,
 *   dmPolicy: 'pairing',
 *   allowedUsers: [],
 *   selfChatMode: false,
 *   sock: { sendMessage: ... }
 * });
 *
 * if (!access.allowed) {
 *   if (access.sendPairingMsg) {
 *     await sock.sendMessage(remoteJid, { text: formatPairingMessage(access.pairingCode) });
 *   }
 *   return;
 * }
 */
export async function checkInboundAccess(
  params: AccessCheckParams
): Promise<AccessControlResult> {
  const {
    remoteJid,
    userId,
    pushName,
    isGroup,
    isSelfChat,
    dmPolicy,
    allowedUsers,
    selfChatMode,
    sock,
    senderE164,
    groupPolicy,
    groupAllowFrom,
  } = params;

  // Group policy enforcement (before DM checks)
  if (isGroup) {
    const policy = groupPolicy ?? 'open';

    // Disabled: Block all group messages
    if (policy === 'disabled') {
      return { allowed: false, reason: 'group-disabled' };
    }

    // Allowlist: Only allow messages from specific senders
    if (policy === 'allowlist') {
      const allowlist = groupAllowFrom ?? allowedUsers ?? [];

      if (allowlist.length === 0) {
        // No allowlist defined = block all groups
        return { allowed: false, reason: 'group-no-allowlist' };
      }

      // Check wildcard or specific sender (normalize phones for consistent comparison)
      const hasWildcard = allowlist.includes('*');
      const normalizedSender = senderE164 ? normalizePhoneForStorage(senderE164) : null;
      const senderAllowed = hasWildcard || (normalizedSender && allowlist.some(num =>
        normalizePhoneForStorage(num) === normalizedSender
      ));

      if (!senderAllowed) {
        return { allowed: false, reason: 'group-sender-blocked' };
      }
    }

    // Open policy or sender passed allowlist
    // Note: Mention gating is applied separately in group-gating module
    return { allowed: true, reason: 'group' };
  }

  // Self-chat always allowed
  if (isSelfChat) {
    return { allowed: true, reason: "self" };
  }

  // Self-chat mode: ONLY respond to self-chat, silently ignore all other messages
  // This prevents bot from accidentally messaging user's contacts
  if (selfChatMode) {
    return { allowed: false, reason: "self-chat-mode" };
  }

  // Open policy: everyone allowed
  if (dmPolicy === "open") {
    return { allowed: true, reason: "allowed" };
  }

  // Check if user is in allowlist or pairing store
  const allowed = await isUserAllowed("whatsapp", userId, allowedUsers);
  if (allowed) {
    return { allowed: true, reason: "allowed" };
  }

  // Allowlist policy: reject if not in list
  if (dmPolicy === "allowlist") {
    await sock.sendMessage(remoteJid, {
      text: "Sorry, you're not authorized to use this bot.",
    });
    return { allowed: false, reason: "blocked" };
  }

  // Pairing policy: create pairing request
  const result = await upsertPairingRequest("whatsapp", userId, pushName ? { username: pushName } : undefined);

  if (!result) {
    // Too many pending requests
    await sock.sendMessage(remoteJid, {
      text: "Too many pending pairing requests. Please try again later.",
    });
    return { allowed: false, reason: "pairing" };
  }

  const { code, created } = result;

  // Send pairing message only on first contact
  if (created) {
    log.info(`New pairing request from ${userId}: ${code}`);
    return {
      allowed: false,
      sendPairingMsg: true,
      pairingCode: code,
      reason: "pairing",
    };
  }

  // User already has pending pairing request
  return { allowed: false, reason: "pairing" };
}

/**
 * Export formatPairingMessage for use in access control flow
 */
export { formatPairingMessage };

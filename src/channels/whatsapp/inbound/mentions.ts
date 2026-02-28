/**
 * WhatsApp Mention Detection
 *
 * Detects if bot was mentioned in a message using multiple methods.
 * Based on OpenClaw's mention detection patterns.
 */

import { createLogger } from '../../../logger.js';

const log = createLogger('WhatsApp');
export interface MentionConfig {
  /** Regex patterns to detect mentions (e.g., ["@?bot", "@?lettabot"]) */
  mentionPatterns: string[];

  /** Bot's E.164 phone number */
  selfE164: string | null;

  /** Bot's WhatsApp JID */
  selfJid: string | null;

  /** Bot's Linked Device ID (for Business/multi-device mentions) */
  selfLid: string | null;
}

export interface MentionDetectionResult {
  /** Whether bot was mentioned */
  wasMentioned: boolean;

  /** Whether this was an implicit mention (reply to bot) */
  implicitMention: boolean;

  /** Detection method used */
  method?: 'jid' | 'regex' | 'e164' | 'reply';
}

/**
 * Normalize text for mention detection by removing zero-width characters.
 *
 * @param text - Message text
 * @returns Cleaned text
 */
function normalizeMentionText(text: string): string {
  return text.trim().replace(/[\u200B-\u200D\uFEFF]/g, '');
}

/**
 * Normalize JID for comparison by removing device suffix.
 * Handles both formats: "XXX:25@domain" and "XXX:25" at end.
 *
 * @param jid - WhatsApp JID to normalize
 * @returns Normalized JID without device suffix
 *
 * @example
 * normalizeJid("919888142915:26@s.whatsapp.net") // → "919888142915@s.whatsapp.net"
 * normalizeJid("214542927831175:25@lid")         // → "214542927831175@lid"
 * normalizeJid("123@s.whatsapp.net")             // → "123@s.whatsapp.net" (unchanged)
 */
function normalizeJid(jid: string | null | undefined): string {
  if (!jid) return '';
  // Remove :XX before @ or at end
  return jid.replace(/:\d+(@|$)/, '$1');
}

/**
 * Detect if bot was mentioned in a message.
 *
 * Detection methods (in priority order):
 * 1. WhatsApp native @mentions (mentionedJids) - Most reliable
 * 2. Regex pattern matching - Flexible (e.g., "@bot", "bot,")
 * 3. E.164 phone number in text - Safety net
 * 4. Reply to bot's message - Implicit mention
 *
 * @param params - Detection parameters
 * @returns Detection result with method used
 *
 * @example
 * const result = detectMention({
 *   body: "@bot what's the weather?",
 *   mentionedJids: ["123456@s.whatsapp.net"],
 *   config: {
 *     mentionPatterns: ["@?bot"],
 *     selfE164: "+1234567890",
 *     selfJid: "1234567890@s.whatsapp.net"
 *   }
 * });
 * // result: { wasMentioned: true, implicitMention: false, method: 'jid' }
 */
export function detectMention(params: {
  body: string;
  mentionedJids?: string[];
  replyToSenderJid?: string;
  replyToSenderE164?: string;
  config: MentionConfig;
}): MentionDetectionResult {
  const { body, mentionedJids, replyToSenderJid, replyToSenderE164, config } = params;

  // METHOD 1: Check WhatsApp native @mentions (mentionedJids)
  if (mentionedJids && mentionedJids.length > 0) {
    const selfJidNorm = normalizeJid(config.selfJid);
    const selfLidNorm = normalizeJid(config.selfLid);

    const mentioned = mentionedJids.some((jid) => {
      const jidNorm = normalizeJid(jid);
      // Check against both standard JID and LID (for Business/multi-device)
      return jidNorm === selfJidNorm || jidNorm === selfLidNorm;
    });

    if (mentioned) {
      return { wasMentioned: true, implicitMention: false, method: 'jid' };
    }

    // If explicit mentions exist for other users, skip regex/E.164 fallback
    // (User specifically mentioned someone else, not the bot)
    return { wasMentioned: false, implicitMention: false };
  }

  // Clean text for pattern matching
  const bodyClean = normalizeMentionText(body);

  // METHOD 2: Regex pattern matching
  for (const pattern of config.mentionPatterns) {
    try {
      const regex = new RegExp(pattern, 'i'); // Case-insensitive
      if (regex.test(bodyClean)) {
        return { wasMentioned: true, implicitMention: false, method: 'regex' };
      }
    } catch (err) {
      log.warn(`Invalid mention pattern: ${pattern}`, err);
    }
  }

  // METHOD 3: E.164 phone number fallback
  if (config.selfE164) {
    const selfDigits = config.selfE164.replace(/\D/g, ''); // Extract digits
    const bodyDigits = bodyClean.replace(/[^\d]/g, '');

    if (bodyDigits.includes(selfDigits)) {
      return { wasMentioned: true, implicitMention: false, method: 'e164' };
    }
  }

  // METHOD 4: Implicit mention (reply to bot's message)
  const selfJidNorm = normalizeJid(config.selfJid);
  const selfLidNorm = normalizeJid(config.selfLid);
  const replyJidNorm = normalizeJid(replyToSenderJid);

  const isReplyToBot =
    (replyJidNorm && (replyJidNorm === selfJidNorm || replyJidNorm === selfLidNorm)) ||
    (config.selfE164 && replyToSenderE164 && config.selfE164 === replyToSenderE164);

  if (isReplyToBot) {
    return { wasMentioned: true, implicitMention: true, method: 'reply' };
  }

  // No mention detected
  return { wasMentioned: false, implicitMention: false };
}

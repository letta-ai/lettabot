/**
 * Signal Group Gating
 *
 * Filters group messages based on per-group mode and mention detection.
 */

import { isGroupAllowed, isGroupUserAllowed, resolveGroupMode, type GroupMode } from '../group-mode.js';

export interface SignalGroupConfig {
  mode?: GroupMode;
  allowedUsers?: string[];
  requireMention?: boolean;  // @deprecated legacy alias
}

export interface SignalMention {
  start?: number;
  length?: number;
  uuid?: string;
  number?: string;
}

export interface SignalQuote {
  id?: number;
  author?: string;
  authorUuid?: string;
  text?: string;
}

export interface SignalGroupGatingParams {
  /** Message text */
  text: string;
  
  /** Group ID (without "group:" prefix) */
  groupId: string;
  
  /** Native Signal mentions from the message */
  mentions?: SignalMention[];
  
  /** Quote/reply info if replying to a message */
  quote?: SignalQuote;
  
  /** Bot's phone number (E.164) */
  selfPhoneNumber: string;
  
  /** Bot's Signal UUID (if known) */
  selfUuid?: string;
  
  /** Sender identifier (phone number or UUID) for per-group allowedUsers check */
  senderId?: string;

  /** Per-group configuration */
  groupsConfig?: Record<string, SignalGroupConfig>;
  
  /** Regex patterns for text-based mention detection */
  mentionPatterns?: string[];
}

export interface SignalGroupGatingResult {
  /** Whether the message should be processed */
  shouldProcess: boolean;

  /** Effective mode for this group */
  mode: GroupMode;
  
  /** Whether bot was mentioned */
  wasMentioned?: boolean;
  
  /** Detection method used */
  method?: 'native' | 'regex' | 'reply' | 'e164';
  
  /** Reason for filtering (if shouldProcess=false) */
  reason?: string;
}

/**
 * Apply group-specific gating logic for Signal messages.
 *
 * Detection methods (in priority order):
 * 1. Native mentions array - Check if bot's phone/UUID is in mentions
 * 2. Regex patterns - Match configured patterns in text
 * 3. Reply to bot - Check if replying to bot's message
 * 4. E.164 fallback - Bot's phone number appears in text
 *
 * @param params - Gating parameters
 * @returns Gating decision
 */
export function applySignalGroupGating(params: SignalGroupGatingParams): SignalGroupGatingResult {
  const { text, groupId, senderId, mentions, quote, selfPhoneNumber, selfUuid, groupsConfig, mentionPatterns } = params;
  const groupKeys = [groupId, `group:${groupId}`];

  // Step 1: Check group allowlist (if groups config exists)
  if (!isGroupAllowed(groupsConfig, groupKeys)) {
    return {
      shouldProcess: false,
      mode: 'open',
      reason: 'group-not-in-allowlist',
    };
  }

  // Step 1b: Per-group user allowlist
  if (senderId && !isGroupUserAllowed(groupsConfig, groupKeys, senderId)) {
    return {
      shouldProcess: false,
      mode: 'open',
      reason: 'user-not-allowed',
    };
  }

  // Step 2: Resolve mode (default: open)
  const mode = resolveGroupMode(groupsConfig, groupKeys, 'open');

  if (mode === 'disabled') {
    return {
      shouldProcess: false,
      mode,
      reason: 'groups-disabled',
    };
  }

  // METHOD 1: Native Signal mentions array
  if (mentions && mentions.length > 0) {
    const selfDigits = selfPhoneNumber.replace(/\D/g, '');
    
    const mentioned = mentions.some((mention) => {
      // Check UUID match
      if (selfUuid && mention.uuid && mention.uuid === selfUuid) {
        return true;
      }
      // Check phone number match (normalize to digits)
      if (mention.number) {
        const mentionDigits = mention.number.replace(/\D/g, '');
        if (mentionDigits === selfDigits) {
          return true;
        }
      }
      return false;
    });

    if (mentioned) {
      return { shouldProcess: true, mode, wasMentioned: true, method: 'native' };
    }

    // If explicit mentions exist for other users, skip fallback methods
    // (User specifically mentioned someone else, not the bot).
    if (mode === 'mention-only') {
      return { shouldProcess: false, mode, wasMentioned: false, reason: 'mention-required' };
    }
    return { shouldProcess: true, mode, wasMentioned: false };
  }

  // METHOD 2: Regex pattern matching
  if (mentionPatterns && mentionPatterns.length > 0) {
    const cleanText = text.trim().replace(/[\u200B-\u200D\uFEFF]/g, '');
    
    for (const pattern of mentionPatterns) {
      try {
        const regex = new RegExp(pattern, 'i');
        if (regex.test(cleanText)) {
          return { shouldProcess: true, mode, wasMentioned: true, method: 'regex' };
        }
      } catch (err) {
        console.warn(`[Signal] Invalid mention pattern: ${pattern}`, err);
      }
    }
  }

  // METHOD 3: Reply to bot's message
  if (quote) {
    const selfDigits = selfPhoneNumber.replace(/\D/g, '');
    
    // Check if quote author matches bot
    const isReplyToBot =
      (selfUuid && quote.authorUuid === selfUuid) ||
      (quote.author && quote.author.replace(/\D/g, '') === selfDigits);

    if (isReplyToBot) {
      return { shouldProcess: true, mode, wasMentioned: true, method: 'reply' };
    }
  }

  // METHOD 4: E.164 phone number fallback
  if (selfPhoneNumber) {
    const selfDigits = selfPhoneNumber.replace(/\D/g, '');
    const textDigits = text.replace(/\D/g, '');

    if (textDigits.includes(selfDigits)) {
      return { shouldProcess: true, mode, wasMentioned: true, method: 'e164' };
    }
  }

  // No mention detected.
  if (mode === 'mention-only') {
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
    wasMentioned: false,
  };
}

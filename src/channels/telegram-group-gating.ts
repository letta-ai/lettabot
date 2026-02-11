/**
 * Telegram Group Gating
 *
 * Filters group messages based on a config-based allowlist and mention detection.
 * Follows the same pattern as Signal (`signal/group-gating.ts`) and WhatsApp
 * (`whatsapp/inbound/group-gating.ts`).
 *
 * This layer runs AFTER the pairing-based group approval middleware.
 * The pairing system controls "can this group access the bot at all?"
 * while this config layer controls "which approved groups does the bot
 * actively participate in?"
 */

import { isGroupAllowed, resolveGroupMode, type GroupMode, type GroupModeConfig } from './group-mode.js';

export interface TelegramGroupGatingParams {
  /** Message text */
  text: string;

  /** Group chat ID (negative number as string) */
  chatId: string;

  /** Bot's @username (without the @) */
  botUsername: string;

  /** Telegram message entities (for structured mention detection) */
  entities?: { type: string; offset: number; length: number }[];

  /** Per-group configuration */
  groupsConfig?: Record<string, GroupModeConfig>;

  /** Regex patterns for additional mention detection */
  mentionPatterns?: string[];
}

export interface TelegramGroupGatingResult {
  /** Whether the message should be processed */
  shouldProcess: boolean;

  /** Effective mode for this group */
  mode: GroupMode;

  /** Whether bot was mentioned */
  wasMentioned?: boolean;

  /** Detection method used */
  method?: 'entity' | 'text' | 'command' | 'regex';

  /** Reason for filtering (if shouldProcess=false) */
  reason?: string;
}

/**
 * Apply group-specific gating logic for Telegram messages.
 *
 * Detection methods (in priority order):
 * 1. Entity-based @username mentions (most reliable)
 * 2. Text-based @username fallback
 * 3. /command@username format (Telegram bot command convention)
 * 4. Regex patterns from config
 *
 * @example
 * const result = applyTelegramGroupGating({
 *   text: '@mybot hello!',
 *   chatId: '-1001234567890',
 *   botUsername: 'mybot',
 *   groupsConfig: { '*': { mode: 'mention-only' } },
 * });
 *
 * if (!result.shouldProcess) return;
 */
export function applyTelegramGroupGating(params: TelegramGroupGatingParams): TelegramGroupGatingResult {
  const { text, chatId, botUsername, entities, groupsConfig, mentionPatterns } = params;

  // Step 1: Group allowlist
  if (!isGroupAllowed(groupsConfig, [chatId])) {
    return {
      shouldProcess: false,
      mode: 'open',
      reason: 'group-not-in-allowlist',
    };
  }

  // Step 2: Resolve mode (default: open)
  const mode = resolveGroupMode(groupsConfig, [chatId], 'open');

  // Step 3: Detect mentions
  const mention = detectTelegramMention({ text, botUsername, entities, mentionPatterns });

  // open/listen modes always pass (listen mode response suppression is handled downstream)
  if (mode === 'open' || mode === 'listen') {
    return {
      shouldProcess: true,
      mode,
      wasMentioned: mention.wasMentioned,
      method: mention.method,
    };
  }

  // mention-only mode: mention required
  if (mention.wasMentioned) {
    return { shouldProcess: true, mode, wasMentioned: true, method: mention.method };
  }
  return { shouldProcess: false, mode, wasMentioned: false, reason: 'mention-required' };
}

function detectTelegramMention(params: {
  text: string;
  botUsername: string;
  entities?: { type: string; offset: number; length: number }[];
  mentionPatterns?: string[];
}): { wasMentioned: boolean; method?: 'entity' | 'text' | 'command' | 'regex' } {
  const { text, botUsername, entities, mentionPatterns } = params;

  // METHOD 1: Telegram entity-based mention detection (most reliable)
  if (entities && entities.length > 0 && botUsername) {
    const mentioned = entities.some((e) => {
      if (e.type === 'mention') {
        const mentionedText = text.substring(e.offset, e.offset + e.length);
        return mentionedText.toLowerCase() === `@${botUsername.toLowerCase()}`;
      }
      return false;
    });
    if (mentioned) {
      return { wasMentioned: true, method: 'entity' };
    }
  }

  // METHOD 2: Text-based @username fallback
  if (botUsername) {
    const usernameRegex = new RegExp(`@${botUsername}\\b`, 'i');
    if (usernameRegex.test(text)) {
      return { wasMentioned: true, method: 'text' };
    }
  }

  // METHOD 3: /command@botusername format (Telegram convention)
  if (botUsername) {
    const commandRegex = new RegExp(`^/\\w+@${botUsername}\\b`, 'i');
    if (commandRegex.test(text.trim())) {
      return { wasMentioned: true, method: 'command' };
    }
  }

  // METHOD 4: Regex patterns from config
  if (mentionPatterns && mentionPatterns.length > 0) {
    for (const pattern of mentionPatterns) {
      try {
        const regex = new RegExp(pattern, 'i');
        if (regex.test(text)) {
          return { wasMentioned: true, method: 'regex' };
        }
      } catch {
        // Invalid pattern -- skip silently
      }
    }
  }

  return { wasMentioned: false };
}

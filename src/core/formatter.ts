/**
 * Message Envelope Formatter
 *
 * Formats incoming messages with metadata context for the agent.
 * Uses <system-reminder> XML tags matching Letta Code CLI conventions.
 */

import type { InboundMessage } from './types.js';
import { normalizePhoneForStorage } from '../utils/phone.js';

// XML tag constants (matching Letta Code CLI conventions from constants.ts)
export const SYSTEM_REMINDER_TAG = 'system-reminder';
export const SYSTEM_REMINDER_OPEN = `<${SYSTEM_REMINDER_TAG}>`;
export const SYSTEM_REMINDER_CLOSE = `</${SYSTEM_REMINDER_TAG}>`;

/**
 * Channel format hints - tells the agent what formatting syntax to use
 * Each channel has different markdown support - hints help agent format appropriately.
 */
const CHANNEL_FORMATS: Record<string, string> = {
  slack: 'mrkdwn: *bold* _italic_ `code` - NO: headers, tables',
  discord: '**bold** *italic* `code` [links](url) ```code blocks``` - NO: headers, tables',
  telegram: 'MarkdownV2: *bold* _italic_ `code` [links](url) - NO: headers, tables',
  whatsapp: '*bold* _italic_ `code` - NO: headers, code fences, links, tables',
  signal: 'ONLY: *bold* _italic_ `code` - NO: headers, code fences, links, quotes, tables',
};

export interface EnvelopeOptions {
  timezone?: 'local' | 'utc' | string;  // IANA timezone or 'local'/'utc'
  includeDay?: boolean;                  // Include day of week (default: true)
  includeSender?: boolean;               // Include sender info (default: true)
  includeGroup?: boolean;                // Include group name (default: true)
}

const DEFAULT_OPTIONS: EnvelopeOptions = {
  timezone: 'local',
  includeDay: true,
  includeSender: true,
  includeGroup: true,
};

/**
 * Session context options for first-message enrichment
 */
export interface SessionContextOptions {
  agentId?: string;
  agentName?: string;
  serverUrl?: string;
}

/**
 * Format a phone number nicely: +15551234567 -> +1 (555) 123-4567
 */
function formatPhoneNumber(phone: string): string {
  // Remove any non-digit characters except leading +
  const hasPlus = phone.startsWith('+');
  const digits = phone.replace(/\D/g, '');
  
  if (digits.length === 11 && digits.startsWith('1')) {
    // US number: 1AAABBBCCCC -> +1 (AAA) BBB-CCCC
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  } else if (digits.length === 10) {
    // US number without country code: AAABBBCCCC -> +1 (AAA) BBB-CCCC
    return `+1 (${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  
  // For other formats, just add the + back if it was there
  return hasPlus ? `+${digits}` : digits;
}

/**
 * Format the sender identifier nicely based on channel
 */
function formatSender(msg: InboundMessage): string {
  // Use display name if available
  if (msg.userName?.trim()) {
    return msg.userName.trim();
  }
  
  // Format based on channel
  switch (msg.channel) {
    case 'slack':
      // Add @ prefix for Slack usernames/IDs
      return msg.userHandle ? `@${msg.userHandle}` : `@${msg.userId}`;

    case 'discord':
      // Add @ prefix for Discord usernames/IDs
      return msg.userHandle ? `@${msg.userHandle}` : `@${msg.userId}`;
    
    case 'whatsapp':
    case 'signal':
      // Format phone numbers nicely
      if (/^\+?\d{10,}$/.test(msg.userId.replace(/\D/g, ''))) {
        return formatPhoneNumber(msg.userId);
      }
      return msg.userId;
    
    case 'telegram':
      return msg.userHandle ? `@${msg.userHandle}` : msg.userId;
    
    default:
      return msg.userId;
  }
}

/**
 * Format channel name for display (capitalized)
 */
function formatChannelName(channel: string): string {
  return channel.charAt(0).toUpperCase() + channel.slice(1);
}

/**
 * Format timestamp with day of week and timezone
 */
function formatTimestamp(date: Date, options: EnvelopeOptions): string {
  const parts: string[] = [];
  
  // Determine timezone settings
  let timeZone: string | undefined;
  if (options.timezone === 'utc') {
    timeZone = 'UTC';
  } else if (options.timezone && options.timezone !== 'local') {
    // Validate IANA timezone
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: options.timezone });
      timeZone = options.timezone;
    } catch {
      // Invalid timezone, fall back to local
      timeZone = undefined;
    }
  }
  
  // Day of week
  if (options.includeDay !== false) {
    const dayFormatter = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      timeZone,
    });
    parts.push(dayFormatter.format(date));
  }
  
  // Date and time
  const dateFormatter = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone,
    timeZoneName: 'short',
  });
  parts.push(dateFormatter.format(date));
  
  return parts.join(', ');
}

function formatBytes(size?: number): string | null {
  if (!size || size < 0) return null;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatAttachmentLines(msg: InboundMessage): string[] {
  if (!msg.attachments || msg.attachments.length === 0) return [];
  return msg.attachments.map((attachment) => {
    const name = attachment.name || attachment.id || 'attachment';
    const details: string[] = [];
    if (attachment.mimeType) details.push(attachment.mimeType);
    const size = formatBytes(attachment.size);
    if (size) details.push(size);
    const detailText = details.length > 0 ? ` (${details.join(', ')})` : '';
    if (attachment.localPath) {
      return `  - ${name}${detailText} saved to ${attachment.localPath}`;
    }
    if (attachment.url) {
      return `  - ${name}${detailText} ${attachment.url}`;
    }
    return `  - ${name}${detailText}`;
  });
}

/**
 * Build the metadata lines for the system-reminder block.
 */
function buildMetadataLines(msg: InboundMessage, options: EnvelopeOptions): string[] {
  const lines: string[] = [];

  // Channel and routing info
  lines.push(`- **Channel**: ${formatChannelName(msg.channel)}`);
  lines.push(`- **Chat ID**: ${msg.chatId}`);
  if (msg.messageId) {
    lines.push(`- **Message ID**: ${msg.messageId}`);
  }

  // Sender
  if (options.includeSender !== false) {
    lines.push(`- **Sender**: ${formatSender(msg)}`);
  }

  // Timestamp
  lines.push(`- **Timestamp**: ${formatTimestamp(msg.timestamp, options)}`);

  // Format support hint
  const formatHint = CHANNEL_FORMATS[msg.channel];
  if (formatHint) {
    lines.push(`- **Format support**: ${formatHint}`);
  }

  return lines;
}

/**
 * Build the chat context lines (group info, mentions, reply context).
 */
function buildChatContextLines(msg: InboundMessage, options: EnvelopeOptions): string[] {
  const lines: string[] = [];

  if (msg.isGroup) {
    lines.push(`- **Type**: Group chat`);
    if (options.includeGroup !== false && msg.groupName?.trim()) {
      if (msg.channel === 'slack' || msg.channel === 'discord') {
        const name = msg.groupName.startsWith('#') ? msg.groupName : `#${msg.groupName}`;
        lines.push(`- **Group**: ${name}`);
      } else {
        lines.push(`- **Group**: ${msg.groupName}`);
      }
    }
    if (msg.wasMentioned) {
      lines.push(`- **Mentioned**: yes`);
    }
    lines.push(`- **Hint**: To skip replying, respond with exactly: \`<no-reply/>\``);
  } else {
    lines.push(`- **Type**: Direct message`);
  }

  if (msg.replyToUser) {
    const normalizedReply = normalizePhoneForStorage(msg.replyToUser);
    const formattedReply = formatPhoneNumber(normalizedReply);
    lines.push(`- **Replying to**: ${formattedReply}`);
  }

  // Reaction (if this is a reaction event)
  if (msg.reaction) {
    const action = msg.reaction.action || 'added';
    lines.push(`- **Reaction**: ${action} ${msg.reaction.emoji} on message ${msg.reaction.messageId}`);
  }

  // Attachments
  const attachmentLines = formatAttachmentLines(msg);
  if (attachmentLines.length > 0) {
    lines.push(`- **Attachments**:`);
    lines.push(...attachmentLines);
  }

  return lines;
}

/**
 * Build session context block for the first message in a chat session.
 */
export function buildSessionContext(options: SessionContextOptions): string[] {
  const lines: string[] = [];

  if (options.agentName || options.agentId) {
    const name = options.agentName || 'lettabot';
    const id = options.agentId ? ` (${options.agentId})` : '';
    lines.push(`- **Agent**: ${name}${id}`);
  }
  if (options.serverUrl) {
    lines.push(`- **Server**: ${options.serverUrl}`);
  }

  return lines;
}

/**
 * Format a message with XML system-reminder envelope.
 *
 * Uses <system-reminder> XML tags matching Letta Code CLI conventions.
 * Metadata is structured as markdown inside the tag, followed by the user's
 * message text outside the tag.
 *
 * Example output:
 * ```
 * <system-reminder>
 * ## Message Metadata
 * - **Channel**: Telegram
 * - **Chat ID**: 123456789
 * - **Sender**: Sarah
 * - **Timestamp**: Wednesday, Jan 28, 4:30 PM PST
 * - **Format support**: MarkdownV2: *bold* _italic_ `code` [links](url) - NO: headers, tables
 *
 * ## Chat Context
 * - **Type**: Direct message
 * </system-reminder>
 *
 * Hello!
 * ```
 */
export function formatMessageEnvelope(
  msg: InboundMessage,
  options: EnvelopeOptions = {},
  sessionContext?: SessionContextOptions,
): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const sections: string[] = [];

  // Session context section (for first message in a chat session)
  if (sessionContext) {
    const sessionLines = buildSessionContext(sessionContext);
    if (sessionLines.length > 0) {
      sections.push(`## Session Context\n${sessionLines.join('\n')}`);
    }
  }

  // Message metadata section
  const metadataLines = buildMetadataLines(msg, opts);
  sections.push(`## Message Metadata\n${metadataLines.join('\n')}`);

  // Chat context section
  const contextLines = buildChatContextLines(msg, opts);
  if (contextLines.length > 0) {
    sections.push(`## Chat Context\n${contextLines.join('\n')}`);
  }

  // Build the full system-reminder block
  const reminderContent = sections.join('\n\n');
  const reminder = `${SYSTEM_REMINDER_OPEN}\n${reminderContent}\n${SYSTEM_REMINDER_CLOSE}`;

  // User message text (outside the tag)
  const body = msg.text?.trim() || '';
  if (body) {
    return `${reminder}\n\n${body}`;
  }
  return reminder;
}

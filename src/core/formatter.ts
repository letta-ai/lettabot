/**
 * Message Envelope Formatter
 * 
 * Formats incoming messages with metadata context for the agent.
 * Based on moltbot's envelope pattern.
 */

import type { InboundMessage } from './types.js';

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
 * Format channel name for display
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

/**
 * Format a message with metadata envelope
 * 
 * Format: [Channel:ChatId Sender Timestamp] Message
 * 
 * The Channel:ChatId format allows the agent to reply using:
 *   lettabot-message send --text "..." --channel telegram --chat 123456789
 * 
 * Examples:
 * - [telegram:123456789 Sarah Wednesday, Jan 28, 4:30 PM PST] Hello!
 * - [slack:C1234567 @cameron Monday, Jan 27, 4:30 PM PST] Hello!
 */
export function formatMessageEnvelope(
  msg: InboundMessage,
  options: EnvelopeOptions = {}
): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const parts: string[] = [];
  
  // Channel:ChatId (for lettabot-message CLI)
  parts.push(`${msg.channel}:${msg.chatId}`);
  
  // Group name (if group chat and enabled)
  if (opts.includeGroup !== false && msg.isGroup && msg.groupName?.trim()) {
    // Format group name with # for Slack/Discord channels
    if ((msg.channel === 'slack' || msg.channel === 'discord') && !msg.groupName.startsWith('#')) {
      parts.push(`#${msg.groupName}`);
    } else {
      parts.push(msg.groupName);
    }
  }
  
  // Sender
  if (opts.includeSender !== false) {
    parts.push(formatSender(msg));
  }
  
  // Timestamp
  const timestamp = formatTimestamp(msg.timestamp, opts);
  parts.push(timestamp);
  
  // Build envelope
  const envelope = `[${parts.join(' ')}]`;
  
  // Add format hint so agent knows what formatting syntax to use
  const formatHint = CHANNEL_FORMATS[msg.channel];
  const hint = formatHint ? `\n(Format: ${formatHint})` : '';
  
  return `${envelope} ${msg.text}${hint}`;
}

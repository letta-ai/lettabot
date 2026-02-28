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

// Channel format hints are now provided per-message via formatterHints on InboundMessage.

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
 * Format a short time string (e.g., "4:30 PM")
 */
function formatShortTime(date: Date, options: EnvelopeOptions): string {
  let timeZone: string | undefined;
  if (options.timezone === 'utc') {
    timeZone = 'UTC';
  } else if (options.timezone && options.timezone !== 'local') {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: options.timezone });
      timeZone = options.timezone;
    } catch {
      timeZone = undefined;
    }
  }

  const formatter = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone,
  });
  return formatter.format(date);
}

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
  const formatHint = msg.formatterHints?.formatHint;
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
    if (msg.isListeningMode) {
      lines.push(`- **Mode**: Listen only — observe and update memories, do not send text replies`);
    } else if (msg.formatterHints?.supportsReactions) {
      lines.push(`- **Hint**: See Response Directives below for \`<no-reply/>\` and \`<actions>\``);
    } else {
      lines.push(`- **Hint**: See Response Directives below for \`<no-reply/>\``);
    }
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
 * Build context-aware Response Directives based on channel capabilities and chat type.
 * In listening mode, shows minimal directives. In normal mode, shows the full set
 * filtered by what the channel actually supports.
 */
function buildResponseDirectives(msg: InboundMessage): string[] {
  const lines: string[] = [];
  const supportsReactions = msg.formatterHints?.supportsReactions ?? false;
  const supportsFiles = msg.formatterHints?.supportsFiles ?? false;
  const isGroup = !!msg.isGroup;
  const isListeningMode = msg.isListeningMode ?? false;

  // Listening mode: minimal directives only
  if (isListeningMode) {
    lines.push(`- \`<no-reply/>\` — acknowledge without replying (recommended)`);
    if (supportsReactions) {
      lines.push(`- \`<actions><react emoji="eyes" /></actions>\` — react to show you saw this`);
    }
    return lines;
  }

  // no-reply
  if (isGroup) {
    lines.push(`- \`<no-reply/>\` — skip replying when the message isn't directed at you`);
  } else {
    lines.push(`- \`<no-reply/>\` — skip replying when the message doesn't need a response`);
  }

  // actions/react (only if channel supports it)
  if (supportsReactions) {
    lines.push(`- \`<actions><react emoji="thumbsup" /></actions>\` — react without sending text (executes silently)`);
    lines.push(`- \`<actions><react emoji="eyes" /></actions>Your text here\` — react and reply`);
    if (isGroup) {
      lines.push(`- \`<actions><react emoji="fire" message="123" /></actions>\` — react to a specific message`);
    }
    lines.push(`- Emoji names: eyes, thumbsup, heart, fire, tada, clap — or unicode`);
    lines.push(`- Prefer directives over tool calls for reactions (faster and cheaper)`);
  }

  // voice memo (always available -- TTS config is server-side)
  lines.push(`- \`<actions><voice>Your message here</voice></actions>\` — send a voice memo via TTS`);

  // file sending (only if channel supports it)
  if (supportsFiles) {
    lines.push(`- \`<send-file path="/path/to/file.png" kind="image" />\` — send a file (restricted to configured directory)`);
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

  // Channel-aware response directives
  const directiveLines = buildResponseDirectives(msg);
  sections.push(`## Response Directives\n${directiveLines.join('\n')}`);
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

/**
 * Format a group batch of messages as a chat log for the agent.
 *
 * Output format:
 * [GROUP CHAT - discord:123 #general - 3 messages]
 * [4:30 PM] Alice: Hey everyone
 * [4:32 PM] Bob: What's up?
 * [4:35 PM] Alice: @LettaBot can you help?
 * (Format: **bold** *italic* ...)
 */
export function formatGroupBatchEnvelope(
  messages: InboundMessage[],
  options: EnvelopeOptions = {},
  isListeningMode?: boolean,
): string {
  if (messages.length === 0) return '';

  const opts = { ...DEFAULT_OPTIONS, ...options };
  const first = messages[0];

  // Header: [GROUP CHAT - channel:chatId #groupName - N messages]
  const headerParts: string[] = ['GROUP CHAT'];
  headerParts.push(`${first.channel}:${first.chatId}`);
  if (first.groupName?.trim()) {
    if ((first.channel === 'slack' || first.channel === 'discord') && !first.groupName.startsWith('#')) {
      headerParts.push(`#${first.groupName}`);
    } else {
      headerParts.push(first.groupName);
    }
  }
  headerParts.push(`${messages.length} message${messages.length === 1 ? '' : 's'}`);
  let header = `[${headerParts.join(' - ')}]`;
  if (isListeningMode) {
    header += '\n[OBSERVATION ONLY - Update memories. Do not reply unless addressed.]';
  }

  // Chat log lines
  const lines = messages.map((msg) => {
    const time = formatShortTime(msg.timestamp, opts);
    const sender = formatSender(msg);
    const textParts: string[] = [];
    if (msg.text?.trim()) textParts.push(msg.text.trim());
    if (msg.reaction) {
      const action = msg.reaction.action || 'added';
      textParts.push(`[Reaction ${action}: ${msg.reaction.emoji}]`);
    }
    if (msg.attachments && msg.attachments.length > 0) {
      const names = msg.attachments.map((a) => a.name || 'attachment').join(', ');
      textParts.push(`[Attachments: ${names}]`);
    }
    const body = textParts.join(' ') || '(empty)';
    return `[${time}] ${sender}: ${body}`;
  });

  // Format hint
  const formatHint = first.formatterHints?.formatHint;
  const hint = formatHint ? `\n(Format: ${formatHint})` : '';

  // Compact directives for batch
  const supportsReactions = first.formatterHints?.supportsReactions ?? false;
  const directiveParts = isListeningMode
    ? [`\`<no-reply/>\` to acknowledge`, ...(supportsReactions ? [`\`<actions><react emoji="eyes" /></actions>\` to react`] : [])]
    : [`\`<no-reply/>\` to skip replying`, ...(supportsReactions ? [`\`<actions><react emoji="thumbsup" /></actions>\` to react`] : [])];
  const directives = `\n(Directives: ${directiveParts.join(', ')})`;

  return `${header}\n${lines.join('\n')}${hint}${directives}`;
}

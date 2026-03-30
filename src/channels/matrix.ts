/**
 * Matrix Channel Adapter
 *
 * Uses matrix-bot-sdk for Matrix homeserver communication.
 * Supports DM pairing for secure access control.
 */

import type { ChannelAdapter } from './types.js';
import type { InboundAttachment, InboundMessage, InboundReaction, OutboundFile, OutboundMessage } from '../core/types.js';
import type { DmPolicy } from '../pairing/types.js';
import { isUserAllowed, upsertPairingRequest } from '../pairing/store.js';
import { checkDmAccess } from './shared/access-control.js';
import { isGroupApproved, approveGroup } from '../pairing/group-store.js';
import { resolveEmoji } from './shared/emoji.js';
import { splitMessageText } from './shared/message-splitter.js';
import { buildAttachmentPath, downloadToFile } from './attachments.js';
import { HELP_TEXT } from '../core/commands.js';
import { isGroupAllowed, isGroupUserAllowed, resolveGroupMode, resolveDailyLimits, checkDailyLimit, type GroupMode, type GroupModeConfig } from './group-mode.js';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { createLogger } from '../logger.js';

const log = createLogger('Matrix');

const MATRIX_SPLIT_THRESHOLD = 64000;
const MATRIX_ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 15000;

/** MIME types that indicate a voice/audio message eligible for transcription. */
const VOICE_MIME_TYPES = new Set([
  'audio/ogg', 'audio/opus', 'audio/webm', 'audio/mp4', 'audio/mpeg',
  'audio/wav', 'audio/x-wav', 'audio/flac', 'audio/aac',
]);

function isVoiceMimeType(mimeType: string): boolean {
  // Match exact type or audio/* with voice-like codecs
  return VOICE_MIME_TYPES.has(mimeType) || mimeType.startsWith('audio/ogg');
}

const KNOWN_MATRIX_COMMANDS = new Set([
  'status', 'heartbeat', 'reset', 'cancel', 'approve', 'disapprove',
  'help', 'start', 'model', 'models', 'setconv', 'breakglass', 'recompile',
]);

export interface MatrixAdapterConfig {
  homeserverUrl: string;
  accessToken: string;
  userId: string;
  deviceId?: string;
  dmPolicy?: 'pairing' | 'allowlist' | 'open';
  allowedUsers?: string[];
  streaming?: boolean;
  attachmentsDir?: string;
  attachmentsMaxBytes?: number;
  mentionPatterns?: string[];
  groups?: Record<string, GroupModeConfig>;
  agentName?: string;
  e2ee?: boolean;
  storePath?: string;
}

/**
 * Convert mxc:// URI to an HTTPS download URL.
 *
 * Uses the authenticated client media endpoint (Matrix v1.11+) which
 * requires a Bearer token.  Falls back to the legacy /_matrix/media/v3
 * path only when the caller cannot supply auth.
 */
function mxcToHttp(homeserverUrl: string, mxcUrl: string): string {
  const withoutScheme = mxcUrl.slice('mxc://'.length);
  const slashIdx = withoutScheme.indexOf('/');
  if (slashIdx === -1) return mxcUrl;
  const server = withoutScheme.slice(0, slashIdx);
  const mediaId = withoutScheme.slice(slashIdx + 1);
  return `${homeserverUrl}/_matrix/client/v1/media/download/${server}/${mediaId}`;
}

/**
 * Convert Markdown to Matrix-compatible HTML.
 *
 * Handles: code blocks, inline code, bold, italic, strikethrough, links,
 * headers (h1-h6), blockquotes, horizontal rules, unordered and ordered
 * lists, and basic pipe tables.
 */
function markdownToHtml(text: string): string {
  // --- Phase 1: Extract fenced code blocks to protect from further processing ---
  const codeBlocks: string[] = [];
  let html = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const langAttr = lang ? ` class="language-${lang}"` : '';
    const placeholder = `\x00CODEBLOCK${codeBlocks.length}\x00`;
    codeBlocks.push(`<pre><code${langAttr}>${escaped}</code></pre>`);
    return placeholder;
  });

  // --- Phase 2: Process block-level elements line by line ---
  const lines = html.split('\n');
  const result: string[] = [];
  let inList: 'ul' | 'ol' | null = null;
  let inBlockquote = false;
  let inTable = false;
  let tableRows: string[] = [];

  const flushTable = () => {
    if (tableRows.length === 0) return;
    const headerRow = tableRows[0];
    const dataRows = tableRows.slice(1).filter(r => !r.match(/^\s*\|[\s:|-]+\|\s*$/));
    let tableHtml = '<table><thead><tr>';
    const headerCells = headerRow.split('|').map(c => c.trim()).filter(c => c);
    for (const cell of headerCells) tableHtml += `<th>${cell}</th>`;
    tableHtml += '</tr></thead>';
    if (dataRows.length > 0) {
      tableHtml += '<tbody>';
      for (const row of dataRows) {
        const cells = row.split('|').map(c => c.trim()).filter(c => c);
        tableHtml += '<tr>';
        for (const cell of cells) tableHtml += `<td>${cell}</td>`;
        tableHtml += '</tr>';
      }
      tableHtml += '</tbody>';
    }
    tableHtml += '</table>';
    result.push(tableHtml);
    tableRows = [];
    inTable = false;
  };

  const flushList = () => {
    if (inList) {
      result.push(inList === 'ul' ? '</ul>' : '</ol>');
      inList = null;
    }
  };

  const flushBlockquote = () => {
    if (inBlockquote) {
      result.push('</blockquote>');
      inBlockquote = false;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine;

    // Code block placeholder — pass through as-is
    if (line.match(/\x00CODEBLOCK\d+\x00/)) {
      flushList();
      flushBlockquote();
      flushTable();
      result.push(line);
      continue;
    }

    // Table rows (starts and ends with |)
    if (line.match(/^\s*\|.*\|\s*$/)) {
      flushList();
      flushBlockquote();
      inTable = true;
      tableRows.push(line);
      continue;
    } else if (inTable) {
      flushTable();
    }

    // Horizontal rule
    if (line.match(/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/)) {
      flushList();
      flushBlockquote();
      result.push('<hr>');
      continue;
    }

    // Headers
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      flushList();
      flushBlockquote();
      const level = headerMatch[1].length;
      result.push(`<h${level}>${headerMatch[2]}</h${level}>`);
      continue;
    }

    // Blockquotes
    if (line.match(/^>\s?/)) {
      flushList();
      if (!inBlockquote) {
        result.push('<blockquote>');
        inBlockquote = true;
      }
      result.push(line.replace(/^>\s?/, '') + '<br>');
      continue;
    } else if (inBlockquote) {
      flushBlockquote();
    }

    // Unordered list items
    if (line.match(/^\s*[-*+]\s+/)) {
      flushBlockquote();
      if (inList !== 'ul') {
        flushList();
        result.push('<ul>');
        inList = 'ul';
      }
      result.push(`<li>${line.replace(/^\s*[-*+]\s+/, '')}</li>`);
      continue;
    }

    // Ordered list items
    const olMatch = line.match(/^\s*(\d+)[.)]\s+/);
    if (olMatch) {
      flushBlockquote();
      if (inList !== 'ol') {
        flushList();
        result.push('<ol>');
        inList = 'ol';
      }
      result.push(`<li>${line.replace(/^\s*\d+[.)]\s+/, '')}</li>`);
      continue;
    }

    // Regular line — flush any open block elements
    if (inList && line.trim() === '') {
      flushList();
      result.push('<br>');
      continue;
    }
    flushList();

    // Empty line
    if (line.trim() === '') {
      result.push('<br>');
      continue;
    }

    result.push(line + '<br>');
  }

  flushList();
  flushBlockquote();
  flushTable();

  html = result.join('\n');

  // --- Phase 3: Inline formatting ---
  // Inline code (before bold/italic to avoid conflicts)
  html = html.replace(/`([^`]+)`/g, (_, code) => {
    const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<code>${escaped}</code>`;
  });

  // Bold (** or __)
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // __ bold only at word boundaries — avoid matching snake_case__names
  html = html.replace(/(?<=^|[\s(>])__(?=\S)([\s\S]+?\S)__(?=$|[\s)<.,;:!?])/gm, '<strong>$1</strong>');

  // Italic (* or _)
  html = html.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>');
  // _ italic only at word boundaries — avoid matching snake_case_names, file_paths, etc.
  html = html.replace(/(?<=^|[\s(>])_(?=\S)([^_]+?\S)_(?=$|[\s)<.,;:!?])/gm, '<em>$1</em>');

  // Strikethrough
  html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // --- Phase 4: Restore code blocks ---
  for (let i = 0; i < codeBlocks.length; i++) {
    html = html.replace(`\x00CODEBLOCK${i}\x00`, codeBlocks[i]);
  }

  return html;
}

function formatPairingMsg(code: string): string {
  return `Hi! This bot requires pairing.\n\nYour pairing code: **${code}**\n\nAsk the bot owner to approve with:\n\`lettabot pairing approve matrix ${code}\``;
}

type MatrixClient = {
  start(): Promise<void>;
  stop(): void;
  sendMessage(roomId: string, content: Record<string, unknown>): Promise<string>;
  sendEvent(roomId: string, eventType: string, content: Record<string, unknown>): Promise<string>;
  setTyping(roomId: string, isTyping: boolean, timeoutMs?: number): Promise<void>;
  uploadContent(data: Buffer, opts?: { name?: string; type?: string }): Promise<string>;
  getJoinedRoomMembers(roomId: string): Promise<string[]>;
  getRoomStateEvent(roomId: string, eventType: string, stateKey: string): Promise<Record<string, unknown>>;
  on(event: string, handler: (...args: unknown[]) => void): void;
};

export class MatrixAdapter implements ChannelAdapter {
  readonly id = 'matrix' as const;
  readonly name = 'Matrix';

  private client: MatrixClient | null = null;
  private config: MatrixAdapterConfig;
  private running = false;
  private roomMemberCache: Map<string, number> = new Map();
  private roomNameCache: Map<string, string> = new Map();

  onMessage?: (msg: InboundMessage) => Promise<void>;
  onCommand?: (command: string, chatId?: string, args?: string, forcePerChat?: boolean) => Promise<string | null>;

  constructor(config: MatrixAdapterConfig) {
    this.config = {
      ...config,
      dmPolicy: config.dmPolicy || 'pairing',
    };
  }

  private async checkAccess(userId: string): Promise<'allowed' | 'blocked' | 'pairing'> {
    return checkDmAccess('matrix', userId, this.config.dmPolicy as DmPolicy, this.config.allowedUsers);
  }

  private async isRoomDm(roomId: string): Promise<boolean> {
    if (this.roomMemberCache.has(roomId)) {
      return this.roomMemberCache.get(roomId)! <= 2;
    }
    try {
      const members = await this.client!.getJoinedRoomMembers(roomId);
      const count = members.length;
      this.roomMemberCache.set(roomId, count);
      return count <= 2;
    } catch (err) {
      log.warn('Failed to get room members for %s: %s', roomId, err);
      return true; // Default to DM for safety
    }
  }

  private async getRoomName(roomId: string): Promise<string | undefined> {
    if (this.roomNameCache.has(roomId)) {
      return this.roomNameCache.get(roomId);
    }
    try {
      const nameEvent = await this.client!.getRoomStateEvent(roomId, 'm.room.name', '');
      const name = nameEvent?.['name'] as string | undefined;
      if (name) {
        this.roomNameCache.set(roomId, name);
        return name;
      }
    } catch {
      // Room may not have a name set
    }
    return undefined;
  }

  async start(): Promise<void> {
    if (this.running) return;

    log.info('Loading matrix-bot-sdk...');
    const sdk = await import('matrix-bot-sdk') as unknown as {
      SimpleFsStorageProvider: new (path: string) => unknown;
      MatrixClient: new (url: string, token: string, storage: unknown) => MatrixClient & { on(e: string, h: (...a: unknown[]) => void): void };
      AutojoinRoomsMixin: { setupOnClient(client: unknown): void };
    };

    const storePath = this.config.storePath || './data/matrix-store';
    log.info(`Storage path: ${storePath}`);
    const storage = new sdk.SimpleFsStorageProvider(storePath);

    const matrixClient = new sdk.MatrixClient(
      this.config.homeserverUrl,
      this.config.accessToken,
      storage,
    );

    sdk.AutojoinRoomsMixin.setupOnClient(matrixClient);
    log.info('AutojoinRoomsMixin enabled');

    this.client = matrixClient as unknown as MatrixClient;

    // Listen for messages
    matrixClient.on('room.message', ((...args: unknown[]) => {
      const [roomId, event] = args as [string, Record<string, unknown>];
      this.handleRoomMessage(roomId, event).catch((err) => {
        log.error('Error handling room.message:', err);
      });
    }) as (...args: unknown[]) => void);

    // Handle room events: cache invalidation + inbound reactions
    matrixClient.on('room.event', ((...args: unknown[]) => {
      const [roomId, event] = args as [string, Record<string, unknown>];
      if (event['type'] === 'm.room.member') {
        this.roomMemberCache.delete(roomId);
      }
      if (event['type'] === 'm.room.name') {
        this.roomNameCache.delete(roomId);
      }
      if (event['type'] === 'm.reaction') {
        this.handleReaction(roomId, event).catch((err) => {
          log.error('Error handling m.reaction:', err);
        });
      }
    }) as (...args: unknown[]) => void);

    // Auto-approve groups when a paired user invites the bot (mirrors Telegram behavior)
    matrixClient.on('room.join', ((...args: unknown[]) => {
      const [roomId, event] = args as [string, Record<string, unknown>];
      this.handleRoomJoin(roomId, event).catch((err) => {
        log.error('Error handling room.join:', err);
      });
    }) as (...args: unknown[]) => void);

    log.info(`Connecting to Matrix homeserver at ${this.config.homeserverUrl}...`);
    try {
      await matrixClient.start();
    } catch (err) {
      log.error('matrix-bot-sdk start() failed:', err);
      throw err;
    }
    this.running = true;
    log.info(`Matrix adapter started as ${this.config.userId}`);
    log.info(`DM policy: ${this.config.dmPolicy}`);
    if (this.config.groups && Object.keys(this.config.groups).length > 0) {
      log.info(`Configured groups: ${Object.keys(this.config.groups).join(', ')}`);
    }
    if (this.config.mentionPatterns?.length) {
      log.info(`Mention patterns: ${this.config.mentionPatterns.join(', ')}`);
    }
  }

  async stop(): Promise<void> {
    if (!this.running || !this.client) return;
    this.client.stop();
    this.running = false;
    log.info('Matrix adapter stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Handle the bot joining a room — auto-approve groups when a paired user invites.
   * Mirrors Telegram's my_chat_member handler.
   */
  private async handleRoomJoin(roomId: string, _event: Record<string, unknown>): Promise<void> {
    const isDm = await this.isRoomDm(roomId);
    if (isDm) return; // DM rooms don't need group approval

    const dmPolicy = this.config.dmPolicy || 'pairing';
    if (dmPolicy !== 'pairing') {
      await approveGroup('matrix', roomId);
      log.info(`Group ${roomId} auto-approved (dmPolicy=${dmPolicy})`);
      return;
    }

    // Try to identify who invited the bot by checking room members
    // In most cases the inviter is the other member already in the room
    try {
      const members = await this.client!.getJoinedRoomMembers(roomId);
      const otherMembers = members.filter(m => m !== this.config.userId);
      const configAllowlist = this.config.allowedUsers;

      for (const memberId of otherMembers) {
        const allowed = await isUserAllowed('matrix', memberId, configAllowlist);
        if (allowed) {
          await approveGroup('matrix', roomId);
          log.info(`Group ${roomId} approved by paired user ${memberId}`);
          return;
        }
      }
      log.info(`Joined group ${roomId} but no paired users found — group not approved`);
    } catch (err) {
      log.warn('Failed to check group members for approval:', err);
    }
  }

  /**
   * Handle inbound m.reaction events — mirrors Telegram's message_reaction handler.
   */
  private async handleReaction(roomId: string, event: Record<string, unknown>): Promise<void> {
    const sender = event['sender'] as string | undefined;
    if (!sender || sender === this.config.userId) return;

    const content = event['content'] as Record<string, unknown> | undefined;
    if (!content) return;

    const relatesTo = content['m.relates_to'] as Record<string, unknown> | undefined;
    if (!relatesTo) return;

    const targetEventId = relatesTo['event_id'] as string | undefined;
    const emoji = relatesTo['key'] as string | undefined;
    if (!targetEventId || !emoji) return;

    // DM access check
    const isDm = await this.isRoomDm(roomId);
    if (isDm) {
      const access = await this.checkAccess(sender);
      if (access !== 'allowed') return;
    }

    log.info(`Reaction ${emoji} from ${sender} on ${targetEventId} in ${roomId}`);

    if (!this.onMessage) return;

    // Matrix doesn't distinguish add/remove in the event itself — reactions are always "added"
    // (redactions handle removal, which is a separate event type)
    const reaction: InboundReaction = {
      emoji,
      messageId: targetEventId,
      action: 'added',
    };

    await this.onMessage({
      channel: 'matrix' as import('../core/types.js').ChannelId,
      chatId: roomId,
      userId: sender,
      userName: sender,
      messageId: targetEventId,
      text: '',
      timestamp: new Date(),
      reaction,
      formatterHints: this.getFormatterHints(),
    });
  }

  private async handleRoomMessage(roomId: string, event: Record<string, unknown>): Promise<void> {
    const sender = event['sender'] as string | undefined;
    if (!sender || sender === this.config.userId) return;

    const content = event['content'] as Record<string, unknown> | undefined;
    if (!content) return;

    const msgtype = content['msgtype'] as string | undefined;
    if (!msgtype) return;

    const eventId = event['event_id'] as string | undefined;
    const originServerTs = event['origin_server_ts'] as number | undefined;
    const timestamp = originServerTs ? new Date(originServerTs) : new Date();
    const body = (content['body'] as string | undefined) || '';

    const isDm = await this.isRoomDm(roomId);
    const isGroup = !isDm;

    log.info(`Message from ${sender} in ${isDm ? 'DM' : 'group'} ${roomId} (type: ${msgtype})`);

    // Group approval check (mirrors Telegram's pairing-based group gating)
    if (isGroup) {
      const dmPolicy = this.config.dmPolicy || 'pairing';
      if (dmPolicy !== 'open' && !(await isGroupApproved('matrix', roomId))) {
        log.info(`Group ${roomId} not approved, ignoring message`);
        return;
      }
    }

    if (isDm) {
      const access = await this.checkAccess(sender);
      log.info(`DM access check for ${sender}: ${access}`);
      if (access === 'blocked') {
        await this.client!.sendMessage(roomId, {
          msgtype: 'm.text',
          body: "Sorry, you're not authorized to use this bot.",
        });
        return;
      }
      if (access === 'pairing') {
        const { code, created } = await upsertPairingRequest('matrix', sender, {
          username: sender,
        });
        if (!code) {
          await this.client!.sendMessage(roomId, {
            msgtype: 'm.text',
            body: 'Too many pending pairing requests. Please try again later.',
          });
          return;
        }
        if (created) {
          log.info(`New pairing request from ${sender}: ${code}`);
        }
        const pairingText = formatPairingMsg(code);
        await this.client!.sendMessage(roomId, {
          msgtype: 'm.text',
          body: pairingText,
          format: 'org.matrix.custom.html',
          formatted_body: markdownToHtml(pairingText),
        });
        return;
      }
    }

    const wasMentioned = isGroup ? this.isMentioned(body) : undefined;
    let groupMode: GroupMode | undefined;
    let groupName: string | undefined;

    // Group gating
    if (isGroup) {
      groupName = await this.getRoomName(roomId);

      if (this.config.groups) {
        const keys = [roomId];
        if (!isGroupAllowed(this.config.groups, keys)) {
          log.info(`Room ${roomId} (${groupName ?? 'unnamed'}) not in allowlist, ignoring`);
          return;
        }
        if (!isGroupUserAllowed(this.config.groups, keys, sender)) {
          log.info(`User ${sender} not allowed in group ${roomId}`);
          return;
        }
        groupMode = resolveGroupMode(this.config.groups, keys, 'open');
        if (groupMode === 'disabled') {
          log.info(`Group ${roomId} mode is disabled, ignoring`);
          return;
        }
        if (groupMode === 'mention-only' && !wasMentioned) {
          log.info(`Group ${roomId} is mention-only and bot was not mentioned, ignoring`);
          return;
        }

        const limits = resolveDailyLimits(this.config.groups, keys);
        const counterScope = limits.matchedKey ?? roomId;
        const counterKey = `${this.config.agentName ?? ''}:matrix:${counterScope}`;
        const limitResult = checkDailyLimit(counterKey, sender, limits);
        if (!limitResult.allowed) {
          log.info(`Daily limit reached for ${counterKey} (${limitResult.reason})`);
          return;
        }
      }
    }

    if (msgtype === 'm.text' && body.startsWith('/')) {
      const parts = body.slice(1).split(/\s+/);
      const command = parts[0]?.toLowerCase();
      const cmdArgs = parts.slice(1).join(' ') || undefined;

      if (command && KNOWN_MATRIX_COMMANDS.has(command)) {
        log.info(`Command: /${command}${cmdArgs ? ` ${cmdArgs}` : ''} from ${sender}`);
        if (command === 'help' || command === 'start') {
          await this.client!.sendMessage(roomId, {
            msgtype: 'm.text',
            body: HELP_TEXT,
          });
          return;
        }

        if (this.onCommand) {
          const result = await this.onCommand(command, roomId, cmdArgs);
          if (result) {
            await this.client!.sendMessage(roomId, {
              msgtype: 'm.text',
              body: result,
            });
          }
          return;
        }
      } else if (command) {
        // Unknown command — send feedback (mirrors Telegram behavior)
        log.info(`Unknown command: /${command} from ${sender}`);
        await this.client!.sendMessage(roomId, {
          msgtype: 'm.text',
          body: `Unknown command: /${command}\nTry /help.`,
        });
        return;
      }
    }

    if (!this.onMessage) return;

    let text = '';
    const attachments: InboundAttachment[] = [];

    if (msgtype === 'm.text') {
      text = body;
    } else if (msgtype === 'm.image' || msgtype === 'm.file' || msgtype === 'm.audio' || msgtype === 'm.video') {
      const mxcUrl = content['url'] as string | undefined;
      const fileName = (content['body'] as string | undefined) || 'attachment';
      const info = content['info'] as Record<string, unknown> | undefined;
      const mimeType = info?.['mimetype'] as string | undefined;
      const size = info?.['size'] as number | undefined;

      const kind: InboundAttachment['kind'] =
        msgtype === 'm.image' ? 'image' :
        msgtype === 'm.audio' ? 'audio' :
        msgtype === 'm.video' ? 'video' : 'file';

      const httpUrl = mxcUrl ? mxcToHttp(this.config.homeserverUrl, mxcUrl) : undefined;
      const authHeaders = { 'Authorization': `Bearer ${this.config.accessToken}` };

      const attachment: InboundAttachment = {
        id: eventId,
        name: fileName,
        mimeType,
        size,
        kind,
        // Don't expose httpUrl — it requires Matrix session auth that the agent doesn't have.
        // The agent uses localPath instead (downloaded below).
      };

      if (httpUrl) {
        const skipForSize = this.config.attachmentsMaxBytes !== undefined
          && this.config.attachmentsMaxBytes !== 0
          && size !== undefined
          && size > this.config.attachmentsMaxBytes;

        if (skipForSize) {
          log.warn(`Attachment ${fileName} exceeds size limit, skipping download.`);
        } else {
          const attachDir = this.config.attachmentsDir || '/tmp/lettabot-matrix';
          const target = buildAttachmentPath(attachDir, 'matrix', roomId, fileName);
          try {
            await downloadToFile(httpUrl, target, {
              timeoutMs: MATRIX_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
              headers: authHeaders,
            });
            attachment.localPath = target;
            log.info(`Attachment saved to ${target}`);
          } catch (err) {
            log.warn('Failed to download attachment:', err);
          }
        }
      }

      attachments.push(attachment);
      log.info(`Attachment: ${kind} "${fileName}" from ${sender}`);

      // Voice transcription: if this is an audio message with a voice MIME type, transcribe it
      // Mirrors Telegram's message:voice handler
      if (kind === 'audio' && mimeType && isVoiceMimeType(mimeType) && httpUrl) {
        text = await this.tryTranscribeVoice(httpUrl, fileName, roomId);
      }
    }

    if (!text && attachments.length === 0) return;

    const isListeningMode = groupMode === 'listen' && !wasMentioned;

    log.info(`Forwarding message to bot core (group=${isGroup}, listening=${isListeningMode}, mentioned=${wasMentioned})`);
    await this.onMessage({
      channel: 'matrix' as import('../core/types.js').ChannelId,
      chatId: roomId,
      userId: sender,
      userName: sender,
      userHandle: sender,
      messageId: eventId,
      text,
      timestamp,
      isGroup,
      groupName,
      wasMentioned,
      isListeningMode,
      attachments,
      formatterHints: this.getFormatterHints(),
    });
  }

  private isMentioned(text: string): boolean {
    if (text.includes(this.config.userId)) return true;
    if (this.config.mentionPatterns) {
      for (const pattern of this.config.mentionPatterns) {
        try {
          if (new RegExp(pattern).test(text)) return true;
        } catch {
          // Invalid pattern — ignore
        }
      }
    }
    return false;
  }

  /**
   * Attempt to transcribe a voice/audio message. Mirrors Telegram's voice handler.
   * Returns the transcription text or an error description.
   */
  private async tryTranscribeVoice(httpUrl: string, fileName: string, roomId: string): Promise<string> {
    const { isTranscriptionConfigured } = await import('../transcription/index.js');
    if (!isTranscriptionConfigured()) {
      log.info('Voice message received but transcription not configured');
      await this.client!.sendMessage(roomId, {
        msgtype: 'm.text',
        body: 'Voice messages require a transcription API key.',
      });
      return '';
    }

    try {
      log.info(`Transcribing voice message: ${fileName}`);
      const response = await fetch(httpUrl, {
        headers: { 'Authorization': `Bearer ${this.config.accessToken}` },
      });
      const buffer = Buffer.from(await response.arrayBuffer());

      const { transcribeAudio } = await import('../transcription/index.js');
      const result = await transcribeAudio(buffer, fileName);

      if (result.success && result.text) {
        log.info(`Transcribed voice message: "${result.text.slice(0, 50)}..."`);
        return `[Voice message]: ${result.text}`;
      } else {
        log.error(`Transcription failed: ${result.error}`);
        return `[Voice message - transcription failed: ${result.error}]`;
      }
    } catch (error) {
      log.error('Error processing voice message:', error);
      return `[Voice message - error: ${error instanceof Error ? error.message : 'unknown error'}]`;
    }
  }

  async sendMessage(msg: OutboundMessage): Promise<{ messageId: string }> {
    if (!this.client) throw new Error('Matrix adapter not started');

    const chunks = splitMessageText(msg.text, MATRIX_SPLIT_THRESHOLD);
    let lastEventId = '';

    log.info(`Sending message to ${msg.chatId} (${chunks.length} chunk(s), ${msg.text.length} chars)`);
    for (const chunk of chunks) {
      // If caller already provided HTML (e.g., reasoning display), use it directly
      const htmlBody = msg.parseMode === 'HTML' ? chunk : markdownToHtml(chunk);
      // Strip HTML tags for the plain text fallback body
      const plainBody = msg.parseMode === 'HTML'
        ? chunk.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
        : chunk;
      const eventId = await this.client.sendMessage(msg.chatId, {
        msgtype: 'm.text',
        body: plainBody,
        format: 'org.matrix.custom.html',
        formatted_body: htmlBody,
      });
      lastEventId = eventId;
    }

    return { messageId: lastEventId };
  }

  async sendFile(file: OutboundFile): Promise<{ messageId: string }> {
    if (!this.client) throw new Error('Matrix adapter not started');

    const fileName = basename(file.filePath);
    log.info(`Sending file "${fileName}" (${file.kind}) to ${file.chatId}`);
    const buffer = await readFile(file.filePath);
    const mxcUrl = await this.client.uploadContent(buffer, { name: fileName });

    const msgtype =
      file.kind === 'image' ? 'm.image' :
      file.kind === 'audio' ? 'm.audio' : 'm.file';

    const eventId = await this.client.sendMessage(file.chatId, {
      msgtype,
      body: file.caption || fileName,
      url: mxcUrl,
    });

    return { messageId: eventId };
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    if (!this.client) throw new Error('Matrix adapter not started');

    log.info(`Editing message ${messageId} in ${chatId}`);
    const htmlBody = markdownToHtml(text);
    await this.client.sendMessage(chatId, {
      msgtype: 'm.text',
      body: `* ${text}`,
      format: 'org.matrix.custom.html',
      formatted_body: `<p>${htmlBody}</p>`,
      'm.new_content': {
        msgtype: 'm.text',
        body: text,
        format: 'org.matrix.custom.html',
        formatted_body: htmlBody,
      },
      'm.relates_to': {
        rel_type: 'm.replace',
        event_id: messageId,
      },
    });
  }

  async addReaction(chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.client) throw new Error('Matrix adapter not started');

    const resolved = resolveEmoji(emoji);
    await this.client.sendEvent(chatId, 'm.reaction', {
      'm.relates_to': {
        rel_type: 'm.annotation',
        event_id: messageId,
        key: resolved,
      },
    });
  }

  async sendTypingIndicator(chatId: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.setTyping(chatId, true, 5000);
    } catch {
      // Ignore typing failures
    }
  }

  async stopTypingIndicator(chatId: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.setTyping(chatId, false);
    } catch {
      // Ignore typing failures
    }
  }

  supportsEditing(): boolean {
    return this.config.streaming ?? false;
  }

  getDmPolicy(): string {
    return this.config.dmPolicy || 'pairing';
  }

  getFormatterHints() {
    return {
      supportsReactions: true,
      supportsFiles: true,
      formatHint: 'Markdown with HTML: **bold** *italic* `code` [links](url) — headers and tables supported',
    };
  }
}

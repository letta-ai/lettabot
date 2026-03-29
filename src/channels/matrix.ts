/**
 * Matrix Channel Adapter
 *
 * Uses matrix-bot-sdk for Matrix homeserver communication.
 * Supports DM pairing for secure access control.
 */

import type { ChannelAdapter } from './types.js';
import type { InboundAttachment, InboundMessage, OutboundFile, OutboundMessage } from '../core/types.js';
import type { DmPolicy } from '../pairing/types.js';
import { upsertPairingRequest } from '../pairing/store.js';
import { checkDmAccess } from './shared/access-control.js';
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
 */
function mxcToHttp(homeserverUrl: string, mxcUrl: string): string {
  const withoutScheme = mxcUrl.slice('mxc://'.length);
  const slashIdx = withoutScheme.indexOf('/');
  if (slashIdx === -1) return mxcUrl;
  const server = withoutScheme.slice(0, slashIdx);
  const mediaId = withoutScheme.slice(slashIdx + 1);
  return `${homeserverUrl}/_matrix/media/v3/download/${server}/${mediaId}`;
}

/**
 * Convert basic Markdown to Matrix-compatible HTML.
 */
function markdownToHtml(text: string): string {
  // Process code blocks before inline code to avoid double-escaping
  let html = text.replace(/```([^`]*?)```/gs, (_, code) => {
    const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<pre><code>${escaped}</code></pre>`;
  });
  html = html.replace(/`([^`]+)`/g, (_, code) => {
    const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<code>${escaped}</code>`;
  });
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  html = html.replace(/\n/g, '<br>');
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
  getJoinedRoomMembers(roomId: string): Promise<{ joined: Record<string, unknown> }>;
  on(event: string, handler: (...args: unknown[]) => void): void;
};

export class MatrixAdapter implements ChannelAdapter {
  readonly id = 'matrix' as const;
  readonly name = 'Matrix';

  private client: MatrixClient | null = null;
  private config: MatrixAdapterConfig;
  private running = false;
  private roomMemberCache: Map<string, number> = new Map();

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
      const result = await this.client!.getJoinedRoomMembers(roomId);
      const count = Object.keys(result.joined).length;
      this.roomMemberCache.set(roomId, count);
      return count <= 2;
    } catch (err) {
      log.warn('Failed to get room members:', err);
      return true; // Default to DM for safety
    }
  }

  async start(): Promise<void> {
    if (this.running) return;

    // Lazy import — matrix-bot-sdk may not be installed in all deployments.
    // We use a Function constructor to avoid static analysis of the import path.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const sdk = await (new Function('m', 'return import(m)'))('matrix-bot-sdk') as {
      SimpleFsStorageProvider: new (path: string) => unknown;
      MatrixClient: new (url: string, token: string, storage: unknown) => MatrixClient & { on(e: string, h: (...a: unknown[]) => void): void };
      AutojoinRoomsMixin: { setupOnClient(client: unknown): void };
    };

    const storePath = this.config.storePath || './data/matrix-store';
    const storage = new sdk.SimpleFsStorageProvider(storePath);

    const matrixClient = new sdk.MatrixClient(
      this.config.homeserverUrl,
      this.config.accessToken,
      storage,
    );

    sdk.AutojoinRoomsMixin.setupOnClient(matrixClient);

    this.client = matrixClient as unknown as MatrixClient;

    matrixClient.on('room.message', ((...args: unknown[]) => {
      const [roomId, event] = args as [string, Record<string, unknown>];
      this.handleRoomMessage(roomId, event).catch((err) => {
        log.error('Error handling room.message:', err);
      });
    }) as (...args: unknown[]) => void);

    log.info('Connecting to Matrix homeserver...');
    await matrixClient.start();
    this.running = true;
    log.info(`Matrix adapter started as ${this.config.userId}`);
    log.info(`DM policy: ${this.config.dmPolicy}`);
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

    if (isDm) {
      const access = await this.checkAccess(sender);
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

    // Group gating
    if (isGroup && this.config.groups) {
      const keys = [roomId];
      if (!isGroupAllowed(this.config.groups, keys)) {
        log.info(`Room ${roomId} not in allowlist, ignoring`);
        return;
      }
      if (!isGroupUserAllowed(this.config.groups, keys, sender)) {
        return;
      }
      groupMode = resolveGroupMode(this.config.groups, keys, 'open');
      if (groupMode === 'disabled') return;
      if (groupMode === 'mention-only' && !wasMentioned) return;

      const limits = resolveDailyLimits(this.config.groups, keys);
      const counterScope = limits.matchedKey ?? roomId;
      const counterKey = `${this.config.agentName ?? ''}:matrix:${counterScope}`;
      const limitResult = checkDailyLimit(counterKey, sender, limits);
      if (!limitResult.allowed) {
        log.info(`Daily limit reached for ${counterKey} (${limitResult.reason})`);
        return;
      }
    }

    if (msgtype === 'm.text' && body.startsWith('/')) {
      const parts = body.slice(1).split(/\s+/);
      const command = parts[0]?.toLowerCase();
      const cmdArgs = parts.slice(1).join(' ') || undefined;

      if (command && KNOWN_MATRIX_COMMANDS.has(command)) {
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

      const attachment: InboundAttachment = {
        id: eventId,
        name: fileName,
        mimeType,
        size,
        kind,
        url: httpUrl,
      };

      if (this.config.attachmentsDir && httpUrl) {
        if (this.config.attachmentsMaxBytes !== 0) {
          if (!this.config.attachmentsMaxBytes || !size || size <= this.config.attachmentsMaxBytes) {
            const target = buildAttachmentPath(this.config.attachmentsDir, 'matrix', roomId, fileName);
            try {
              await downloadToFile(httpUrl, target, {
                timeoutMs: MATRIX_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
              });
              attachment.localPath = target;
              log.info(`Attachment saved to ${target}`);
            } catch (err) {
              log.warn('Failed to download attachment:', err);
            }
          } else {
            log.warn(`Attachment ${fileName} exceeds size limit, skipping download.`);
          }
        }
      }

      attachments.push(attachment);
    }

    if (!text && attachments.length === 0) return;

    const isListeningMode = groupMode === 'listen' && !wasMentioned;

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

  async sendMessage(msg: OutboundMessage): Promise<{ messageId: string }> {
    if (!this.client) throw new Error('Matrix adapter not started');

    const chunks = splitMessageText(msg.text, MATRIX_SPLIT_THRESHOLD);
    let lastEventId = '';

    for (const chunk of chunks) {
      const htmlBody = markdownToHtml(chunk);
      const eventId = await this.client.sendMessage(msg.chatId, {
        msgtype: 'm.text',
        body: chunk,
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

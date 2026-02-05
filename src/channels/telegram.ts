/**
 * Telegram Channel Adapter
 * 
 * Uses grammY for Telegram Bot API.
 * Supports DM pairing for secure access control.
 */

import { Bot, InputFile } from 'grammy';
import type { ChannelAdapter } from './types.js';
import type { InboundAttachment, InboundMessage, InboundReaction, OutboundFile, OutboundMessage } from '../core/types.js';
import type { DmPolicy } from '../pairing/types.js';
import {
  isUserAllowed,
  upsertPairingRequest,
  formatPairingMessage,
} from '../pairing/store.js';
import { basename } from 'node:path';
import { buildAttachmentPath, downloadToFile } from './attachments.js';

export interface TelegramConfig {
  token: string;
  dmPolicy?: DmPolicy;           // 'pairing' (default), 'allowlist', or 'open'
  allowedUsers?: number[];       // Telegram user IDs (config allowlist)
  attachmentsDir?: string;
  attachmentsMaxBytes?: number;
}

export class TelegramAdapter implements ChannelAdapter {
  readonly id = 'telegram' as const;
  readonly name = 'Telegram';
  
  private bot: Bot;
  private config: TelegramConfig;
  private running = false;
  private attachmentsDir?: string;
  private attachmentsMaxBytes?: number;
  
  onMessage?: (msg: InboundMessage) => Promise<void>;
  onCommand?: (command: string) => Promise<string | null>;
  
  constructor(config: TelegramConfig) {
    this.config = {
      ...config,
      dmPolicy: config.dmPolicy || 'pairing',  // Default to pairing
    };
    this.bot = new Bot(config.token);
    this.attachmentsDir = config.attachmentsDir;
    this.attachmentsMaxBytes = config.attachmentsMaxBytes;
    this.setupHandlers();
  }
  
  /**
   * Check if a user is authorized based on dmPolicy
   * Returns true if allowed, false if blocked, 'pairing' if pending pairing
   */
  private async checkAccess(userId: string, username?: string, firstName?: string): Promise<'allowed' | 'blocked' | 'pairing'> {
    const policy = this.config.dmPolicy || 'pairing';
    const userIdStr = userId;
    
    // Open policy: everyone allowed
    if (policy === 'open') {
      return 'allowed';
    }
    
    // Check if already allowed (config or store)
    const configAllowlist = this.config.allowedUsers?.map(String);
    const allowed = await isUserAllowed('telegram', userIdStr, configAllowlist);
    if (allowed) {
      return 'allowed';
    }
    
    // Allowlist policy: not allowed if not in list
    if (policy === 'allowlist') {
      return 'blocked';
    }
    
    // Pairing policy: create/update pairing request
    return 'pairing';
  }
  
  private setupHandlers(): void {
    // Middleware: Check access based on dmPolicy
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (!userId) return;
      
      const access = await this.checkAccess(
        String(userId),
        ctx.from?.username,
        ctx.from?.first_name
      );
      
      if (access === 'allowed') {
        await next();
        return;
      }
      
      if (access === 'blocked') {
        await ctx.reply("Sorry, you're not authorized to use this bot.");
        return;
      }
      
      // Pairing flow
      const { code, created } = await upsertPairingRequest('telegram', String(userId), {
        username: ctx.from?.username,
        firstName: ctx.from?.first_name,
        lastName: ctx.from?.last_name,
      });
      
      if (!code) {
        // Too many pending requests
        await ctx.reply(
          "Too many pending pairing requests. Please try again later."
        );
        return;
      }
      
      // Only send pairing message on first contact (created=true)
      // or if this is a new message (not just middleware check)
      if (created) {
        console.log(`[Telegram] New pairing request from ${userId} (${ctx.from?.username || 'no username'}): ${code}`);
        await ctx.reply(formatPairingMessage(code), { parse_mode: 'Markdown' });
      }
      
      // Don't process the message further
      return;
    });
    
    // Handle /start and /help
    this.bot.command(['start', 'help'], async (ctx) => {
      await ctx.reply(
        "*LettaBot* - AI assistant with persistent memory\n\n" +
        "*Commands:*\n" +
        "/status - Show current status\n" +
        "/help - Show this message\n\n" +
        "Just send me a message to get started!",
        { parse_mode: 'Markdown' }
      );
    });
    
    // Handle /status
    this.bot.command('status', async (ctx) => {
      if (this.onCommand) {
        const result = await this.onCommand('status');
        await ctx.reply(result || 'No status available');
      }
    });
    
    // Handle /heartbeat - trigger heartbeat manually (silent - no reply)
    this.bot.command('heartbeat', async (ctx) => {
      if (this.onCommand) {
        await this.onCommand('heartbeat');
      }
    });
    
    // Handle text messages
    this.bot.on('message:text', async (ctx) => {
      const userId = ctx.from?.id;
      const chatId = ctx.chat.id;
      const text = ctx.message.text;
      
      if (!userId) return;
      if (text.startsWith('/')) return;  // Skip other commands
      
      if (this.onMessage) {
        await this.onMessage({
          channel: 'telegram',
          chatId: String(chatId),
          userId: String(userId),
          userName: ctx.from.username || ctx.from.first_name,
          messageId: String(ctx.message.message_id),
          text,
          timestamp: new Date(),
        });
      }
    });

    // Handle message reactions (Bot API >= 7.0)
    this.bot.on('message_reaction', async (ctx) => {
      const reaction = ctx.update.message_reaction;
      if (!reaction) return;
      const userId = reaction.user?.id;
      if (!userId) return;

      const access = await this.checkAccess(
        String(userId),
        reaction.user?.username,
        reaction.user?.first_name
      );
      if (access !== 'allowed') {
        return;
      }

      const chatId = reaction.chat?.id;
      const messageId = reaction.message_id;
      if (!chatId || !messageId) return;

      const newEmoji = extractTelegramReaction(reaction.new_reaction?.[0]);
      const oldEmoji = extractTelegramReaction(reaction.old_reaction?.[0]);
      const emoji = newEmoji || oldEmoji;
      if (!emoji) return;

      const action: InboundReaction['action'] = newEmoji ? 'added' : 'removed';

      if (this.onMessage) {
        await this.onMessage({
          channel: 'telegram',
          chatId: String(chatId),
          userId: String(userId),
          userName: reaction.user?.username || reaction.user?.first_name || undefined,
          messageId: String(messageId),
          text: '',
          timestamp: new Date(),
          reaction: {
            emoji,
            messageId: String(messageId),
            action,
          },
        });
      }
    });

    // Handle voice messages (must be registered before generic 'message' handler)
    this.bot.on('message:voice', async (ctx) => {
      const userId = ctx.from?.id;
      const chatId = ctx.chat.id;

      if (!userId) return;

      // Check if transcription is configured (config or env)
      const { loadConfig } = await import('../config/index.js');
      const config = loadConfig();
      if (!config.transcription?.apiKey && !process.env.OPENAI_API_KEY) {
        await ctx.reply('Voice messages require OpenAI API key for transcription. See: https://github.com/letta-ai/lettabot#voice-messages');
        return;
      }

      try {
        // Get file link
        const voice = ctx.message.voice;
        const file = await ctx.api.getFile(voice.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${this.config.token}/${file.file_path}`;

        // Download audio
        const response = await fetch(fileUrl);
        const buffer = Buffer.from(await response.arrayBuffer());

        // Transcribe
        const { transcribeAudio } = await import('../transcription/index.js');
        const result = await transcribeAudio(buffer, 'voice.ogg');

        let messageText: string;
        if (result.success && result.text) {
          console.log(`[Telegram] Transcribed voice message: "${result.text.slice(0, 50)}..."`);
          messageText = `[Voice message]: ${result.text}`;
        } else {
          console.error(`[Telegram] Transcription failed: ${result.error}`);
          messageText = `[Voice message - transcription failed: ${result.error}]`;
        }

        // Send to agent
        if (this.onMessage) {
          await this.onMessage({
            channel: 'telegram',
            chatId: String(chatId),
            userId: String(userId),
            userName: ctx.from.username || ctx.from.first_name,
            messageId: String(ctx.message.message_id),
            text: messageText,
            timestamp: new Date(),
          });
        }
      } catch (error) {
        console.error('[Telegram] Error processing voice message:', error);
        // Send error to agent so it can explain
        if (this.onMessage) {
          await this.onMessage({
            channel: 'telegram',
            chatId: String(chatId),
            userId: String(userId),
            userName: ctx.from?.username || ctx.from?.first_name,
            messageId: String(ctx.message.message_id),
            text: `[Voice message - error: ${error instanceof Error ? error.message : 'unknown error'}]`,
            timestamp: new Date(),
          });
        }
      }
    });

    // Handle non-text messages with attachments (excluding voice - handled above)
    this.bot.on('message', async (ctx) => {
      if (!ctx.message || ctx.message.text || ctx.message.voice) return;
      const userId = ctx.from?.id;
      const chatId = ctx.chat.id;
      if (!userId) return;

      const { attachments, caption } = await this.collectAttachments(ctx.message, String(chatId));
      if (attachments.length === 0 && !caption) return;

      if (this.onMessage) {
        await this.onMessage({
          channel: 'telegram',
          chatId: String(chatId),
          userId: String(userId),
          userName: ctx.from.username || ctx.from.first_name,
          messageId: String(ctx.message.message_id),
          text: caption || '',
          timestamp: new Date(),
          attachments,
        });
      }
    });
    
    // Error handler
    this.bot.catch((err) => {
      console.error('[Telegram] Bot error:', err);
    });
  }
  
  async start(): Promise<void> {
    if (this.running) return;
    
    // Don't await - bot.start() never resolves (it's a long-polling loop)
    // The onStart callback fires when polling begins
    this.bot.start({
      onStart: (botInfo) => {
        console.log(`[Telegram] Bot started as @${botInfo.username}`);
        console.log(`[Telegram] DM policy: ${this.config.dmPolicy}`);
        this.running = true;
      },
    });
    
    // Give it a moment to connect before returning
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  async stop(): Promise<void> {
    if (!this.running) return;
    await this.bot.stop();
    this.running = false;
  }
  
  isRunning(): boolean {
    return this.running;
  }
  
  async sendMessage(msg: OutboundMessage): Promise<{ messageId: string }> {
    const { markdownToTelegramV2 } = await import('./telegram-format.js');
    
    // Convert markdown to Telegram MarkdownV2 format
    const formatted = await markdownToTelegramV2(msg.text);
    
    const result = await this.bot.api.sendMessage(msg.chatId, formatted, {
      parse_mode: 'MarkdownV2',
      reply_to_message_id: msg.replyToMessageId ? Number(msg.replyToMessageId) : undefined,
    });
    return { messageId: String(result.message_id) };
  }

  async sendFile(file: OutboundFile): Promise<{ messageId: string }> {
    const input = new InputFile(file.filePath);
    const caption = file.caption || undefined;

    if (file.kind === 'image') {
      const result = await this.bot.api.sendPhoto(file.chatId, input, { caption });
      return { messageId: String(result.message_id) };
    }

    const result = await this.bot.api.sendDocument(file.chatId, input, { caption });
    return { messageId: String(result.message_id) };
  }
  
  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    const { markdownToTelegramV2 } = await import('./telegram-format.js');
    const formatted = await markdownToTelegramV2(text);
    await this.bot.api.editMessageText(chatId, Number(messageId), formatted, { parse_mode: 'MarkdownV2' });
  }

  async addReaction(chatId: string, messageId: string, emoji: string): Promise<void> {
    const resolved = resolveTelegramEmoji(emoji);
    if (!TELEGRAM_REACTION_SET.has(resolved)) {
      throw new Error(`Unsupported Telegram reaction emoji: ${resolved}`);
    }
    await this.bot.api.setMessageReaction(chatId, Number(messageId), [
      { type: 'emoji', emoji: resolved as TelegramReactionEmoji },
    ]);
  }
  
  async sendTypingIndicator(chatId: string): Promise<void> {
    await this.bot.api.sendChatAction(chatId, 'typing');
  }
  
  /**
   * Get the underlying bot instance (for commands, etc.)
   */
  getBot(): Bot {
    return this.bot;
  }

  private async collectAttachments(
    message: any,
    chatId: string
  ): Promise<{ attachments: InboundAttachment[]; caption?: string }> {
    const attachments: InboundAttachment[] = [];
    const caption = message.caption as string | undefined;

    if (message.photo && message.photo.length > 0) {
      const photo = message.photo[message.photo.length - 1];
      const attachment = await this.fetchTelegramFile({
        fileId: photo.file_id,
        fileName: `photo-${photo.file_unique_id}.jpg`,
        mimeType: 'image/jpeg',
        size: photo.file_size,
        kind: 'image',
        chatId,
      });
      if (attachment) attachments.push(attachment);
    }

    if (message.document) {
      const doc = message.document;
      const attachment = await this.fetchTelegramFile({
        fileId: doc.file_id,
        fileName: doc.file_name,
        mimeType: doc.mime_type,
        size: doc.file_size,
        kind: 'file',
        chatId,
      });
      if (attachment) attachments.push(attachment);
    }

    if (message.video) {
      const video = message.video;
      const attachment = await this.fetchTelegramFile({
        fileId: video.file_id,
        fileName: video.file_name || `video-${video.file_unique_id}.mp4`,
        mimeType: video.mime_type,
        size: video.file_size,
        kind: 'video',
        chatId,
      });
      if (attachment) attachments.push(attachment);
    }

    if (message.audio) {
      const audio = message.audio;
      const attachment = await this.fetchTelegramFile({
        fileId: audio.file_id,
        fileName: audio.file_name || `audio-${audio.file_unique_id}.mp3`,
        mimeType: audio.mime_type,
        size: audio.file_size,
        kind: 'audio',
        chatId,
      });
      if (attachment) attachments.push(attachment);
    }

    if (message.voice) {
      const voice = message.voice;
      const attachment = await this.fetchTelegramFile({
        fileId: voice.file_id,
        fileName: `voice-${voice.file_unique_id}.ogg`,
        mimeType: voice.mime_type,
        size: voice.file_size,
        kind: 'audio',
        chatId,
      });
      if (attachment) attachments.push(attachment);
    }

    if (message.animation) {
      const animation = message.animation;
      const attachment = await this.fetchTelegramFile({
        fileId: animation.file_id,
        fileName: animation.file_name || `animation-${animation.file_unique_id}.mp4`,
        mimeType: animation.mime_type,
        size: animation.file_size,
        kind: 'video',
        chatId,
      });
      if (attachment) attachments.push(attachment);
    }

    if (message.sticker) {
      const sticker = message.sticker;
      const attachment = await this.fetchTelegramFile({
        fileId: sticker.file_id,
        fileName: `sticker-${sticker.file_unique_id}.${sticker.is_animated ? 'tgs' : 'webp'}`,
        mimeType: sticker.mime_type,
        size: sticker.file_size,
        kind: 'image',
        chatId,
      });
      if (attachment) attachments.push(attachment);
    }

    return { attachments, caption };
  }

  private async fetchTelegramFile(options: {
    fileId: string;
    fileName?: string;
    mimeType?: string;
    size?: number;
    kind?: InboundAttachment['kind'];
    chatId: string;
  }): Promise<InboundAttachment | null> {
    const { fileId, fileName, mimeType, size, kind, chatId } = options;
    const attachment: InboundAttachment = {
      id: fileId,
      name: fileName,
      mimeType,
      size,
      kind,
    };

    if (!this.attachmentsDir) {
      return attachment;
    }
    if (this.attachmentsMaxBytes === 0) {
      return attachment;
    }
    if (this.attachmentsMaxBytes && size && size > this.attachmentsMaxBytes) {
      console.warn(`[Telegram] Attachment ${fileName || fileId} exceeds size limit, skipping download.`);
      return attachment;
    }

    try {
      const file = await this.bot.api.getFile(fileId);
      const remotePath = file.file_path;
      if (!remotePath) return attachment;
      const resolvedName = fileName || basename(remotePath) || fileId;
      const target = buildAttachmentPath(this.attachmentsDir, 'telegram', chatId, resolvedName);
      const url = `https://api.telegram.org/file/bot${this.config.token}/${remotePath}`;
      await downloadToFile(url, target);
      attachment.localPath = target;
      console.log(`[Telegram] Attachment saved to ${target}`);
    } catch (err) {
      console.warn('[Telegram] Failed to download attachment:', err);
    }
    return attachment;
  }
}

function extractTelegramReaction(reaction?: {
  type?: string;
  emoji?: string;
  custom_emoji_id?: string;
}): string | null {
  if (!reaction) return null;
  if ('emoji' in reaction && reaction.emoji) {
    return reaction.emoji;
  }
  if ('custom_emoji_id' in reaction && reaction.custom_emoji_id) {
    return `custom:${reaction.custom_emoji_id}`;
  }
  return null;
}

const TELEGRAM_EMOJI_ALIAS_TO_UNICODE: Record<string, string> = {
  eyes: '👀',
  thumbsup: '👍',
  thumbs_up: '👍',
  '+1': '👍',
  heart: '❤️',
  fire: '🔥',
  smile: '😄',
  laughing: '😆',
  tada: '🎉',
  clap: '👏',
  ok_hand: '👌',
};

function resolveTelegramEmoji(input: string): string {
  const match = input.match(/^:([^:]+):$/);
  const alias = match ? match[1] : null;
  if (alias && TELEGRAM_EMOJI_ALIAS_TO_UNICODE[alias]) {
    return TELEGRAM_EMOJI_ALIAS_TO_UNICODE[alias];
  }
  if (TELEGRAM_EMOJI_ALIAS_TO_UNICODE[input]) {
    return TELEGRAM_EMOJI_ALIAS_TO_UNICODE[input];
  }
  return input;
}

const TELEGRAM_REACTION_EMOJIS = [
  '👍', '👎', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '🤬', '😢',
  '🎉', '🤩', '🤮', '💩', '🙏', '👌', '🕊', '🤡', '🥱', '🥴', '😍', '🐳',
  '❤‍🔥', '🌚', '🌭', '💯', '🤣', '⚡', '🍌', '🏆', '💔', '🤨', '😐', '🍓',
  '🍾', '💋', '🖕', '😈', '😴', '😭', '🤓', '👻', '👨‍💻', '👀', '🎃', '🙈',
  '😇', '😨', '🤝', '✍', '🤗', '🫡', '🎅', '🎄', '☃', '💅', '🤪', '🗿',
  '🆒', '💘', '🙉', '🦄', '😘', '💊', '🙊', '😎', '👾', '🤷‍♂', '🤷',
  '🤷‍♀', '😡',
] as const;

type TelegramReactionEmoji = typeof TELEGRAM_REACTION_EMOJIS[number];

const TELEGRAM_REACTION_SET = new Set<string>(TELEGRAM_REACTION_EMOJIS);

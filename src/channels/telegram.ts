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
import { checkDmAccess } from './shared/access-control.js';
import { resolveEmoji } from './shared/emoji.js';
import { splitMessageText, splitFormattedText } from './shared/message-splitter.js';
import { isGroupApproved, approveGroup } from '../pairing/group-store.js';
import { basename } from 'node:path';
import { buildAttachmentPath, downloadToFile } from './attachments.js';
import { applyTelegramGroupGating } from './telegram-group-gating.js';
import { resolveDailyLimits, checkDailyLimit, type GroupModeConfig } from './group-mode.js';
import { HELP_TEXT } from '../core/commands.js';

import { createLogger } from '../logger.js';

const log = createLogger('Telegram');
const KNOWN_TELEGRAM_COMMANDS = new Set([
  'status',
  'model',
  'heartbeat',
  'reset',
  'cancel',
  'approve',
  'disapprove',
  'setconv',
  'help',
  'start',
]);

function getTelegramErrorReason(err: unknown): string {
  if (err && typeof err === 'object') {
    const maybeError = err as { description?: string; message?: string };
    if (typeof maybeError.description === 'string' && maybeError.description.trim().length > 0) {
      return maybeError.description;
    }
    if (typeof maybeError.message === 'string' && maybeError.message.trim().length > 0) {
      return maybeError.message;
    }
  }
  return String(err);
}

function shouldFallbackToAudio(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const description = (err as { description?: string }).description;
  if (typeof description !== 'string') return false;
  return description.includes('VOICE_MESSAGES_FORBIDDEN');
}

export interface TelegramConfig {
  token: string;
  dmPolicy?: DmPolicy;           // 'pairing' (default), 'allowlist', or 'open'
  allowedUsers?: number[];       // Telegram user IDs (config allowlist)
  streaming?: boolean;           // Stream responses via progressive message edits (default: false)
  attachmentsDir?: string;
  attachmentsMaxBytes?: number;
  mentionPatterns?: string[];    // Regex patterns for mention detection
  groups?: Record<string, GroupModeConfig>;  // Per-group settings
  agentName?: string;       // For scoping daily limit counters in multi-agent mode
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
  onCommand?: (command: string, chatId?: string, args?: string) => Promise<string | null>;
  
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
   * Apply group gating for a message context.
   * Returns null if the message should be dropped, or message metadata if it should proceed.
   */
  private applyGroupGating(ctx: { chat: { type: string; id: number; title?: string }; from?: { id: number }; message?: { text?: string; entities?: { type: string; offset: number; length: number }[] } }): { isGroup: boolean; groupName?: string; wasMentioned: boolean; isListeningMode?: boolean } | null {
    const chatType = ctx.chat.type;
    const isGroup = chatType === 'group' || chatType === 'supergroup';
    const groupName = isGroup && 'title' in ctx.chat ? ctx.chat.title : undefined;

    if (!isGroup) {
      return { isGroup: false, wasMentioned: false };
    }

    const text = ctx.message?.text || '';
    const botUsername = this.bot.botInfo?.username || '';

    const gatingResult = applyTelegramGroupGating({
      text,
      chatId: String(ctx.chat.id),
      senderId: ctx.from?.id ? String(ctx.from.id) : undefined,
      botUsername,
      entities: ctx.message?.entities?.map(e => ({
        type: e.type,
        offset: e.offset,
        length: e.length,
      })),
      groupsConfig: this.config.groups,
      mentionPatterns: this.config.mentionPatterns,
    });

    if (!gatingResult.shouldProcess) {
      log.info(`Group message filtered: ${gatingResult.reason}`);
      return null;
    }

    // Daily rate limit check (after all other gating so we only count real triggers)
    const chatIdStr = String(ctx.chat.id);
    const senderId = ctx.from?.id ? String(ctx.from.id) : '';
    const limits = resolveDailyLimits(this.config.groups, [chatIdStr]);
    const counterKey = `${this.config.agentName ?? ''}:telegram:${limits.matchedKey ?? chatIdStr}`;
    const limitResult = checkDailyLimit(counterKey, senderId, limits);
    if (!limitResult.allowed) {
      log.info(`Daily limit reached for ${counterKey} (${limitResult.reason})`);
      return null;
    }

    const wasMentioned = gatingResult.wasMentioned ?? false;
    const isListeningMode = gatingResult.mode === 'listen' && !wasMentioned;
    return { isGroup, groupName, wasMentioned, isListeningMode };
  }

  private async checkAccess(userId: string, _username?: string, _firstName?: string): Promise<'allowed' | 'blocked' | 'pairing'> {
    const configAllowlist = this.config.allowedUsers?.map(String);
    return checkDmAccess('telegram', userId, this.config.dmPolicy, configAllowlist);
  }
  
  private setupHandlers(): void {
    // Detect when bot is added/removed from groups (proactive group gating)
    this.bot.on('my_chat_member', async (ctx) => {
      const chatMember = ctx.myChatMember;
      if (!chatMember) return;

      const chatType = chatMember.chat.type;
      if (chatType !== 'group' && chatType !== 'supergroup') return;

      const newStatus = chatMember.new_chat_member.status;
      if (newStatus !== 'member' && newStatus !== 'administrator') return;

      const chatId = String(chatMember.chat.id);
      const fromId = String(chatMember.from.id);
      const dmPolicy = this.config.dmPolicy || 'pairing';

      // No gating when policy is not pairing
      if (dmPolicy !== 'pairing') {
        await approveGroup('telegram', chatId);
        log.info(`Group ${chatId} auto-approved (dmPolicy=${dmPolicy})`);
        return;
      }

      // Check if the user who added the bot is paired
      const configAllowlist = this.config.allowedUsers?.map(String);
      const allowed = await isUserAllowed('telegram', fromId, configAllowlist);

      if (allowed) {
        await approveGroup('telegram', chatId);
        log.info(`Group ${chatId} approved by paired user ${fromId}`);
      } else {
        log.info(`Unpaired user ${fromId} tried to add bot to group ${chatId}, leaving`);
        try {
          await ctx.api.sendMessage(chatId, 'This bot can only be added to groups by paired users.');
          await ctx.api.leaveChat(chatId);
        } catch (err) {
          log.error('Failed to leave group:', err);
        }
      }
    });

    this.bot.command('approve', async (ctx) => {
      if (this.onCommand) {
        const result = await this.onCommand('approve', String(ctx.chat.id));
        if (result) {
          const replyToMessageId =
            'message' in ctx && ctx.message
              ? String(ctx.message.message_id)
              : undefined;
          await this.sendMessage({
            chatId: String(ctx.chat.id),
            text: result,
            replyToMessageId,
          });
        }
      }
    });

    this.bot.command('disapprove', async (ctx) => {
      if (this.onCommand) {
        const args = ctx.match?.trim() || undefined;
        const result = await this.onCommand('disapprove', String(ctx.chat.id), args);
        if (result) {
          const replyToMessageId =
            'message' in ctx && ctx.message
              ? String(ctx.message.message_id)
              : undefined;
          await this.sendMessage({
            chatId: String(ctx.chat.id),
            text: result,
            replyToMessageId,
          });
        }
      }
    });

    // Middleware: Check access based on dmPolicy (bypass for groups)
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      // Group gating: check if group is approved before processing
      const chatType = ctx.chat?.type;
      if (chatType === 'group' || chatType === 'supergroup') {
        const dmPolicy = this.config.dmPolicy || 'pairing';
        if (dmPolicy === 'open' || await isGroupApproved('telegram', String(ctx.chat!.id))) {
          await next();
        }
        // Silently drop messages from unapproved groups
        return;
      }

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
        log.info(`New pairing request from ${userId} (${ctx.from?.username || 'no username'}): ${code}`);
        await ctx.reply(formatPairingMessage(code), { parse_mode: 'Markdown' });
      }
      
      // Don't process the message further
      return;
    });
    
    // Handle /start and /help
    this.bot.command(['start', 'help'], async (ctx) => {
      const replyToMessageId =
        'message' in ctx && ctx.message
          ? String(ctx.message.message_id)
          : undefined;
      await this.sendMessage({
        chatId: String(ctx.chat.id),
        text: HELP_TEXT,
        replyToMessageId,
      });
    });
    
    // Handle /status
    this.bot.command('status', async (ctx) => {
      if (this.onCommand) {
        const result = await this.onCommand('status', String(ctx.chat.id));
        const replyToMessageId =
          'message' in ctx && ctx.message
            ? String(ctx.message.message_id)
            : undefined;
        await this.sendMessage({
          chatId: String(ctx.chat.id),
          text: result || 'No status available',
          replyToMessageId,
        });
      }
    });
    
    // Handle /heartbeat - trigger heartbeat manually (silent - no reply)
    this.bot.command('heartbeat', async (ctx) => {
      if (this.onCommand) {
        await this.onCommand('heartbeat', String(ctx.chat.id));
      }
    });

    // Handle /reset
    this.bot.command('reset', async (ctx) => {
      if (this.onCommand) {
        const result = await this.onCommand('reset', String(ctx.chat.id));
        const replyToMessageId =
          'message' in ctx && ctx.message
            ? String(ctx.message.message_id)
            : undefined;
        await this.sendMessage({
          chatId: String(ctx.chat.id),
          text: result || 'Reset complete',
          replyToMessageId,
        });
      }
    });

    this.bot.command('cancel', async (ctx) => {
      if (this.onCommand) {
        const result = await this.onCommand('cancel', String(ctx.chat.id));
        if (result) {
          const replyToMessageId =
            'message' in ctx && ctx.message
              ? String(ctx.message.message_id)
              : undefined;
          await this.sendMessage({
            chatId: String(ctx.chat.id),
            text: result,
            replyToMessageId,
          });
        }
      }
    });

    // Handle /model [handle]
    this.bot.command('model', async (ctx) => {
      if (this.onCommand) {
        const args = ctx.match?.trim() || undefined;
        const result = await this.onCommand('model', String(ctx.chat.id), args);
        const replyToMessageId =
          'message' in ctx && ctx.message
            ? String(ctx.message.message_id)
            : undefined;
        await this.sendMessage({
          chatId: String(ctx.chat.id),
          text: result || 'No model info available',
          replyToMessageId,
        });
      }
    });

    // Handle /setconv <id>
    this.bot.command('setconv', async (ctx) => {
      if (this.onCommand) {
        const args = ctx.match?.trim() || undefined;
        const result = await this.onCommand('setconv', String(ctx.chat.id), args);
        const replyToMessageId =
          'message' in ctx && ctx.message
            ? String(ctx.message.message_id)
            : undefined;
        await this.sendMessage({
          chatId: String(ctx.chat.id),
          text: result || 'Failed to set conversation',
          replyToMessageId,
        });
      }
    });
    
    // Handle text messages
    this.bot.on('message:text', async (ctx) => {
      const userId = ctx.from?.id;
      const chatId = ctx.chat.id;
      const text = ctx.message.text;

      if (!userId) return;
      if (text.startsWith('/')) {
        const commandToken = text.slice(1).trim().split(/\s+/)[0] || '';
        const commandName = commandToken.toLowerCase().split('@')[0];
        if (!KNOWN_TELEGRAM_COMMANDS.has(commandName)) {
          await this.sendMessage({
            chatId: String(chatId),
            text: `Unknown command: /${commandName || '(empty)'}\nTry /help.`,
            replyToMessageId: String(ctx.message.message_id),
          });
        }
        return;
      }

      // Group gating (runs AFTER pairing middleware)
      const gating = this.applyGroupGating(ctx);
      if (!gating) return; // Filtered by group gating
      const { isGroup, groupName, wasMentioned, isListeningMode } = gating;

      if (this.onMessage) {
        await this.onMessage({
          channel: 'telegram',
          chatId: String(chatId),
          userId: String(userId),
          userName: ctx.from.username || ctx.from.first_name,
          userHandle: ctx.from.username,
          messageId: String(ctx.message.message_id),
          text,
          timestamp: new Date(),
          isGroup,
          groupName,
          wasMentioned,
          isListeningMode,
          formatterHints: this.getFormatterHints(),
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
          formatterHints: this.getFormatterHints(),
        });
      }
    });

    // Handle voice messages (must be registered before generic 'message' handler)
    this.bot.on('message:voice', async (ctx) => {
      const userId = ctx.from?.id;
      const chatId = ctx.chat.id;

      if (!userId) return;

      // Group gating
      const gating = this.applyGroupGating(ctx);
      if (!gating) return;
      const { isGroup, groupName, wasMentioned, isListeningMode } = gating;

      // Check if transcription is configured (config or env)
      const { isTranscriptionConfigured } = await import('../transcription/index.js');
      if (!isTranscriptionConfigured()) {
        await ctx.reply('Voice messages require a transcription API key. See: https://github.com/letta-ai/lettabot#voice');
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
          log.info(`Transcribed voice message: "${result.text.slice(0, 50)}..."`);
          messageText = `[Voice message]: ${result.text}`;
        } else {
          log.error(`Transcription failed: ${result.error}`);
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
            isGroup,
            groupName,
            wasMentioned,
            isListeningMode,
            formatterHints: this.getFormatterHints(),
          });
        }
      } catch (error) {
        log.error('Error processing voice message:', error);
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
            isGroup,
            groupName,
            wasMentioned,
            isListeningMode,
            formatterHints: this.getFormatterHints(),
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

      // Group gating
      const gating = this.applyGroupGating(ctx);
      if (!gating) return;
      const { isGroup, groupName, wasMentioned, isListeningMode } = gating;

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
          isGroup,
          groupName,
          wasMentioned,
          isListeningMode,
          attachments,
          formatterHints: this.getFormatterHints(),
        });
      }
    });
    
    // Error handler
    this.bot.catch((err) => {
      log.error('Bot error:', err);
    });
  }
  
  async start(): Promise<void> {
    if (this.running) return;
    
    // Don't await - bot.start() never resolves (it's a long-polling loop)
    // The onStart callback fires when polling begins
    // Must catch errors: on deploy, the old instance's getUpdates long-poll may still
    // be active, causing a 409 Conflict. grammY retries internally but can throw.
    this.bot.start({
      onStart: (botInfo) => {
        log.info(`Bot started as @${botInfo.username}`);
        log.info(`DM policy: ${this.config.dmPolicy}`);
        this.running = true;
      },
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('terminated by other getUpdates request') || msg.includes('409')) {
        log.error(`getUpdates conflict (likely old instance still polling). Retrying in 5s...`);
        setTimeout(() => {
          this.running = false;
          this.start().catch(e => log.error('Retry failed:', e));
        }, 5000);
      } else {
        log.error('Bot polling error:', err);
      }
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
    
    // Split long messages into chunks (Telegram limit: 4096 chars)
    const chunks = splitMessageText(msg.text, TELEGRAM_SPLIT_THRESHOLD);
    let lastMessageId = '';
    
    for (const chunk of chunks) {
      // Only first chunk replies to the original message
      const replyId = !lastMessageId && msg.replyToMessageId ? Number(msg.replyToMessageId) : undefined;
      
      // If caller specified a parse mode, send directly (skip markdown conversion)
      if (msg.parseMode) {
        try {
          const result = await this.bot.api.sendMessage(msg.chatId, chunk, {
            parse_mode: msg.parseMode as 'MarkdownV2' | 'HTML',
            reply_to_message_id: replyId,
          });
          lastMessageId = String(result.message_id);
          continue;
        } catch (e) {
          log.warn(`${msg.parseMode} send failed, falling back to default:`, e);
          // Fall through to default conversion path
        }
      }

      // Try MarkdownV2 first
      try {
        const formatted = await markdownToTelegramV2(chunk);
        // MarkdownV2 escaping can expand text beyond 4096 - re-split if needed
        if (formatted.length > TELEGRAM_MAX_LENGTH) {
          const subChunks = splitFormattedText(formatted, TELEGRAM_MAX_LENGTH);
          for (const sub of subChunks) {
            const result = await this.bot.api.sendMessage(msg.chatId, sub, {
              parse_mode: 'MarkdownV2',
              reply_to_message_id: replyId,
            });
            lastMessageId = String(result.message_id);
          }
        } else {
          const result = await this.bot.api.sendMessage(msg.chatId, formatted, {
            parse_mode: 'MarkdownV2',
            reply_to_message_id: replyId,
          });
          lastMessageId = String(result.message_id);
        }
      } catch (e) {
        // If MarkdownV2 fails, send raw text (also split if needed)
        log.warn('MarkdownV2 send failed, falling back to raw text:', e);
        const plainChunks = splitFormattedText(chunk, TELEGRAM_MAX_LENGTH);
        for (const plain of plainChunks) {
          const result = await this.bot.api.sendMessage(msg.chatId, plain, {
            reply_to_message_id: replyId,
          });
          lastMessageId = String(result.message_id);
        }
      }
    }
    
    return { messageId: lastMessageId };
  }

  async sendFile(file: OutboundFile): Promise<{ messageId: string }> {
    const input = new InputFile(file.filePath);
    const caption = file.caption || undefined;

    if (file.kind === 'image') {
      const result = await this.bot.api.sendPhoto(file.chatId, input, { caption });
      return { messageId: String(result.message_id) };
    }

    if (file.kind === 'audio') {
      try {
        const result = await this.bot.api.sendVoice(file.chatId, input, { caption });
        return { messageId: String(result.message_id) };
      } catch (err: any) {
        const reason = getTelegramErrorReason(err);
        // Only retry with sendAudio for deterministic voice-policy rejections.
        // For network/timeout errors we rethrow to avoid possible duplicate sends.
        if (!shouldFallbackToAudio(err)) {
          throw err;
        }
        log.warn('sendVoice failed with VOICE_MESSAGES_FORBIDDEN, falling back to sendAudio:', reason);
        try {
          const result = await this.bot.api.sendAudio(file.chatId, new InputFile(file.filePath), { caption });
          return { messageId: String(result.message_id) };
        } catch (fallbackErr: any) {
          const fallbackReason = getTelegramErrorReason(fallbackErr);
          log.error('sendAudio fallback also failed:', fallbackReason);
          throw fallbackErr;
        }
      }
    }

    const result = await this.bot.api.sendDocument(file.chatId, input, { caption });
    return { messageId: String(result.message_id) };
  }
  
  supportsEditing(): boolean {
    return this.config.streaming ?? false;
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    const { markdownToTelegramV2 } = await import('./telegram-format.js');
    try {
      const formatted = await markdownToTelegramV2(text);
      await this.bot.api.editMessageText(chatId, Number(messageId), formatted, { parse_mode: 'MarkdownV2' });
    } catch (e: any) {
      // "message is not modified" means content is already up-to-date -- harmless, don't retry
      if (e?.description?.includes('message is not modified')) return;
      // If MarkdownV2 fails, fall back to plain text (mirrors sendMessage fallback)
      log.warn('MarkdownV2 edit failed, falling back to raw text:', e);
      await this.bot.api.editMessageText(chatId, Number(messageId), text);
    }
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
  
  getDmPolicy(): string {
    return this.config.dmPolicy || 'pairing';
  }

  getFormatterHints() {
    return {
      supportsReactions: true,
      supportsFiles: true,
      formatHint: 'MarkdownV2: *bold* _italic_ `code` [link](url) — NO: headers, tables',
    };
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
      log.warn(`Attachment ${fileName || fileId} exceeds size limit, skipping download.`);
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
      log.info(`Attachment saved to ${target}`);
    } catch (err) {
      log.warn('Failed to download attachment:', err);
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

function resolveTelegramEmoji(input: string): string {
  const resolved = resolveEmoji(input);
  // Strip variation selectors (U+FE0E / U+FE0F). Telegram's reaction API
  // expects bare emoji without them (e.g. ❤ not ❤️).
  return resolved.replace(/[\uFE0E\uFE0F]/g, '');
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

// Telegram message length limits
const TELEGRAM_MAX_LENGTH = 4096;
const TELEGRAM_SPLIT_THRESHOLD = 3800;

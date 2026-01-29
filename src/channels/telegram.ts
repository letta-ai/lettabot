/**
 * Telegram Channel Adapter
 * 
 * Uses grammY for Telegram Bot API.
 * Supports DM pairing for secure access control.
 */

import { Bot } from 'grammy';
import type { ChannelAdapter } from './types.js';
import type { InboundMessage, OutboundMessage } from '../core/types.js';
import type { DmPolicy } from '../pairing/types.js';
import {
  isUserAllowed,
  upsertPairingRequest,
  formatPairingMessage,
} from '../pairing/store.js';

export interface TelegramConfig {
  token: string;
  dmPolicy?: DmPolicy;           // 'pairing' (default), 'allowlist', or 'open'
  allowedUsers?: number[];       // Telegram user IDs (config allowlist)
}

export class TelegramAdapter implements ChannelAdapter {
  readonly id = 'telegram' as const;
  readonly name = 'Telegram';
  
  private bot: Bot;
  private config: TelegramConfig;
  private running = false;
  
  onMessage?: (msg: InboundMessage) => Promise<void>;
  onCommand?: (command: string) => Promise<string | null>;
  
  constructor(config: TelegramConfig) {
    this.config = {
      ...config,
      dmPolicy: config.dmPolicy || 'pairing',  // Default to pairing
    };
    this.bot = new Bot(config.token);
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
    
    // Handle /heartbeat (silent - no reply)
    this.bot.command('heartbeat', async (ctx) => {
      if (this.onCommand) {
        await this.onCommand('heartbeat');
        // No reply - heartbeat runs silently
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
    
    // Error handler
    this.bot.catch((err) => {
      console.error('[Telegram] Bot error:', err);
    });
  }
  
  async start(): Promise<void> {
    if (this.running) return;
    
    await this.bot.start({
      onStart: (botInfo) => {
        console.log(`[Telegram] Bot started as @${botInfo.username}`);
        console.log(`[Telegram] DM policy: ${this.config.dmPolicy}`);
        this.running = true;
      },
    });
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
    const formatted = markdownToTelegramV2(msg.text);
    
    const result = await this.bot.api.sendMessage(msg.chatId, formatted, {
      parse_mode: 'MarkdownV2',
      reply_to_message_id: msg.replyToMessageId ? Number(msg.replyToMessageId) : undefined,
    });
    return { messageId: String(result.message_id) };
  }
  
  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    const { markdownToTelegramV2 } = await import('./telegram-format.js');
    const formatted = markdownToTelegramV2(text);
    await this.bot.api.editMessageText(chatId, Number(messageId), formatted, { parse_mode: 'MarkdownV2' });
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
}

/**
 * Discord Channel Adapter
 *
 * Uses discord.js for Discord API.
 * Supports DM pairing for secure access control.
 */

import type { ChannelAdapter } from './types.js';
import type { InboundMessage, OutboundMessage } from '../core/types.js';
import type { DmPolicy } from '../pairing/types.js';
import { isUserAllowed, upsertPairingRequest } from '../pairing/store.js';

// Dynamic import to avoid requiring Discord deps if not used
let Client: typeof import('discord.js').Client;
let GatewayIntentBits: typeof import('discord.js').GatewayIntentBits;
let Partials: typeof import('discord.js').Partials;

export interface DiscordConfig {
  token: string;
  dmPolicy?: DmPolicy;      // 'pairing' (default), 'allowlist', or 'open'
  allowedUsers?: string[];  // Discord user IDs
}

export class DiscordAdapter implements ChannelAdapter {
  readonly id = 'discord' as const;
  readonly name = 'Discord';

  private client: InstanceType<typeof Client> | null = null;
  private config: DiscordConfig;
  private running = false;

  onMessage?: (msg: InboundMessage) => Promise<void>;
  onCommand?: (command: string) => Promise<string | null>;

  constructor(config: DiscordConfig) {
    this.config = {
      ...config,
      dmPolicy: config.dmPolicy || 'pairing',
    };
  }

  /**
   * Check if a user is authorized based on dmPolicy
   * Returns 'allowed', 'blocked', or 'pairing'
   */
  private async checkAccess(userId: string): Promise<'allowed' | 'blocked' | 'pairing'> {
    const policy = this.config.dmPolicy || 'pairing';

    // Open policy: everyone allowed
    if (policy === 'open') {
      return 'allowed';
    }

    // Check if already allowed (config or store)
    const allowed = await isUserAllowed('discord', userId, this.config.allowedUsers);
    if (allowed) {
      return 'allowed';
    }

    // Allowlist policy: not allowed if not in list
    if (policy === 'allowlist') {
      return 'blocked';
    }

    // Pairing policy: needs pairing
    return 'pairing';
  }

  /**
   * Format pairing message for Discord
   */
  private formatPairingMsg(code: string): string {
    return `Hi! This bot requires pairing.

Your pairing code: **${code}**

Ask the bot owner to approve with:
\`lettabot pairing approve discord ${code}\``;
  }

  private async sendPairingMessage(
    message: import('discord.js').Message,
    text: string
  ): Promise<void> {
    const channel = message.channel;
    const canSend = channel.isTextBased() && 'send' in channel;
    const sendable = canSend
      ? (channel as unknown as { send: (content: string) => Promise<unknown> })
      : null;

    if (!message.guildId) {
      if (sendable) {
        await sendable.send(text);
      }
      return;
    }

    try {
      await message.author.send(text);
    } catch {
      if (sendable) {
        await sendable.send(text);
      }
    }
  }

  async start(): Promise<void> {
    if (this.running) return;

    const discord = await import('discord.js');
    Client = discord.Client;
    GatewayIntentBits = discord.GatewayIntentBits;
    Partials = discord.Partials;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    });

    this.client.on('ready', () => {
      const tag = this.client?.user?.tag || '(unknown)';
      console.log(`[Discord] Bot logged in as ${tag}`);
      console.log(`[Discord] DM policy: ${this.config.dmPolicy}`);
      this.running = true;
    });

    this.client.on('messageCreate', async (message) => {
      if (message.author?.bot) return;

      const content = (message.content || '').trim();
      const userId = message.author?.id;
      if (!userId) return;

      const access = await this.checkAccess(userId);
      if (access === 'blocked') {
        const ch = message.channel;
        if (ch.isTextBased() && 'send' in ch) {
          await (ch as { send: (content: string) => Promise<unknown> }).send(
            "Sorry, you're not authorized to use this bot."
          );
        }
        return;
      }

      if (access === 'pairing') {
        const { code, created } = await upsertPairingRequest('discord', userId, {
          username: message.author.username,
        });

        if (!code) {
          await message.channel.send('Too many pending pairing requests. Please try again later.');
          return;
        }

        if (created) {
          console.log(`[Discord] New pairing request from ${userId} (${message.author.username}): ${code}`);
        }

        await this.sendPairingMessage(message, this.formatPairingMsg(code));
        return;
      }

      if (!content) return;

      if (content.startsWith('/')) {
        const command = content.slice(1).split(/\s+/)[0]?.toLowerCase();
        if (this.onCommand) {
          if (command === 'status') {
            const result = await this.onCommand('status');
            if (result) {
              await message.channel.send(result);
            }
            return;
          }
          if (command === 'heartbeat') {
            await this.onCommand('heartbeat');
            return;
          }
        }
      }

      if (this.onMessage) {
        const isGroup = !!message.guildId;
        const groupName = isGroup && 'name' in message.channel ? message.channel.name : undefined;
        const displayName = message.member?.displayName || message.author.globalName || message.author.username;

        await this.onMessage({
          channel: 'discord',
          chatId: message.channel.id,
          userId,
          userName: displayName,
          userHandle: message.author.username,
          messageId: message.id,
          text: content,
          timestamp: message.createdAt,
          isGroup,
          groupName,
        });
      }
    });

    this.client.on('error', (err) => {
      console.error('[Discord] Client error:', err);
    });

    console.log('[Discord] Connecting...');
    await this.client.login(this.config.token);
  }

  async stop(): Promise<void> {
    if (!this.running || !this.client) return;
    this.client.destroy();
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  async sendMessage(msg: OutboundMessage): Promise<{ messageId: string }> {
    if (!this.client) throw new Error('Discord not started');
    const channel = await this.client.channels.fetch(msg.chatId);
    if (!channel || !channel.isTextBased() || !('send' in channel)) {
      throw new Error(`Discord channel not found or not text-based: ${msg.chatId}`);
    }

    const result = await (channel as { send: (content: string) => Promise<{ id: string }> }).send(msg.text);
    return { messageId: result.id };
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    if (!this.client) throw new Error('Discord not started');
    const channel = await this.client.channels.fetch(chatId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`Discord channel not found or not text-based: ${chatId}`);
    }

    const message = await channel.messages.fetch(messageId);
    const botUserId = this.client.user?.id;
    if (!botUserId || message.author.id !== botUserId) {
      console.warn('[Discord] Cannot edit message not sent by bot');
      return;
    }
    await message.edit(text);
  }

  async sendTypingIndicator(chatId: string): Promise<void> {
    if (!this.client) return;
    try {
      const channel = await this.client.channels.fetch(chatId);
      if (!channel || !channel.isTextBased() || !('sendTyping' in channel)) return;
      await (channel as { sendTyping: () => Promise<void> }).sendTyping();
    } catch {
      // Ignore typing indicator failures
    }
  }

  supportsEditing(): boolean {
    return true;
  }
}

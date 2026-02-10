/**
 * Discord Channel Adapter
 *
 * Uses discord.js for Discord API.
 * Supports DM pairing for secure access control.
 */

import type { ChannelAdapter } from './types.js';
import type { InboundAttachment, InboundMessage, InboundReaction, OutboundFile, OutboundMessage } from '../core/types.js';
import type { DmPolicy } from '../pairing/types.js';
import { isUserAllowed, upsertPairingRequest } from '../pairing/store.js';
import { buildAttachmentPath, downloadToFile } from './attachments.js';
import { HELP_TEXT } from '../core/commands.js';

// Dynamic import to avoid requiring Discord deps if not used
let Client: typeof import('discord.js').Client;
let GatewayIntentBits: typeof import('discord.js').GatewayIntentBits;
let Partials: typeof import('discord.js').Partials;

export interface DiscordConfig {
  token: string;
  dmPolicy?: DmPolicy;      // 'pairing' (default), 'allowlist', or 'open'
  allowedUsers?: string[];  // Discord user IDs
  attachmentsDir?: string;
  attachmentsMaxBytes?: number;
  groups?: Record<string, { requireMention?: boolean }>;  // Per-guild/channel settings
}

export class DiscordAdapter implements ChannelAdapter {
  readonly id = 'discord' as const;
  readonly name = 'Discord';

  private client: InstanceType<typeof Client> | null = null;
  private config: DiscordConfig;
  private running = false;
  private attachmentsDir?: string;
  private attachmentsMaxBytes?: number;

  onMessage?: (msg: InboundMessage) => Promise<void>;
  onCommand?: (command: string) => Promise<string | null>;

  constructor(config: DiscordConfig) {
    this.config = {
      ...config,
      dmPolicy: config.dmPolicy || 'pairing',
    };
    this.attachmentsDir = config.attachmentsDir;
    this.attachmentsMaxBytes = config.attachmentsMaxBytes;
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
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageReactions,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
    });

    this.client.once('clientReady', () => {
      const tag = this.client?.user?.tag || '(unknown)';
      console.log(`[Discord] Bot logged in as ${tag}`);
      console.log(`[Discord] DM policy: ${this.config.dmPolicy}`);
      this.running = true;
    });

    this.client.on('messageCreate', async (message) => {
      if (message.author?.bot) return;

      let content = (message.content || '').trim();
      const userId = message.author?.id;
      if (!userId) return;
      
      // Handle audio attachments
      const audioAttachment = message.attachments.find(a => a.contentType?.startsWith('audio/'));
      if (audioAttachment?.url) {
        try {
          const { loadConfig } = await import('../config/index.js');
          const config = loadConfig();
          if (!config.transcription?.apiKey && !process.env.OPENAI_API_KEY) {
            await message.reply('Voice messages require OpenAI API key for transcription. See: https://github.com/letta-ai/lettabot#voice-messages');
          } else {
            // Download audio
            const response = await fetch(audioAttachment.url);
            const buffer = Buffer.from(await response.arrayBuffer());
            
            const { transcribeAudio } = await import('../transcription/index.js');
            const ext = audioAttachment.contentType?.split('/')[1] || 'mp3';
            const result = await transcribeAudio(buffer, audioAttachment.name || `audio.${ext}`);
            
            if (result.success && result.text) {
              console.log(`[Discord] Transcribed audio: "${result.text.slice(0, 50)}..."`);
              content = (content ? content + '\n' : '') + `[Voice message]: ${result.text}`;
            } else {
              console.error(`[Discord] Transcription failed: ${result.error}`);
              content = (content ? content + '\n' : '') + `[Voice message - transcription failed: ${result.error}]`;
            }
          }
        } catch (error) {
          console.error('[Discord] Error transcribing audio:', error);
          content = (content ? content + '\n' : '') + `[Voice message - error: ${error instanceof Error ? error.message : 'unknown error'}]`;
        }
      }

      // Bypass pairing for guild (group) messages
      if (!message.guildId) {
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
      }

      const attachments = await this.collectAttachments(message.attachments, message.channel.id);
      if (!content && attachments.length === 0) return;

      if (content.startsWith('/')) {
        const command = content.slice(1).split(/\s+/)[0]?.toLowerCase();
        if (command === 'help' || command === 'start') {
          await message.channel.send(HELP_TEXT);
          return;
        }
        if (this.onCommand) {
          if (command === 'status') {
            const result = await this.onCommand('status');
            if (result) {
              await message.channel.send(result);
            }
            return;
          }
          if (command === 'heartbeat') {
            const result = await this.onCommand('heartbeat');
            if (result) {
              await message.channel.send(result);
            }
            return;
          }
        }
      }

      if (this.onMessage) {
        const isGroup = !!message.guildId;
        const groupName = isGroup && 'name' in message.channel ? message.channel.name : undefined;
        const displayName = message.member?.displayName || message.author.globalName || message.author.username;
        const wasMentioned = isGroup && !!this.client?.user && message.mentions.has(this.client.user);

        // Group gating: config-based allowlist + mention requirement
        if (isGroup && this.config.groups) {
          const groups = this.config.groups;
          const chatId = message.channel.id;
          const serverId = message.guildId;
          const allowlistEnabled = Object.keys(groups).length > 0;

          if (allowlistEnabled) {
            const hasWildcard = Object.hasOwn(groups, '*');
            const hasSpecific = Object.hasOwn(groups, chatId)
              || (serverId && Object.hasOwn(groups, serverId));
            if (!hasWildcard && !hasSpecific) {
              console.log(`[Discord] Group ${chatId} not in allowlist, ignoring`);
              return;
            }
          }

          const groupConfig = groups[chatId]
            ?? (serverId ? groups[serverId] : undefined)
            ?? groups['*'];
          const requireMention = groupConfig?.requireMention ?? true;

          if (requireMention && !wasMentioned) {
            return; // Mention required but not mentioned -- silent drop
          }
        }

        await this.onMessage({
          channel: 'discord',
          chatId: message.channel.id,
          userId,
          userName: displayName,
          userHandle: message.author.username,
          messageId: message.id,
          text: content || '',
          timestamp: message.createdAt,
          isGroup,
          groupName,
          serverId: message.guildId || undefined,
          wasMentioned,
          attachments,
        });
      }
    });

    this.client.on('error', (err) => {
      console.error('[Discord] Client error:', err);
    });

    this.client.on('messageReactionAdd', async (reaction, user) => {
      await this.handleReactionEvent(reaction, user, 'added');
    });

    this.client.on('messageReactionRemove', async (reaction, user) => {
      await this.handleReactionEvent(reaction, user, 'removed');
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

  async addReaction(chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.client) throw new Error('Discord not started');
    const channel = await this.client.channels.fetch(chatId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`Discord channel not found or not text-based: ${chatId}`);
    }

    const textChannel = channel as { messages: { fetch: (id: string) => Promise<{ react: (input: string) => Promise<unknown> }> } };
    const message = await textChannel.messages.fetch(messageId);
    const resolved = resolveDiscordEmoji(emoji);
    await message.react(resolved);
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

  getDmPolicy(): string {
    return this.config.dmPolicy || 'pairing';
  }

  supportsEditing(): boolean {
    return true;
  }

  private async handleReactionEvent(
    reaction: import('discord.js').MessageReaction | import('discord.js').PartialMessageReaction,
    user: import('discord.js').User | import('discord.js').PartialUser,
    action: InboundReaction['action']
  ): Promise<void> {
    if ('bot' in user && user.bot) return;

    try {
      if (reaction.partial) {
        await reaction.fetch();
      }
      if (reaction.message.partial) {
        await reaction.message.fetch();
      }
    } catch (err) {
      console.warn('[Discord] Failed to fetch reaction/message:', err);
    }

    const message = reaction.message;
    const channelId = message.channel?.id;
    if (!channelId) return;

    const access = await this.checkAccess(user.id);
    if (access !== 'allowed') {
      return;
    }

    const emoji = reaction.emoji.id
      ? reaction.emoji.toString()
      : (reaction.emoji.name || reaction.emoji.toString());
    if (!emoji) return;

    const isGroup = !!message.guildId;
    const groupName = isGroup && 'name' in message.channel
      ? message.channel.name || undefined
      : undefined;
    const userId = user.id;
    const userName = 'username' in user ? (user.username ?? undefined) : undefined;
    const displayName = message.guild?.members.cache.get(userId)?.displayName
      || userName
      || userId;

    this.onMessage?.({
      channel: 'discord',
      chatId: channelId,
      userId: userId,
      userName: displayName,
      userHandle: userName || userId,
      messageId: message.id,
      text: '',
      timestamp: new Date(),
      isGroup,
      groupName,
      serverId: message.guildId || undefined,
      reaction: {
        emoji,
        messageId: message.id,
        action,
      },
    }).catch((err) => {
      console.error('[Discord] Error handling reaction:', err);
    });
  }

  private async collectAttachments(attachments: unknown, channelId: string): Promise<InboundAttachment[]> {
    if (!attachments || typeof attachments !== 'object') return [];
    const list = Array.from((attachments as { values: () => Iterable<DiscordAttachment> }).values?.() || []);
    if (list.length === 0) return [];
    const results: InboundAttachment[] = [];
    for (const attachment of list) {
      const name = attachment.name || attachment.id || 'attachment';
      const entry: InboundAttachment = {
        id: attachment.id,
        name,
        mimeType: attachment.contentType || undefined,
        size: attachment.size,
        kind: attachment.contentType?.startsWith('image/') ? 'image' : 'file',
        url: attachment.url,
      };
      if (this.attachmentsDir && attachment.url) {
        if (this.attachmentsMaxBytes === 0) {
          results.push(entry);
          continue;
        }
        if (this.attachmentsMaxBytes && attachment.size && attachment.size > this.attachmentsMaxBytes) {
          console.warn(`[Discord] Attachment ${name} exceeds size limit, skipping download.`);
          results.push(entry);
          continue;
        }
        const target = buildAttachmentPath(this.attachmentsDir, 'discord', channelId, name);
        try {
          await downloadToFile(attachment.url, target);
          entry.localPath = target;
          console.log(`[Discord] Attachment saved to ${target}`);
        } catch (err) {
          console.warn('[Discord] Failed to download attachment:', err);
        }
      }
      results.push(entry);
    }
    return results;
  }
}

const DISCORD_EMOJI_ALIAS_TO_UNICODE: Record<string, string> = {
  eyes: '\u{1F440}',
  thumbsup: '\u{1F44D}',
  thumbs_up: '\u{1F44D}',
  '+1': '\u{1F44D}',
  heart: '\u2764\uFE0F',
  fire: '\u{1F525}',
  smile: '\u{1F604}',
  laughing: '\u{1F606}',
  tada: '\u{1F389}',
  clap: '\u{1F44F}',
  ok_hand: '\u{1F44C}',
};

function resolveDiscordEmoji(input: string): string {
  const aliasMatch = input.match(/^:([^:]+):$/);
  const alias = aliasMatch ? aliasMatch[1] : null;
  if (alias && DISCORD_EMOJI_ALIAS_TO_UNICODE[alias]) {
    return DISCORD_EMOJI_ALIAS_TO_UNICODE[alias];
  }
  if (DISCORD_EMOJI_ALIAS_TO_UNICODE[input]) {
    return DISCORD_EMOJI_ALIAS_TO_UNICODE[input];
  }
  return input;
}

type DiscordAttachment = {
  id?: string;
  name?: string | null;
  contentType?: string | null;
  size?: number;
  url?: string;
};

/**
 * Discord Channel Adapter
 *
 * Uses discord.js for Discord API.
 * Supports DM pairing for secure access control.
 */

import type { ChannelAdapter } from './types.js';
import type { InboundAttachment, InboundMessage, InboundReaction, OutboundFile, OutboundMessage } from '../core/types.js';
import type { DmPolicy } from '../pairing/types.js';
import { upsertPairingRequest } from '../pairing/store.js';
import { checkDmAccess } from './shared/access-control.js';
import { resolveEmoji } from './shared/emoji.js';
import { splitMessageText } from './shared/message-splitter.js';
import { buildAttachmentPath, downloadToFile } from './attachments.js';
import { HELP_TEXT } from '../core/commands.js';
import { isGroupAllowed, isGroupUserAllowed, resolveGroupMode, resolveReceiveBotMessages, resolveDailyLimits, checkDailyLimit, type GroupModeConfig } from './group-mode.js';
import { basename } from 'node:path';

import { createLogger } from '../logger.js';

const log = createLogger('Discord');
const DISCORD_ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 15000;
// Dynamic import to avoid requiring Discord deps if not used
let Client: typeof import('discord.js').Client;
let GatewayIntentBits: typeof import('discord.js').GatewayIntentBits;
let Partials: typeof import('discord.js').Partials;

export interface DiscordConfig {
  token: string;
  dmPolicy?: DmPolicy;      // 'pairing' (default), 'allowlist', or 'open'
  allowedUsers?: string[];  // Discord user IDs
  streaming?: boolean;      // Stream responses via progressive message edits (default: false)
  attachmentsDir?: string;
  attachmentsMaxBytes?: number;
  groups?: Record<string, GroupModeConfig>;  // Per-guild/channel settings
  agentName?: string;       // For scoping daily limit counters in multi-agent mode
  ignoreBotReactions?: boolean;   // Ignore all bot reactions (default: true). Set false for multi-bot setups.
}

export function shouldProcessDiscordBotMessage(params: {
  isFromBot: boolean;
  isGroup: boolean;
  authorId?: string;
  selfUserId?: string;
  groups?: Record<string, GroupModeConfig>;
  keys: string[];
}): boolean {
  if (!params.isFromBot) return true;
  if (!params.isGroup) return false;
  if (params.selfUserId && params.authorId === params.selfUserId) return false;
  return resolveReceiveBotMessages(params.groups, params.keys);
}

export type DiscordThreadMode = 'any' | 'thread-only';

export function buildDiscordGroupKeys(params: {
  chatId: string;
  serverId?: string | null;
  parentChatId?: string | null;
}): string[] {
  const keys: string[] = [];
  const add = (value?: string | null) => {
    if (!value) return;
    if (keys.includes(value)) return;
    keys.push(value);
  };

  add(params.chatId);
  add(params.parentChatId);
  add(params.serverId);
  return keys;
}

export function resolveDiscordThreadMode(
  groups: Record<string, GroupModeConfig> | undefined,
  keys: string[],
  fallback: DiscordThreadMode = 'any',
): DiscordThreadMode {
  if (groups) {
    for (const key of keys) {
      const mode = groups[key]?.threadMode;
      if (mode === 'any' || mode === 'thread-only') return mode;
    }
    const wildcard = groups['*']?.threadMode;
    if (wildcard === 'any' || wildcard === 'thread-only') return wildcard;
  }
  return fallback;
}

export function resolveDiscordAutoCreateThreadOnMention(
  groups: Record<string, GroupModeConfig> | undefined,
  keys: string[],
): boolean {
  if (groups) {
    for (const key of keys) {
      if (groups[key]?.autoCreateThreadOnMention !== undefined) {
        return !!groups[key].autoCreateThreadOnMention;
      }
    }
    if (groups['*']?.autoCreateThreadOnMention !== undefined) {
      return !!groups['*'].autoCreateThreadOnMention;
    }
  }
  return false;
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
  onCommand?: (command: string, chatId?: string, args?: string, forcePerChat?: boolean) => Promise<string | null>;

  constructor(config: DiscordConfig) {
    this.config = {
      ...config,
      dmPolicy: config.dmPolicy || 'pairing',
    };
    this.attachmentsDir = config.attachmentsDir;
    this.attachmentsMaxBytes = config.attachmentsMaxBytes;
  }

  private async checkAccess(userId: string): Promise<'allowed' | 'blocked' | 'pairing'> {
    return checkDmAccess('discord', userId, this.config.dmPolicy, this.config.allowedUsers);
  }

  private async createThreadForMention(
    message: import('discord.js').Message,
    seedText: string,
  ): Promise<{ id: string; name?: string } | null> {
    const normalized = seedText.replace(/<@!?\d+>/g, '').trim();
    const firstLine = normalized.split('\n')[0]?.trim();
    const baseName = firstLine || `${message.author.username} question`;
    const threadName = baseName.slice(0, 100);

    try {
      const thread = await message.startThread({
        name: threadName,
        reason: 'lettabot thread-only mention trigger',
      });
      return { id: thread.id, name: thread.name };
    } catch (error) {
      log.warn('Failed to create thread for mention:', error instanceof Error ? error.message : error);
      return null;
    }
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
      log.info(`Bot logged in as ${tag}`);
      log.info(`DM policy: ${this.config.dmPolicy}`);
      this.running = true;
    });

    this.client.on('messageCreate', async (message) => {
      const isFromBot = !!message.author?.bot;
      const isGroup = !!message.guildId;
      const chatId = message.channel.id;
      const channelWithThread = message.channel as { isThread?: () => boolean; parentId?: string | null };
      const isThreadMessage = typeof channelWithThread.isThread === 'function' && channelWithThread.isThread();
      const parentChannelId = isThreadMessage ? channelWithThread.parentId ?? undefined : undefined;
      const keys = buildDiscordGroupKeys({
        chatId,
        parentChatId: parentChannelId,
        serverId: message.guildId,
      });
      const selfUserId = this.client?.user?.id;
      const wasMentioned = isGroup && !!this.client?.user && message.mentions.has(this.client.user);

      if (!shouldProcessDiscordBotMessage({
        isFromBot,
        isGroup,
        authorId: message.author?.id,
        selfUserId,
        groups: this.config.groups,
        keys,
      })) return;

      let content = (message.content || '').trim();
      const userId = message.author?.id;
      if (!userId) return;

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
            log.info(`New pairing request from ${userId} (${message.author.username}): ${code}`);
          }

          await this.sendPairingMessage(message, this.formatPairingMsg(code));
          return;
        }
      }

      if (content.startsWith('/')) {
        const parts = content.slice(1).split(/\s+/);
        const command = parts[0]?.toLowerCase();
        const cmdArgs = parts.slice(1).join(' ') || undefined;
        const isHelpCommand = command === 'help' || command === 'start';
        const isManagedCommand =
          command === 'status' ||
          command === 'reset' ||
          command === 'heartbeat' ||
          command === 'cancel' ||
          command === 'approve' ||
          command === 'disapprove' ||
          command === 'model' ||
          command === 'setconv';

        // Unknown commands (or managed commands without onCommand) fall through to agent processing.
        if (isHelpCommand || (isManagedCommand && this.onCommand)) {
          if (isGroup && this.config.groups && !isHelpCommand) {
            if (!isGroupAllowed(this.config.groups, keys)) {
              log.info(`Group ${chatId} not in allowlist, ignoring command`);
              return;
            }
            if (!isGroupUserAllowed(this.config.groups, keys, userId)) {
              return;
            }
            const mode = resolveGroupMode(this.config.groups, keys, 'open');
            if (mode === 'disabled') {
              return;
            }
            if (mode === 'mention-only' && !wasMentioned) {
              return;
            }
          }

          let commandChatId = message.channel.id;
          let commandSendTarget: { send: (content: string) => Promise<unknown> } | null =
            message.channel.isTextBased() && 'send' in message.channel
              ? (message.channel as { send: (content: string) => Promise<unknown> })
              : null;

          let commandForcePerChat = false;
          if (isGroup && this.config.groups) {
            const threadMode = resolveDiscordThreadMode(this.config.groups, keys);
            commandForcePerChat = threadMode === 'thread-only' || isThreadMessage;
            if (commandForcePerChat && !isThreadMessage) {
              const shouldCreateThread =
                wasMentioned && resolveDiscordAutoCreateThreadOnMention(this.config.groups, keys);
              if (!shouldCreateThread) {
                return;
              }

              // Keep command behavior aligned with normal message gating in thread-only mode.
              const createdThread = await this.createThreadForMention(message, content);
              if (!createdThread) {
                return;
              }

              if (!this.client) {
                return;
              }
              const threadChannel = await this.client.channels.fetch(createdThread.id);
              if (!threadChannel || !threadChannel.isTextBased() || !('send' in threadChannel)) {
                return;
              }

              commandChatId = createdThread.id;
              commandSendTarget = threadChannel as { send: (content: string) => Promise<unknown> };
            }
          }

          if (isHelpCommand) {
            if (!commandSendTarget) return;
            await commandSendTarget.send(HELP_TEXT);
            return;
          }

          if (this.onCommand && isManagedCommand) {
            const result = await this.onCommand(command, commandChatId, cmdArgs, commandForcePerChat || undefined);
            if (result) {
              if (!commandSendTarget) return;
              await commandSendTarget.send(result);
            }
            return;
          }
        }
      }

      if (this.onMessage) {
        const groupName = isGroup && 'name' in message.channel ? message.channel.name : undefined;
        const displayName = message.member?.displayName || message.author.globalName || message.author.username;
        let isListeningMode = false;
        let effectiveChatId = message.channel.id;
        let effectiveGroupName = groupName;
        let isThreadOnly = false;

        // Group gating: config-based allowlist + mode
        if (isGroup && this.config.groups) {
          if (!isGroupAllowed(this.config.groups, keys)) {
            log.info(`Group ${chatId} not in allowlist, ignoring`);
            return;
          }

          if (!isGroupUserAllowed(this.config.groups, keys, userId)) {
            return; // User not in group allowedUsers -- silent drop
          }

          const mode = resolveGroupMode(this.config.groups, keys, 'open');
          if (mode === 'disabled') {
            return; // Groups disabled for this channel -- silent drop
          }
          if (mode === 'mention-only' && !wasMentioned) {
            return; // Mention required but not mentioned -- silent drop
          }
          isListeningMode = mode === 'listen' && !wasMentioned;

          // Daily rate limit check before side-effectful actions (like thread creation)
          // so over-limit mentions don't create empty threads.
          const limits = resolveDailyLimits(this.config.groups, keys);
          const counterScope = limits.matchedKey ?? chatId;
          const counterKey = `${this.config.agentName ?? ''}:discord:${counterScope}`;
          const limitResult = checkDailyLimit(counterKey, userId, limits);
          if (!limitResult.allowed) {
            log.info(`Daily limit reached for ${counterKey} (${limitResult.reason})`);
            return;
          }

          const threadMode = resolveDiscordThreadMode(this.config.groups, keys);
          isThreadOnly = threadMode === 'thread-only';
          if (isThreadOnly && !isThreadMessage) {
            const shouldCreateThread =
              wasMentioned && resolveDiscordAutoCreateThreadOnMention(this.config.groups, keys);
            if (!shouldCreateThread) {
              return; // Thread-only mode drops non-thread messages unless auto-create is enabled on @mention
            }

            const createdThread = await this.createThreadForMention(message, content);
            if (!createdThread) {
              return;
            }
            effectiveChatId = createdThread.id;
            effectiveGroupName = createdThread.name || effectiveGroupName;
          }
        }

        const audioAttachment = message.attachments.find((a) => a.contentType?.startsWith('audio/'));
        if (audioAttachment?.url) {
          try {
            const { isTranscriptionConfigured } = await import('../transcription/index.js');
            if (!isTranscriptionConfigured()) {
              await message.reply('Voice messages require a transcription API key. See: https://github.com/letta-ai/lettabot#voice');
            } else {
              const response = await fetch(audioAttachment.url);
              const buffer = Buffer.from(await response.arrayBuffer());

              const { transcribeAudio } = await import('../transcription/index.js');
              const ext = audioAttachment.contentType?.split('/')[1] || 'mp3';
              const result = await transcribeAudio(buffer, audioAttachment.name || `audio.${ext}`);

              if (result.success && result.text) {
                log.info(`Transcribed audio: "${result.text.slice(0, 50)}..."`);
                content = (content ? content + '\n' : '') + `[Voice message]: ${result.text}`;
              } else {
                log.error(`Transcription failed: ${result.error}`);
                content = (content ? content + '\n' : '') + `[Voice message - transcription failed: ${result.error}]`;
              }
            }
          } catch (error) {
            log.error('Error transcribing audio:', error);
            content = (content ? content + '\n' : '') + `[Voice message - error: ${error instanceof Error ? error.message : 'unknown error'}]`;
          }
        }

        const attachments = await this.collectAttachments(message.attachments, message.channel.id);
        if (!content && attachments.length === 0) return;

        await this.onMessage({
          channel: 'discord',
          chatId: effectiveChatId,
          userId,
          userName: displayName,
          userHandle: message.author.username,
          messageId: message.id,
          text: content || '',
          timestamp: message.createdAt,
          isGroup,
          groupName: effectiveGroupName,
          serverId: message.guildId || undefined,
          wasMentioned,
          isListeningMode,
          threadId: isThreadMessage ? effectiveChatId : undefined,
          forcePerChat: (isThreadOnly || isThreadMessage) || undefined,
          attachments,
          formatterHints: this.getFormatterHints(),
        });
      }
    });

    this.client.on('error', (err) => {
      log.error('Client error:', err);
    });

    this.client.on('messageReactionAdd', async (reaction, user) => {
      await this.handleReactionEvent(reaction, user, 'added');
    });

    this.client.on('messageReactionRemove', async (reaction, user) => {
      await this.handleReactionEvent(reaction, user, 'removed');
    });

    log.info('Connecting...');
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
    const targetChannelId = msg.threadId || msg.chatId;
    const channel = await this.client.channels.fetch(targetChannelId);
    if (!channel || !channel.isTextBased() || !('send' in channel)) {
      throw new Error(`Discord channel not found or not text-based: ${targetChannelId}`);
    }

    const sendable = channel as { send: (content: string) => Promise<{ id: string }> };
    const chunks = splitMessageText(msg.text, DISCORD_SPLIT_THRESHOLD);
    let lastMessageId = '';
    for (const chunk of chunks) {
      const result = await sendable.send(chunk);
      lastMessageId = result.id;
    }
    return { messageId: lastMessageId };
  }

  async sendFile(file: OutboundFile): Promise<{ messageId: string }> {
    if (!this.client) throw new Error('Discord not started');
    const targetChannelId = file.threadId || file.chatId;
    const channel = await this.client.channels.fetch(targetChannelId);
    if (!channel || !channel.isTextBased() || !('send' in channel)) {
      throw new Error(`Discord channel not found or not text-based: ${targetChannelId}`);
    }

    const payload = {
      content: file.caption || undefined,
      files: [
        { attachment: file.filePath, name: basename(file.filePath) },
      ],
    };
    const result = await (channel as { send: (options: typeof payload) => Promise<{ id: string }> }).send(payload);
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
      log.warn('Cannot edit message not sent by bot');
      return;
    }

    // Discord edit limit is 2000 chars -- truncate if needed (edits can't split)
    const truncated = text.length > DISCORD_MAX_LENGTH
      ? text.slice(0, DISCORD_MAX_LENGTH - 1) + '\u2026'
      : text;
    await message.edit(truncated);
  }

  async addReaction(chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.client) throw new Error('Discord not started');
    const channel = await this.client.channels.fetch(chatId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`Discord channel not found or not text-based: ${chatId}`);
    }

    const textChannel = channel as { messages: { fetch: (id: string) => Promise<{ react: (input: string) => Promise<unknown> }> } };
    const message = await textChannel.messages.fetch(messageId);
    const resolved = resolveEmoji(emoji);
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

  getFormatterHints() {
    return {
      supportsReactions: true,
      supportsFiles: true,
      formatHint: 'Discord markdown: **bold** *italic* `code` [links](url) ```code blocks``` — supports headers',
    };
  }

  supportsEditing(): boolean {
    return this.config.streaming ?? false;
  }

  private async handleReactionEvent(
    reaction: import('discord.js').MessageReaction | import('discord.js').PartialMessageReaction,
    user: import('discord.js').User | import('discord.js').PartialUser,
    action: InboundReaction['action']
  ): Promise<void> {
    // By default ignore all bot reactions; when ignoreBotReactions is false,
    // only ignore self-reactions (allows multi-bot setups)
    const ignoreBots = this.config.ignoreBotReactions ?? true;
    if (ignoreBots && 'bot' in user && user.bot) return;
    if (!ignoreBots && user.id === this.client?.user?.id) return;

    try {
      if (reaction.partial) {
        await reaction.fetch();
      }
      if (reaction.message.partial) {
        await reaction.message.fetch();
      }
    } catch (err) {
      log.warn('Failed to fetch reaction/message:', err);
    }

    const message = reaction.message;
    const channelId = message.channel?.id;
    if (!channelId) return;

    const isGroup = !!message.guildId;
    const channelWithThread = message.channel as { isThread?: () => boolean; parentId?: string | null };
    const isThreadMessage = typeof channelWithThread.isThread === 'function' && channelWithThread.isThread();
    const parentChannelId = isThreadMessage ? channelWithThread.parentId ?? undefined : undefined;
    const keys = buildDiscordGroupKeys({
      chatId: channelId,
      parentChatId: parentChannelId,
      serverId: message.guildId,
    });

    // DM policy should only gate DMs, not guild reactions.
    if (!isGroup) {
      const access = await this.checkAccess(user.id);
      if (access !== 'allowed') {
        return;
      }
    }

    let isListeningMode = false;
    let reactionForcePerChat = false;
    if (isGroup && this.config.groups) {
      if (!isGroupAllowed(this.config.groups, keys)) {
        log.info(`Reaction group ${channelId} not in allowlist, ignoring`);
        return;
      }

      if (!isGroupUserAllowed(this.config.groups, keys, user.id)) {
        return;
      }

      const mode = resolveGroupMode(this.config.groups, keys, 'open');
      if (mode === 'disabled' || mode === 'mention-only') {
        return;
      }
      isListeningMode = mode === 'listen';

      const threadMode = resolveDiscordThreadMode(this.config.groups, keys);
      if (threadMode === 'thread-only' && !isThreadMessage) {
        return;
      }
      reactionForcePerChat = threadMode === 'thread-only';

      const limits = resolveDailyLimits(this.config.groups, keys);
      const counterScope = limits.matchedKey ?? channelId;
      const counterKey = `${this.config.agentName ?? ''}:discord:${counterScope}`;
      const limitResult = checkDailyLimit(counterKey, user.id, limits);
      if (!limitResult.allowed) {
        log.info(`Daily limit reached for ${counterKey} (${limitResult.reason})`);
        return;
      }
    }

    const emoji = reaction.emoji.id
      ? reaction.emoji.toString()
      : (reaction.emoji.name || reaction.emoji.toString());
    if (!emoji) return;

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
      isListeningMode,
      forcePerChat: (reactionForcePerChat || isThreadMessage) || undefined,
      reaction: {
        emoji,
        messageId: message.id,
        action,
      },
      formatterHints: this.getFormatterHints(),
    }).catch((err) => {
      log.error('Error handling reaction:', err);
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
          log.warn(`Attachment ${name} exceeds size limit, skipping download.`);
          results.push(entry);
          continue;
        }
        const target = buildAttachmentPath(this.attachmentsDir, 'discord', channelId, name);
        try {
          await downloadToFile(attachment.url, target, {
            timeoutMs: DISCORD_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
          });
          entry.localPath = target;
          log.info(`Attachment saved to ${target}`);
        } catch (err) {
          log.warn('Failed to download attachment:', err);
        }
      }
      results.push(entry);
    }
    return results;
  }
}

// Discord message length limits
const DISCORD_MAX_LENGTH = 2000;
const DISCORD_SPLIT_THRESHOLD = 1900;

type DiscordAttachment = {
  id?: string;
  name?: string | null;
  contentType?: string | null;
  size?: number;
  url?: string;
};

/**
 * Slack Channel Adapter
 * 
 * Uses @slack/bolt for Slack API with Socket Mode.
 */

import type { ChannelAdapter } from './types.js';
import type { InboundAttachment, InboundMessage, InboundReaction, OutboundFile, OutboundMessage } from '../core/types.js';
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { buildAttachmentPath, downloadToFile } from './attachments.js';

// Dynamic import to avoid requiring Slack deps if not used
let App: typeof import('@slack/bolt').App;

export interface SlackConfig {
  botToken: string;       // xoxb-...
  appToken: string;       // xapp-... (for Socket Mode)
  allowedUsers?: string[]; // Slack user IDs (e.g., U01234567)
  attachmentsDir?: string;
  attachmentsMaxBytes?: number;
}

export class SlackAdapter implements ChannelAdapter {
  readonly id = 'slack' as const;
  readonly name = 'Slack';
  
  private app: InstanceType<typeof App> | null = null;
  private config: SlackConfig;
  private running = false;
  private attachmentsDir?: string;
  private attachmentsMaxBytes?: number;
  
  onMessage?: (msg: InboundMessage) => Promise<void>;
  
  constructor(config: SlackConfig) {
    this.config = config;
    this.attachmentsDir = config.attachmentsDir;
    this.attachmentsMaxBytes = config.attachmentsMaxBytes;
  }
  
  async start(): Promise<void> {
    if (this.running) return;
    
    // Dynamic import
    const bolt = await import('@slack/bolt');
    App = bolt.App;
    
    this.app = new App({
      token: this.config.botToken,
      appToken: this.config.appToken,
      socketMode: true,
    });
    
    // Handle messages
    this.app.message(async ({ message, say, client }) => {
      // Type guard for regular messages
      if (message.subtype !== undefined) return;
      if (!('user' in message) || !('text' in message)) return;
      
      const userId = message.user;
      let text = message.text || '';
      const channelId = message.channel;
      const threadTs = message.thread_ts || message.ts; // Reply in thread if applicable
      
      // Handle audio file attachments
      const files = (message as any).files as Array<{ mimetype?: string; url_private_download?: string; name?: string }> | undefined;
      const audioFile = files?.find(f => f.mimetype?.startsWith('audio/'));
      if (audioFile?.url_private_download) {
        try {
          const { loadConfig } = await import('../config/index.js');
          const config = loadConfig();
          if (!config.transcription?.apiKey && !process.env.OPENAI_API_KEY) {
            await say('Voice messages require OpenAI API key for transcription. See: https://github.com/letta-ai/lettabot#voice-messages');
          } else {
            // Download file (requires bot token for auth)
            const response = await fetch(audioFile.url_private_download, {
              headers: { 'Authorization': `Bearer ${this.config.botToken}` }
            });
            const buffer = Buffer.from(await response.arrayBuffer());
            
            const { transcribeAudio } = await import('../transcription/index.js');
            const ext = audioFile.mimetype?.split('/')[1] || 'mp3';
            const transcript = await transcribeAudio(buffer, audioFile.name || `audio.${ext}`);
            
            console.log(`[Slack] Transcribed audio: "${transcript.slice(0, 50)}..."`);
            text = (text ? text + '\n' : '') + `[Voice message]: ${transcript}`;
          }
        } catch (error) {
          console.error('[Slack] Error transcribing audio:', error);
        }
      }
      
      // Check allowed users
      if (this.config.allowedUsers && this.config.allowedUsers.length > 0) {
        if (!this.config.allowedUsers.includes(userId)) {
          await say("Sorry, you're not authorized to use this bot.");
          return;
        }
      }
      
      if (this.onMessage) {
        const attachments = await this.collectAttachments(
          (message as { files?: SlackFile[] }).files,
          channelId
        );
        // Determine if this is a group/channel (not a DM)
        // DMs have channel IDs starting with 'D', channels start with 'C'
        const isGroup = !channelId.startsWith('D');
        
        await this.onMessage({
          channel: 'slack',
          chatId: channelId,
          userId: userId || '',
          userHandle: userId || '',  // Slack user ID serves as handle
          messageId: message.ts || undefined,
          text: text || '',
          timestamp: new Date(Number(message.ts) * 1000),
          threadId: threadTs,
          isGroup,
          groupName: isGroup ? channelId : undefined,  // Would need conversations.info for name
          attachments,
        });
      }
    });
    
    // Handle app mentions (@bot)
    this.app.event('app_mention', async ({ event }) => {
      const userId = event.user || '';
      const text = (event.text || '').replace(/<@[A-Z0-9]+>/g, '').trim(); // Remove mention
      const channelId = event.channel;
      const threadTs = event.thread_ts || event.ts; // Reply in thread, or start new thread from the mention
      
      if (this.config.allowedUsers && this.config.allowedUsers.length > 0) {
        if (!userId || !this.config.allowedUsers.includes(userId)) {
          // Can't use say() in app_mention event the same way
          return;
        }
      }
      
      if (this.onMessage) {
        const attachments = await this.collectAttachments(
          (event as { files?: SlackFile[] }).files,
          channelId
        );
        // app_mention is always in a channel (group)
        const isGroup = !channelId.startsWith('D');
        
        await this.onMessage({
          channel: 'slack',
          chatId: channelId,
          userId: userId || '',
          userHandle: userId || '',  // Slack user ID serves as handle
          messageId: event.ts || undefined,
          text: text || '',
          timestamp: new Date(Number(event.ts) * 1000),
          threadId: threadTs,
          isGroup,
          groupName: isGroup ? channelId : undefined,
          attachments,
        });
      }
    });

    this.app.event('reaction_added', async ({ event }) => {
      await this.handleReactionEvent(event as SlackReactionEvent, 'added');
    });

    this.app.event('reaction_removed', async ({ event }) => {
      await this.handleReactionEvent(event as SlackReactionEvent, 'removed');
    });
    
    console.log('[Slack] Connecting via Socket Mode...');
    await this.app.start();
    console.log('[Slack] Bot started in Socket Mode');
    this.running = true;
  }
  
  async stop(): Promise<void> {
    if (!this.running || !this.app) return;
    await this.app.stop();
    this.running = false;
  }
  
  isRunning(): boolean {
    return this.running;
  }
  
  async sendMessage(msg: OutboundMessage): Promise<{ messageId: string }> {
    if (!this.app) throw new Error('Slack not started');
    
    const result = await this.app.client.chat.postMessage({
      channel: msg.chatId,
      text: msg.text,
      thread_ts: msg.threadId,
    });
    
    return { messageId: result.ts || '' };
  }

  async sendFile(file: OutboundFile): Promise<{ messageId: string }> {
    if (!this.app) throw new Error('Slack not started');

    const basePayload = {
      channels: file.chatId,
      file: createReadStream(file.filePath),
      filename: basename(file.filePath),
      initial_comment: file.caption,
    };
    const result = file.threadId
      ? await this.app.client.files.upload({ ...basePayload, thread_ts: file.threadId })
      : await this.app.client.files.upload(basePayload);

    const shares = (result.file as { shares?: Record<string, Record<string, { ts?: string }[]>> } | undefined)?.shares;
    const ts = shares?.public?.[file.chatId]?.[0]?.ts
      || shares?.private?.[file.chatId]?.[0]?.ts
      || '';

    return { messageId: ts };
  }
  
  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    if (!this.app) throw new Error('Slack not started');
    
    await this.app.client.chat.update({
      channel: chatId,
      ts: messageId,
      text,
    });
  }

  async addReaction(chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.app) throw new Error('Slack not started');
    const name = resolveSlackEmojiName(emoji);
    if (!name) {
      throw new Error('Unknown emoji alias for Slack');
    }
    await this.app.client.reactions.add({
      channel: chatId,
      name,
      timestamp: messageId,
    });
  }
  
  async sendTypingIndicator(_chatId: string): Promise<void> {
    // Slack doesn't have a typing indicator API for bots
    // This is a no-op
  }

  private async handleReactionEvent(
    event: SlackReactionEvent,
    action: InboundReaction['action']
  ): Promise<void> {
    const userId = event.user || '';
    if (!userId) return;

    if (this.config.allowedUsers && this.config.allowedUsers.length > 0) {
      if (!this.config.allowedUsers.includes(userId)) {
        return;
      }
    }

    const channelId = event.item?.channel;
    const messageId = event.item?.ts;
    if (!channelId || !messageId) return;

    const emoji = event.reaction ? `:${event.reaction}:` : '';
    if (!emoji) return;

    const isGroup = !channelId.startsWith('D');
    const eventTs = Number(event.event_ts);
    const timestamp = Number.isFinite(eventTs) ? new Date(eventTs * 1000) : new Date();

    await this.onMessage?.({
      channel: 'slack',
      chatId: channelId,
      userId,
      userHandle: userId,
      messageId,
      text: '',
      timestamp,
      isGroup,
      groupName: isGroup ? channelId : undefined,
      reaction: {
        emoji,
        messageId,
        action,
      },
    });
  }

  private async collectAttachments(
    files: SlackFile[] | undefined,
    channelId: string
  ): Promise<InboundAttachment[]> {
    return collectSlackAttachments(
      this.attachmentsDir,
      this.attachmentsMaxBytes,
      channelId,
      files,
      this.config.botToken
    );
  }
}

type SlackFile = {
  id?: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
};

type SlackReactionEvent = {
  user?: string;
  reaction?: string;
  item?: {
    channel?: string;
    ts?: string;
  };
  event_ts?: string;
};

async function maybeDownloadSlackFile(
  attachmentsDir: string | undefined,
  attachmentsMaxBytes: number | undefined,
  channelId: string,
  file: SlackFile,
  token: string
): Promise<InboundAttachment> {
  const name = file.name || file.id || 'attachment';
  const url = file.url_private_download || file.url_private;
  const attachment: InboundAttachment = {
    id: file.id,
    name,
    mimeType: file.mimetype,
    size: file.size,
    kind: file.mimetype?.startsWith('image/') ? 'image' : 'file',
    url,
  };
  if (!attachmentsDir) {
    return attachment;
  }
  if (attachmentsMaxBytes === 0) {
    return attachment;
  }
  if (attachmentsMaxBytes && file.size && file.size > attachmentsMaxBytes) {
    console.warn(`[Slack] Attachment ${name} exceeds size limit, skipping download.`);
    return attachment;
  }
  if (!url) {
    return attachment;
  }
  const target = buildAttachmentPath(attachmentsDir, 'slack', channelId, name);
  try {
    await downloadToFile(url, target, { Authorization: `Bearer ${token}` });
    attachment.localPath = target;
    console.log(`[Slack] Attachment saved to ${target}`);
  } catch (err) {
    console.warn('[Slack] Failed to download attachment:', err);
  }
  return attachment;
}

async function collectSlackAttachments(
  attachmentsDir: string | undefined,
  attachmentsMaxBytes: number | undefined,
  channelId: string,
  files: SlackFile[] | undefined,
  token: string
): Promise<InboundAttachment[]> {
  if (!files || files.length === 0) return [];
  const attachments: InboundAttachment[] = [];
  for (const file of files) {
    attachments.push(await maybeDownloadSlackFile(attachmentsDir, attachmentsMaxBytes, channelId, file, token));
  }
  return attachments;
}

const EMOJI_ALIAS_TO_UNICODE: Record<string, string> = {
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

const UNICODE_TO_ALIAS = new Map<string, string>(
  Object.entries(EMOJI_ALIAS_TO_UNICODE).map(([name, value]) => [value, name])
);

function resolveSlackEmojiName(input: string): string | null {
  const aliasMatch = input.match(/^:([^:]+):$/);
  if (aliasMatch) {
    return aliasMatch[1];
  }
  if (EMOJI_ALIAS_TO_UNICODE[input]) {
    return input;
  }
  return UNICODE_TO_ALIAS.get(input) || null;
}

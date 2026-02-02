/**
 * WhatsApp Channel Adapter
 * 
 * Uses @whiskeysockets/baileys for WhatsApp Web API.
 * Supports DM pairing for secure access control.
 */

import type { ChannelAdapter } from './types.js';
import type { InboundAttachment, InboundMessage, OutboundFile, OutboundMessage } from '../core/types.js';
import type { DmPolicy } from '../pairing/types.js';
import {
  isUserAllowed,
  upsertPairingRequest,
  formatPairingMessage,
} from '../pairing/store.js';
import { normalizePhoneForStorage } from '../utils/phone.js';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import qrcode from 'qrcode-terminal';
import { buildAttachmentPath, writeStreamToFile } from './attachments.js';

export interface WhatsAppConfig {
  sessionPath?: string;  // Where to store auth state
  dmPolicy?: DmPolicy;   // 'pairing' (default), 'allowlist', or 'open'
  allowedUsers?: string[]; // Phone numbers (e.g., +15551234567)
  selfChatMode?: boolean; // Respond to "message yourself" (for personal number use)
  attachmentsDir?: string;
  attachmentsMaxBytes?: number;
}

export class WhatsAppAdapter implements ChannelAdapter {
  readonly id = 'whatsapp' as const;
  readonly name = 'WhatsApp';
  
  private sock: any = null;
  private config: WhatsAppConfig;
  private running = false;
  private sessionPath: string;
  private attachmentsDir?: string;
  private attachmentsMaxBytes?: number;
  private downloadContentFromMessage?: (message: any, type: string) => Promise<AsyncIterable<Uint8Array>>;
  private myJid: string = '';  // Bot's own JID (for selfChatMode)
  private myNumber: string = ''; // Bot's phone number
  private selfChatLid: string = ''; // Self-chat LID (for selfChatMode conversion)
  private lidToJid: Map<string, string> = new Map(); // Map LID -> real JID for replies
  private sentMessageIds: Set<string> = new Set(); // Track messages we've sent
  private processedMessageIds: Set<string> = new Set(); // Dedupe incoming messages
  
  onMessage?: (msg: InboundMessage) => Promise<void>;
  
  constructor(config: WhatsAppConfig) {
    this.config = {
      ...config,
      dmPolicy: config.dmPolicy || 'pairing',  // Default to pairing
    };
    this.sessionPath = resolve(config.sessionPath || './data/whatsapp-session');
    this.attachmentsDir = config.attachmentsDir;
    this.attachmentsMaxBytes = config.attachmentsMaxBytes;
  }
  
  /**
   * Check if a user is authorized based on dmPolicy
   * Returns 'allowed', 'blocked', or 'pairing'
   */
  private async checkAccess(userId: string, userName?: string): Promise<'allowed' | 'blocked' | 'pairing'> {
    const policy = this.config.dmPolicy || 'pairing';
    // userId is already normalized with + prefix by normalizePhoneForStorage

    // Open policy: everyone allowed
    if (policy === 'open') {
      return 'allowed';
    }

    // Self-chat mode: always allow self
    if (this.config.selfChatMode && userId === this.myNumber) {
      return 'allowed';
    }

    // Check if already allowed (config or store)
    const allowed = await isUserAllowed('whatsapp', userId, this.config.allowedUsers);
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
   * Format pairing message for WhatsApp
   */
  private formatPairingMsg(code: string): string {
    return `Hi! This bot requires pairing.

Your pairing code: *${code}*

Ask the bot owner to approve with:
\`lettabot pairing approve whatsapp ${code}\``;
  }
  
  async start(): Promise<void> {
    if (this.running) return;
    
    // Suppress noisy Baileys console output (session crypto details, errors)
    const originalLog = console.log;
    const originalError = console.error;
    const suppressPatterns = [
      'Closing session',
      'SessionEntry',
      'Session error',
      'Bad MAC',
      'Failed to decrypt',
      'Closing open session',
      'prekey bundle',
    ];
    const shouldSuppress = (msg: string) => suppressPatterns.some(p => msg.includes(p));
    
    console.log = (...args: any[]) => {
      const msg = args[0]?.toString?.() || '';
      if (shouldSuppress(msg)) return;
      originalLog.apply(console, args);
    };
    console.error = (...args: any[]) => {
      const msg = args[0]?.toString?.() || '';
      if (shouldSuppress(msg)) return;
      originalError.apply(console, args);
    };
    
    // Check for competing WhatsApp bots
    try {
      const { execSync } = await import('node:child_process');
      const procs = execSync('ps aux | grep -i "clawdbot\\|moltbot" | grep -v grep', { encoding: 'utf-8' });
      if (procs.trim()) {
        console.warn('[WhatsApp] ⚠️  Warning: clawdbot/moltbot is running and may compete for WhatsApp connection.');
        console.warn('[WhatsApp] Stop it with: launchctl unload ~/Library/LaunchAgents/com.clawdbot.gateway.plist');
      }
    } catch {} // No competing bots found
    
    // Ensure session directory exists
    mkdirSync(this.sessionPath, { recursive: true });
    
    // Dynamic import
    const { 
      default: makeWASocket, 
      useMultiFileAuthState, 
      DisconnectReason,
      fetchLatestBaileysVersion,
      makeCacheableSignalKeyStore,
      downloadMediaMessage,
      downloadContentFromMessage,
    } = await import('@whiskeysockets/baileys');
    
    // Load auth state
    const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath);
    
    // Get latest WA Web version
    const { version } = await fetchLatestBaileysVersion();
    console.log('[WhatsApp] Using WA Web version:', version.join('.'));
    
    // Silent logger to suppress noisy baileys logs
    const silentLogger = {
      level: 'silent',
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
      child: () => silentLogger,
    };
    
    // Create socket with proper config (matching moltbot)
    this.sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, silentLogger as any),
      },
      version,
      browser: ['LettaBot', 'Desktop', '1.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      logger: silentLogger as any,
    });
    this.downloadContentFromMessage = downloadContentFromMessage as unknown as (
      message: any,
      type: string
    ) => Promise<AsyncIterable<Uint8Array>>;
    
    // Save credentials when updated
    this.sock.ev.on('creds.update', saveCreds);
    
    // Handle connection updates
    this.sock.ev.on('connection.update', (update: any) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        console.log('[WhatsApp] Scan this QR code in WhatsApp → Linked Devices:');
        qrcode.generate(qr, { small: true });
      }
      
      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error as any)?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('[WhatsApp] Connection closed, reconnecting:', shouldReconnect);
        
        if (shouldReconnect) {
          this.start();  // Reconnect
        } else {
          this.running = false;
        }
      } else if (connection === 'open') {
        // Capture our own JID for selfChatMode
        this.myJid = this.sock.user?.id || '';
        this.myNumber = this.myJid.replace(/@.*/, '').replace(/:\d+/, '');
        console.log(`[WhatsApp] Connected as ${this.myNumber}`);
        this.running = true;
      }
    });
    
    // Handle incoming messages
    this.sock.ev.on('messages.upsert', async ({ messages, type }: any) => {
      
      for (const m of messages) {
        const messageId = m.key.id || '';
        
        // Skip messages we sent (prevents loop in selfChatMode)
        if (this.sentMessageIds.has(messageId)) {
          this.sentMessageIds.delete(messageId); // Clean up
          continue;
        }
        
        // Skip duplicate messages (WhatsApp retry mechanism)
        if (this.processedMessageIds.has(messageId)) {
          continue;
        }
        this.processedMessageIds.add(messageId);
        setTimeout(() => this.processedMessageIds.delete(messageId), 60000);
        
        const remoteJid = m.key.remoteJid || '';
        
        // Detect self-chat: message from ourselves to ourselves
        const senderPn = (m.key as any).senderPn as string | undefined;
        const isSelfChat = m.key.fromMe && (
          remoteJid === this.myJid || 
          remoteJid.replace(/@.*/, '') === this.myNumber ||
          // In selfChatMode, fromMe + LID = self-chat (don't require !senderPn as it can vary)
          (this.config.selfChatMode && remoteJid.includes('@lid'))
        );
        
        // Track self-chat LID for reply conversion
        if (isSelfChat && remoteJid.includes('@lid')) {
          this.selfChatLid = remoteJid;
        }
        
        // Skip own messages (unless selfChatMode enabled for self-chat)
        if (m.key.fromMe) {
          if (!(this.config.selfChatMode && isSelfChat)) {
            continue;
          }
        }
        
        // Capture LID → real JID mapping from senderPn (for replying to LID contacts)
        if (remoteJid.includes('@lid') && (m.key as any).senderPn) {
          this.lidToJid.set(remoteJid, (m.key as any).senderPn);
        }
        
        // Unwrap message content (handles ephemeral/viewOnce messages)
        const messageContent = this.unwrapMessageContent(m.message);
        let text = messageContent?.conversation ||
                   messageContent?.extendedTextMessage?.text ||
                   '';
        
        // Handle audio/voice messages - transcribe if configured
        const audioMessage = messageContent?.audioMessage;
        if (audioMessage) {
          try {
            const { loadConfig } = await import('../config/index.js');
            const config = loadConfig();
            if (!config.transcription?.apiKey && !process.env.OPENAI_API_KEY) {
              await this.sock!.sendMessage(remoteJid, { 
                text: 'Voice messages require OpenAI API key for transcription. See: https://github.com/letta-ai/lettabot#voice-messages' 
              });
              continue;
            }
            
            // Download audio
            const buffer = await downloadMediaMessage(m, 'buffer', {});
            
            // Transcribe
            const { transcribeAudio } = await import('../transcription/index.js');
            const transcript = await transcribeAudio(buffer as Buffer, 'voice.ogg');
            
            console.log(`[WhatsApp] Transcribed voice message: "${transcript.slice(0, 50)}..."`);
            text = `[Voice message]: ${transcript}`;
          } catch (error) {
            console.error('[WhatsApp] Error transcribing voice message:', error);
            continue;
          }
        }
        
        // Detect other media (images, videos, documents)
        const preview = this.extractMediaPreview(messageContent);
        const resolvedText = text || preview.caption || '';
        
        if (!resolvedText && !preview.hasMedia) continue;
        
        const userId = normalizePhoneForStorage(remoteJid);
        const isGroup = remoteJid.endsWith('@g.us');
        const pushName = m.pushName;
        
        // Check access control (for DMs only, groups are open, self-chat always allowed)
        if (!isGroup && !isSelfChat) {
          // CRITICAL: If selfChatMode is enabled, ONLY respond to self-chat messages
          // Silently ignore all non-self messages to prevent bot from messaging other people
          if (this.config.selfChatMode) {
            continue;
          }
          
          const access = await this.checkAccess(userId, pushName);
          
          if (access === 'blocked') {
            await this.sock.sendMessage(remoteJid, { text: "Sorry, you're not authorized to use this bot." });
            continue;
          }
          
          if (access === 'pairing') {
            // Create pairing request
            const result = await upsertPairingRequest('whatsapp', userId, pushName);
            
            if (!result) {
              await this.sock.sendMessage(remoteJid, { 
                text: "Too many pending pairing requests. Please try again later." 
              });
              continue;
            }
            
            const { code, created } = result;
            
            // Send pairing message on first contact
            if (created) {
              console.log(`[WhatsApp] New pairing request from ${userId}: ${code}`);
              await this.sock.sendMessage(remoteJid, { text: this.formatPairingMsg(code) });
            }
            continue;
          }
        }
        
        if (this.onMessage) {
          const attachments = preview.hasMedia
            ? (await this.collectAttachments(messageContent, remoteJid, messageId)).attachments
            : [];
          const finalText = text || preview.caption || '';
          await this.onMessage({
            channel: 'whatsapp',
            chatId: remoteJid,
            userId,
            userName: pushName || undefined,
            messageId: m.key?.id || undefined,
            text: finalText,
            timestamp: new Date(m.messageTimestamp * 1000),
            isGroup,
            // Group name would require additional API call to get chat metadata
            // For now, we don't have it readily available from the message
            attachments,
          });
        }
      }
    });
  }
  
  async stop(): Promise<void> {
    if (!this.running || !this.sock) return;
    await this.sock.logout();
    this.running = false;
  }
  
  isRunning(): boolean {
    return this.running;
  }
  
  async sendMessage(msg: OutboundMessage): Promise<{ messageId: string }> {
    if (!this.sock) throw new Error('WhatsApp not connected');

    const targetJid = this.resolveTargetJid(msg.chatId);
    
    try {
      const result = await this.sock.sendMessage(targetJid, { text: msg.text });
      const messageId = result?.key?.id || '';
      
      // Track sent message to avoid processing it as incoming (selfChatMode loop prevention)
      if (messageId) {
        this.sentMessageIds.add(messageId);
        // Clean up old IDs after 60 seconds
        setTimeout(() => this.sentMessageIds.delete(messageId), 60000);
      }
      
      return { messageId };
    } catch (error) {
      console.error(`[WhatsApp] sendMessage error:`, error);
      throw error;
    }
  }

  async sendFile(file: OutboundFile): Promise<{ messageId: string }> {
    if (!this.sock) throw new Error('WhatsApp not connected');

    const targetJid = this.resolveTargetJid(file.chatId);
    const caption = file.caption || undefined;
    const fileName = basename(file.filePath);
    const payload = file.kind === 'image'
      ? { image: { url: file.filePath }, caption }
      : { document: { url: file.filePath }, caption, fileName };

    const result = await this.sock.sendMessage(targetJid, payload);
    const messageId = result?.key?.id || '';
    if (messageId) {
      this.sentMessageIds.add(messageId);
      setTimeout(() => this.sentMessageIds.delete(messageId), 60000);
    }
    return { messageId };
  }

  async addReaction(_chatId: string, _messageId: string, _emoji: string): Promise<void> {
    // WhatsApp reactions via Baileys are not supported here yet.
  }
  
  supportsEditing(): boolean {
    return false;
  }
  
  async editMessage(_chatId: string, _messageId: string, _text: string): Promise<void> {
    // WhatsApp doesn't support editing messages - no-op
  }
  
  async sendTypingIndicator(chatId: string): Promise<void> {
    if (!this.sock) return;
    await this.sock.sendPresenceUpdate('composing', chatId);
  }

  private unwrapMessageContent(message: any): any {
    if (!message) return null;
    if (message.ephemeralMessage?.message) return message.ephemeralMessage.message;
    if (message.viewOnceMessage?.message) return message.viewOnceMessage.message;
    if (message.viewOnceMessageV2?.message) return message.viewOnceMessageV2.message;
    return message;
  }

  private extractMediaPreview(messageContent: any): { hasMedia: boolean; caption?: string } {
    if (!messageContent) return { hasMedia: false };
    const mediaMessage = messageContent.imageMessage
      || messageContent.videoMessage
      || messageContent.audioMessage
      || messageContent.documentMessage
      || messageContent.stickerMessage;
    if (!mediaMessage) return { hasMedia: false };
    return { hasMedia: true, caption: mediaMessage.caption as string | undefined };
  }

  private async collectAttachments(
    messageContent: any,
    chatId: string,
    messageId: string
  ): Promise<{ attachments: InboundAttachment[]; caption?: string }> {
    const attachments: InboundAttachment[] = [];
    if (!messageContent) return { attachments };
    if (!this.downloadContentFromMessage) return { attachments };

    let mediaMessage: any;
    let mediaType: 'image' | 'video' | 'audio' | 'document' | 'sticker' | null = null;
    let kind: InboundAttachment['kind'] = 'file';

    if (messageContent.imageMessage) {
      mediaMessage = messageContent.imageMessage;
      mediaType = 'image';
      kind = 'image';
    } else if (messageContent.videoMessage) {
      mediaMessage = messageContent.videoMessage;
      mediaType = 'video';
      kind = 'video';
    } else if (messageContent.audioMessage) {
      mediaMessage = messageContent.audioMessage;
      mediaType = 'audio';
      kind = 'audio';
    } else if (messageContent.documentMessage) {
      mediaMessage = messageContent.documentMessage;
      mediaType = 'document';
      kind = 'file';
    } else if (messageContent.stickerMessage) {
      mediaMessage = messageContent.stickerMessage;
      mediaType = 'sticker';
      kind = 'image';
    }

    if (!mediaMessage || !mediaType) return { attachments };

    const mimeType = mediaMessage.mimetype as string | undefined;
    const fileLength = mediaMessage.fileLength;
    const size = typeof fileLength === 'number'
      ? fileLength
      : typeof fileLength?.toNumber === 'function'
        ? fileLength.toNumber()
        : undefined;
    const ext = extensionFromMime(mimeType);
    const defaultName = `whatsapp-${messageId}.${ext}`;
    const name = mediaMessage.fileName || defaultName;

    const attachment: InboundAttachment = {
      name,
      mimeType,
      size,
      kind,
    };

    if (this.attachmentsDir) {
      if (this.attachmentsMaxBytes === 0) {
        attachments.push(attachment);
        const caption = mediaMessage.caption as string | undefined;
        return { attachments, caption };
      }
      if (this.attachmentsMaxBytes && size && size > this.attachmentsMaxBytes) {
        console.warn(`[WhatsApp] Attachment ${name} exceeds size limit, skipping download.`);
        attachments.push(attachment);
        const caption = mediaMessage.caption as string | undefined;
        return { attachments, caption };
      }
      const target = buildAttachmentPath(this.attachmentsDir, 'whatsapp', chatId, name);
      try {
        const stream = await this.downloadContentFromMessage(mediaMessage, mediaType);
        await writeStreamToFile(stream, target);
        attachment.localPath = target;
        console.log(`[WhatsApp] Attachment saved to ${target}`);
      } catch (err) {
        console.warn('[WhatsApp] Failed to download attachment:', err);
      }
    }

    attachments.push(attachment);
    const caption = mediaMessage.caption as string | undefined;
    return { attachments, caption };
  }

  private resolveTargetJid(chatId: string): string {
    let targetJid = chatId;
    if (targetJid.includes('@lid')) {
      if (targetJid === this.selfChatLid && this.myNumber) {
        targetJid = `${this.myNumber}@s.whatsapp.net`;
      } else if (this.lidToJid.has(targetJid)) {
        targetJid = this.lidToJid.get(targetJid)!;
      } else {
        console.error(`[WhatsApp] Cannot send to unknown LID: ${targetJid}`);
        throw new Error('Cannot send to unknown LID - no mapping found');
      }
    }
    return targetJid;
  }
}

function extensionFromMime(mimeType?: string): string {
  if (!mimeType) return 'bin';
  const clean = mimeType.split(';')[0] || '';
  const parts = clean.split('/');
  if (parts.length < 2) return 'bin';
  const ext = parts[1].trim();
  return ext || 'bin';
}

/**
 * WhatsApp Channel Adapter
 * 
 * Uses @whiskeysockets/baileys for WhatsApp Web API.
 * Supports DM pairing for secure access control.
 */

import type { ChannelAdapter } from './types.js';
import type { InboundMessage, OutboundMessage } from '../core/types.js';
import type { DmPolicy } from '../pairing/types.js';
import {
  isUserAllowed,
  upsertPairingRequest,
  formatPairingMessage,
} from '../pairing/store.js';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import qrcode from 'qrcode-terminal';

export interface WhatsAppConfig {
  sessionPath?: string;  // Where to store auth state
  dmPolicy?: DmPolicy;   // 'pairing' (default), 'allowlist', or 'open'
  allowedUsers?: string[]; // Phone numbers (e.g., +15551234567)
  selfChatMode?: boolean; // Respond to "message yourself" (for personal number use)
}

export class WhatsAppAdapter implements ChannelAdapter {
  readonly id = 'whatsapp' as const;
  readonly name = 'WhatsApp';
  
  private sock: any = null;
  private config: WhatsAppConfig;
  private running = false;
  private sessionPath: string;
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
  }
  
  /**
   * Check if a user is authorized based on dmPolicy
   * Returns 'allowed', 'blocked', or 'pairing'
   */
  private async checkAccess(userId: string, userName?: string): Promise<'allowed' | 'blocked' | 'pairing'> {
    const policy = this.config.dmPolicy || 'pairing';
    const phone = userId.startsWith('+') ? userId : `+${userId}`;
    
    // Open policy: everyone allowed
    if (policy === 'open') {
      return 'allowed';
    }
    
    // Self-chat mode: always allow self
    if (this.config.selfChatMode && userId === this.myNumber) {
      return 'allowed';
    }
    
    // Check if already allowed (config or store)
    const allowed = await isUserAllowed('whatsapp', phone, this.config.allowedUsers);
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
        // For self-chat, senderPn is undefined, so we detect by: fromMe + LID + selfChatMode
        const senderPn = (m.key as any).senderPn as string | undefined;
        const isSelfChat = m.key.fromMe && (
          remoteJid === this.myJid || 
          remoteJid.replace(/@.*/, '') === this.myNumber ||
          // In selfChatMode, fromMe + LID (with no senderPn) = self-chat
          (this.config.selfChatMode && remoteJid.includes('@lid') && !senderPn)
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
        
        // Get message text
        const text = m.message?.conversation || 
                     m.message?.extendedTextMessage?.text ||
                     '';
        
        if (!text) continue;
        
        const userId = remoteJid.replace('@s.whatsapp.net', '').replace('@g.us', '');
        const isGroup = remoteJid.endsWith('@g.us');
        const pushName = m.pushName;
        
        // Check access control (for DMs only, groups are open)
        if (!isGroup) {
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
          await this.onMessage({
            channel: 'whatsapp',
            chatId: remoteJid,
            userId,
            userName: pushName || undefined,
            messageId: m.key?.id || undefined,
            text,
            timestamp: new Date(m.messageTimestamp * 1000),
            isGroup,
            // Group name would require additional API call to get chat metadata
            // For now, we don't have it readily available from the message
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
    
    // Convert LID to proper JID for sending
    let targetJid = msg.chatId;
    if (targetJid.includes('@lid')) {
      if (targetJid === this.selfChatLid && this.myNumber) {
        // Self-chat LID -> our own number
        targetJid = `${this.myNumber}@s.whatsapp.net`;
      } else if (this.lidToJid.has(targetJid)) {
        // Friend LID -> their real JID from senderPn
        targetJid = this.lidToJid.get(targetJid)!;
      }
      // If no mapping, keep as-is and hope baileys handles it
    }
    
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
}

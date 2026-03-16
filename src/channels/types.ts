/**
 * Channel Adapter Interface
 * 
 * Each channel (Telegram, Slack, Discord, WhatsApp, Signal) implements this interface.
 */

import type { InboundMessage, OutboundMessage, OutboundFile, FormatterHints } from '../core/types.js';
import type { ChannelId } from './setup.js';

/**
 * Channel adapter - implement this for each messaging platform
 */
export interface ChannelAdapter {
  readonly id: ChannelId;
  readonly name: string;
  
  // Lifecycle
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  
  // Messaging
  sendMessage(msg: OutboundMessage): Promise<{ messageId: string }>;
  editMessage(chatId: string, messageId: string, text: string, htmlPrefix?: string): Promise<void>;
  sendTypingIndicator(chatId: string): Promise<void>;
  stopTypingIndicator?(chatId: string): Promise<void>;

  // Capabilities (optional)
  supportsEditing?(): boolean;
  sendFile?(file: OutboundFile): Promise<{ messageId: string }>;
  sendAudio?(chatId: string, text: string): Promise<void>;
  addReaction?(chatId: string, messageId: string, emoji: string): Promise<void>;
  removeReaction?(chatId: string, messageId: string, emoji: string): Promise<void>;
  /** Called after a bot message is sent (for TTS mapping, etc.) */
  onMessageSent?(chatId: string, messageId: string, stepId?: string): void;
  /** Store text for TTS regeneration on 🎤 reaction */
  storeAudioMessage?(messageId: string, conversationId: string, roomId: string, text: string): void;
  getDmPolicy?(): string;
  getFormatterHints(): FormatterHints;
  
  // Event handlers (set by bot core)
  onMessage?: (msg: InboundMessage) => Promise<void>;
  onCommand?: (command: string, chatId?: string, args?: string, forcePerChat?: boolean) => Promise<string | null>;
}

/**
 * Typing heartbeat helper - keeps "typing..." indicator active
 */
export class TypingHeartbeat {
  private interval: NodeJS.Timeout | null = null;
  private adapter: ChannelAdapter | null = null;
  private chatId: string | null = null;
  
  start(adapter: ChannelAdapter, chatId: string): void {
    this.stop();
    this.adapter = adapter;
    this.chatId = chatId;
    
    const sendTyping = () => {
      this.adapter?.sendTypingIndicator(this.chatId!).catch(() => {});
    };
    
    sendTyping();
    this.interval = setInterval(sendTyping, 4000); // Most platforms expire typing after 5s
  }
  
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.adapter = null;
    this.chatId = null;
  }
}

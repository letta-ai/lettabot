/**
 * Mock Channel Adapter for E2E Testing
 * 
 * Captures messages sent by the bot and allows simulating inbound messages.
 */

import type { ChannelAdapter } from '../channels/types.js';
import type { InboundMessage, OutboundMessage } from '../core/types.js';
import { parseCommand, HELP_TEXT } from '../core/commands.js';

export class MockChannelAdapter implements ChannelAdapter {
  readonly id = 'mock' as const;
  readonly name = 'Mock (Testing)';
  
  private running = false;
  private sentMessages: OutboundMessage[] = [];
  private responseResolvers: Array<(msg: OutboundMessage) => void> = [];
  
  onMessage?: (msg: InboundMessage) => Promise<void>;
  onCommand?: (command: string) => Promise<string | null>;
  
  async start(): Promise<void> {
    this.running = true;
  }
  
  async stop(): Promise<void> {
    this.running = false;
  }
  
  isRunning(): boolean {
    return this.running;
  }
  
  async sendMessage(msg: OutboundMessage): Promise<{ messageId: string }> {
    const messageId = `mock-${Date.now()}`;
    this.sentMessages.push(msg);
    
    // Resolve any waiting promises
    const resolver = this.responseResolvers.shift();
    if (resolver) {
      resolver(msg);
    }
    
    return { messageId };
  }
  
  async editMessage(_chatId: string, _messageId: string, _text: string): Promise<void> {
    // No-op for mock
  }
  
  async sendTypingIndicator(_chatId: string): Promise<void> {
    // No-op for mock
  }
  
  supportsEditing(): boolean {
    return false; // Disable streaming edits for simpler testing
  }
  
  /**
   * Simulate an inbound message and wait for response
   */
  async simulateMessage(
    text: string,
    options: {
      userId?: string;
      chatId?: string;
      userName?: string;
    } = {}
  ): Promise<string> {
    if (!this.onMessage) {
      throw new Error('No message handler registered');
    }
    
    const chatId = options.chatId || 'test-chat-123';
    
    // Handle slash commands locally (like real channels do)
    const command = parseCommand(text);
    if (command) {
      if (command === 'help' || command === 'start') {
        return HELP_TEXT;
      } else if (this.onCommand) {
        const result = await this.onCommand(command);
        return result || '(No response)';
      }
      return '(Command not handled)';
    }
    
    // Create promise that resolves when bot sends response
    const responsePromise = new Promise<OutboundMessage>((resolve) => {
      this.responseResolvers.push(resolve);
    });
    
    // Send the inbound message
    const inbound: InboundMessage = {
      channel: 'mock',
      chatId,
      userId: options.userId || 'test-user-456',
      userName: options.userName || 'Test User',
      text,
      timestamp: new Date(),
    };
    
    // Don't await - let it process async
    this.onMessage(inbound).catch(err => {
      console.error('[MockChannel] Error processing message:', err);
    });
    
    // Wait for response with timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Response timeout (60s)')), 60000);
    });
    
    const response = await Promise.race([responsePromise, timeoutPromise]);
    return response.text;
  }
  
  /**
   * Get all sent messages (for assertions)
   */
  getSentMessages(): OutboundMessage[] {
    return [...this.sentMessages];
  }
  
  /**
   * Clear sent messages
   */
  clearMessages(): void {
    this.sentMessages = [];
  }
}

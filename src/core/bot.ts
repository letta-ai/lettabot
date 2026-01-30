/**
 * LettaBot Core - Handles agent communication
 * 
 * Single agent, single conversation - chat continues across all channels.
 */

import { createSession, resumeSession, type Session } from '@letta-ai/letta-code-sdk';
import { existsSync, mkdirSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { ChannelAdapter } from '../channels/types.js';
import type { BotConfig, InboundMessage, OutboundFile, TriggerContext } from './types.js';
import { Store } from './store.js';
import { updateAgentName } from '../tools/letta-api.js';
import { installSkillsToAgent } from '../skills/loader.js';
import { formatMessageEnvelope } from './formatter.js';
import { loadMemoryBlocks } from './memory.js';
import { SYSTEM_PROMPT } from './system-prompt.js';
import { StreamingDirectiveParser, type AssistantAction } from './directives.js';

export class LettaBot {
  private store: Store;
  private config: BotConfig;
  private channels: Map<string, ChannelAdapter> = new Map();
  private messageQueue: Array<{ msg: InboundMessage; adapter: ChannelAdapter }> = [];
  private lastUserMessageTime: Date | null = null;
  
  // Callback to trigger heartbeat (set by main.ts)
  public onTriggerHeartbeat?: () => Promise<void>;
  private processing = false;
  
  constructor(config: BotConfig) {
    this.config = config;
    
    // Ensure working directory exists
    mkdirSync(config.workingDir, { recursive: true });
    
    // Store in project root (same as main.ts reads for LETTA_AGENT_ID)
    this.store = new Store('lettabot-agent.json');
    
    console.log(`LettaBot initialized. Agent ID: ${this.store.agentId || '(new)'}`);
  }
  
  /**
   * Register a channel adapter
   */
  registerChannel(adapter: ChannelAdapter): void {
    adapter.onMessage = (msg) => this.handleMessage(msg, adapter);
    adapter.onCommand = (cmd) => this.handleCommand(cmd);
    this.channels.set(adapter.id, adapter);
    console.log(`Registered channel: ${adapter.name}`);
  }
  
  /**
   * Handle slash commands
   */
  private async handleCommand(command: string): Promise<string | null> {
    console.log(`[Command] Received: /${command}`);
    switch (command) {
      case 'status': {
        const info = this.store.getInfo();
        const lines = [
          `*Status*`,
          `Agent ID: \`${info.agentId || '(none)'}\``,
          `Created: ${info.createdAt || 'N/A'}`,
          `Last used: ${info.lastUsedAt || 'N/A'}`,
          `Channels: ${Array.from(this.channels.keys()).join(', ')}`,
        ];
        return lines.join('\n');
      }
      case 'heartbeat': {
        console.log('[Command] /heartbeat received');
        if (!this.onTriggerHeartbeat) {
          console.log('[Command] /heartbeat - no trigger callback configured');
          return '⚠️ Heartbeat service not configured';
        }
        console.log('[Command] /heartbeat - triggering heartbeat...');
        // Trigger heartbeat asynchronously
        this.onTriggerHeartbeat().catch(err => {
          console.error('[Heartbeat] Manual trigger failed:', err);
        });
        return '⏰ Heartbeat triggered (silent mode - check server logs)';
      }
      default:
        return null;
    }
  }
  
  /**
   * Start all registered channels
   */
  async start(): Promise<void> {
    const startPromises = Array.from(this.channels.entries()).map(async ([id, adapter]) => {
      try {
        console.log(`Starting channel: ${adapter.name}...`);
        await adapter.start();
        console.log(`Started channel: ${adapter.name}`);
      } catch (e) {
        console.error(`Failed to start channel ${id}:`, e);
      }
    });
    
    await Promise.all(startPromises);
  }
  
  /**
   * Stop all channels
   */
  async stop(): Promise<void> {
    for (const adapter of this.channels.values()) {
      try {
        await adapter.stop();
      } catch (e) {
        console.error(`Failed to stop channel ${adapter.id}:`, e);
      }
    }
  }
  
  /**
   * Queue incoming message for processing (prevents concurrent SDK sessions)
   */
  private async handleMessage(msg: InboundMessage, adapter: ChannelAdapter): Promise<void> {
    console.log(`[${msg.channel}] Message from ${msg.userId}: ${msg.text}`);
    
    // Add to queue
    this.messageQueue.push({ msg, adapter });
    console.log(`[Queue] Added to queue, length: ${this.messageQueue.length}, processing: ${this.processing}`);
    
    // Process queue if not already processing
    if (!this.processing) {
      console.log('[Queue] Starting queue processing');
      this.processQueue().catch(err => console.error('[Queue] Fatal error in processQueue:', err));
    } else {
      console.log('[Queue] Already processing, will process when current message finishes');
    }
  }
  
  /**
   * Process messages one at a time
   */
  private async processQueue(): Promise<void> {
    console.log(`[Queue] processQueue called: processing=${this.processing}, queueLength=${this.messageQueue.length}`);
    if (this.processing || this.messageQueue.length === 0) {
      console.log('[Queue] Exiting early: already processing or empty queue');
      return;
    }
    
    this.processing = true;
    console.log('[Queue] Started processing');
    
    while (this.messageQueue.length > 0) {
      const { msg, adapter } = this.messageQueue.shift()!;
      console.log(`[Queue] Processing message from ${msg.userId} (${this.messageQueue.length} remaining)`);
      try {
        await this.processMessage(msg, adapter);
      } catch (error) {
        console.error('[Queue] Error processing message:', error);
      }
    }
    
    console.log('[Queue] Finished processing all messages');
    this.processing = false;
  }
  
  /**
   * Process a single message
   */
  private async processMessage(msg: InboundMessage, adapter: ChannelAdapter): Promise<void> {
    console.log('[Bot] Starting processMessage');
    // Track when user last sent a message (for heartbeat skip logic)
    this.lastUserMessageTime = new Date();
    
    // Track last message target for heartbeat delivery
    this.store.lastMessageTarget = {
      channel: msg.channel,
      chatId: msg.chatId,
      messageId: msg.messageId,
      updatedAt: new Date().toISOString(),
    };
    
    console.log('[Bot] Sending typing indicator');
    // Start typing indicator
    await adapter.sendTypingIndicator(msg.chatId);
    console.log('[Bot] Typing indicator sent');
    
    // Create or resume session
    let session: Session;
    let usedDefaultConversation = false;
    let usedSpecificConversation = false;
    // Base options for all sessions (model only included for new agents)
    const baseOptions = {
      permissionMode: 'bypassPermissions' as const,
      allowedTools: this.config.allowedTools,
      cwd: this.config.workingDir,
      systemPrompt: SYSTEM_PROMPT,
      // bypassPermissions mode auto-allows all tools, no canUseTool callback needed
    };
    
    console.log('[Bot] Creating/resuming session');
    try {
    if (this.store.conversationId) {
      // Resume the specific conversation we've been using
      console.log(`[Bot] Resuming conversation: ${this.store.conversationId}`);
      process.env.LETTA_AGENT_ID = this.store.agentId || undefined;
      usedSpecificConversation = true;
      session = resumeSession(this.store.conversationId, baseOptions);
    } else if (this.store.agentId) {
        // Agent exists but no conversation - try default conversation
        console.log(`[Bot] Resuming agent default conversation: ${this.store.agentId}`);
        process.env.LETTA_AGENT_ID = this.store.agentId;
        usedDefaultConversation = true;
        session = resumeSession(this.store.agentId, baseOptions);
      } else {
        // Create new agent with default conversation
        console.log('[Bot] Creating new agent');
        session = createSession(undefined, { ...baseOptions, model: this.config.model, memory: loadMemoryBlocks(this.config.agentName) });
      }
      console.log('[Bot] Session created/resumed');
      
      const defaultTimeoutMs = 30000; // 30s timeout
      const envTimeoutMs = Number(process.env.LETTA_SESSION_TIMEOUT_MS);
      const initTimeoutMs = Number.isFinite(envTimeoutMs) && envTimeoutMs > 0
        ? envTimeoutMs
        : defaultTimeoutMs;
      const withTimeout = async <T>(promise: Promise<T>, label: string): Promise<T> => {
        let timeoutId: NodeJS.Timeout;
        const timeoutPromise = new Promise<T>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`${label} timed out after ${initTimeoutMs}ms`));
          }, initTimeoutMs);
        });
        try {
          return await Promise.race([promise, timeoutPromise]);
        } finally {
          clearTimeout(timeoutId!);
        }
      };

      let initInfo;
      try {
        initInfo = await withTimeout(session.initialize(), 'Session initialize');
      } catch (error) {
        if (usedSpecificConversation && this.store.agentId) {
          console.warn('[Bot] Conversation missing, creating a new conversation...');
          session.close();
          session = createSession(this.store.agentId, baseOptions);
          initInfo = await withTimeout(session.initialize(), 'Session initialize (new conversation)');
          usedSpecificConversation = false;
          usedDefaultConversation = false;
        } else if (usedDefaultConversation && this.store.agentId) {
          console.warn('[Bot] Default conversation missing, creating a new conversation...');
          session.close();
          session = createSession(this.store.agentId, baseOptions);
          initInfo = await withTimeout(session.initialize(), 'Session initialize (new conversation)');
          usedDefaultConversation = false;
        } else {
          throw error;
        }
      }

      // Send message to agent with metadata envelope
      const formattedMessage = formatMessageEnvelope(msg);
      
      // Keep typing indicator alive
      const typingInterval = setInterval(() => {
        adapter.sendTypingIndicator(msg.chatId).catch(() => {});
      }, 4000);

      let sentAnyMessage = false;
      const pendingPrompts: string[] = [formattedMessage];
      let followupCount = 0;
      const maxFollowups = 3;

      const handleSessionResult = () => {
        if (session.agentId && session.agentId !== this.store.agentId) {
          const isNewAgent = !this.store.agentId;
          const currentBaseUrl = process.env.LETTA_BASE_URL || 'https://api.letta.com';
          this.store.setAgent(session.agentId, currentBaseUrl, session.conversationId || undefined);
          console.log('Saved agent ID:', session.agentId, 'conversation ID:', session.conversationId, 'on server:', currentBaseUrl);
          if (isNewAgent) {
            if (this.config.agentName && session.agentId) {
              updateAgentName(session.agentId, this.config.agentName).catch(() => {});
            }
            if (session.agentId) {
              installSkillsToAgent(session.agentId);
            }
          }
        } else if (session.conversationId && session.conversationId !== this.store.conversationId) {
          this.store.conversationId = session.conversationId;
        }
      };

      try {
        while (pendingPrompts.length > 0 && followupCount < maxFollowups) {
          const prompt = pendingPrompts.shift()!;
          try {
            await withTimeout(session.send(prompt), 'Session send');
          } catch (sendError) {
            console.error('[Bot] Error sending message:', sendError);
            throw sendError;
          }

          const parser = new StreamingDirectiveParser();
          const actions: AssistantAction[] = [];
          let response = '';
          let messageId: string | null = null;
          let lastUpdate = Date.now();
          const canEdit = adapter.supportsEditing?.() ?? true;

          const sendOrEdit = async (text: string, forceSend = false) => {
            if (messageId && canEdit && !forceSend) {
              await adapter.editMessage(msg.chatId, messageId, text);
              sentAnyMessage = true;
              return;
            }
            const result = await adapter.sendMessage({
              chatId: msg.chatId,
              text,
              threadId: msg.threadId,
            });
            messageId = result.messageId;
            sentAnyMessage = true;
          };

          for await (const streamMsg of session.stream()) {
            if (streamMsg.type === 'assistant') {
              const parsed = parser.ingest(streamMsg.content);
              if (parsed.actions.length) {
                actions.push(...parsed.actions);
              }
              if (parsed.text) {
                response += parsed.text;
                if (canEdit && Date.now() - lastUpdate > 500 && response.length > 0) {
                  try {
                    await sendOrEdit(response);
                  } catch {
                    // Ignore edit errors during streaming
                  }
                  lastUpdate = Date.now();
                }
              }
            }

            if (streamMsg.type === 'result') {
              handleSessionResult();
              break;
            }
          }

          const tail = parser.flush();
          if (tail.actions.length) {
            actions.push(...tail.actions);
          }
          if (tail.text) {
            response += tail.text;
          }

          if (response.trim()) {
            try {
              await sendOrEdit(response, !canEdit);
            } catch (sendError) {
              console.error('[Bot] Error sending response:', sendError);
            }
          }

          for (const action of actions) {
            console.log('[Bot] Parsed directive action:', action);
            if (action.type === 'message') {
              const chunks = this.splitMessage(action.content, msg.channel);
              for (const chunk of chunks) {
                try {
                  await adapter.sendMessage({
                    chatId: msg.chatId,
                    text: chunk,
                    threadId: msg.threadId,
                  });
                  sentAnyMessage = true;
                } catch (error) {
                  console.error('[Bot] Send failed:', error);
                }
              }
              continue;
            }

            if (action.type === 'react') {
              const targetId = action.messageId || msg.messageId;
              if (!targetId) {
                console.warn('[Bot] React directive missing message ID');
                continue;
              }
              const emoji = adapter.id === 'slack'
                ? action.emoji
                : this.resolveUnicodeEmoji(action.emoji);
              try {
                await adapter.addReaction(msg.chatId, targetId, emoji);
                sentAnyMessage = true;
              } catch (error) {
                console.error('[Bot] Reaction failed:', error);
              }
              continue;
            }

            if (action.type === 'send_file') {
              const resolved = this.resolveFilePath(action.path);
              if (!resolved) {
                console.warn(`[Bot] File not found: ${action.path}`);
                continue;
              }
              const outbound: OutboundFile = {
                chatId: msg.chatId,
                filePath: resolved,
                kind: action.kind,
                threadId: msg.threadId,
              };
              try {
                await adapter.sendFile(outbound);
                sentAnyMessage = true;
              } catch (error) {
                console.error('[Bot] File send failed:', error);
              }
              continue;
            }

          }

          followupCount += 1;
        }
      } finally {
        clearInterval(typingInterval);
      }
      if (!sentAnyMessage) {
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: '(No response from agent)',
          threadId: msg.threadId,
        });
      }
      
    } catch (error) {
      console.error('[Bot] Error processing message:', error);
      await adapter.sendMessage({
        chatId: msg.chatId,
        text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        threadId: msg.threadId,
      });
    } finally {
      session!?.close();
    }
  }

  private resolveFilePath(input: string): string | null {
    const trimmed = input.trim();
    if (!trimmed) return null;
    const resolved = isAbsolute(trimmed)
      ? trimmed
      : resolve(this.config.workingDir, trimmed);
    return existsSync(resolved) ? resolved : null;
  }

  private splitMessage(content: string, channel: string): string[] {
    const limits: Record<string, number> = {
      discord: 1900,
      telegram: 3900,
      slack: 38000,
      whatsapp: 1800,
      signal: 1800,
    };
    const limit = limits[channel] || 1900;
    if (content.length <= limit) return [content];
    const chunks: string[] = [];
    let remaining = content;
    while (remaining.length > 0) {
      chunks.push(remaining.slice(0, limit));
      remaining = remaining.slice(limit);
    }
    return chunks;
  }

  private resolveUnicodeEmoji(input: string): string {
    const match = input.match(/^:([^:]+):$/);
    const alias = match ? match[1] : null;
    const key = alias || input;
    return EMOJI_ALIAS_TO_UNICODE[key] || input;
  }
  
  /**
   * Send a message to the agent (for cron jobs, webhooks, etc.)
   * 
   * In silent mode (heartbeats, cron), the agent's text response is NOT auto-delivered.
   * The agent must use `lettabot-message` CLI via Bash to send messages explicitly.
   * 
   * @param text - The prompt/message to send
   * @param context - Optional trigger context (for logging/tracking)
   * @returns The agent's response text
   */
  async sendToAgent(
    text: string,
    _context?: TriggerContext
  ): Promise<string> {
    // Base options (model only for new agents)
    const baseOptions = {
      permissionMode: 'bypassPermissions' as const,
      allowedTools: this.config.allowedTools,
      cwd: this.config.workingDir,
      systemPrompt: SYSTEM_PROMPT,
      // bypassPermissions mode auto-allows all tools, no canUseTool callback needed
    };
    
    let session: Session;
    let usedDefaultConversation = false;
    let usedSpecificConversation = false;
    if (this.store.conversationId) {
      // Resume the specific conversation we've been using
      usedSpecificConversation = true;
      session = resumeSession(this.store.conversationId, baseOptions);
    } else if (this.store.agentId) {
      // Agent exists but no conversation - try default conversation
      usedDefaultConversation = true;
      session = resumeSession(this.store.agentId, baseOptions);
    } else {
      // Create new agent with default conversation
      session = createSession(undefined, { ...baseOptions, model: this.config.model, memory: loadMemoryBlocks(this.config.agentName) });
    }
    
    try {
      try {
        await session.send(text);
      } catch (error) {
        if (usedSpecificConversation && this.store.agentId) {
          console.warn('[Bot] Conversation missing, creating a new conversation...');
          session.close();
          session = createSession(this.store.agentId, baseOptions);
          await session.send(text);
          usedSpecificConversation = false;
          usedDefaultConversation = false;
        } else if (usedDefaultConversation && this.store.agentId) {
          console.warn('[Bot] Default conversation missing, creating a new conversation...');
          session.close();
          session = createSession(this.store.agentId, baseOptions);
          await session.send(text);
          usedDefaultConversation = false;
        } else {
          throw error;
        }
      }
      
      let response = '';
      for await (const msg of session.stream()) {
        if (msg.type === 'assistant') {
          response += msg.content;
        }
        
        if (msg.type === 'result') {
          if (session.agentId && session.agentId !== this.store.agentId) {
            const currentBaseUrl = process.env.LETTA_BASE_URL || 'https://api.letta.com';
            this.store.setAgent(session.agentId, currentBaseUrl, session.conversationId || undefined);
          } else if (session.conversationId && session.conversationId !== this.store.conversationId) {
            this.store.conversationId = session.conversationId;
          }
          break;
        }
      }
      
      return response;
    } finally {
      session.close();
    }
  }
  
  /**
   * Deliver a message to a specific channel
   */
  async deliverToChannel(channelId: string, chatId: string, text: string): Promise<void> {
    const adapter = this.channels.get(channelId);
    if (!adapter) {
      console.error(`Channel not found: ${channelId}`);
      return;
    }
    await adapter.sendMessage({ chatId, text });
  }
  
  /**
   * Get bot status
   */
  getStatus(): { agentId: string | null; channels: string[] } {
    return {
      agentId: this.store.agentId,
      channels: Array.from(this.channels.keys()),
    };
  }
  
  
  /**
   * Reset agent (clear memory)
   */
  reset(): void {
    this.store.reset();
    console.log('Agent reset');
  }
  
  /**
   * Get the last message target (for heartbeat delivery)
   */
  getLastMessageTarget(): { channel: string; chatId: string } | null {
    return this.store.lastMessageTarget || null;
  }
  
  /**
   * Get the time of the last user message (for heartbeat skip logic)
   */
  getLastUserMessageTime(): Date | null {
    return this.lastUserMessageTime;
  }
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

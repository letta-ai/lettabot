/**
 * AgentSession - Manages a single agent's state, channels, and message processing
 *
 * In multi-agent mode, each AgentSession:
 * - Has its own message queue (isolated from other agents)
 * - Manages its own Letta agent (eager creation on start)
 * - Handles its own channels
 *
 * See: https://github.com/letta-ai/lettabot/issues/109
 */

import { createSession, resumeSession, createAgent, type Session } from '@letta-ai/letta-code-sdk';
import { mkdirSync } from 'node:fs';
import type { ChannelAdapter } from '../channels/types.js';
import type { BotConfig, InboundMessage, TriggerContext, LastMessageTarget, AgentState, BotLike } from './types.js';
import { MultiAgentStore } from './store.js';
import { updateAgentName } from '../tools/letta-api.js';
import { installSkillsToAgent } from '../skills/loader.js';
import { formatMessageEnvelope } from './formatter.js';
import { loadMemoryBlocks } from './memory.js';
import { SYSTEM_PROMPT } from './system-prompt.js';
import { StreamWatchdog } from './stream-watchdog.js';
import { getAgentDataDir, migrateChannelState } from '../utils/paths.js';

export interface AgentSessionConfig extends BotConfig {
  /** Agent name (from config) */
  agentName: string;
  /** Existing Letta agent ID (optional - for linking to existing Letta Code agents) */
  existingAgentId?: string;
}

export class AgentSession implements BotLike {
  /** Agent name from config (user-friendly identifier) */
  public readonly name: string;

  private store: MultiAgentStore;
  private config: AgentSessionConfig;
  private channels: Map<string, ChannelAdapter> = new Map();
  private messageQueue: Array<{ msg: InboundMessage; adapter: ChannelAdapter }> = [];
  private lastUserMessageTime: Date | null = null;
  private processing = false;

  /** Callback to trigger heartbeat (set by gateway) */
  public onTriggerHeartbeat?: () => Promise<void>;

  constructor(config: AgentSessionConfig, store: MultiAgentStore) {
    this.name = config.agentName;
    this.config = config;
    this.store = store;

    // Ensure working directory exists
    mkdirSync(config.workingDir, { recursive: true });

    console.log(`[AgentSession:${this.name}] Initialized. Agent ID: ${this.agentId || '(new)'}`);
  }

  /** Get the Letta agent ID for this session */
  get agentId(): string | null {
    // Check for existing agent ID from config first
    if (this.config.existingAgentId) {
      return this.config.existingAgentId;
    }
    return this.store.getAgentId(this.name);
  }

  /** Get the conversation ID for this session */
  get conversationId(): string | undefined {
    return this.store.getAgent(this.name)?.conversationId;
  }

  /**
   * Register a channel adapter for this agent
   */
  registerChannel(adapter: ChannelAdapter): void {
    adapter.onMessage = (msg) => this.handleMessage(msg, adapter);
    adapter.onCommand = (cmd) => this.handleCommand(cmd);
    this.channels.set(adapter.id, adapter);
    console.log(`[AgentSession:${this.name}] Registered channel: ${adapter.id}`);
  }

  /**
   * Start the agent session
   *
   * EAGER AGENT CREATION: Creates the Letta agent if it doesn't exist,
   * ensuring agentId is available for channel state directories.
   */
  async start(): Promise<void> {
    // Eager agent creation - ensure agent exists before starting channels
    if (!this.agentId) {
      console.log(`[AgentSession:${this.name}] Creating agent (eager)...`);
      await this.createAgentEagerly();
    }

    // Migrate channel state from legacy location if needed
    if (this.agentId) {
      migrateChannelState(this.agentId);
    }

    // Set data directory for stateful channels (WhatsApp, Signal)
    const dataDir = this.agentId ? getAgentDataDir(this.agentId) : undefined;
    for (const adapter of this.channels.values()) {
      if (dataDir && typeof (adapter as any).setDataDir === 'function') {
        (adapter as any).setDataDir(dataDir);
      }
    }

    // Start all channels
    const startPromises = Array.from(this.channels.entries()).map(async ([id, adapter]) => {
      try {
        console.log(`[AgentSession:${this.name}] Starting channel: ${id}...`);
        await adapter.start();
        console.log(`[AgentSession:${this.name}] Started channel: ${id}`);
      } catch (e) {
        console.error(`[AgentSession:${this.name}] Failed to start channel ${id}:`, e);
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
        console.error(`[AgentSession:${this.name}] Failed to stop channel ${adapter.id}:`, e);
      }
    }
  }

  /**
   * Create agent eagerly (before first message)
   */
  private async createAgentEagerly(): Promise<void> {
    const newAgentId = await createAgent({
      model: this.config.model,
      systemPrompt: SYSTEM_PROMPT,
      memory: loadMemoryBlocks(this.config.agentName),
    });
    console.log(`[AgentSession:${this.name}] Agent created: ${newAgentId}`);

    // Install feature-gated skills to agent-scoped directory
    installSkillsToAgent(newAgentId, {
      cronEnabled: this.config.cronEnabled,
      googleEnabled: this.config.googleEnabled,
    });

    // Save agent ID to store
    const currentBaseUrl = process.env.LETTA_BASE_URL || 'https://api.letta.com';
    this.store.setAgentId(this.name, newAgentId, currentBaseUrl);

    // Set agent name via API
    if (this.config.agentName) {
      updateAgentName(newAgentId, this.config.agentName).catch(() => {});
    }
  }

  /**
   * Get base session options
   */
  private getBaseSessionOptions() {
    return {
      permissionMode: 'bypassPermissions' as const,
      allowedTools: this.config.allowedTools,
      cwd: this.config.workingDir,
      // Note: systemPrompt/memory now passed to createAgent() for new agents (SDK 0.0.5+)
    };
  }

  /**
   * Get or create a session for the agent
   */
  private async getOrCreateSession(): Promise<{
    session: Session;
    usedSpecificConversation: boolean;
    usedDefaultConversation: boolean;
  }> {
    const baseOptions = this.getBaseSessionOptions();
    const agentState = this.store.getAgent(this.name);

    let session: Session;
    let usedDefaultConversation = false;
    let usedSpecificConversation = false;

    if (agentState?.conversationId) {
      // Resume specific conversation
      console.log(`[AgentSession:${this.name}] Resuming conversation: ${agentState.conversationId}`);
      process.env.LETTA_AGENT_ID = agentState.agentId || undefined;
      usedSpecificConversation = true;
      session = resumeSession(agentState.conversationId, baseOptions);
    } else if (agentState?.agentId) {
      // Agent exists but no conversation - try default conversation
      console.log(`[AgentSession:${this.name}] Resuming agent default conversation: ${agentState.agentId}`);
      process.env.LETTA_AGENT_ID = agentState.agentId;
      usedDefaultConversation = true;
      session = resumeSession(agentState.agentId, baseOptions);
    } else {
      // This shouldn't happen with eager creation, but handle it
      console.log(`[AgentSession:${this.name}] Creating agent on first message (fallback)...`);
      await this.createAgentEagerly();
      const newAgentId = this.agentId!;
      // Use createSession for new agents (SDK 0.0.5+ pattern)
      session = createSession(newAgentId, baseOptions);
    }

    return { session, usedSpecificConversation, usedDefaultConversation };
  }

  /**
   * Handle slash commands
   */
  private async handleCommand(command: string): Promise<string | null> {
    console.log(`[AgentSession:${this.name}] Command: /${command}`);
    switch (command) {
      case 'status': {
        const agentState = this.store.getAgent(this.name);
        const lines = [
          `*Status (${this.name})*`,
          `Agent ID: \`${agentState?.agentId || '(none)'}\``,
          `Created: ${agentState?.createdAt || 'N/A'}`,
          `Last used: ${agentState?.lastUsedAt || 'N/A'}`,
          `Channels: ${Array.from(this.channels.keys()).join(', ')}`,
        ];
        return lines.join('\n');
      }
      case 'heartbeat': {
        if (!this.onTriggerHeartbeat) {
          return '⚠️ Heartbeat service not configured';
        }
        this.onTriggerHeartbeat().catch(err => {
          console.error(`[AgentSession:${this.name}] Heartbeat trigger failed:`, err);
        });
        return '⏰ Heartbeat triggered (silent mode - check server logs)';
      }
      default:
        return null;
    }
  }

  /**
   * Queue incoming message for processing
   */
  private async handleMessage(msg: InboundMessage, adapter: ChannelAdapter): Promise<void> {
    console.log(`[AgentSession:${this.name}] Message from ${msg.userId}: ${msg.text}`);

    this.messageQueue.push({ msg, adapter });
    console.log(`[AgentSession:${this.name}] Queue length: ${this.messageQueue.length}`);

    if (!this.processing) {
      this.processQueue().catch(err =>
        console.error(`[AgentSession:${this.name}] Fatal error in processQueue:`, err)
      );
    }
  }

  /**
   * Process messages one at a time
   */
  private async processQueue(): Promise<void> {
    if (this.processing || this.messageQueue.length === 0) return;

    this.processing = true;

    while (this.messageQueue.length > 0) {
      const { msg, adapter } = this.messageQueue.shift()!;
      console.log(`[AgentSession:${this.name}] Processing message (${this.messageQueue.length} remaining)`);
      try {
        await this.processMessage(msg, adapter);
      } catch (error) {
        console.error(`[AgentSession:${this.name}] Error processing message:`, error);
      }
    }

    this.processing = false;
  }

  /**
   * Process a single message
   */
  private async processMessage(msg: InboundMessage, adapter: ChannelAdapter): Promise<void> {
    this.lastUserMessageTime = new Date();

    // Track last message target for heartbeat delivery
    this.store.setLastMessageTarget(this.name, {
      channel: msg.channel,
      chatId: msg.chatId,
      messageId: msg.messageId,
      updatedAt: new Date().toISOString(),
    });

    await adapter.sendTypingIndicator(msg.chatId);

    let { session, usedSpecificConversation, usedDefaultConversation } = await this.getOrCreateSession();

    try {
      const defaultTimeoutMs = 30000;
      const envTimeoutMs = Number(process.env.LETTA_SESSION_TIMEOUT_MS);
      const initTimeoutMs = Number.isFinite(envTimeoutMs) && envTimeoutMs > 0 ? envTimeoutMs : defaultTimeoutMs;

      const withTimeout = async <T>(promise: Promise<T>, label: string): Promise<T> => {
        let timeoutId: NodeJS.Timeout;
        const timeoutPromise = new Promise<T>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${initTimeoutMs}ms`)), initTimeoutMs);
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
        const baseOptions = this.getBaseSessionOptions();
        const agentId = this.agentId;
        if (usedSpecificConversation && agentId) {
          console.warn(`[AgentSession:${this.name}] Conversation missing, creating new...`);
          session.close();
          session = createSession(agentId, baseOptions);
          initInfo = await withTimeout(session.initialize(), 'Session initialize (new)');
          usedSpecificConversation = false;
        } else if (usedDefaultConversation && agentId) {
          console.warn(`[AgentSession:${this.name}] Default conversation missing, creating new...`);
          session.close();
          session = createSession(agentId, baseOptions);
          initInfo = await withTimeout(session.initialize(), 'Session initialize (new)');
          usedDefaultConversation = false;
        } else {
          throw error;
        }
      }

      if (initInfo.conversationId) {
        const currentConvId = this.store.getAgent(this.name)?.conversationId;
        if (initInfo.conversationId !== currentConvId) {
          this.store.setAgent(this.name, { conversationId: initInfo.conversationId });
        }
      }

      const formattedMessage = formatMessageEnvelope(msg);
      await withTimeout(session.send(formattedMessage), 'Session send');

      // Stream response
      let response = '';
      let lastUpdate = Date.now();
      let messageId: string | null = null;
      let lastMsgType: string | null = null;
      let lastAssistantUuid: string | null = null;
      let sentAnyMessage = false;

      const watchdog = new StreamWatchdog({
        onAbort: () => {
          session.abort().catch(() => {});
          try { session.close(); } catch {}
        },
      });
      watchdog.start();

      const finalizeMessage = async () => {
        if (response.trim()) {
          try {
            if (messageId) {
              await adapter.editMessage(msg.chatId, messageId, response);
            } else {
              await adapter.sendMessage({ chatId: msg.chatId, text: response, threadId: msg.threadId });
            }
            sentAnyMessage = true;
          } catch {}
        }
        response = '';
        messageId = null;
        lastUpdate = Date.now();
      };

      const typingInterval = setInterval(() => {
        adapter.sendTypingIndicator(msg.chatId).catch(() => {});
      }, 4000);

      try {
        for await (const streamMsg of session.stream()) {
          const msgUuid = (streamMsg as any).uuid;
          watchdog.ping();

          if (lastMsgType && lastMsgType !== streamMsg.type && response.trim()) {
            await finalizeMessage();
          }

          if (streamMsg.type !== lastMsgType) {
            if (streamMsg.type === 'tool_call') {
              console.log(`[AgentSession:${this.name}] Tool: ${(streamMsg as any).toolName || 'unknown'}`);
            }
          }
          lastMsgType = streamMsg.type;

          if (streamMsg.type === 'assistant') {
            if (msgUuid && lastAssistantUuid && msgUuid !== lastAssistantUuid && response.trim()) {
              await finalizeMessage();
            }
            lastAssistantUuid = msgUuid || lastAssistantUuid;
            response += streamMsg.content;

            const canEdit = adapter.supportsEditing?.() ?? true;
            if (canEdit && Date.now() - lastUpdate > 500 && response.length > 0) {
              try {
                if (messageId) {
                  await adapter.editMessage(msg.chatId, messageId, response);
                } else {
                  const result = await adapter.sendMessage({ chatId: msg.chatId, text: response, threadId: msg.threadId });
                  messageId = result.messageId;
                }
              } catch {}
              lastUpdate = Date.now();
            }
          }

          if (streamMsg.type === 'result') {
            if (session.conversationId) {
              const currentConvId = this.store.getAgent(this.name)?.conversationId;
              if (session.conversationId !== currentConvId) {
                this.store.setAgent(this.name, { conversationId: session.conversationId });
              }
            }
            break;
          }
        }
      } finally {
        watchdog.stop();
        clearInterval(typingInterval);
      }

      if (response.trim()) {
        try {
          if (messageId) {
            await adapter.editMessage(msg.chatId, messageId, response);
          } else {
            await adapter.sendMessage({ chatId: msg.chatId, text: response, threadId: msg.threadId });
          }
          sentAnyMessage = true;
        } catch {
          if (!messageId) {
            await adapter.sendMessage({ chatId: msg.chatId, text: response, threadId: msg.threadId });
            sentAnyMessage = true;
          }
        }
      }

      if (!sentAnyMessage) {
        await adapter.sendMessage({ chatId: msg.chatId, text: '(No response from agent)', threadId: msg.threadId });
      }
    } catch (error) {
      console.error(`[AgentSession:${this.name}] Error:`, error);
      await adapter.sendMessage({
        chatId: msg.chatId,
        text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        threadId: msg.threadId,
      });
    } finally {
      session!?.close();
    }
  }

  /**
   * Send a message to the agent (for cron jobs, webhooks, etc.)
   */
  async sendToAgent(text: string, _context?: TriggerContext): Promise<string> {
    let { session, usedSpecificConversation, usedDefaultConversation } = await this.getOrCreateSession();

    try {
      try {
        await session.send(text);
      } catch (error) {
        const baseOptions = this.getBaseSessionOptions();
        const agentId = this.agentId;
        if (usedSpecificConversation && agentId) {
          session.close();
          session = createSession(agentId, baseOptions);
          await session.send(text);
        } else if (usedDefaultConversation && agentId) {
          session.close();
          session = createSession(agentId, baseOptions);
          await session.send(text);
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
          if (session.conversationId) {
            const currentConvId = this.store.getAgent(this.name)?.conversationId;
            if (session.conversationId !== currentConvId) {
              this.store.setAgent(this.name, { conversationId: session.conversationId });
            }
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
   * Deliver a message or file to a channel
   */
  async deliverToChannel(
    channelId: string,
    chatId: string,
    options: { text?: string; filePath?: string; kind?: 'image' | 'file' }
  ): Promise<string | undefined> {
    const adapter = this.channels.get(channelId);
    if (!adapter) {
      throw new Error(`Channel not found: ${channelId}`);
    }

    if (options.filePath) {
      if (typeof adapter.sendFile !== 'function') {
        throw new Error(`Channel ${channelId} does not support file sending`);
      }
      const result = await adapter.sendFile({
        chatId,
        filePath: options.filePath,
        caption: options.text,
        kind: options.kind,
      });
      return result.messageId;
    }

    if (options.text) {
      const result = await adapter.sendMessage({ chatId, text: options.text });
      return result.messageId;
    }

    throw new Error('Either text or filePath must be provided');
  }

  /**
   * Get channel by ID
   */
  getChannel(channelId: string): ChannelAdapter | undefined {
    return this.channels.get(channelId);
  }

  /**
   * Get all channel IDs
   */
  getChannelIds(): string[] {
    return Array.from(this.channels.keys());
  }

  /**
   * Get last message target
   */
  getLastMessageTarget(): LastMessageTarget | null {
    return this.store.getLastMessageTarget(this.name);
  }

  /**
   * Get last user message time
   */
  getLastUserMessageTime(): Date | null {
    return this.lastUserMessageTime;
  }

  /**
   * Get agent state
   */
  getState(): AgentState | null {
    return this.store.getAgent(this.name);
  }
}

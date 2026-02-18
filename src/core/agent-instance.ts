/**
 * Agent Instance
 * 
 * Handles a single agent in multi-agent mode.
 * Each instance has its own workspace, store, and Letta agent.
 */

import { createAgent, createSession, resumeSession, type Session } from '@letta-ai/letta-code-sdk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ChannelAdapter } from '../channels/types.js';
import type { InboundMessage, TriggerContext } from './types.js';
import { updateAgentName } from '../tools/letta-api.js';
import { formatMessageEnvelope } from './formatter.js';
import { loadMemoryBlocks } from './memory.js';
import { SYSTEM_PROMPT } from './system-prompt.js';

/**
 * Agent instance configuration
 */
export interface AgentInstanceConfig {
  /** Config ID (e.g., "home", "work") - used for store path */
  configId: string;
  /** Display name */
  name: string;
  /** Working directory for this agent */
  workspace: string;
  /** Model to use */
  model?: string;
  /** Allowed tools */
  allowedTools?: string[];
}

/**
 * Agent state persisted to disk
 */
interface AgentState {
  /** Letta Cloud agent ID */
  agentId: string | null;
  /** Current conversation ID */
  conversationId?: string | null;
  /** Server URL this agent belongs to */
  baseUrl?: string;
  /** When the agent was created */
  createdAt?: string;
  /** When the agent was last used */
  lastUsedAt?: string;
  /** Last message target for heartbeats */
  lastMessageTarget?: {
    channel: string;
    chatId: string;
    messageId?: string;
    updatedAt: string;
  };
}

const DEFAULT_ALLOWED_TOOLS = [
  'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Task',
  'web_search', 'conversation_search',
];

/**
 * Single agent instance
 */
export class AgentInstance {
  readonly configId: string;
  readonly name: string;
  readonly workspace: string;
  readonly model: string | undefined;
  
  private state: AgentState;
  private statePath: string;
  private allowedTools: string[];
  private processing = false;
  private messageQueue: Array<{
    msg: InboundMessage;
    adapter: ChannelAdapter;
    resolve: (value: void) => void;
    reject: (error: Error) => void;
  }> = [];
  
  constructor(config: AgentInstanceConfig) {
    this.configId = config.configId;
    this.name = config.name;
    this.workspace = this.resolveWorkspace(config.workspace);
    this.model = config.model;
    this.allowedTools = config.allowedTools || DEFAULT_ALLOWED_TOOLS;
    
    // State stored in ~/.lettabot/agents/{configId}/state.json
    const stateDir = join(homedir(), '.lettabot', 'agents', config.configId);
    this.statePath = join(stateDir, 'state.json');
    
    // Ensure directories exist
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(this.workspace, { recursive: true });
    
    // Load existing state
    this.state = this.loadState();
    
    console.log(`[Agent:${this.configId}] Initialized. Letta ID: ${this.state.agentId || '(new)'}`);
  }
  
  /**
   * Get the Letta Cloud agent ID
   */
  get agentId(): string | null {
    return this.state.agentId;
  }
  
  /**
   * Get the current conversation ID
   */
  get conversationId(): string | null {
    return this.state.conversationId || null;
  }
  
  /**
   * Get last message target for heartbeats
   */
  get lastMessageTarget(): AgentState['lastMessageTarget'] | null {
    return this.state.lastMessageTarget || null;
  }
  
  /**
   * Process an incoming message
   */
  async processMessage(msg: InboundMessage, adapter: ChannelAdapter): Promise<void> {
    return new Promise((resolve, reject) => {
      this.messageQueue.push({ msg, adapter, resolve, reject });
      if (!this.processing) {
        this.processQueue();
      }
    });
  }
  
  /**
   * Send a message to the agent (for cron, heartbeat, etc.)
   */
  async sendToAgent(text: string, _context?: TriggerContext): Promise<string> {
    const baseOptions = {
      permissionMode: 'bypassPermissions' as const,
      allowedTools: this.allowedTools,
      cwd: this.workspace,
    };
    
    let session: Session;
    let usedDefaultConversation = false;
    let usedSpecificConversation = false;
    
    if (this.state.conversationId) {
      usedSpecificConversation = true;
      session = resumeSession(this.state.conversationId, baseOptions);
    } else if (this.state.agentId) {
      usedDefaultConversation = true;
      session = resumeSession(this.state.agentId, baseOptions);
    } else {
      const newAgentId = await createAgent({
        ...baseOptions,
        model: this.model,
        memory: loadMemoryBlocks(this.name),
        systemPrompt: SYSTEM_PROMPT,
        memfs: true,
      });
      session = resumeSession(newAgentId, baseOptions);
    }
    
    try {
      try {
        await session.send(text);
      } catch (error) {
        if (usedSpecificConversation && this.state.agentId) {
          console.warn(`[Agent:${this.configId}] Conversation missing, creating new...`);
          session.close();
          session = createSession(this.state.agentId, baseOptions);
          await session.send(text);
        } else if (usedDefaultConversation && this.state.agentId) {
          console.warn(`[Agent:${this.configId}] Default conversation missing, creating new...`);
          session.close();
          session = createSession(this.state.agentId, baseOptions);
          await session.send(text);
        } else {
          throw error;
        }
      }
      
      let response = '';
      for await (const streamMsg of session.stream()) {
        if (streamMsg.type === 'assistant') {
          response += streamMsg.content;
        }
        if (streamMsg.type === 'result') {
          this.handleSessionResult(session);
          break;
        }
      }
      
      return response;
    } finally {
      session.close();
    }
  }
  
  /**
   * Reset the agent (clear stored state)
   */
  reset(): void {
    this.state = { agentId: null };
    this.saveState();
    console.log(`[Agent:${this.configId}] Reset`);
  }
  
  /**
   * Set the agent ID (for container deploys that discover existing agents)
   */
  setAgentId(agentId: string): void {
    this.state.agentId = agentId;
    this.saveState();
    console.log(`[Agent:${this.configId}] Agent ID set to: ${agentId}`);
  }
  
  /**
   * Process message queue sequentially
   */
  private async processQueue(): Promise<void> {
    if (this.processing || this.messageQueue.length === 0) return;
    
    this.processing = true;
    
    while (this.messageQueue.length > 0) {
      const { msg, adapter, resolve, reject } = this.messageQueue.shift()!;
      try {
        await this.handleMessage(msg, adapter);
        resolve();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    
    this.processing = false;
  }
  
  /**
   * Handle a single message
   */
  private async handleMessage(msg: InboundMessage, adapter: ChannelAdapter): Promise<void> {
    console.log(`[Agent:${this.configId}] Message from ${msg.userId}: ${msg.text.slice(0, 50)}...`);
    
    // Track last message target for heartbeats
    this.state.lastMessageTarget = {
      channel: msg.channel,
      chatId: msg.chatId,
      messageId: msg.messageId,
      updatedAt: new Date().toISOString(),
    };
    this.saveState();
    
    // Start typing indicator
    await adapter.sendTypingIndicator(msg.chatId);
    
    const baseOptions = {
      permissionMode: 'bypassPermissions' as const,
      allowedTools: this.allowedTools,
      cwd: this.workspace,
    };
    
    let session: Session;
    let usedDefaultConversation = false;
    let usedSpecificConversation = false;
    
    if (this.state.conversationId) {
      usedSpecificConversation = true;
      process.env.LETTA_AGENT_ID = this.state.agentId || undefined;
      session = resumeSession(this.state.conversationId, baseOptions);
    } else if (this.state.agentId) {
      usedDefaultConversation = true;
      process.env.LETTA_AGENT_ID = this.state.agentId;
      session = resumeSession(this.state.agentId, baseOptions);
    } else {
      const newAgentId = await createAgent({
        ...baseOptions,
        model: this.model,
        memory: loadMemoryBlocks(this.name),
        systemPrompt: SYSTEM_PROMPT,
        memfs: true,
      });
      session = resumeSession(newAgentId, baseOptions);
    }
    
    try {
      // Initialize session with timeout
      const initTimeoutMs = 30000;
      let initInfo;
      
      try {
        initInfo = await this.withTimeout(session.initialize(), 'Session initialize', initTimeoutMs);
      } catch (error) {
        if (usedSpecificConversation && this.state.agentId) {
          console.warn(`[Agent:${this.configId}] Conversation missing, creating new...`);
          session.close();
          session = createSession(this.state.agentId, baseOptions);
          initInfo = await this.withTimeout(session.initialize(), 'Session initialize', initTimeoutMs);
        } else if (usedDefaultConversation && this.state.agentId) {
          console.warn(`[Agent:${this.configId}] Default conversation missing, creating new...`);
          session.close();
          session = createSession(this.state.agentId, baseOptions);
          initInfo = await this.withTimeout(session.initialize(), 'Session initialize', initTimeoutMs);
        } else {
          throw error;
        }
      }
      
      // Send message
      const formattedMessage = formatMessageEnvelope(msg);
      await this.withTimeout(session.send(formattedMessage), 'Session send', initTimeoutMs);
      
      // Stream response
      let response = '';
      let messageId: string | null = null;
      let lastUpdate = Date.now();
      let sentAnyMessage = false;
      
      // Keep typing indicator alive
      const typingInterval = setInterval(() => {
        adapter.sendTypingIndicator(msg.chatId).catch(() => {});
      }, 4000);
      
      try {
        for await (const streamMsg of session.stream()) {
          if (streamMsg.type === 'assistant') {
            response += streamMsg.content;
            
            // Stream updates for channels that support editing
            const canEdit = adapter.supportsEditing?.() ?? true;
            if (canEdit && Date.now() - lastUpdate > 500 && response.length > 0) {
              try {
                if (messageId) {
                  await adapter.editMessage(msg.chatId, messageId, response);
                } else {
                  const result = await adapter.sendMessage({
                    chatId: msg.chatId,
                    text: response,
                    threadId: msg.threadId,
                  });
                  messageId = result.messageId;
                }
                sentAnyMessage = true;
              } catch {
                // Ignore edit errors
              }
              lastUpdate = Date.now();
            }
          }
          
          if (streamMsg.type === 'result') {
            this.handleSessionResult(session);
            break;
          }
        }
      } finally {
        clearInterval(typingInterval);
      }
      
      // Send final response
      if (response.trim()) {
        try {
          if (messageId) {
            await adapter.editMessage(msg.chatId, messageId, response);
          } else {
            await adapter.sendMessage({
              chatId: msg.chatId,
              text: response,
              threadId: msg.threadId,
            });
            sentAnyMessage = true;
          }
        } catch (sendError) {
          console.error(`[Agent:${this.configId}] Error sending response:`, sendError);
          if (!messageId) {
            await adapter.sendMessage({
              chatId: msg.chatId,
              text: response,
              threadId: msg.threadId,
            });
            sentAnyMessage = true;
          }
        }
      }
      

    } catch (error) {
      console.error(`[Agent:${this.configId}] Error:`, error);
      await adapter.sendMessage({
        chatId: msg.chatId,
        text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        threadId: msg.threadId,
      });
    } finally {
      session.close();
    }
  }
  
  /**
   * Handle session result - save agent/conversation IDs
   */
  private handleSessionResult(session: Session): void {
    const isNewAgent = !this.state.agentId && session.agentId;
    
    if (session.agentId && session.agentId !== this.state.agentId) {
      const currentBaseUrl = process.env.LETTA_BASE_URL || 'https://api.letta.com';
      this.state.agentId = session.agentId;
      this.state.baseUrl = currentBaseUrl;
      this.state.lastUsedAt = new Date().toISOString();
      if (!this.state.createdAt) {
        this.state.createdAt = new Date().toISOString();
      }
    }
    
    if (session.conversationId && session.conversationId !== this.state.conversationId) {
      this.state.conversationId = session.conversationId;
    }
    
    this.saveState();
    
    // Set agent name on new creation
    if (isNewAgent && session.agentId) {
      updateAgentName(session.agentId, this.name).catch(() => {});
    }
  }
  
  /**
   * Wrap a promise with timeout
   */
  private async withTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
    let timeoutId: NodeJS.Timeout;
    const timeoutPromise = new Promise<T>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutId!);
    }
  }
  
  /**
   * Resolve workspace path
   */
  private resolveWorkspace(workspace: string): string {
    if (workspace.startsWith('~')) {
      return workspace.replace('~', homedir());
    }
    return resolve(workspace);
  }
  
  /**
   * Load state from disk
   */
  private loadState(): AgentState {
    try {
      if (existsSync(this.statePath)) {
        const raw = readFileSync(this.statePath, 'utf-8');
        return JSON.parse(raw) as AgentState;
      }
    } catch (e) {
      console.error(`[Agent:${this.configId}] Failed to load state:`, e);
    }
    return { agentId: null };
  }
  
  /**
   * Save state to disk
   */
  private saveState(): void {
    try {
      writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
    } catch (e) {
      console.error(`[Agent:${this.configId}] Failed to save state:`, e);
    }
  }
}

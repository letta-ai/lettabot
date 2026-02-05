/**
 * LettaBot Core - Handles agent communication
 * 
 * Single agent, single conversation - chat continues across all channels.
 */

import { createAgent, createSession, resumeSession, type Session } from '@letta-ai/letta-code-sdk';
import { mkdirSync } from 'node:fs';
import type { ChannelAdapter } from '../channels/types.js';
import type { BotConfig, InboundMessage, TriggerContext } from './types.js';
import { Store } from './store.js';
import { updateAgentName, getPendingApprovals, rejectApproval, cancelRuns, disableAllToolApprovals } from '../tools/letta-api.js';
import { installSkillsToAgent } from '../skills/loader.js';
import { formatMessageEnvelope } from './formatter.js';
import { loadMemoryBlocks } from './memory.js';
import { SYSTEM_PROMPT } from './system-prompt.js';
import { StreamWatchdog } from './stream-watchdog.js';

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
   * Attempt to recover from stuck approval state.
   * Returns true if recovery was attempted, false if no recovery needed.
   * @param maxAttempts Maximum recovery attempts before giving up (default: 2)
   */
  private async attemptRecovery(maxAttempts = 2): Promise<{ recovered: boolean; shouldReset: boolean }> {
    if (!this.store.agentId) {
      return { recovered: false, shouldReset: false };
    }
    
    console.log('[Bot] Checking for pending approvals...');
    
    try {
      // Check for pending approvals FIRST, before checking attempt counter
      const pendingApprovals = await getPendingApprovals(
        this.store.agentId,
        this.store.conversationId || undefined
      );
      
      if (pendingApprovals.length === 0) {
        // No pending approvals, reset counter and continue
        this.store.resetRecoveryAttempts();
        return { recovered: false, shouldReset: false };
      }
      
      // There ARE pending approvals - check if we've exceeded max attempts
      const attempts = this.store.recoveryAttempts;
      if (attempts >= maxAttempts) {
        console.error(`[Bot] Recovery failed after ${attempts} attempts. Still have ${pendingApprovals.length} pending approval(s).`);
        console.error('[Bot] Try running: lettabot reset-conversation');
        return { recovered: false, shouldReset: true };
      }
      
      console.log(`[Bot] Found ${pendingApprovals.length} pending approval(s), attempting recovery (attempt ${attempts + 1}/${maxAttempts})...`);
      this.store.incrementRecoveryAttempts();
      
      // Reject all pending approvals
      for (const approval of pendingApprovals) {
        console.log(`[Bot] Rejecting approval for ${approval.toolName} (${approval.toolCallId})`);
        await rejectApproval(
          this.store.agentId,
          { toolCallId: approval.toolCallId, reason: 'Session was interrupted - retrying request' },
          this.store.conversationId || undefined
        );
      }
      
      // Cancel any active runs
      const runIds = [...new Set(pendingApprovals.map(a => a.runId))];
      if (runIds.length > 0) {
        console.log(`[Bot] Cancelling ${runIds.length} active run(s)...`);
        await cancelRuns(this.store.agentId, runIds);
      }
      
      // Disable tool approvals for the future (proactive fix)
      console.log('[Bot] Disabling tool approval requirements...');
      await disableAllToolApprovals(this.store.agentId);
      
      console.log('[Bot] Recovery completed');
      return { recovered: true, shouldReset: false };
      
    } catch (error) {
      console.error('[Bot] Recovery failed:', error);
      this.store.incrementRecoveryAttempts();
      return { recovered: false, shouldReset: this.store.recoveryAttempts >= maxAttempts };
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
    
    // Attempt recovery from stuck approval state before starting session
    const recovery = await this.attemptRecovery();
    if (recovery.shouldReset) {
      await adapter.sendMessage({
        chatId: msg.chatId,
        text: '(Session recovery failed after multiple attempts. Try: lettabot reset-conversation)',
        threadId: msg.threadId,
      });
      return;
    }
    if (recovery.recovered) {
      console.log('[Bot] Recovered from stuck approval, continuing with message processing');
    }
    
    // Create or resume session
    let session: Session;
    let usedDefaultConversation = false;
    let usedSpecificConversation = false;
    // Base options for sessions (systemPrompt/memory set via createAgent for new agents)
    const baseOptions = {
      permissionMode: 'bypassPermissions' as const,
      allowedTools: this.config.allowedTools,
      cwd: this.config.workingDir,
      // bypassPermissions mode auto-allows all tools, no canUseTool callback needed
      // But add logging callback to diagnose approval flow issues (#132)
      canUseTool: (toolName: string, toolInput: Record<string, unknown>) => {
        console.log(`[Bot] Tool approval requested: ${toolName} (should be auto-approved by bypassPermissions)`);
        console.log(`[Bot] WARNING: canUseTool callback should NOT be called when permissionMode=bypassPermissions`);
        // Return allow anyway as fallback
        return { behavior: 'allow' as const };
      },
    };
    console.log('[Bot] Session options:', { permissionMode: baseOptions.permissionMode, allowedTools: baseOptions.allowedTools?.length });
    
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
        const newAgentId = await createAgent({
          model: this.config.model,
          systemPrompt: SYSTEM_PROMPT,
          memory: loadMemoryBlocks(this.config.agentName),
        });
        session = createSession(newAgentId, baseOptions);
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
      if (initInfo.conversationId && initInfo.conversationId !== this.store.conversationId) {
        this.store.conversationId = initInfo.conversationId;
        console.log('[Bot] Saved conversation ID:', initInfo.conversationId);
      }

      // Send message to agent with metadata envelope
      const formattedMessage = formatMessageEnvelope(msg);
      try {
        await withTimeout(session.send(formattedMessage), 'Session send');
      } catch (sendError) {
        console.error('[Bot] Error sending message:', sendError);
        throw sendError;
      }
      
      // Stream response
      let response = '';
      let lastUpdate = Date.now();
      let messageId: string | null = null;
      let lastMsgType: string | null = null;
      let lastAssistantUuid: string | null = null;
      let sentAnyMessage = false;
      let receivedAnyData = false; // Track if we got ANY stream data
      const msgTypeCounts: Record<string, number> = {};
      
      // Stream watchdog - abort if idle for too long
      const watchdog = new StreamWatchdog({
        onAbort: () => {
          session.abort().catch((err) => {
            console.error('[Bot] Stream abort failed:', err);
          });
          try {
            session.close();
          } catch (err) {
            console.error('[Bot] Stream close failed:', err);
          }
        },
      });
      watchdog.start();
      
      // Helper to finalize and send current accumulated response
      const finalizeMessage = async () => {
        if (response.trim()) {
          try {
            if (messageId) {
              await adapter.editMessage(msg.chatId, messageId, response);
            } else {
              await adapter.sendMessage({ chatId: msg.chatId, text: response, threadId: msg.threadId });
            }
            sentAnyMessage = true;
            const preview = response.length > 50 ? response.slice(0, 50) + '...' : response;
            console.log(`[Bot] Sent: "${preview}"`);
          } catch {
            // Ignore send errors
          }
        }
        // Reset for next message bubble
        response = '';
        messageId = null;
        lastUpdate = Date.now();
      };
      
      // Keep typing indicator alive
      const typingInterval = setInterval(() => {
        adapter.sendTypingIndicator(msg.chatId).catch(() => {});
      }, 4000);
      
      try {
        for await (const streamMsg of session.stream()) {
          const msgUuid = (streamMsg as any).uuid;
          watchdog.ping();
          receivedAnyData = true;
          msgTypeCounts[streamMsg.type] = (msgTypeCounts[streamMsg.type] || 0) + 1;
          
          // Verbose logging: show every stream message type
          if (process.env.DEBUG_STREAM) {
            const preview = JSON.stringify(streamMsg).slice(0, 200);
            console.log(`[Stream] type=${streamMsg.type} ${preview}`);
          }
          
          // When message type changes, finalize the current message
          // This ensures different message types appear as separate bubbles
          if (lastMsgType && lastMsgType !== streamMsg.type && response.trim()) {
            await finalizeMessage();
          }
          
          // Log meaningful events (always, not just on type change for tools)
          if (streamMsg.type === 'tool_call') {
            const toolName = (streamMsg as any).toolName || 'unknown';
            console.log(`[Bot] Calling tool: ${toolName}`);
          } else if (streamMsg.type === 'tool_result') {
            const isError = (streamMsg as any).isError;
            const contentLen = (streamMsg as any).content?.length || 0;
            console.log(`[Bot] Tool completed: error=${isError}, resultLen=${contentLen}`);
          } else if (streamMsg.type === 'assistant' && lastMsgType !== 'assistant') {
            console.log(`[Bot] Generating response...`);
          } else if (streamMsg.type === 'reasoning' && lastMsgType !== 'reasoning') {
            console.log(`[Bot] Reasoning...`);
          } else if (streamMsg.type === 'init' && lastMsgType !== 'init') {
            console.log(`[Bot] Session initialized`);
          }
          lastMsgType = streamMsg.type;
          
          if (streamMsg.type === 'assistant') {
            // Check if this is a new assistant message (different UUID)
            if (msgUuid && lastAssistantUuid && msgUuid !== lastAssistantUuid && response.trim()) {
              await finalizeMessage();
            }
            lastAssistantUuid = msgUuid || lastAssistantUuid;
            
            response += streamMsg.content;
            
            // Stream updates only for channels that support editing (Telegram, Slack)
            const canEdit = adapter.supportsEditing?.() ?? true;
            if (canEdit && Date.now() - lastUpdate > 500 && response.length > 0) {
              try {
                if (messageId) {
                  await adapter.editMessage(msg.chatId, messageId, response);
                } else {
                  const result = await adapter.sendMessage({ chatId: msg.chatId, text: response, threadId: msg.threadId });
                  messageId = result.messageId;
                }
              } catch {
                // Ignore edit errors
              }
              lastUpdate = Date.now();
            }
          }
          
          if (streamMsg.type === 'result') {
            // Log result details for debugging (#132)
            const resultMsg = streamMsg as { result?: string; success?: boolean; error?: string };
            console.log(`[Bot] Stream result: success=${resultMsg.success}, hasResponse=${response.trim().length > 0}, resultLen=${resultMsg.result?.length || 0}`);
            console.log(`[Bot] Stream message counts:`, msgTypeCounts);
            if (resultMsg.error) {
              console.error(`[Bot] Result error: ${resultMsg.error}`);
            }
            
            // Check for potential stuck state (empty result usually means pending approval or error)
            if (resultMsg.success && resultMsg.result === '' && !response.trim()) {
              console.error('[Bot] Warning: Agent returned empty result with no response.');
              console.error('[Bot] This may indicate the agent is processing internally or encountered an issue.');
              console.error('[Bot] Agent ID:', this.store.agentId);
              console.error('[Bot] Conversation ID:', this.store.conversationId);
            }
            
            // Save agent ID and conversation ID
            if (session.agentId && session.agentId !== this.store.agentId) {
              const isNewAgent = !this.store.agentId;
              // Save agent ID along with the current server URL
              const currentBaseUrl = process.env.LETTA_BASE_URL || 'https://api.letta.com';
              this.store.setAgent(session.agentId, currentBaseUrl, session.conversationId || undefined);
              console.log('Saved agent ID:', session.agentId, 'conversation ID:', session.conversationId, 'on server:', currentBaseUrl);
              
              // Setup new agents: set name, install skills
              if (isNewAgent) {
                if (this.config.agentName && session.agentId) {
                  updateAgentName(session.agentId, this.config.agentName).catch(() => {});
                }
                if (session.agentId) {
                  installSkillsToAgent(session.agentId, this.config.skills);
                }
              }
            } else if (session.conversationId && session.conversationId !== this.store.conversationId) {
              // Update conversation ID if it changed
              this.store.conversationId = session.conversationId;
            }
            break;
          }

        }
      } finally {
        watchdog.stop();
        clearInterval(typingInterval);
      }
      
      // Send final response
      if (response.trim()) {
        try {
          if (messageId) {
            await adapter.editMessage(msg.chatId, messageId, response);
          } else {
            await adapter.sendMessage({ chatId: msg.chatId, text: response, threadId: msg.threadId });
          }
          sentAnyMessage = true;
          // Reset recovery counter on successful response
          this.store.resetRecoveryAttempts();
          const preview = response.length > 50 ? response.slice(0, 50) + '...' : response;
          console.log(`[Bot] Sent: "${preview}"`);
        } catch (sendError) {
          console.error('[Bot] Error sending response:', sendError);
          if (!messageId) {
            await adapter.sendMessage({ chatId: msg.chatId, text: response, threadId: msg.threadId });
            sentAnyMessage = true;
            // Reset recovery counter on successful response
            this.store.resetRecoveryAttempts();
          }
        }
      }
      
      // Only show "no response" if we never sent anything
      if (!sentAnyMessage) {
        if (!receivedAnyData) {
          // Stream timed out with NO data at all - likely stuck approval or connection issue
          console.error('[Bot] Stream received NO DATA - possible stuck tool approval');
          console.error('[Bot] Conversation:', this.store.conversationId);
          console.error('[Bot] This can happen when a previous session disconnected mid-tool-approval');
          console.error('[Bot] Recovery will be attempted automatically on the next message.');
          await adapter.sendMessage({ 
            chatId: msg.chatId, 
            text: '(Session interrupted. Please try your message again - recovery in progress.)', 
            threadId: msg.threadId 
          });
        } else {
          console.warn('[Bot] Stream received data but no assistant message');
          console.warn('[Bot] Message types received:', msgTypeCounts);
          console.warn('[Bot] This may indicate: ADE session conflict, agent processing, or internal error');
          // Give user informative message - avoid suggesting reset
          await adapter.sendMessage({ 
            chatId: msg.chatId, 
            text: '(Agent is processing but returned no response. Please try again.)', 
            threadId: msg.threadId 
          });
        }
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
    // Wait for any in-progress message processing to complete
    // This prevents 409 conflicts when heartbeats overlap with user messages
    while (this.processing) {
      console.log('[Bot] Waiting for message queue to finish before sendToAgent...');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Mark as processing to prevent queue from starting
    this.processing = true;
    console.log('[Bot] sendToAgent acquired processing lock');
    
    try {
      return await this._sendToAgentInternal(text, _context);
    } finally {
      this.processing = false;
      console.log('[Bot] sendToAgent released processing lock');
      // Trigger queue processing in case messages arrived while we were busy
      this.processQueue();
    }
  }
  
  private async _sendToAgentInternal(
    text: string,
    _context?: TriggerContext
  ): Promise<string> {
    // Base options for sessions (systemPrompt/memory set via createAgent for new agents)
    const baseOptions = {
      permissionMode: 'bypassPermissions' as const,
      allowedTools: this.config.allowedTools,
      cwd: this.config.workingDir,
      // bypassPermissions mode auto-allows all tools, no canUseTool callback needed
      // But add logging callback to diagnose approval flow issues (#132)
      canUseTool: (toolName: string, _toolInput: Record<string, unknown>) => {
        console.log(`[Bot] Tool approval requested in sendToAgent: ${toolName}`);
        console.log(`[Bot] WARNING: canUseTool callback should NOT be called when permissionMode=bypassPermissions`);
        return { behavior: 'allow' as const };
      },
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
      const newAgentId = await createAgent({
        model: this.config.model,
        systemPrompt: SYSTEM_PROMPT,
        memory: loadMemoryBlocks(this.config.agentName),
      });
      session = createSession(newAgentId, baseOptions);
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
      const watchdog = new StreamWatchdog({
        onAbort: () => {
          console.warn('[Bot] sendToAgent stream idle timeout, aborting session...');
          session.abort().catch((err) => {
            console.error('[Bot] sendToAgent abort failed:', err);
          });
          try {
            session.close();
          } catch (err) {
            console.error('[Bot] sendToAgent close failed:', err);
          }
        },
      });
      watchdog.start();
      
      try {
        for await (const msg of session.stream()) {
          watchdog.ping();
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
      } finally {
        watchdog.stop();
      }
      
      return response;
    } finally {
      session.close();
    }
  }
  
  /**
   * Deliver a message or file to a specific channel
   */
  async deliverToChannel(
    channelId: string,
    chatId: string,
    options: {
      text?: string;
      filePath?: string;
      kind?: 'image' | 'file';
    }
  ): Promise<string | undefined> {
    const adapter = this.channels.get(channelId);
    if (!adapter) {
      console.error(`Channel not found: ${channelId}`);
      throw new Error(`Channel not found: ${channelId}`);
    }

    // Send file if provided
    if (options.filePath) {
      if (typeof adapter.sendFile !== 'function') {
        throw new Error(`Channel ${channelId} does not support file sending`);
      }

      const result = await adapter.sendFile({
        chatId,
        filePath: options.filePath,
        caption: options.text,  // text becomes caption for files
        kind: options.kind,
      });

      return result.messageId;
    }

    // Send text message
    if (options.text) {
      const result = await adapter.sendMessage({ chatId, text: options.text });
      return result.messageId;
    }

    throw new Error('Either text or filePath must be provided');
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
   * Set agent ID (for container deploys that discover existing agents)
   */
  setAgentId(agentId: string): void {
    this.store.agentId = agentId;
    console.log(`[Bot] Agent ID set to: ${agentId}`);
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

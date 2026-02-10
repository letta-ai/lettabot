/**
 * LettaBot Core - Handles agent communication
 * 
 * Single agent, single conversation - chat continues across all channels.
 */

import { createAgent, createSession, resumeSession, imageFromFile, imageFromURL, type Session, type MessageContentItem, type SendMessage } from '@letta-ai/letta-code-sdk';
import { mkdirSync } from 'node:fs';
import type { ChannelAdapter } from '../channels/types.js';
import type { BotConfig, InboundMessage, TriggerContext } from './types.js';
import type { AgentSession } from './interfaces.js';
import { Store } from './store.js';
import { updateAgentName, getPendingApprovals, rejectApproval, cancelRuns, recoverOrphanedConversationApproval } from '../tools/letta-api.js';
import { installSkillsToAgent } from '../skills/loader.js';
import { formatMessageEnvelope, formatGroupBatchEnvelope, type SessionContextOptions } from './formatter.js';
import type { GroupBatcher } from './group-batcher.js';
import { loadMemoryBlocks } from './memory.js';
import { SYSTEM_PROMPT } from './system-prompt.js';
import { parseDirectives, stripActionsBlock, type Directive } from './directives.js';


/**
 * Detect if an error is a 409 CONFLICT from an orphaned approval.
 */
function isApprovalConflictError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes('waiting for approval')) return true;
    if (msg.includes('conflict') && msg.includes('approval')) return true;
  }
  const statusError = error as { status?: number };
  if (statusError?.status === 409) return true;
  return false;
}

/**
 * Detect if an error indicates a missing conversation or agent.
 * Only these errors should trigger the "create new conversation" fallback.
 * Auth, network, and protocol errors should NOT be retried.
 */
function isConversationMissingError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes('not found')) return true;
    if (msg.includes('conversation') && (msg.includes('missing') || msg.includes('does not exist'))) return true;
    if (msg.includes('agent') && msg.includes('not found')) return true;
  }
  const statusError = error as { status?: number };
  if (statusError?.status === 404) return true;
  return false;
}

const SUPPORTED_IMAGE_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
]);

async function buildMultimodalMessage(
  formattedText: string,
  msg: InboundMessage,
): Promise<SendMessage> {
  if (process.env.INLINE_IMAGES === 'false') {
    return formattedText;
  }

  const imageAttachments = (msg.attachments ?? []).filter(
    (a) => a.kind === 'image'
      && (a.localPath || a.url)
      && (!a.mimeType || SUPPORTED_IMAGE_MIMES.has(a.mimeType))
  );

  if (imageAttachments.length === 0) {
    return formattedText;
  }

  const content: MessageContentItem[] = [
    { type: 'text', text: formattedText },
  ];

  for (const attachment of imageAttachments) {
    try {
      if (attachment.localPath) {
        content.push(imageFromFile(attachment.localPath));
      } else if (attachment.url) {
        content.push(await imageFromURL(attachment.url));
      }
    } catch (err) {
      console.warn(`[Bot] Failed to load image ${attachment.name || 'unknown'}: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (content.length > 1) {
    console.log(`[Bot] Sending ${content.length - 1} inline image(s) to LLM`);
  }

  return content.length > 1 ? content : formattedText;
}

// ---------------------------------------------------------------------------
// Stream message type with toolCallId/uuid for dedup
// ---------------------------------------------------------------------------
export interface StreamMsg {
  type: string;
  content?: string;
  toolCallId?: string;
  toolName?: string;
  uuid?: string;
  isError?: boolean;
  result?: string;
  success?: boolean;
  error?: string;
  [key: string]: unknown;
}

export class LettaBot implements AgentSession {
  private store: Store;
  private config: BotConfig;
  private channels: Map<string, ChannelAdapter> = new Map();
  private messageQueue: Array<{ msg: InboundMessage; adapter: ChannelAdapter }> = [];
  private lastUserMessageTime: Date | null = null;
  
  // Callback to trigger heartbeat (set by main.ts)
  public onTriggerHeartbeat?: () => Promise<void>;
  private groupBatcher?: GroupBatcher;
  private groupIntervals: Map<string, number> = new Map();
  private instantGroupIds: Set<string> = new Set();
  private listeningGroupIds: Set<string> = new Set();
  private processing = false;
  
  constructor(config: BotConfig) {
    this.config = config;
    mkdirSync(config.workingDir, { recursive: true });
    this.store = new Store('lettabot-agent.json', config.agentName);
    console.log(`LettaBot initialized. Agent ID: ${this.store.agentId || '(new)'}`);
  }

  // =========================================================================
  // Response prefix (for multi-agent group chat identification)
  // =========================================================================

  /**
   * Prepend configured displayName prefix to outbound agent responses.
   * Returns text unchanged if no prefix is configured.
   */
  private prefixResponse(text: string): string {
    if (!this.config.displayName) return text;
    return `${this.config.displayName}: ${text}`;
  }

  // =========================================================================
  // Session options (shared by processMessage and sendToAgent)
  // =========================================================================

  private get baseSessionOptions() {
    return {
      permissionMode: 'bypassPermissions' as const,
      allowedTools: this.config.allowedTools,
      cwd: this.config.workingDir,
      canUseTool: (toolName: string, _toolInput: Record<string, unknown>) => {
        console.log(`[Bot] Tool approval requested: ${toolName} (should be auto-approved by bypassPermissions)`);
        return { behavior: 'allow' as const };
      },
    };
  }

  // =========================================================================
  // Session lifecycle helpers
  // =========================================================================

  /**
   * Execute parsed directives (reactions, etc.) via the channel adapter.
   * Returns true if any directive was successfully executed.
   */
  private async executeDirectives(
    directives: Directive[],
    adapter: ChannelAdapter,
    chatId: string,
    fallbackMessageId?: string,
  ): Promise<boolean> {
    let acted = false;
    for (const directive of directives) {
      if (directive.type === 'react') {
        const targetId = directive.messageId || fallbackMessageId;
        if (!adapter.addReaction) {
          console.warn(`[Bot] Directive react skipped: ${adapter.name} does not support addReaction`);
          continue;
        }
        if (targetId) {
          try {
            await adapter.addReaction(chatId, targetId, directive.emoji);
            acted = true;
            console.log(`[Bot] Directive: reacted with ${directive.emoji}`);
          } catch (err) {
            console.warn('[Bot] Directive react failed:', err instanceof Error ? err.message : err);
          }
        }
      }
    }
    return acted;
  }

  /**
   * Create or resume a session with automatic fallback.
   * 
   * Priority: conversationId → agentId (default conv) → createAgent
   * If resume fails (conversation missing), falls back to createSession.
   */
  private async getSession(): Promise<Session> {
    const opts = this.baseSessionOptions;

    if (this.store.conversationId) {
      process.env.LETTA_AGENT_ID = this.store.agentId || undefined;
      return resumeSession(this.store.conversationId, opts);
    }
    if (this.store.agentId) {
      process.env.LETTA_AGENT_ID = this.store.agentId;
      // Create a new conversation instead of resuming the default.
      // This handles the case where the default conversation was deleted
      // or never created (e.g., after migrations).
      return createSession(this.store.agentId, opts);
    }

    // Create new agent -- persist immediately so we don't orphan it on later failures
    console.log('[Bot] Creating new agent');
    const newAgentId = await createAgent({
      systemPrompt: SYSTEM_PROMPT,
      memory: loadMemoryBlocks(this.config.agentName),
    });
    const currentBaseUrl = process.env.LETTA_BASE_URL || 'https://api.letta.com';
    this.store.setAgent(newAgentId, currentBaseUrl);
    console.log('[Bot] Saved new agent ID:', newAgentId);

    // First-run setup: name and skills
    if (this.config.agentName) {
      updateAgentName(newAgentId, this.config.agentName).catch(() => {});
    }
    installSkillsToAgent(newAgentId, this.config.skills);

    return createSession(newAgentId, opts);
  }

  /**
   * Persist conversation ID after a successful session result.
   * Agent ID and first-run setup are handled eagerly in getSession().
   */
  private persistSessionState(session: Session): void {
    // Agent ID already persisted in getSession() on creation.
    // Here we only update if the server returned a different one (shouldn't happen).
    if (session.agentId && session.agentId !== this.store.agentId) {
      const currentBaseUrl = process.env.LETTA_BASE_URL || 'https://api.letta.com';
      this.store.setAgent(session.agentId, currentBaseUrl, session.conversationId || undefined);
      console.log('[Bot] Agent ID updated:', session.agentId);
    } else if (session.conversationId && session.conversationId !== this.store.conversationId) {
      this.store.conversationId = session.conversationId;
      console.log('[Bot] Conversation ID updated:', session.conversationId);
    }
  }

  /**
   * Send a message and return a deduplicated stream.
   * 
   * Handles:
   * - Session creation with fallback chain
   * - CONFLICT recovery from orphaned approvals (retry once)
   * - Conversation-not-found fallback (create new conversation)
   * - Tool call deduplication
   * - Session persistence after result
   * 
   * Caller is responsible for consuming the stream and closing the session.
   */
  private async runSession(
    message: SendMessage,
    options: { retried?: boolean } = {},
  ): Promise<{ session: Session; stream: () => AsyncGenerator<StreamMsg> }> {
    const { retried = false } = options;

    let session = await this.getSession();

    // Send message with fallback chain
    try {
      await session.send(message);
    } catch (error) {
      // 409 CONFLICT from orphaned approval
      if (!retried && isApprovalConflictError(error) && this.store.agentId && this.store.conversationId) {
        console.log('[Bot] CONFLICT detected - attempting orphaned approval recovery...');
        session.close();
        const result = await recoverOrphanedConversationApproval(
          this.store.agentId,
          this.store.conversationId
        );
        if (result.recovered) {
          console.log(`[Bot] Recovery succeeded (${result.details}), retrying...`);
          return this.runSession(message, { retried: true });
        }
        console.error(`[Bot] Orphaned approval recovery failed: ${result.details}`);
        throw error;
      }

      // Conversation/agent not found - try creating a new conversation.
      // Only retry on errors that indicate missing conversation/agent, not
      // on auth, network, or protocol errors (which would just fail again).
      if (this.store.agentId && isConversationMissingError(error)) {
        console.warn('[Bot] Conversation not found, creating a new conversation...');
        session.close();
        session = createSession(this.store.agentId, this.baseSessionOptions);
        await session.send(message);
      } else {
        throw error;
      }
    }

    // Persist conversation ID immediately after successful send, before streaming.
    // If streaming disconnects/aborts before result, the next turn will still
    // resume the correct conversation instead of forking a new one.
    if (session.conversationId && session.conversationId !== this.store.conversationId) {
      this.store.conversationId = session.conversationId;
      console.log('[Bot] Saved conversation ID:', session.conversationId);
    }

    // Return session and a deduplicated stream generator
    const seenToolCallIds = new Set<string>();
    const self = this;

    async function* dedupedStream(): AsyncGenerator<StreamMsg> {
      for await (const raw of session.stream()) {
        const msg = raw as StreamMsg;

        // Deduplicate tool_call chunks (server streams token-by-token)
        if (msg.type === 'tool_call') {
          const id = msg.toolCallId;
          if (id && seenToolCallIds.has(id)) continue;
          if (id) seenToolCallIds.add(id);
        }

        yield msg;

        // Persist state on result
        if (msg.type === 'result') {
          self.persistSessionState(session);
          break;
        }
      }
    }

    return { session, stream: dedupedStream };
  }

  // =========================================================================
  // Channel management
  // =========================================================================

  registerChannel(adapter: ChannelAdapter): void {
    adapter.onMessage = (msg) => this.handleMessage(msg, adapter);
    adapter.onCommand = (cmd) => this.handleCommand(cmd);
    this.channels.set(adapter.id, adapter);
    console.log(`Registered channel: ${adapter.name}`);
  }
  
  setGroupBatcher(batcher: GroupBatcher, intervals: Map<string, number>, instantGroupIds?: Set<string>, listeningGroupIds?: Set<string>): void {
    this.groupBatcher = batcher;
    this.groupIntervals = intervals;
    if (instantGroupIds) {
      this.instantGroupIds = instantGroupIds;
    }
    if (listeningGroupIds) {
      this.listeningGroupIds = listeningGroupIds;
    }
    console.log('[Bot] Group batcher configured');
  }

  processGroupBatch(msg: InboundMessage, adapter: ChannelAdapter): void {
    const count = msg.batchedMessages?.length || 0;
    console.log(`[Bot] Group batch: ${count} messages from ${msg.channel}:${msg.chatId}`);
    const effective = (count === 1 && msg.batchedMessages)
      ? msg.batchedMessages[0]
      : msg;

    // Check if this group is in listening mode
    const isListening = this.listeningGroupIds.has(`${msg.channel}:${msg.chatId}`)
      || (msg.serverId && this.listeningGroupIds.has(`${msg.channel}:${msg.serverId}`));
    if (isListening && !msg.wasMentioned) {
      effective.isListeningMode = true;
    }

    this.messageQueue.push({ msg: effective, adapter });
    if (!this.processing) {
      this.processQueue().catch(err => console.error('[Queue] Fatal error in processQueue:', err));
    }
  }

  // =========================================================================
  // Commands
  // =========================================================================

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
        if (!this.onTriggerHeartbeat) {
          return '⚠️ Heartbeat service not configured';
        }
        this.onTriggerHeartbeat().catch(err => {
          console.error('[Heartbeat] Manual trigger failed:', err);
        });
        return '⏰ Heartbeat triggered (silent mode - check server logs)';
      }
      case 'reset': {
        const oldConversationId = this.store.conversationId;
        this.store.conversationId = null;
        this.store.resetRecoveryAttempts();
        console.log(`[Command] /reset - conversation cleared (was: ${oldConversationId})`);
        return 'Conversation reset. Send a message to start a new conversation. (Agent memory is preserved.)';
      }
      default:
        return null;
    }
  }

  // =========================================================================
  // Start / Stop
  // =========================================================================
  
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
  
  async stop(): Promise<void> {
    for (const adapter of this.channels.values()) {
      try {
        await adapter.stop();
      } catch (e) {
        console.error(`Failed to stop channel ${adapter.id}:`, e);
      }
    }
  }

  // =========================================================================
  // Approval recovery
  // =========================================================================
  
  private async attemptRecovery(maxAttempts = 2): Promise<{ recovered: boolean; shouldReset: boolean }> {
    if (!this.store.agentId) {
      return { recovered: false, shouldReset: false };
    }
    
    console.log('[Bot] Checking for pending approvals...');
    
    try {
      const pendingApprovals = await getPendingApprovals(
        this.store.agentId,
        this.store.conversationId || undefined
      );
      
      if (pendingApprovals.length === 0) {
        if (this.store.conversationId) {
          const convResult = await recoverOrphanedConversationApproval(
            this.store.agentId!,
            this.store.conversationId
          );
          if (convResult.recovered) {
            console.log(`[Bot] Conversation-level recovery succeeded: ${convResult.details}`);
            return { recovered: true, shouldReset: false };
          }
        }
        this.store.resetRecoveryAttempts();
        return { recovered: false, shouldReset: false };
      }
      
      const attempts = this.store.recoveryAttempts;
      if (attempts >= maxAttempts) {
        console.error(`[Bot] Recovery failed after ${attempts} attempts. Still have ${pendingApprovals.length} pending approval(s).`);
        return { recovered: false, shouldReset: true };
      }
      
      console.log(`[Bot] Found ${pendingApprovals.length} pending approval(s), attempting recovery (attempt ${attempts + 1}/${maxAttempts})...`);
      this.store.incrementRecoveryAttempts();
      
      for (const approval of pendingApprovals) {
        console.log(`[Bot] Rejecting approval for ${approval.toolName} (${approval.toolCallId})`);
        await rejectApproval(
          this.store.agentId,
          { toolCallId: approval.toolCallId, reason: 'Session was interrupted - retrying request' },
          this.store.conversationId || undefined
        );
      }
      
      const runIds = [...new Set(pendingApprovals.map(a => a.runId))];
      if (runIds.length > 0) {
        console.log(`[Bot] Cancelling ${runIds.length} active run(s)...`);
        await cancelRuns(this.store.agentId, runIds);
      }
      
      console.log('[Bot] Recovery completed');
      return { recovered: true, shouldReset: false };
      
    } catch (error) {
      console.error('[Bot] Recovery failed:', error);
      this.store.incrementRecoveryAttempts();
      return { recovered: false, shouldReset: this.store.recoveryAttempts >= maxAttempts };
    }
  }

  // =========================================================================
  // Message queue
  // =========================================================================
  
  private async handleMessage(msg: InboundMessage, adapter: ChannelAdapter): Promise<void> {
    console.log(`[${msg.channel}] Message from ${msg.userId}: ${msg.text}`);

    if (msg.isGroup && this.groupBatcher) {
      const isInstant = this.instantGroupIds.has(`${msg.channel}:${msg.chatId}`)
        || (msg.serverId && this.instantGroupIds.has(`${msg.channel}:${msg.serverId}`));
      const debounceMs = isInstant ? 0 : (this.groupIntervals.get(msg.channel) ?? 5000);
      console.log(`[Bot] Group message routed to batcher (debounce=${debounceMs}ms, mentioned=${msg.wasMentioned}, instant=${!!isInstant})`);
      this.groupBatcher.enqueue(msg, adapter, debounceMs);
      return;
    }

    this.messageQueue.push({ msg, adapter });
    if (!this.processing) {
      this.processQueue().catch(err => console.error('[Queue] Fatal error in processQueue:', err));
    }
  }
  
  private async processQueue(): Promise<void> {
    if (this.processing || this.messageQueue.length === 0) return;
    
    this.processing = true;
    
    while (this.messageQueue.length > 0) {
      const { msg, adapter } = this.messageQueue.shift()!;
      try {
        await this.processMessage(msg, adapter);
      } catch (error) {
        console.error('[Queue] Error processing message:', error);
      }
    }
    
    console.log('[Queue] Finished processing all messages');
    this.processing = false;
  }

  // =========================================================================
  // processMessage - User-facing message handling
  // =========================================================================
  
  private async processMessage(msg: InboundMessage, adapter: ChannelAdapter, retried = false): Promise<void> {
    // Track timing and last target
    this.lastUserMessageTime = new Date();

    // Skip heartbeat target update for listening mode (don't redirect heartbeats)
    if (!msg.isListeningMode) {
      this.store.lastMessageTarget = {
        channel: msg.channel,
        chatId: msg.chatId,
        messageId: msg.messageId,
        updatedAt: new Date().toISOString(),
      };
    }

    // Skip typing indicator for listening mode
    if (!msg.isListeningMode) {
      await adapter.sendTypingIndicator(msg.chatId);
    }

    // Pre-send approval recovery
    const recovery = await this.attemptRecovery();
    if (recovery.shouldReset) {
      if (!msg.isListeningMode) {
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: '(Session recovery failed after multiple attempts. Try: lettabot reset-conversation)',
          threadId: msg.threadId,
        });
      }
      return;
    }

    // Format message with metadata envelope
    const prevTarget = this.store.lastMessageTarget;
    const isNewChatSession = !prevTarget || prevTarget.chatId !== msg.chatId || prevTarget.channel !== msg.channel;
    const sessionContext: SessionContextOptions | undefined = isNewChatSession ? {
      agentId: this.store.agentId || undefined,
      serverUrl: process.env.LETTA_BASE_URL || this.store.baseUrl || 'https://api.letta.com',
    } : undefined;

    const formattedText = msg.isBatch && msg.batchedMessages
      ? formatGroupBatchEnvelope(msg.batchedMessages, {}, msg.isListeningMode)
      : formatMessageEnvelope(msg, {}, sessionContext);
    const messageToSend = await buildMultimodalMessage(formattedText, msg);

    // Run session
    let session: Session | null = null;
    try {
      const run = await this.runSession(messageToSend, { retried });
      session = run.session;

      // Stream response with delivery
      let response = '';
      let lastUpdate = Date.now();
      let messageId: string | null = null;
      let lastMsgType: string | null = null;
      let lastAssistantUuid: string | null = null;
      let sentAnyMessage = false;
      let receivedAnyData = false;
      const msgTypeCounts: Record<string, number> = {};
      
      const finalizeMessage = async () => {
        if (response.trim() === '<no-reply/>') {
          console.log('[Bot] Agent chose not to reply (no-reply marker)');
          sentAnyMessage = true;
          response = '';
          messageId = null;
          lastUpdate = Date.now();
          return;
        }
        // Parse and execute XML directives before sending
        if (response.trim()) {
          const { cleanText, directives } = parseDirectives(response);
          response = cleanText;
          if (await this.executeDirectives(directives, adapter, msg.chatId, msg.messageId)) {
            sentAnyMessage = true;
          }
        }
        if (response.trim()) {
          try {
            const prefixed = this.prefixResponse(response);
            if (messageId) {
              await adapter.editMessage(msg.chatId, messageId, prefixed);
            } else {
              await adapter.sendMessage({ chatId: msg.chatId, text: prefixed, threadId: msg.threadId });
            }
            sentAnyMessage = true;
          } catch {
            if (messageId) sentAnyMessage = true;
          }
        }
        response = '';
        messageId = null;
        lastUpdate = Date.now();
      };
      
      const typingInterval = setInterval(() => {
        adapter.sendTypingIndicator(msg.chatId).catch(() => {});
      }, 4000);
      
      try {
        for await (const streamMsg of run.stream()) {
          receivedAnyData = true;
          msgTypeCounts[streamMsg.type] = (msgTypeCounts[streamMsg.type] || 0) + 1;
          
          const preview = JSON.stringify(streamMsg).slice(0, 300);
          console.log(`[Stream] type=${streamMsg.type} ${preview}`);
          
          // Finalize on type change (avoid double-handling when result provides full response)
          if (lastMsgType && lastMsgType !== streamMsg.type && response.trim() && streamMsg.type !== 'result') {
            await finalizeMessage();
          }
          
          // Tool loop detection
          const maxToolCalls = this.config.maxToolCalls ?? 100;
          if (streamMsg.type === 'tool_call' && (msgTypeCounts['tool_call'] || 0) >= maxToolCalls) {
            console.error(`[Bot] Agent stuck in tool loop (${msgTypeCounts['tool_call']} calls), aborting`);
            session.abort().catch(() => {});
            response = '(Agent got stuck in a tool loop and was stopped. Try sending your message again.)';
            break;
          }

          // Log meaningful events
          if (streamMsg.type === 'tool_call') {
            console.log(`[Bot] Calling tool: ${streamMsg.toolName || 'unknown'}`);
          } else if (streamMsg.type === 'tool_result') {
            console.log(`[Bot] Tool completed: error=${streamMsg.isError}, resultLen=${(streamMsg as any).content?.length || 0}`);
          } else if (streamMsg.type === 'assistant' && lastMsgType !== 'assistant') {
            console.log(`[Bot] Generating response...`);
          } else if (streamMsg.type === 'reasoning' && lastMsgType !== 'reasoning') {
            console.log(`[Bot] Reasoning...`);
          }
          lastMsgType = streamMsg.type;
          
          if (streamMsg.type === 'assistant') {
            const msgUuid = streamMsg.uuid;
            if (msgUuid && lastAssistantUuid && msgUuid !== lastAssistantUuid && response.trim()) {
              await finalizeMessage();
            }
            lastAssistantUuid = msgUuid || lastAssistantUuid;
            
            response += streamMsg.content || '';
            
            // Live-edit streaming for channels that support it
            // Hold back streaming edits while response could still be <no-reply/> or <actions> block
            const canEdit = adapter.supportsEditing?.() ?? true;
            const trimmed = response.trim();
            const mayBeHidden = '<no-reply/>'.startsWith(trimmed)
              || '<actions>'.startsWith(trimmed)
              || (trimmed.startsWith('<actions') && !trimmed.includes('</actions>'));
            // Strip any completed <actions> block from the streaming text
            const streamText = stripActionsBlock(response).trim();
            if (canEdit && !mayBeHidden && streamText.length > 0 && Date.now() - lastUpdate > 500) {
              try {
                const prefixedStream = this.prefixResponse(streamText);
                if (messageId) {
                  await adapter.editMessage(msg.chatId, messageId, prefixedStream);
                } else {
                  const result = await adapter.sendMessage({ chatId: msg.chatId, text: prefixedStream, threadId: msg.threadId });
                  messageId = result.messageId;
                  sentAnyMessage = true;
                }
              } catch (editErr) {
                console.warn('[Bot] Streaming edit failed:', editErr instanceof Error ? editErr.message : editErr);
              }
              lastUpdate = Date.now();
            }
          }
          
          if (streamMsg.type === 'result') {
            const resultText = typeof streamMsg.result === 'string' ? streamMsg.result : '';
            if (resultText.trim().length > 0) {
              response = resultText;
            }
            const hasResponse = response.trim().length > 0;
            const isTerminalError = streamMsg.success === false || !!streamMsg.error;
            console.log(`[Bot] Stream result: success=${streamMsg.success}, hasResponse=${hasResponse}, resultLen=${resultText.length}`);
            console.log(`[Bot] Stream message counts:`, msgTypeCounts);
            if (streamMsg.error) {
              const detail = resultText.trim();
              if (detail) {
                console.error(`[Bot] Result error: ${streamMsg.error} (${detail.slice(0, 200)})`);
              } else {
                console.error(`[Bot] Result error: ${streamMsg.error}`);
              }
            }

            // Retry once when stream ends without any assistant text.
            // This catches both empty-success and terminal-error runs.
            // TODO(letta-code-sdk#31): Remove once SDK handles HITL approvals in bypassPermissions mode.
            // Only retry if we never sent anything to the user. hasResponse tracks
            // the current buffer, but finalizeMessage() clears it on type changes.
            // sentAnyMessage is the authoritative "did we deliver output" flag.
            const nothingDelivered = !hasResponse && !sentAnyMessage;
            const shouldRetryForEmptyResult = streamMsg.success && resultText === '' && nothingDelivered;
            const shouldRetryForErrorResult = isTerminalError && nothingDelivered;
            if (shouldRetryForEmptyResult || shouldRetryForErrorResult) {
              if (shouldRetryForEmptyResult) {
                console.error('[Bot] Warning: Agent returned empty result with no response.');
              }
              if (shouldRetryForErrorResult) {
                console.error('[Bot] Warning: Agent returned terminal error result with no response.');
              }

              if (!retried && this.store.agentId && this.store.conversationId) {
                const reason = shouldRetryForErrorResult ? 'error result' : 'empty result';
                console.log(`[Bot] ${reason} - attempting orphaned approval recovery...`);
                session.close();
                session = null;
                clearInterval(typingInterval);
                const convResult = await recoverOrphanedConversationApproval(
                  this.store.agentId,
                  this.store.conversationId
                );
                if (convResult.recovered) {
                  console.log(`[Bot] Recovery succeeded (${convResult.details}), retrying message...`);
                  return this.processMessage(msg, adapter, true);
                }
                console.warn(`[Bot] No orphaned approvals found: ${convResult.details}`);

                // Some client-side approval failures do not surface as pending approvals.
                // Retry once anyway in case the previous run terminated mid-tool cycle.
                if (shouldRetryForErrorResult) {
                  console.log('[Bot] Retrying once after terminal error (no orphaned approvals detected)...');
                  return this.processMessage(msg, adapter, true);
                }
              }
            }

            if (isTerminalError && !hasResponse && !sentAnyMessage) {
              const err = streamMsg.error || 'unknown error';
              response = `(Agent run failed: ${err}. Try sending your message again.)`;
            }
            
            break;
          }
        }
      } finally {
        clearInterval(typingInterval);
        adapter.stopTypingIndicator?.(msg.chatId)?.catch(() => {});
      }
      
      // Handle no-reply marker
      if (response.trim() === '<no-reply/>') {
        sentAnyMessage = true;
        response = '';
      }

      // Parse and execute XML directives (e.g. <actions><react emoji="eyes" /></actions>)
      if (response.trim()) {
        const { cleanText, directives } = parseDirectives(response);
        response = cleanText;
        if (await this.executeDirectives(directives, adapter, msg.chatId, msg.messageId)) {
          sentAnyMessage = true;
        }
      }

      // Detect unsupported multimodal
      if (Array.isArray(messageToSend) && response.includes('[Image omitted]')) {
        console.warn('[Bot] Model does not support images -- consider a vision-capable model or features.inlineImages: false');
      }

      // Listening mode: agent processed for memory, suppress response delivery
      if (msg.isListeningMode) {
        console.log(`[Bot] Listening mode: processed ${msg.channel}:${msg.chatId} for memory (response suppressed)`);
        return;
      }

      // Send final response
      if (response.trim()) {
        const prefixedFinal = this.prefixResponse(response);
        try {
          if (messageId) {
            await adapter.editMessage(msg.chatId, messageId, prefixedFinal);
          } else {
            await adapter.sendMessage({ chatId: msg.chatId, text: prefixedFinal, threadId: msg.threadId });
          }
          sentAnyMessage = true;
          this.store.resetRecoveryAttempts();
        } catch {
          // Edit failed -- send as new message so user isn't left with truncated text
          try {
            await adapter.sendMessage({ chatId: msg.chatId, text: prefixedFinal, threadId: msg.threadId });
            sentAnyMessage = true;
            this.store.resetRecoveryAttempts();
          } catch (retryError) {
            console.error('[Bot] Retry send also failed:', retryError);
          }
        }
      }
      
      // Handle no response
      if (!sentAnyMessage) {
        if (!receivedAnyData) {
          console.error('[Bot] Stream received NO DATA - possible stuck state');
          await adapter.sendMessage({ 
            chatId: msg.chatId, 
            text: '(Session interrupted. Try: lettabot reset-conversation)', 
            threadId: msg.threadId 
          });
        } else {
          const hadToolActivity = (msgTypeCounts['tool_call'] || 0) > 0 || (msgTypeCounts['tool_result'] || 0) > 0;
          if (hadToolActivity) {
            console.log('[Bot] Agent had tool activity but no assistant message - likely sent via tool');
          } else {
            const convIdShort = this.store.conversationId?.slice(0, 8) || 'none';
            await adapter.sendMessage({ 
              chatId: msg.chatId, 
              text: `(No response. Conversation: ${convIdShort}... Try: lettabot reset-conversation)`, 
              threadId: msg.threadId 
            });
          }
        }
      }
      
    } catch (error) {
      console.error('[Bot] Error processing message:', error);
      try {
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          threadId: msg.threadId,
        });
      } catch (sendError) {
        console.error('[Bot] Failed to send error message to channel:', sendError);
      }
    } finally {
      session?.close();
    }
  }

  // =========================================================================
  // sendToAgent - Background triggers (heartbeats, cron, webhooks)
  // =========================================================================
  
  async sendToAgent(
    text: string,
    _context?: TriggerContext
  ): Promise<string> {
    // Serialize with message queue to prevent 409 conflicts
    while (this.processing) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    this.processing = true;
    
    try {
      const { session, stream } = await this.runSession(text);
      
      try {
        let response = '';
        for await (const msg of stream()) {
          if (msg.type === 'assistant') {
            response += msg.content || '';
          }
          if (msg.type === 'result') {
            // TODO(letta-code-sdk#31): Remove once SDK handles HITL approvals in bypassPermissions mode.
            if (msg.success === false || msg.error) {
              const detail = typeof msg.result === 'string' ? msg.result.trim() : '';
              throw new Error(detail ? `Agent run failed: ${msg.error || 'error'} (${detail})` : `Agent run failed: ${msg.error || 'error'}`);
            }
            break;
          }
        }
        return response;
      } finally {
        session.close();
      }
    } finally {
      this.processing = false;
      this.processQueue();
    }
  }

  /**
   * Stream a message to the agent, yielding chunks as they arrive.
   * Same lifecycle as sendToAgent() but yields StreamMsg instead of accumulating.
   */
  async *streamToAgent(
    text: string,
    _context?: TriggerContext
  ): AsyncGenerator<StreamMsg> {
    // Serialize with message queue to prevent 409 conflicts
    while (this.processing) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    this.processing = true;

    try {
      const { session, stream } = await this.runSession(text);

      try {
        yield* stream();
      } finally {
        session.close();
      }
    } finally {
      this.processing = false;
      this.processQueue();
    }
  }

  // =========================================================================
  // Channel delivery + status
  // =========================================================================
  
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
      const result = await adapter.sendMessage({ chatId, text: this.prefixResponse(options.text) });
      return result.messageId;
    }

    throw new Error('Either text or filePath must be provided');
  }

  getStatus(): { agentId: string | null; channels: string[] } {
    return {
      agentId: this.store.agentId,
      channels: Array.from(this.channels.keys()),
    };
  }
  
  setAgentId(agentId: string): void {
    this.store.agentId = agentId;
    console.log(`[Bot] Agent ID set to: ${agentId}`);
  }
  
  reset(): void {
    this.store.reset();
    console.log('Agent reset');
  }
  
  getLastMessageTarget(): { channel: string; chatId: string } | null {
    return this.store.lastMessageTarget || null;
  }
  
  getLastUserMessageTime(): Date | null {
    return this.lastUserMessageTime;
  }
}

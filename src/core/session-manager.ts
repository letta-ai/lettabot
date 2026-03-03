/**
 * SessionManager - Owns CLI subprocess lifecycle, session creation,
 * LRU eviction, invalidation, and message send+stream.
 *
 * Extracted from bot.ts to isolate session concerns from message
 * routing, channel management, and directive execution.
 */

import { createAgent, createSession, resumeSession, type Session, type SendMessage, type CanUseToolCallback } from '@letta-ai/letta-code-sdk';
import type { BotConfig, StreamMsg } from './types.js';
import { isApprovalConflictError, isConversationMissingError, isAgentMissingFromInitError } from './errors.js';
import { Store } from './store.js';
import { updateAgentName, recoverOrphanedConversationApproval } from '../tools/letta-api.js';
import { installSkillsToAgent, prependSkillDirsToPath } from '../skills/loader.js';
import { loadMemoryBlocks } from './memory.js';
import { SYSTEM_PROMPT } from './system-prompt.js';
import { createManageTodoTool } from '../tools/todo.js';
import { syncTodosFromTool } from '../todo/store.js';
import { createLogger } from '../logger.js';

const log = createLogger('Session');

export class SessionManager {
  private readonly store: Store;
  private readonly config: BotConfig;

  // Active processing keys -- owned by LettaBot, read here for LRU eviction safety.
  private readonly processingKeys: ReadonlySet<string>;
  // Stale-result fingerprints -- owned by LettaBot, cleaned here on invalidation/eviction.
  private readonly lastResultRunFingerprints: Map<string, string>;

  // Persistent sessions: reuse CLI subprocesses across messages.
  private sessions: Map<string, Session> = new Map();
  private sessionLastUsed: Map<string, number> = new Map();
  private sessionCreationLocks: Map<string, { promise: Promise<Session>; generation: number }> = new Map();
  private sessionGenerations: Map<string, number> = new Map();

  // Per-message tool callback. Updated before each send() so the Session
  // options (which hold a stable wrapper) route to the current handler.
  private currentCanUseTool: CanUseToolCallback | undefined;

  // Stable callback wrapper so the Session options never change, but we can
  // swap out the per-message handler before each send().
  private readonly sessionCanUseTool: CanUseToolCallback = async (toolName, toolInput) => {
    if (this.currentCanUseTool) {
      return this.currentCanUseTool(toolName, toolInput);
    }
    return { behavior: 'allow' as const };
  };

  constructor(
    store: Store,
    config: BotConfig,
    processingKeys: ReadonlySet<string>,
    lastResultRunFingerprints: Map<string, string>,
  ) {
    this.store = store;
    this.config = config;
    this.processingKeys = processingKeys;
    this.lastResultRunFingerprints = lastResultRunFingerprints;
  }

  // =========================================================================
  // Todo sync (stream utility)
  // =========================================================================

  private getTodoAgentKey(): string {
    return this.store.agentId || this.config.agentName || 'LettaBot';
  }

  /** Sync TodoWrite tool calls to the persistent heartbeat store. */
  syncTodoToolCall(streamMsg: StreamMsg): void {
    if (streamMsg.type !== 'tool_call') return;

    const normalizedToolName = (streamMsg.toolName || '').toLowerCase();
    const isBuiltInTodoTool = normalizedToolName === 'todowrite'
      || normalizedToolName === 'todo_write'
      || normalizedToolName === 'writetodos'
      || normalizedToolName === 'write_todos';
    if (!isBuiltInTodoTool) return;

    const input = (streamMsg.toolInput && typeof streamMsg.toolInput === 'object')
      ? streamMsg.toolInput as Record<string, unknown>
      : null;
    if (!input || !Array.isArray(input.todos)) return;

    const incoming: Array<{
      content?: string;
      description?: string;
      status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
    }> = [];
    for (const item of input.todos) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      const statusRaw = typeof obj.status === 'string' ? obj.status : '';
      if (!['pending', 'in_progress', 'completed', 'cancelled'].includes(statusRaw)) continue;
      incoming.push({
        content: typeof obj.content === 'string' ? obj.content : undefined,
        description: typeof obj.description === 'string' ? obj.description : undefined,
        status: statusRaw as 'pending' | 'in_progress' | 'completed' | 'cancelled',
      });
    }
    if (incoming.length === 0) return;

    try {
      const summary = syncTodosFromTool(this.getTodoAgentKey(), incoming);
      if (summary.added > 0 || summary.updated > 0) {
        log.info(`Synced ${summary.totalIncoming} todo(s) from ${streamMsg.toolName} into heartbeat store (added=${summary.added}, updated=${summary.updated})`);
      }
    } catch (err) {
      log.warn('Failed to sync TodoWrite todos:', err instanceof Error ? err.message : err);
    }
  }

  // =========================================================================
  // Session options & timeout
  // =========================================================================

  private getSessionTimeoutMs(): number {
    const envTimeoutMs = Number(process.env.LETTA_SESSION_TIMEOUT_MS);
    if (Number.isFinite(envTimeoutMs) && envTimeoutMs > 0) {
      return envTimeoutMs;
    }
    return 60000;
  }

  async withSessionTimeout<T>(
    promise: Promise<T>,
    label: string,
  ): Promise<T> {
    const timeoutMs = this.getSessionTimeoutMs();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<T>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  private baseSessionOptions(canUseTool?: CanUseToolCallback) {
    return {
      permissionMode: 'bypassPermissions' as const,
      allowedTools: this.config.allowedTools,
      disallowedTools: [
        // Block built-in TodoWrite -- it requires interactive approval (fails
        // silently during heartbeats) and writes to the CLI's own store rather
        // than lettabot's persistent heartbeat store.  The agent should use the
        // custom manage_todo tool instead.
        'TodoWrite',
        ...(this.config.disallowedTools || []),
      ],
      cwd: this.config.workingDir,
      tools: [createManageTodoTool(this.getTodoAgentKey())],
      // Memory filesystem (context repository): true -> --memfs, false -> --no-memfs, undefined -> leave unchanged
      ...(this.config.memfs !== undefined ? { memfs: this.config.memfs } : {}),
      // In bypassPermissions mode, canUseTool is only called for interactive
      // tools (AskUserQuestion, ExitPlanMode). When no callback is provided
      // (background triggers), the SDK auto-denies interactive tools.
      ...(canUseTool ? { canUseTool } : {}),
    };
  }

  // =========================================================================
  // Session lifecycle (per-key)
  // =========================================================================

  /**
   * Return the persistent session for the given conversation key,
   * creating and initializing it if needed.
   *
   * After initialization, calls bootstrapState() to detect pending approvals.
   * If an orphaned approval is found, recovers proactively before returning
   * the session -- preventing the first send() from hitting a 409 CONFLICT.
   */
  async ensureSessionForKey(key: string, bootstrapRetried = false): Promise<Session> {
    const generation = this.sessionGenerations.get(key) ?? 0;

    // Fast path: session already exists
    const existing = this.sessions.get(key);
    if (existing) {
      this.sessionLastUsed.set(key, Date.now());
      return existing;
    }

    // Coalesce concurrent callers: if another call is already creating this
    // key (e.g. warmSession running while first message arrives), wait for
    // it instead of creating a duplicate session.
    const pending = this.sessionCreationLocks.get(key);
    if (pending && pending.generation === generation) return pending.promise;

    const promise = this._createSessionForKey(key, bootstrapRetried, generation);
    this.sessionCreationLocks.set(key, { promise, generation });
    try {
      return await promise;
    } finally {
      const current = this.sessionCreationLocks.get(key);
      if (current?.promise === promise) {
        this.sessionCreationLocks.delete(key);
      }
    }
  }

  /** Internal session creation -- called via ensureSessionForKey's lock. */
  private async _createSessionForKey(
    key: string,
    bootstrapRetried: boolean,
    generation: number,
  ): Promise<Session> {
    // Session was invalidated while this creation path was queued.
    if ((this.sessionGenerations.get(key) ?? 0) !== generation) {
      return this.ensureSessionForKey(key, bootstrapRetried);
    }

    // Re-read the store file from disk so we pick up agent/conversation ID
    // changes made by other processes (e.g. after a restart or container deploy).
    this.store.refresh();

    const opts = this.baseSessionOptions(this.sessionCanUseTool);
    let session: Session;
    let sessionAgentId: string | undefined;

    // In disabled mode, always resume the agent's built-in default conversation.
    // Skip store lookup entirely -- no conversation ID is persisted.
    const convId = key === 'default'
      ? null
      : key === 'shared'
        ? this.store.conversationId
        : this.store.getConversationId(key);

    // Propagate per-agent cron store path to CLI subprocesses (lettabot-schedule)
    if (this.config.cronStorePath) {
      process.env.CRON_STORE_PATH = this.config.cronStorePath;
    }

    if (key === 'default' && this.store.agentId) {
      process.env.LETTA_AGENT_ID = this.store.agentId;
      installSkillsToAgent(this.store.agentId, this.config.skills);
      sessionAgentId = this.store.agentId;
      prependSkillDirsToPath(sessionAgentId); // must be before resumeSession spawns subprocess
      session = resumeSession('default', opts);
    } else if (convId) {
      process.env.LETTA_AGENT_ID = this.store.agentId || undefined;
      if (this.store.agentId) {
        installSkillsToAgent(this.store.agentId, this.config.skills);
        sessionAgentId = this.store.agentId;
        prependSkillDirsToPath(sessionAgentId); // must be before resumeSession spawns subprocess
      }
      session = resumeSession(convId, opts);
    } else if (this.store.agentId) {
      // Agent exists but no conversation stored -- resume the default conversation
      process.env.LETTA_AGENT_ID = this.store.agentId;
      installSkillsToAgent(this.store.agentId, this.config.skills);
      sessionAgentId = this.store.agentId;
      prependSkillDirsToPath(sessionAgentId); // must be before resumeSession spawns subprocess
      session = resumeSession(this.store.agentId, opts);
    } else {
      // Create new agent -- persist immediately so we don't orphan it on later failures
      log.info('Creating new agent');
      const newAgentId = await createAgent({
        systemPrompt: SYSTEM_PROMPT,
        memory: loadMemoryBlocks(this.config.agentName),
        tags: ['origin:lettabot'],
        ...(this.config.memfs !== undefined ? { memfs: this.config.memfs } : {}),
      });
      const currentBaseUrl = process.env.LETTA_BASE_URL || 'https://api.letta.com';
      this.store.setAgent(newAgentId, currentBaseUrl);
      log.info('Saved new agent ID:', newAgentId);

      if (this.config.agentName) {
        updateAgentName(newAgentId, this.config.agentName).catch(() => {});
      }
      installSkillsToAgent(newAgentId, this.config.skills);
      sessionAgentId = newAgentId;
      prependSkillDirsToPath(sessionAgentId); // must be before createSession spawns subprocess

      // In disabled mode, resume the built-in default conversation instead of
      // creating a new one.  Other modes create a fresh conversation per key.
      session = key === 'default'
        ? resumeSession('default', opts)
        : createSession(newAgentId, opts);
    }

    // Initialize eagerly so the subprocess is ready before the first send()
    log.info(`Initializing session subprocess (key=${key})...`);
    try {
      await this.withSessionTimeout(session.initialize(), `Session initialize (key=${key})`);
      log.info(`Session subprocess ready (key=${key})`);
    } catch (error) {
      // Close immediately so failed initialization cannot leak a subprocess.
      session.close();

      // If the stored agent ID doesn't exist on the server (deleted externally,
      // ghost agent from failed pairing, etc.), clear the stale ID and retry.
      if (this.store.agentId && !bootstrapRetried && isAgentMissingFromInitError(error)) {
        log.warn(
          `Agent ${this.store.agentId} appears missing from server, ` +
          `clearing stale agent ID and recreating...`,
        );
        this.store.clearAgent();
        return this._createSessionForKey(key, /* bootstrapRetried */ true, generation);
      }

      throw error;
    }

    // reset/invalidate can happen while initialize() is in-flight.
    if ((this.sessionGenerations.get(key) ?? 0) !== generation) {
      log.info(`Discarding stale initialized session (key=${key})`);
      session.close();
      return this.ensureSessionForKey(key, bootstrapRetried);
    }

    // Proactive approval detection via bootstrapState().
    if (!bootstrapRetried && this.store.agentId) {
      try {
        const bootstrap = await this.withSessionTimeout(
          session.bootstrapState(),
          `Session bootstrapState (key=${key})`,
        );
        if (bootstrap.hasPendingApproval) {
          const convId = bootstrap.conversationId || session.conversationId;
          log.warn(`Pending approval detected at session startup (key=${key}, conv=${convId}), recovering...`);
          session.close();
          if (convId) {
            const result = await recoverOrphanedConversationApproval(
              this.store.agentId,
              convId,
              true, /* deepScan */
            );
            if (result.recovered) {
              log.info(`Proactive approval recovery succeeded: ${result.details}`);
            } else {
              log.warn(`Proactive approval recovery did not find resolvable approvals: ${result.details}`);
            }
          }
          return this._createSessionForKey(key, true, generation);
        }
      } catch (err) {
        // bootstrapState failure is non-fatal -- the reactive 409 handler in
        // runSession() will catch stuck approvals.
        log.warn(`bootstrapState check failed (key=${key}), continuing:`, err instanceof Error ? err.message : err);
      }
    }

    if ((this.sessionGenerations.get(key) ?? 0) !== generation) {
      log.info(`Discarding stale session after bootstrapState (key=${key})`);
      session.close();
      return this.ensureSessionForKey(key, bootstrapRetried);
    }

    // LRU eviction: in per-chat mode, limit concurrent sessions to avoid
    // unbounded subprocess growth.
    const maxSessions = this.config.maxSessions ?? 10;
    if (this.config.conversationMode === 'per-chat' && this.sessions.size >= maxSessions) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [k, ts] of this.sessionLastUsed) {
        if (k === key) continue;
        if (!this.sessions.has(k)) continue;
        // Never evict an active/in-flight key (can close a live stream).
        if (this.processingKeys.has(k) || this.sessionCreationLocks.has(k)) continue;
        if (ts < oldestTime) {
          oldestKey = k;
          oldestTime = ts;
        }
      }
      if (oldestKey) {
        log.info(`LRU session eviction: closing session for key="${oldestKey}" (${this.sessions.size} active, max=${maxSessions})`);
        const evicted = this.sessions.get(oldestKey);
        evicted?.close();
        this.sessions.delete(oldestKey);
        this.sessionLastUsed.delete(oldestKey);
        this.sessionGenerations.delete(oldestKey);
        this.sessionCreationLocks.delete(oldestKey);
        this.lastResultRunFingerprints.delete(oldestKey);
      } else {
        // All existing sessions are active; allow temporary overflow.
        log.debug(`LRU session eviction skipped: all ${this.sessions.size} sessions are active/in-flight`);
      }
    }

    this.sessions.set(key, session);
    this.sessionLastUsed.set(key, Date.now());
    return session;
  }

  /** Get an active session by key (for abort/cancel). */
  getSession(key: string): Session | undefined {
    return this.sessions.get(key);
  }

  /**
   * Destroy session(s). If key provided, destroys only that key.
   * If key is undefined, destroys ALL sessions.
   */
  invalidateSession(key?: string): void {
    if (key) {
      const nextGeneration = (this.sessionGenerations.get(key) ?? 0) + 1;
      this.sessionGenerations.set(key, nextGeneration);
      this.sessionCreationLocks.delete(key);

      const session = this.sessions.get(key);
      if (session) {
        log.info(`Invalidating session (key=${key})`);
        session.close();
        this.sessions.delete(key);
        this.sessionLastUsed.delete(key);
      }
      this.lastResultRunFingerprints.delete(key);
    } else {
      const keys = new Set<string>([
        ...this.sessions.keys(),
        ...this.sessionCreationLocks.keys(),
      ]);
      for (const k of keys) {
        const nextGeneration = (this.sessionGenerations.get(k) ?? 0) + 1;
        this.sessionGenerations.set(k, nextGeneration);
      }

      for (const [k, session] of this.sessions) {
        log.info(`Invalidating session (key=${k})`);
        session.close();
      }
      this.sessions.clear();
      this.sessionCreationLocks.clear();
      this.sessionLastUsed.clear();
      this.lastResultRunFingerprints.clear();
    }
  }

  /**
   * Pre-warm the session subprocess at startup.
   */
  async warmSession(): Promise<void> {
    this.store.refresh();
    if (!this.store.agentId && !this.store.conversationId) return;
    try {
      const mode = this.config.conversationMode || 'shared';
      if (mode === 'shared') {
        await this.ensureSessionForKey('shared');
      }
    } catch (err) {
      log.warn('Session pre-warm failed:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Persist conversation ID after a successful session result.
   * Agent ID and first-run setup are handled eagerly in ensureSessionForKey().
   */
  persistSessionState(session: Session, convKey?: string): void {
    // Agent ID already persisted in ensureSessionForKey() on creation.
    // Here we only update if the server returned a different one (shouldn't happen).
    if (session.agentId && session.agentId !== this.store.agentId) {
      const currentBaseUrl = process.env.LETTA_BASE_URL || 'https://api.letta.com';
      this.store.setAgent(session.agentId, currentBaseUrl, session.conversationId || undefined);
      log.info('Agent ID updated:', session.agentId);
    } else if (session.conversationId && session.conversationId !== 'default' && convKey !== 'default') {
      // In per-channel mode, persist per-key. In shared mode, use legacy field.
      // Skip saving "default" -- it's an API alias, not a real conversation ID.
      // In disabled mode (convKey === 'default'), skip -- always use the built-in default.
      if (convKey && convKey !== 'shared') {
        const existing = this.store.getConversationId(convKey);
        if (session.conversationId !== existing) {
          this.store.setConversationId(convKey, session.conversationId);
          log.info(`Conversation ID updated (key=${convKey}):`, session.conversationId);
        }
      } else if (session.conversationId !== this.store.conversationId) {
        this.store.conversationId = session.conversationId;
        log.info('Conversation ID updated:', session.conversationId);
      }
    }
  }

  // =========================================================================
  // Send + stream
  // =========================================================================

  /**
   * Send a message and return a deduplicated stream.
   *
   * Handles:
   * - Persistent session reuse (subprocess stays alive across messages)
   * - CONFLICT recovery from orphaned approvals (retry once)
   * - Conversation-not-found fallback (create new conversation)
   * - Tool call deduplication
   * - Session persistence after result
   */
  async runSession(
    message: SendMessage,
    options: { retried?: boolean; canUseTool?: CanUseToolCallback; convKey?: string } = {},
  ): Promise<{ session: Session; stream: () => AsyncGenerator<StreamMsg> }> {
    const { retried = false, canUseTool, convKey = 'shared' } = options;

    // Update the per-message callback before sending
    this.currentCanUseTool = canUseTool;

    let session = await this.ensureSessionForKey(convKey);

    // Resolve the conversation ID for this key (for error recovery)
    const convId = convKey === 'shared'
      ? this.store.conversationId
      : this.store.getConversationId(convKey);

    // Send message with fallback chain
    try {
      await this.withSessionTimeout(session.send(message), `Session send (key=${convKey})`);
    } catch (error) {
      // 409 CONFLICT from orphaned approval
      if (!retried && isApprovalConflictError(error) && this.store.agentId && convId) {
        log.info('CONFLICT detected - attempting orphaned approval recovery...');
        this.invalidateSession(convKey);
        const result = await recoverOrphanedConversationApproval(
          this.store.agentId,
          convId
        );
        if (result.recovered) {
          log.info(`Recovery succeeded (${result.details}), retrying...`);
          return this.runSession(message, { retried: true, canUseTool, convKey });
        }
        log.error(`Orphaned approval recovery failed: ${result.details}`);
        throw error;
      }

      // Conversation/agent not found - try creating a new conversation.
      if (this.store.agentId && isConversationMissingError(error)) {
        log.warn(`Conversation not found (key=${convKey}), creating a new conversation...`);
        this.invalidateSession(convKey);
        if (convKey !== 'shared') {
          this.store.clearConversation(convKey);
        } else {
          this.store.conversationId = null;
        }
        session = await this.ensureSessionForKey(convKey);
        try {
          await this.withSessionTimeout(session.send(message), `Session send retry (key=${convKey})`);
        } catch (retryError) {
          this.invalidateSession(convKey);
          throw retryError;
        }
      } else {
        // Unknown error -- invalidate so we get a fresh subprocess next time
        this.invalidateSession(convKey);
        throw error;
      }
    }

    // Persist conversation ID immediately after successful send, before streaming.
    this.persistSessionState(session, convKey);

    // Return session and a stream generator that buffers tool_call chunks and
    // flushes them with fully accumulated arguments on the next type boundary.
    const pendingToolCalls = new Map<string, { msg: StreamMsg; accumulatedArgs: string }>();
    const self = this;
    const capturedConvKey = convKey; // Capture for closure

    /** Merge tool argument strings, handling both delta and cumulative chunking. */
    function mergeToolArgs(existing: string, incoming: string): string {
      if (!incoming) return existing;
      if (!existing) return incoming;
      if (incoming === existing) return existing;
      // Cumulative: latest chunk includes all prior text
      if (incoming.startsWith(existing)) return incoming;
      if (existing.endsWith(incoming)) return existing;
      // Delta: each chunk is an append
      return `${existing}${incoming}`;
    }

    function* flushPending(): Generator<StreamMsg> {
      for (const [, pending] of pendingToolCalls) {
        if (!pending.accumulatedArgs) {
          // No rawArguments accumulated (old SDK or single complete chunk) --
          // preserve the original toolInput from the first chunk as-is.
          yield pending.msg;
          continue;
        }
        let toolInput: Record<string, unknown> = {};
        try { toolInput = JSON.parse(pending.accumulatedArgs); }
        catch { toolInput = { raw: pending.accumulatedArgs }; }
        yield { ...pending.msg, toolInput };
      }
      pendingToolCalls.clear();
      lastPendingToolCallId = null;
    }

    let anonToolCallCounter = 0;
    let lastPendingToolCallId: string | null = null;

    async function* dedupedStream(): AsyncGenerator<StreamMsg> {
      for await (const raw of session.stream()) {
        const msg = raw as StreamMsg;

        if (msg.type === 'tool_call') {
          let id = msg.toolCallId;
          if (!id) {
            // Tool calls without IDs (e.g., from models that don't emit
            // tool_call_id on subsequent argument chunks) still need to be
            // accumulated. Assign a synthetic ID so they enter the buffer.
            // If tool name matches the most recent pending call, treat this as
            // a continuation even when the first chunk had a real toolCallId.
            const currentPending = lastPendingToolCallId ? pendingToolCalls.get(lastPendingToolCallId) : null;
            if (lastPendingToolCallId && currentPending && (currentPending.msg.toolName || 'unknown') === (msg.toolName || 'unknown')) {
              id = lastPendingToolCallId;
            } else {
              id = `__anon_${++anonToolCallCounter}__`;
            }
          }

          const incoming = (msg as StreamMsg & { rawArguments?: string }).rawArguments || '';
          const existing = pendingToolCalls.get(id);
          if (existing) {
            existing.accumulatedArgs = mergeToolArgs(existing.accumulatedArgs, incoming);
          } else {
            pendingToolCalls.set(id, { msg, accumulatedArgs: incoming });
          }
          lastPendingToolCallId = id;
          continue; // buffer, don't yield yet
        }

        // Flush pending tool calls on semantic type boundary (not stream_event)
        if (pendingToolCalls.size > 0 && msg.type !== 'stream_event') {
          yield* flushPending();
        }

        if (msg.type === 'result') {
          // Flush any remaining before result
          yield* flushPending();
          self.persistSessionState(session, capturedConvKey);
        }

        yield msg;

        if (msg.type === 'result') {
          break;
        }
      }

      // Flush remaining at generator end (shouldn't normally happen)
      yield* flushPending();
    }

    return { session, stream: dedupedStream };
  }
}

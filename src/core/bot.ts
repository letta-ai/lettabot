/**
 * LettaBot Core - Handles agent communication
 * 
 * Single agent, single conversation - chat continues across all channels.
 */

import { imageFromFile, imageFromURL, type Session, type MessageContentItem, type SendMessage, type CanUseToolCallback } from '@letta-ai/letta-code-sdk';
import { mkdirSync, existsSync } from 'node:fs';
import { access, unlink, realpath, stat, constants } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { extname, resolve, join } from 'node:path';
import type { ChannelAdapter } from '../channels/types.js';
import type { BotConfig, InboundMessage, TriggerContext, StreamMsg } from './types.js';
import { formatApiErrorForUser } from './errors.js';
import { formatToolCallDisplay, formatReasoningDisplay, formatQuestionsForChannel } from './display.js';
import type { AgentSession } from './interfaces.js';
import { Store } from './store.js';
import { getPendingApprovals, rejectApproval, cancelRuns, cancelConversation, recoverOrphanedConversationApproval, getLatestRunError, getAgentModel, updateAgentModel } from '../tools/letta-api.js';
import { getAgentSkillExecutableDirs, isVoiceMemoConfigured } from '../skills/loader.js';
import { formatMessageEnvelope, formatGroupBatchEnvelope, type SessionContextOptions } from './formatter.js';
import type { GroupBatcher } from './group-batcher.js';
import { redactOutbound } from './redact.js';
import { parseDirectives, stripActionsBlock, type Directive } from './directives.js';
import { resolveEmoji } from './emoji.js';
import { SessionManager } from './session-manager.js';


import { createLogger } from '../logger.js';

const log = createLogger('Bot');
const SUPPORTED_IMAGE_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
]);

const IMAGE_FILE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff',
]);

const AUDIO_FILE_EXTENSIONS = new Set([
  '.ogg', '.opus', '.mp3', '.m4a', '.wav', '.aac', '.flac',
]);

type StreamErrorDetail = {
  message: string;
  stopReason: string;
  apiError?: Record<string, unknown>;
  isApprovalError?: boolean;
};

type ResultRetryDecision = {
  isTerminalError: boolean;
  isConflictError: boolean;
  isApprovalConflict: boolean;
  isNonRetryableError: boolean;
  shouldRetryForEmptyResult: boolean;
  shouldRetryForErrorResult: boolean;
};

/** Infer whether a file is an image, audio, or generic file based on extension. */
export function inferFileKind(filePath: string): 'image' | 'file' | 'audio' {
  const ext = extname(filePath).toLowerCase();
  if (IMAGE_FILE_EXTENSIONS.has(ext)) return 'image';
  if (AUDIO_FILE_EXTENSIONS.has(ext)) return 'audio';
  return 'file';
}

/**
 * Check whether a resolved file path is inside the allowed directory.
 * Prevents path traversal attacks in the send-file directive.
 *
 * Uses realpath() for both the file and directory to follow symlinks,
 * preventing symlink-based escapes (e.g., data/evil -> /etc/passwd).
 * Falls back to textual resolve() when paths don't exist on disk.
 */
export async function isPathAllowed(filePath: string, allowedDir: string): Promise<boolean> {
  // Resolve the allowed directory -- use realpath if it exists, resolve() otherwise
  let canonicalDir: string;
  try {
    canonicalDir = await realpath(allowedDir);
  } catch {
    canonicalDir = resolve(allowedDir);
  }

  // Resolve the file -- use realpath if it exists, resolve() otherwise
  let canonicalFile: string;
  try {
    canonicalFile = await realpath(filePath);
  } catch {
    canonicalFile = resolve(filePath);
  }

  return canonicalFile === canonicalDir || canonicalFile.startsWith(canonicalDir + '/');
}

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
      log.warn(`Failed to load image ${attachment.name || 'unknown'}: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (content.length > 1) {
    log.info(`Sending ${content.length - 1} inline image(s) to LLM`);
  }

  return content.length > 1 ? content : formattedText;
}

export { type StreamMsg } from './types.js';

export function isResponseDeliverySuppressed(msg: Pick<InboundMessage, 'isListeningMode'>): boolean {
  return msg.isListeningMode === true;
}

/**
 * Pure function: resolve the conversation key for a channel message.
 * Returns `${channel}:${chatId}` in per-chat mode.
 * Returns the channel id in per-channel mode or when the channel is in overrides.
 * Returns 'shared' otherwise.
 */
export function resolveConversationKey(
  channel: string,
  conversationMode: string | undefined,
  conversationOverrides: Set<string>,
  chatId?: string,
): string {
  if (conversationMode === 'disabled') return 'default';
  const normalized = channel.toLowerCase();
  if (conversationMode === 'per-chat' && chatId) return `${normalized}:${chatId}`;
  if (conversationMode === 'per-channel') return normalized;
  if (conversationOverrides.has(normalized)) return normalized;
  return 'shared';
}

/**
 * Pure function: resolve the conversation key for heartbeat/sendToAgent.
 * The heartbeat setting is orthogonal to conversation mode:
 *   - "dedicated" always returns "heartbeat" (isolated conversation)
 *   - "<channel>" always routes to that channel's conversation
 *   - "last-active" routes to wherever the user last messaged from
 */
export function resolveHeartbeatConversationKey(
  conversationMode: string | undefined,
  heartbeatConversation: string | undefined,
  conversationOverrides: Set<string>,
  lastActiveChannel?: string,
  lastActiveChatId?: string,
): string {
  if (conversationMode === 'disabled') return 'default';
  const hb = heartbeatConversation || 'last-active';

  // "dedicated" always gets its own conversation, regardless of mode
  if (hb === 'dedicated') return 'heartbeat';

  // Explicit channel name — route to that channel's conversation
  if (hb !== 'last-active') return hb;

  // "last-active" handling varies by mode
  if (conversationMode === 'per-chat') {
    if (lastActiveChannel && lastActiveChatId) {
      return `${lastActiveChannel.toLowerCase()}:${lastActiveChatId}`;
    }
    return 'shared';
  }

  if (conversationMode === 'per-channel') {
    return lastActiveChannel ?? 'shared';
  }

  // shared mode — if overrides exist, respect the override channel
  if (conversationOverrides.size > 0 && lastActiveChannel) {
    return resolveConversationKey(lastActiveChannel, conversationMode, conversationOverrides);
  }

  return 'shared';
}

export class LettaBot implements AgentSession {
  readonly store: Store;
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
  private processing = false; // Global lock for shared mode
  private processingKeys: Set<string> = new Set(); // Per-key locks for per-channel mode
  private cancelledKeys: Set<string> = new Set(); // Tracks keys where /cancel was issued
  private sendSequence = 0; // Monotonic counter for desync diagnostics
  // Forward-looking: stale-result detection via runIds becomes active once the
  // SDK surfaces non-empty result run_ids. Until then, this map mostly stays
  // empty and the streamed/result divergence guard remains the active defense.
  private lastResultRunFingerprints: Map<string, string> = new Map();

  // AskUserQuestion support: resolves when the next user message arrives.
  // In per-chat mode, keyed by convKey so each chat resolves independently.
  // In shared mode, a single entry keyed by 'shared' provides legacy behavior.
  private pendingQuestionResolvers: Map<string, (text: string) => void> = new Map();

  private conversationOverrides: Set<string> = new Set();
  private readonly sessionManager: SessionManager;

  constructor(config: BotConfig) {
    this.config = config;
    mkdirSync(config.workingDir, { recursive: true });
    this.store = new Store('lettabot-agent.json', config.agentName);
    if (config.reuseSession === false) {
      log.warn('Session reuse disabled (conversations.reuseSession=false): each foreground/background message uses a fresh SDK subprocess (~5s overhead per turn).');
    }
    if (config.conversationOverrides?.length) {
      this.conversationOverrides = new Set(config.conversationOverrides.map((ch) => ch.toLowerCase()));
    }
    this.sessionManager = new SessionManager(this.store, config, this.processingKeys, this.lastResultRunFingerprints);
    log.info(`LettaBot initialized. Agent ID: ${this.store.agentId || '(new)'}`);
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

  private normalizeStreamRunIds(msg: StreamMsg): string[] {
    const ids: string[] = [];

    const rawRunId = (msg as StreamMsg & { runId?: unknown; run_id?: unknown }).runId
      ?? (msg as StreamMsg & { run_id?: unknown }).run_id;
    if (typeof rawRunId === 'string' && rawRunId.trim().length > 0) {
      ids.push(rawRunId.trim());
    }

    const rawRunIds = (msg as StreamMsg & { runIds?: unknown; run_ids?: unknown }).runIds
      ?? (msg as StreamMsg & { run_ids?: unknown }).run_ids;
    if (Array.isArray(rawRunIds)) {
      for (const id of rawRunIds) {
        if (typeof id === 'string' && id.trim().length > 0) {
          ids.push(id.trim());
        }
      }
    }

    if (ids.length === 0) return [];
    return [...new Set(ids)];
  }

  private normalizeResultRunIds(msg: StreamMsg): string[] {
    const runIds = this.normalizeStreamRunIds(msg);
    if (runIds.length === 0) return [];

    return [...new Set(runIds)].sort();
  }

  private classifyResultRun(convKey: string, msg: StreamMsg): 'fresh' | 'stale' | 'unknown' {
    const runIds = this.normalizeResultRunIds(msg);
    if (runIds.length === 0) return 'unknown';

    const fingerprint = runIds.join(',');
    const previous = this.lastResultRunFingerprints.get(convKey);
    if (previous === fingerprint) {
      log.warn(`Detected stale duplicate result (key=${convKey}, runIds=${fingerprint})`);
      return 'stale';
    }

    this.lastResultRunFingerprints.set(convKey, fingerprint);
    return 'fresh';
  }

  // =========================================================================
  // AskUserQuestion formatting
  // =========================================================================
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
    threadId?: string,
  ): Promise<boolean> {
    let acted = false;
    for (const directive of directives) {
      if (directive.type === 'react') {
        const targetId = directive.messageId || fallbackMessageId;
        if (!adapter.addReaction) {
          log.warn(`Directive react skipped: ${adapter.name} does not support addReaction`);
          continue;
        }
        if (targetId) {
          // Resolve text aliases (thumbsup, eyes, etc.) to Unicode characters.
          // The LLM typically outputs names; channel APIs need actual emoji.
          const resolved = resolveEmoji(directive.emoji);
          try {
            await adapter.addReaction(chatId, targetId, resolved.unicode);
            acted = true;
            log.info(`Directive: reacted with ${resolved.unicode} (${directive.emoji})`);
          } catch (err) {
            log.warn('Directive react failed:', err instanceof Error ? err.message : err);
          }
        }
        continue;
      }

      if (directive.type === 'send-message') {
        // Targeted message delivery to a specific channel:chat.
        try {
          const targetAdapter = this.channels.get(directive.channel);
          if (!targetAdapter) {
            log.warn(`Directive send-message skipped: channel "${directive.channel}" not registered`);
            continue;
          }
          await targetAdapter.sendMessage({ chatId: directive.chat, text: this.prefixResponse(directive.text) });
          acted = true;
          log.info(`Directive: sent message to ${directive.channel}:${directive.chat} (${directive.text.length} chars)`);
        } catch (err) {
          log.warn('Directive send-message failed:', err instanceof Error ? err.message : err);
        }
        continue;
      }

      if (directive.type === 'send-file') {
        // Reject partial targeting: both channel and chat must be set together.
        // Without this guard, a missing field silently falls back to the triggering chat.
        if ((directive.channel && !directive.chat) || (!directive.channel && directive.chat)) {
          log.warn(`Directive send-file skipped: cross-channel targeting requires both channel and chat (got channel=${directive.channel || 'missing'}, chat=${directive.chat || 'missing'})`);
          continue;
        }

        // Resolve target adapter: use cross-channel targeting if both channel and chat are set,
        // otherwise fall back to the adapter/chatId that triggered this response.
        const targetAdapter = (directive.channel && directive.chat)
          ? this.channels.get(directive.channel)
          : adapter;
        const targetChatId = (directive.channel && directive.chat) ? directive.chat : chatId;

        if (!targetAdapter) {
          log.warn(`Directive send-file skipped: channel "${directive.channel}" not registered`);
          continue;
        }
        if (typeof targetAdapter.sendFile !== 'function') {
          log.warn(`Directive send-file skipped: ${targetAdapter.name} does not support sendFile`);
          continue;
        }

        // Path sandboxing: resolve both config and directive paths relative to workingDir.
        // This keeps behavior consistent when process.cwd differs from agent workingDir.
        const allowedDirConfig = this.config.sendFileDir || join('data', 'outbound');
        const allowedDir = resolve(this.config.workingDir, allowedDirConfig);
        const resolvedPath = resolve(this.config.workingDir, directive.path);
        if (!await isPathAllowed(resolvedPath, allowedDir)) {
          log.warn(`Directive send-file blocked: ${directive.path} is outside allowed directory ${allowedDir}`);
          continue;
        }

        // Async file existence + readability check
        try {
          await access(resolvedPath, constants.R_OK);
        } catch {
          log.warn(`Directive send-file skipped: file not found or not readable at ${directive.path}`);
          continue;
        }

        // File size guard (default: 50MB)
        const maxSize = this.config.sendFileMaxSize ?? 50 * 1024 * 1024;
        try {
          const fileStat = await stat(resolvedPath);
          if (fileStat.size > maxSize) {
            log.warn(`Directive send-file blocked: ${directive.path} is ${fileStat.size} bytes (max: ${maxSize})`);
            continue;
          }
        } catch {
          log.warn(`Directive send-file skipped: could not stat ${directive.path}`);
          continue;
        }

        try {
          await targetAdapter.sendFile({
            chatId: targetChatId,
            filePath: resolvedPath,
            caption: directive.caption,
            kind: directive.kind ?? inferFileKind(resolvedPath),
            threadId: (directive.channel && directive.chat) ? undefined : threadId,
          });
          acted = true;
          const target = (directive.channel && directive.chat) ? ` to ${directive.channel}:${directive.chat}` : '';
          log.info(`Directive: sent file ${resolvedPath}${target}`);

          // Optional cleanup: delete file after successful send.
          // Only honored when sendFileCleanup is enabled in config (defense-in-depth).
          if (directive.cleanup && this.config.sendFileCleanup) {
            try {
              await unlink(resolvedPath);
              log.warn(`Directive: cleaned up ${resolvedPath}`);
            } catch (cleanupErr) {
              log.warn('Directive send-file cleanup failed:', cleanupErr instanceof Error ? cleanupErr.message : cleanupErr);
            }
          }
        } catch (err) {
          log.warn('Directive send-file failed:', err instanceof Error ? err.message : err);
        }
      }

      if (directive.type === 'voice') {
        if (!isVoiceMemoConfigured()) {
          log.warn('Directive voice skipped: no TTS credentials configured');
          continue;
        }
        if (typeof adapter.sendFile !== 'function') {
          log.warn(`Directive voice skipped: ${adapter.name} does not support sendFile`);
          continue;
        }

        // Find lettabot-tts in agent's skill dirs
        const agentId = this.store.agentId;
        const skillDirs = agentId ? getAgentSkillExecutableDirs(agentId) : [];
        const ttsPath = skillDirs
          .map(dir => join(dir, 'lettabot-tts'))
          .find(p => existsSync(p));

        const ttsProvider = (process.env.TTS_PROVIDER || 'elevenlabs').toLowerCase();
        const ttsVoice = ttsProvider === 'openai'
          ? (process.env.OPENAI_TTS_VOICE || 'alloy')
          : (process.env.ELEVENLABS_VOICE_ID || 'onwK4e9ZLuTAKqWW03F9');
        const ttsModel = ttsProvider === 'openai'
          ? (process.env.OPENAI_TTS_MODEL || 'tts-1')
          : (process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2');

        if (!ttsPath) {
          log.warn('Directive voice skipped: lettabot-tts not found in skill dirs');
          continue;
        }

        log.info(
          `Directive voice: generating memo (provider=${ttsProvider}, model=${ttsModel}, voice=${ttsVoice}, textLen=${directive.text.length})`,
        );
        log.info(`Directive voice: helper=${ttsPath}`);

        try {
          const outputPath = await new Promise<string>((resolve, reject) => {
            execFile(ttsPath, [directive.text], {
              cwd: this.config.workingDir,
              env: { ...process.env, LETTABOT_WORKING_DIR: this.config.workingDir },
              timeout: 30_000,
            }, (err, stdout, stderr) => {
              if (err) {
                const execErr = new Error(stderr?.trim() || err.message) as Error & {
                  code?: string | number | null;
                  signal?: NodeJS.Signals;
                  stdout?: string;
                  stderr?: string;
                };
                execErr.code = err.code;
                execErr.signal = err.signal;
                execErr.stdout = stdout?.trim();
                execErr.stderr = stderr?.trim();
                reject(execErr);
              } else {
                const output = stdout.trim();
                if (!output) {
                  reject(new Error('lettabot-tts returned an empty output path'));
                  return;
                }
                if (stderr?.trim()) {
                  log.warn('Directive voice: lettabot-tts stderr:', stderr.trim());
                }
                resolve(output.split('\n').at(-1)?.trim() || output);
              }
            });
          });

          const outputStats = await stat(outputPath);
          if (!outputStats.isFile()) {
            throw new Error(`Generated TTS output is not a file: ${outputPath}`);
          }
          log.info(`Directive voice: generated file ${outputPath} (${outputStats.size} bytes)`);

          await adapter.sendFile({
            chatId,
            filePath: outputPath,
            kind: 'audio',
            threadId,
          });
          acted = true;
          log.info(`Directive: sent voice memo (${directive.text.length} chars)`);

          // Clean up generated file
          try { await unlink(outputPath); } catch {}
        } catch (err) {
          const execErr = err as Error & {
            code?: string | number | null;
            signal?: NodeJS.Signals;
            stdout?: string;
            stderr?: string;
          };
          log.warn('Directive voice failed:', {
            message: execErr?.message || String(err),
            code: execErr?.code,
            signal: execErr?.signal,
            stdout: typeof execErr?.stdout === 'string' ? execErr.stdout.slice(0, 300) : undefined,
            stderr: typeof execErr?.stderr === 'string' ? execErr.stderr.slice(0, 1200) : undefined,
            provider: ttsProvider,
            model: ttsModel,
            voice: ttsVoice,
            helper: ttsPath,
          });
        }
      }
    }
    return acted;
  }

  // =========================================================================
  // Conversation key resolution
  // =========================================================================

  /**
   * Resolve the conversation key for a channel message.
   * Returns 'shared' in shared mode (unless channel is in perChannel overrides).
   * Returns channel id in per-channel mode or for override channels.
   */
  private resolveConversationKey(channel: string, chatId?: string): string {
    return resolveConversationKey(channel, this.config.conversationMode, this.conversationOverrides, chatId);
  }

  /**
   * Resolve the conversation key for heartbeat/sendToAgent.
   * Respects perChannel overrides when using last-active in shared mode.
   */
  private resolveHeartbeatConversationKey(): string {
    const target = this.store.lastMessageTarget;
    return resolveHeartbeatConversationKey(
      this.config.conversationMode,
      this.config.heartbeatConversation,
      this.conversationOverrides,
      target?.channel,
      target?.chatId,
    );
  }

  // Session lifecycle delegated to SessionManager

  /**
   * Pre-warm the session subprocess at startup.
   */
  async warmSession(): Promise<void> {
    return this.sessionManager.warmSession();
  }

  /**
   * Invalidate cached session(s), forcing a fresh session on next message.
   * The next message will create a fresh session using the current store state.
   */
  invalidateSession(key?: string): void {
    this.sessionManager.invalidateSession(key);
  }

  // =========================================================================
  // Channel management
  // =========================================================================

  registerChannel(adapter: ChannelAdapter): void {
    adapter.onMessage = (msg) => this.handleMessage(msg, adapter);
    adapter.onCommand = (cmd, chatId, args) => this.handleCommand(cmd, adapter.id, chatId, args);

    // Wrap outbound methods when any redaction layer is active.
    // Secrets are enabled by default unless explicitly disabled.
    const redactionConfig = this.config.redaction;
    const shouldRedact = redactionConfig?.secrets !== false || redactionConfig?.pii === true;
    if (shouldRedact) {
      const origSend = adapter.sendMessage.bind(adapter);
      adapter.sendMessage = (msg) => origSend({ ...msg, text: redactOutbound(msg.text, redactionConfig) });

      const origEdit = adapter.editMessage.bind(adapter);
      adapter.editMessage = (chatId, messageId, text) => origEdit(chatId, messageId, redactOutbound(text, redactionConfig));
    }

    this.channels.set(adapter.id, adapter);
    log.info(`Registered channel: ${adapter.name}`);
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
    log.info('Group batcher configured');
  }

  processGroupBatch(msg: InboundMessage, adapter: ChannelAdapter): void {
    const count = msg.batchedMessages?.length || 0;
    log.info(`Group batch: ${count} messages from ${msg.channel}:${msg.chatId}`);
    const effective = (count === 1 && msg.batchedMessages)
      ? msg.batchedMessages[0]
      : msg;

    // Legacy listeningGroups fallback (new mode-based configs set isListeningMode in adapters)
    if (effective.isListeningMode === undefined) {
      const isListening = this.listeningGroupIds.has(`${msg.channel}:${msg.chatId}`)
        || (msg.serverId && this.listeningGroupIds.has(`${msg.channel}:${msg.serverId}`));
      if (isListening && !msg.wasMentioned) {
        effective.isListeningMode = true;
      }
    }

    const convKey = this.resolveConversationKey(effective.channel, effective.chatId);
    if (convKey !== 'shared') {
      this.enqueueForKey(convKey, effective, adapter);
    } else {
      this.messageQueue.push({ msg: effective, adapter });
      if (!this.processing) {
        this.processQueue().catch(err => log.error('Fatal error in processQueue:', err));
      }
    }
  }

  // =========================================================================
  // Commands
  // =========================================================================

  private async handleCommand(command: string, channelId?: string, chatId?: string, args?: string): Promise<string | null> {
    log.info(`Received: /${command}${args ? ` ${args}` : ''}`);
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
          log.error('Manual trigger failed:', err);
        });
        return '⏰ Heartbeat triggered (silent mode - check server logs)';
      }
      case 'reset': {
        // Always scope the reset to the caller's conversation key so that
        // other channels/chats' conversations are never silently destroyed.
        // resolveConversationKey returns 'shared' for non-override channels,
        // the channel id for per-channel, or channel:chatId for per-chat.
        const convKey = channelId ? this.resolveConversationKey(channelId, chatId) : 'shared';

        // In disabled mode the bot always uses the agent's built-in default
        // conversation -- there's nothing to reset locally.
        if (convKey === 'default') {
          return 'Conversations are disabled -- nothing to reset.';
        }

        this.store.clearConversation(convKey);
        this.store.resetRecoveryAttempts();
        this.sessionManager.invalidateSession(convKey);
        log.info(`/reset - conversation cleared for key="${convKey}"`);
        // Eagerly create the new session so we can report the conversation ID.
        try {
          const session = await this.sessionManager.ensureSessionForKey(convKey);
          const newConvId = session.conversationId || '(pending)';
          this.sessionManager.persistSessionState(session, convKey);
          if (convKey === 'shared') {
            return `Conversation reset. New conversation: ${newConvId}\n(Agent memory is preserved.)`;
          }
          const scope = this.config.conversationMode === 'per-chat' ? 'this chat' : 'this channel';
          return `Conversation reset for ${scope}. New conversation: ${newConvId}\nOther conversations are unaffected. (Agent memory is preserved.)`;
        } catch {
          if (convKey === 'shared') {
            return 'Conversation reset. Send a message to start a new conversation. (Agent memory is preserved.)';
          }
          const scope = this.config.conversationMode === 'per-chat' ? 'this chat' : 'this channel';
          return `Conversation reset for ${scope}. Other conversations are unaffected. (Agent memory is preserved.)`;
        }
      }
      case 'cancel': {
        const convKey = channelId ? this.resolveConversationKey(channelId, chatId) : 'shared';

        // Check if there's actually an active run for this conversation key
        if (!this.processingKeys.has(convKey) && !this.processing) {
          return '(Nothing to cancel -- no active run.)';
        }

        // Signal the stream loop to break
        this.cancelledKeys.add(convKey);

        // Abort client-side stream
        const session = this.sessionManager.getSession(convKey);
        if (session) {
          session.abort().catch(() => {});
          log.info(`/cancel - aborted session stream (key=${convKey})`);
        }

        // Cancel server-side run (conversation-scoped)
        const convId = convKey === 'shared'
          ? this.store.conversationId
          : this.store.getConversationId(convKey);
        if (convId) {
          const ok = await cancelConversation(convId);
          if (!ok) {
            return '(Run cancelled locally, but server-side cancellation failed.)';
          }
        }

        log.info(`/cancel - run cancelled (key=${convKey})`);
        return '(Run cancelled.)';
      }
      case 'model': {
        const agentId = this.store.agentId;
        if (!agentId) return 'No agent configured.';

        if (args) {
          const success = await updateAgentModel(agentId, args);
          if (success) {
            return `Model updated to: ${args}`;
          }
          return 'Failed to update model. Check the handle is valid.\nUse /model to list available models.';
        }

        const current = await getAgentModel(agentId);
        const { models: recommendedModels } = await import('../utils/model-selection.js');
        const lines = [
          `Current model: \`${current || '(unknown)'}\``,
          '',
          'Recommended models:',
        ];
        for (const m of recommendedModels) {
          const marker = m.handle === current ? ' (current)' : '';
          lines.push(`  ${m.label} - \`${m.handle}\`${marker}`);
        }
        lines.push('', 'Use `/model <handle>` to switch.');
        return lines.join('\n');
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
        log.info(`Starting channel: ${adapter.name}...`);
        await adapter.start();
        log.info(`Started channel: ${adapter.name}`);
      } catch (e) {
        log.error(`Failed to start channel ${id}:`, e);
      }
    });
    await Promise.all(startPromises);
  }
  
  async stop(): Promise<void> {
    for (const adapter of this.channels.values()) {
      try {
        await adapter.stop();
      } catch (e) {
        log.error(`Failed to stop channel ${adapter.id}:`, e);
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
    
    log.info('Checking for pending approvals...');
    
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
            log.info(`Conversation-level recovery succeeded: ${convResult.details}`);
            return { recovered: true, shouldReset: false };
          }
        }
        this.store.resetRecoveryAttempts();
        return { recovered: false, shouldReset: false };
      }
      
      const attempts = this.store.recoveryAttempts;
      if (attempts >= maxAttempts) {
        log.error(`Recovery failed after ${attempts} attempts. Still have ${pendingApprovals.length} pending approval(s).`);
        return { recovered: false, shouldReset: true };
      }
      
      log.info(`Found ${pendingApprovals.length} pending approval(s), attempting recovery (attempt ${attempts + 1}/${maxAttempts})...`);
      this.store.incrementRecoveryAttempts();
      
      for (const approval of pendingApprovals) {
        log.info(`Rejecting approval for ${approval.toolName} (${approval.toolCallId})`);
        await rejectApproval(
          this.store.agentId,
          { toolCallId: approval.toolCallId, reason: 'Session was interrupted - retrying request' },
          this.store.conversationId || undefined
        );
      }
      
      const runIds = [...new Set(pendingApprovals.map(a => a.runId))];
      if (runIds.length > 0) {
        log.info(`Cancelling ${runIds.length} active run(s)...`);
        await cancelRuns(this.store.agentId, runIds);
      }
      
      log.info('Recovery completed');
      return { recovered: true, shouldReset: false };
      
    } catch (error) {
      log.error('Recovery failed:', error);
      this.store.incrementRecoveryAttempts();
      return { recovered: false, shouldReset: this.store.recoveryAttempts >= maxAttempts };
    }
  }

  // =========================================================================
  // Message queue
  // =========================================================================
  
  private async handleMessage(msg: InboundMessage, adapter: ChannelAdapter): Promise<void> {
    // AskUserQuestion support: if the agent is waiting for a user answer,
    // intercept this message and resolve the pending promise instead of
    // queuing it for normal processing. This prevents a deadlock where
    // the stream is paused waiting for user input while the processing
    // flag blocks new messages from being handled.
    const incomingConvKey = this.resolveConversationKey(msg.channel, msg.chatId);
    const pendingResolver = this.pendingQuestionResolvers.get(incomingConvKey);
    if (pendingResolver) {
      log.info(`Intercepted message as AskUserQuestion answer from ${msg.userId} (key=${incomingConvKey})`);
      pendingResolver(msg.text || '');
      this.pendingQuestionResolvers.delete(incomingConvKey);
      return;
    }

    log.info(`Message from ${msg.userId} on ${msg.channel}: ${msg.text}`);

    if (msg.isGroup && this.groupBatcher) {
      const isInstant = this.instantGroupIds.has(`${msg.channel}:${msg.chatId}`)
        || (msg.serverId && this.instantGroupIds.has(`${msg.channel}:${msg.serverId}`));
      const debounceMs = isInstant ? 0 : (this.groupIntervals.get(msg.channel) ?? 5000);
      log.info(`Group message routed to batcher (debounce=${debounceMs}ms, mentioned=${msg.wasMentioned}, instant=${!!isInstant})`);
      this.groupBatcher.enqueue(msg, adapter, debounceMs);
      return;
    }

    const convKey = this.resolveConversationKey(msg.channel, msg.chatId);
    if (convKey !== 'shared') {
      // Per-channel, per-chat, or override mode: messages on different keys can run in parallel.
      this.enqueueForKey(convKey, msg, adapter);
    } else {
      // Shared mode: single global queue (existing behavior)
      this.messageQueue.push({ msg, adapter });
      if (!this.processing) {
        this.processQueue().catch(err => log.error('Fatal error in processQueue:', err));
      }
    }
  }

  /**
   * Enqueue a message for a specific conversation key.
   * Messages with the same key are serialized; different keys run in parallel.
   */
  private keyedQueues: Map<string, Array<{ msg: InboundMessage; adapter: ChannelAdapter }>> = new Map();

  private enqueueForKey(key: string, msg: InboundMessage, adapter: ChannelAdapter): void {
    let queue = this.keyedQueues.get(key);
    if (!queue) {
      queue = [];
      this.keyedQueues.set(key, queue);
    }
    queue.push({ msg, adapter });

    if (!this.processingKeys.has(key)) {
      this.processKeyedQueue(key).catch(err =>
        log.error(`Fatal error in processKeyedQueue(${key}):`, err)
      );
    }
  }

  private async processKeyedQueue(key: string): Promise<void> {
    if (this.processingKeys.has(key)) return;
    this.processingKeys.add(key);

    const queue = this.keyedQueues.get(key);
    while (queue && queue.length > 0) {
      const { msg, adapter } = queue.shift()!;
      try {
        await this.processMessage(msg, adapter);
      } catch (error) {
        log.error(`Error processing message (key=${key}):`, error);
      }
    }

    this.processingKeys.delete(key);
    this.keyedQueues.delete(key);
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.messageQueue.length === 0) return;
    
    this.processing = true;
    
    while (this.messageQueue.length > 0) {
      const { msg, adapter } = this.messageQueue.shift()!;
      try {
        await this.processMessage(msg, adapter);
      } catch (error) {
        log.error('Error processing message:', error);
      }
    }
    
    log.info('Finished processing all messages');
    this.processing = false;
  }

  private buildCanUseToolCallback(msg: InboundMessage, adapter: ChannelAdapter): CanUseToolCallback {
    return async (toolName, toolInput) => {
      if (toolName === 'AskUserQuestion') {
        const questions = (toolInput.questions || []) as Array<{
          question: string;
          header: string;
          options: Array<{ label: string; description: string }>;
          multiSelect: boolean;
        }>;
        const questionText = formatQuestionsForChannel(questions);
        log.info(`AskUserQuestion: sending ${questions.length} question(s) to ${msg.channel}:${msg.chatId}`);
        await adapter.sendMessage({ chatId: msg.chatId, text: questionText, threadId: msg.threadId });

        // Wait for the user's next message (intercepted by handleMessage).
        // Key by convKey so each chat resolves independently in per-chat mode.
        const questionConvKey = this.resolveConversationKey(msg.channel, msg.chatId);
        const answer = await new Promise<string>((resolve) => {
          this.pendingQuestionResolvers.set(questionConvKey, resolve);
        });
        log.info(`AskUserQuestion: received answer (${answer.length} chars)`);

        const answers: Record<string, string> = {};
        for (const q of questions) {
          answers[q.question] = answer;
        }
        return {
          behavior: 'allow' as const,
          updatedInput: { ...toolInput, answers },
        };
      }

      // All other interactive tools: allow by default
      return { behavior: 'allow' as const };
    };
  }

  private async prepareMessageForRun(
    msg: InboundMessage,
    adapter: ChannelAdapter,
    suppressDelivery: boolean,
    lap: (label: string) => void,
  ): Promise<{ messageToSend: SendMessage; canUseTool: CanUseToolCallback } | null> {
    this.lastUserMessageTime = new Date();

    // Skip heartbeat target update for listening mode (don't redirect heartbeats)
    if (!suppressDelivery) {
      this.store.lastMessageTarget = {
        channel: msg.channel,
        chatId: msg.chatId,
        messageId: msg.messageId,
        updatedAt: new Date().toISOString(),
      };
    }

    // Fire-and-forget typing indicator so session creation starts immediately
    if (!suppressDelivery) {
      adapter.sendTypingIndicator(msg.chatId).catch(() => {});
    }
    lap('typing indicator');

    // Pre-send approval recovery (secondary defense).
    // Primary detection is now in ensureSessionForKey() via bootstrapState().
    // This fallback only fires when previous failures incremented recoveryAttempts,
    // covering edge cases where a cached session encounters a new stuck approval.
    const recovery = this.store.recoveryAttempts > 0
      ? await this.attemptRecovery()
      : { recovered: false, shouldReset: false };
    lap('recovery check');
    if (recovery.shouldReset) {
      if (!suppressDelivery) {
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: `(I had trouble processing that -- the session hit a stuck state and automatic recovery failed after ${this.store.recoveryAttempts} attempt(s). Please try sending your message again. If this keeps happening, /reset will clear the conversation for this channel.)`,
          threadId: msg.threadId,
        });
      }
      return null;
    }

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
    lap('format message');

    const canUseTool = this.buildCanUseToolCallback(msg, adapter);
    return { messageToSend, canUseTool };
  }

  private isNonRetryableError(lastErrorDetail: StreamErrorDetail | null, isTerminalError: boolean): boolean {
    if (!isTerminalError) return false;
    const errMsg = lastErrorDetail?.message?.toLowerCase() || '';
    const errApiMsg = (typeof lastErrorDetail?.apiError?.message === 'string'
      ? lastErrorDetail.apiError.message : '').toLowerCase();
    const errAny = errMsg + ' ' + errApiMsg;
    return (
      errAny.includes('out of credits') || errAny.includes('usage limit') ||
      errAny.includes('401') || errAny.includes('403') ||
      errAny.includes('unauthorized') || errAny.includes('forbidden') ||
      errAny.includes('404') ||
      ((errAny.includes('agent') || errAny.includes('conversation')) && errAny.includes('not found')) ||
      errAny.includes('rate limit') || errAny.includes('429')
    );
  }

  private buildResultRetryDecision(
    streamMsg: StreamMsg,
    resultText: string,
    hasResponse: boolean,
    sentAnyMessage: boolean,
    lastErrorDetail: StreamErrorDetail | null,
  ): ResultRetryDecision {
    const isTerminalError = streamMsg.success === false || !!streamMsg.error;
    const nothingDelivered = !hasResponse && !sentAnyMessage;
    const isConflictError = lastErrorDetail?.message?.toLowerCase().includes('conflict') || false;
    const isApprovalConflict = (isConflictError &&
      lastErrorDetail?.message?.toLowerCase().includes('waiting for approval')) ||
      lastErrorDetail?.isApprovalError === true;
    const isNonRetryableError = this.isNonRetryableError(lastErrorDetail, isTerminalError);

    return {
      isTerminalError,
      isConflictError,
      isApprovalConflict,
      isNonRetryableError,
      shouldRetryForEmptyResult: streamMsg.success === true && resultText === '' && nothingDelivered,
      shouldRetryForErrorResult: isTerminalError && nothingDelivered && !isConflictError && !isNonRetryableError,
    };
  }

  private async deliverNoVisibleResponseIfNeeded(
    msg: InboundMessage,
    adapter: ChannelAdapter,
    sentAnyMessage: boolean,
    receivedAnyData: boolean,
    msgTypeCounts: Record<string, number>,
  ): Promise<void> {
    if (sentAnyMessage) return;

    if (!receivedAnyData) {
      log.error('Stream received NO DATA - possible stuck state');
      await adapter.sendMessage({
        chatId: msg.chatId,
        text: '(No response received -- the connection may have dropped or the server may be busy. Please try again. If this persists, /reset will start a fresh conversation.)',
        threadId: msg.threadId,
      });
      return;
    }

    const hadToolActivity = (msgTypeCounts['tool_call'] || 0) > 0 || (msgTypeCounts['tool_result'] || 0) > 0;
    if (hadToolActivity) {
      log.info('Agent had tool activity but no assistant message - likely sent via tool');
      return;
    }

    await adapter.sendMessage({
      chatId: msg.chatId,
      text: '(The agent processed your message but didn\'t produce a visible response. This can happen with certain prompts. Try rephrasing or sending again.)',
      threadId: msg.threadId,
    });
  }

  // =========================================================================
  // processMessage - User-facing message handling
  // =========================================================================
  
  private async processMessage(msg: InboundMessage, adapter: ChannelAdapter, retried = false): Promise<void> {
    // Track timing and last target
    const debugTiming = !!process.env.LETTABOT_DEBUG_TIMING;
    const t0 = debugTiming ? performance.now() : 0;
    const lap = (label: string) => {
      log.debug(`${label}: ${(performance.now() - t0).toFixed(0)}ms`);
    };
    const suppressDelivery = isResponseDeliverySuppressed(msg);
    const prepared = await this.prepareMessageForRun(msg, adapter, suppressDelivery, lap);
    if (!prepared) {
      return;
    }
    const { messageToSend, canUseTool } = prepared;

    // Run session
    let session: Session | null = null;
    try {
      const convKey = this.resolveConversationKey(msg.channel, msg.chatId);
      const seq = ++this.sendSequence;
      const userText = msg.text || '';
      log.info(`processMessage seq=${seq} key=${convKey} retried=${retried} user=${msg.userId} textLen=${userText.length}`);
      if (userText.length > 0) {
        log.debug(`processMessage seq=${seq} textPreview=${userText.slice(0, 80)}`);
      }
      const run = await this.sessionManager.runSession(messageToSend, { retried, canUseTool, convKey });
      lap('session send');
      session = run.session;

      // Stream response with delivery
      let response = '';
      let lastUpdate = 0; // Start at 0 so the first streaming edit fires immediately
      let rateLimitedUntil = 0; // Timestamp until which we should avoid API calls (429 backoff)
      let messageId: string | null = null;
      let lastMsgType: string | null = null;
      let lastAssistantUuid: string | null = null;
      let sentAnyMessage = false;
      let receivedAnyData = false;
      let sawNonAssistantSinceLastUuid = false;
      let lastErrorDetail: StreamErrorDetail | null = null;
      let retryInfo: { attempt: number; maxAttempts: number; reason: string } | null = null;
      let reasoningBuffer = '';
      let expectedForegroundRunId: string | null = null;
      let expectedForegroundRunSource: 'assistant' | 'result' | null = null;
      let sawCompetingRunEvent = false;
      let sawForegroundResult = false;
      let filteredRunEventCount = 0;
      let ignoredNonForegroundResultCount = 0;
      let bufferedDisplayFlushed = false;
      let bufferedDisplayFlushCount = 0;
      let bufferedDisplayDropCount = 0;
      const bufferedDisplayEvents: Array<
        | { kind: 'reasoning'; runId: string; content: string }
        | { kind: 'tool_call'; runId: string; msg: StreamMsg }
      > = [];
      const msgTypeCounts: Record<string, number> = {};

      const parseAndHandleDirectives = async () => {
        if (!response.trim()) return;
        const { cleanText, directives } = parseDirectives(response);
        response = cleanText;
        if (directives.length === 0) return;

        if (suppressDelivery) {
          log.info(`Listening mode: skipped ${directives.length} directive(s)`);
          return;
        }

        if (await this.executeDirectives(directives, adapter, msg.chatId, msg.messageId, msg.threadId)) {
          sentAnyMessage = true;
        }
      };

      const sendReasoningDisplay = async (content: string) => {
        if (!this.config.display?.showReasoning || suppressDelivery || !content.trim()) return;
        try {
          const reasoning = formatReasoningDisplay(content, adapter.id, this.config.display?.reasoningMaxChars);
          await adapter.sendMessage({
            chatId: msg.chatId,
            text: reasoning.text,
            threadId: msg.threadId,
            parseMode: reasoning.parseMode,
          });
          // Note: display messages don't set sentAnyMessage -- they're informational,
          // not a substitute for an assistant response.
        } catch (err) {
          log.warn('Failed to send reasoning display:', err instanceof Error ? err.message : err);
        }
      };

      const sendToolCallDisplay = async (toolMsg: StreamMsg) => {
        if (!this.config.display?.showToolCalls || suppressDelivery) return;
        try {
          const text = formatToolCallDisplay(toolMsg);
          await adapter.sendMessage({ chatId: msg.chatId, text, threadId: msg.threadId });
        } catch (err) {
          log.warn('Failed to send tool call display:', err instanceof Error ? err.message : err);
        }
      };

      const bufferRunScopedDisplayEvent = (runId: string, streamMsg: StreamMsg) => {
        if (streamMsg.type === 'reasoning') {
          if (!this.config.display?.showReasoning) return;
          const chunk = typeof streamMsg.content === 'string' ? streamMsg.content : '';
          if (!chunk) return;
          const lastEvent = bufferedDisplayEvents[bufferedDisplayEvents.length - 1];
          if (lastEvent && lastEvent.kind === 'reasoning' && lastEvent.runId === runId) {
            lastEvent.content += chunk;
          } else {
            bufferedDisplayEvents.push({ kind: 'reasoning', runId, content: chunk });
          }
          return;
        }

        if (streamMsg.type === 'tool_call') {
          if (!this.config.display?.showToolCalls) return;
          bufferedDisplayEvents.push({ kind: 'tool_call', runId, msg: streamMsg });
        }
      };

      const flushBufferedDisplayEventsForRun = async (runId: string) => {
        for (const event of bufferedDisplayEvents) {
          if (event.runId !== runId) {
            bufferedDisplayDropCount += 1;
            continue;
          }
          if (event.kind === 'reasoning') {
            await sendReasoningDisplay(event.content);
            bufferedDisplayFlushCount += 1;
            continue;
          }

          this.sessionManager.syncTodoToolCall(event.msg);
          await sendToolCallDisplay(event.msg);
          bufferedDisplayFlushCount += 1;
        }
        bufferedDisplayEvents.length = 0;
      };
      
      const finalizeMessage = async () => {
        // Parse and execute XML directives before sending
        await parseAndHandleDirectives();

        // Check for no-reply AFTER directive parsing
        if (response.trim() === '<no-reply/>') {
          log.info('Agent chose not to reply (no-reply marker)');
          sentAnyMessage = true;
          response = '';
          messageId = null;
          lastUpdate = Date.now();
          return;
        }

        if (!suppressDelivery && response.trim()) {
          // Wait out any active rate limit before sending
          const rlRemaining = rateLimitedUntil - Date.now();
          if (rlRemaining > 0) {
            const waitMs = Math.min(rlRemaining, 30_000);
            log.info(`Waiting ${(waitMs / 1000).toFixed(1)}s for rate limit before finalize`);
            await new Promise(resolve => setTimeout(resolve, waitMs));
          }
          try {
            const prefixed = this.prefixResponse(response);
            if (messageId) {
              await adapter.editMessage(msg.chatId, messageId, prefixed);
            } else {
              await adapter.sendMessage({ chatId: msg.chatId, text: prefixed, threadId: msg.threadId });
            }
            sentAnyMessage = true;
          } catch (finalizeErr) {
            if (messageId) {
              // Edit failed but original message was already visible
              sentAnyMessage = true;
            } else {
              log.warn('finalizeMessage send failed:', finalizeErr instanceof Error ? finalizeErr.message : finalizeErr);
            }
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
        let firstChunkLogged = false;
        let streamedAssistantText = '';
        for await (const streamMsg of run.stream()) {
          // Check for /cancel before processing each chunk
          if (this.cancelledKeys.has(convKey)) {
            log.info(`Stream cancelled by /cancel (key=${convKey})`);
            break;
          }
          if (!firstChunkLogged) { lap('first stream chunk'); firstChunkLogged = true; }
          const eventRunIds = this.normalizeStreamRunIds(streamMsg);
          if (expectedForegroundRunId === null && eventRunIds.length > 0) {
            if (streamMsg.type === 'assistant' || streamMsg.type === 'result') {
              expectedForegroundRunId = eventRunIds[0];
              expectedForegroundRunSource = streamMsg.type === 'assistant' ? 'assistant' : 'result';
              log.info(`Selected foreground run for stream delivery (seq=${seq}, key=${convKey}, runId=${expectedForegroundRunId}, source=${streamMsg.type})`);
              if (!bufferedDisplayFlushed && bufferedDisplayEvents.length > 0) {
                await flushBufferedDisplayEventsForRun(expectedForegroundRunId);
                bufferedDisplayFlushed = true;
              }
            } else {
              // Do not lock to a run based on pre-assistant non-terminal events;
              // these can belong to a concurrent background run.
              const runId = eventRunIds[0];
              if (runId && (streamMsg.type === 'reasoning' || streamMsg.type === 'tool_call')) {
                bufferRunScopedDisplayEvent(runId, streamMsg);
                filteredRunEventCount++;
                log.trace(`Buffering run-scoped pre-foreground display event (seq=${seq}, key=${convKey}, type=${streamMsg.type}, runId=${runId})`);
                continue;
              }
              filteredRunEventCount++;
              log.trace(`Deferring run-scoped pre-foreground event (seq=${seq}, key=${convKey}, type=${streamMsg.type}, runIds=${eventRunIds.join(',')})`);
              continue;
            }
          } else if (expectedForegroundRunId && eventRunIds.length > 0 && !eventRunIds.includes(expectedForegroundRunId)) {
            // Strict no-rebind policy: once foreground is selected, never switch.
            sawCompetingRunEvent = true;
            filteredRunEventCount++;
            if (streamMsg.type === 'result') {
              ignoredNonForegroundResultCount++;
              log.warn(`Ignoring non-foreground result event (seq=${seq}, key=${convKey}, runIds=${eventRunIds.join(',')}, expected=${expectedForegroundRunId}, source=${expectedForegroundRunSource || 'unknown'})`);
            } else {
              log.trace(`Skipping non-foreground stream event (seq=${seq}, key=${convKey}, type=${streamMsg.type}, runIds=${eventRunIds.join(',')}, expected=${expectedForegroundRunId})`);
            }
            continue;
          }

          receivedAnyData = true;
          msgTypeCounts[streamMsg.type] = (msgTypeCounts[streamMsg.type] || 0) + 1;
          
          log.trace(`type=${streamMsg.type} ${JSON.stringify(streamMsg).slice(0, 300)}`);
          
          // stream_event is a low-level streaming primitive (partial deltas), not a
          // semantic type change. Skip it for type-transition logic so it doesn't
          // prematurely flush reasoning buffers or finalize assistant messages.
          const isSemanticType = streamMsg.type !== 'stream_event';

          // Finalize on type change (avoid double-handling when result provides full response)
          if (isSemanticType && lastMsgType && lastMsgType !== streamMsg.type && response.trim() && streamMsg.type !== 'result') {
            await finalizeMessage();
          }

          // Flush reasoning buffer when type changes away from reasoning
          if (isSemanticType && lastMsgType === 'reasoning' && streamMsg.type !== 'reasoning' && reasoningBuffer.trim()) {
            log.info(`Reasoning: ${reasoningBuffer.trim()}`);
            await sendReasoningDisplay(reasoningBuffer);
            reasoningBuffer = '';
          }

          // (Tool call displays fire immediately in the tool_call handler below.)
          
          // Tool loop detection
          const maxToolCalls = this.config.maxToolCalls ?? 100;
          if (streamMsg.type === 'tool_call' && (msgTypeCounts['tool_call'] || 0) >= maxToolCalls) {
            log.error(`Agent stuck in tool loop (${msgTypeCounts['tool_call']} calls), aborting`);
            session.abort().catch(() => {});
            response = '(Agent got stuck in a tool loop and was stopped. Try sending your message again.)';
            break;
          }

          // Log meaningful events with structured summaries
          if (streamMsg.type === 'tool_call') {
            this.sessionManager.syncTodoToolCall(streamMsg);
            const tcName = streamMsg.toolName || 'unknown';
            const tcId = streamMsg.toolCallId?.slice(0, 12) || '?';
            log.info(`>>> TOOL CALL: ${tcName} (id: ${tcId})`);
            sawNonAssistantSinceLastUuid = true;
            // Display tool call (args are fully accumulated by dedupedStream buffer-and-flush)
            await sendToolCallDisplay(streamMsg);
          } else if (streamMsg.type === 'tool_result') {
            log.info(`<<< TOOL RESULT: error=${streamMsg.isError}, len=${(streamMsg as any).content?.length || 0}`);
            sawNonAssistantSinceLastUuid = true;
          } else if (streamMsg.type === 'assistant' && lastMsgType !== 'assistant') {
            log.info(`Generating response...`);
          } else if (streamMsg.type === 'reasoning') {
            if (lastMsgType !== 'reasoning') {
              log.info(`Reasoning...`);
            }
            sawNonAssistantSinceLastUuid = true;
            // Accumulate reasoning content for display
            if (this.config.display?.showReasoning) {
              reasoningBuffer += streamMsg.content || '';
            }
          } else if (streamMsg.type === 'error') {
            // SDK now surfaces error detail that was previously dropped.
            // Store for use in the user-facing error message.
            lastErrorDetail = {
              message: (streamMsg as any).message || 'unknown',
              stopReason: (streamMsg as any).stopReason || 'error',
              apiError: (streamMsg as any).apiError,
            };
            log.error(`Stream error detail: ${lastErrorDetail.message} [${lastErrorDetail.stopReason}]`);
            sawNonAssistantSinceLastUuid = true;
          } else if (streamMsg.type === 'retry') {
            const rm = streamMsg as any;
            retryInfo = { attempt: rm.attempt, maxAttempts: rm.maxAttempts, reason: rm.reason };
            log.info(`Retrying (${rm.attempt}/${rm.maxAttempts}): ${rm.reason}`);
            sawNonAssistantSinceLastUuid = true;
          } else if (streamMsg.type !== 'assistant') {
            sawNonAssistantSinceLastUuid = true;
          }
          // Don't let stream_event overwrite lastMsgType -- it's noise between
          // semantic types and would cause false type-transition triggers.
          if (isSemanticType) lastMsgType = streamMsg.type;
          
          if (streamMsg.type === 'assistant') {
            const msgUuid = streamMsg.uuid;
            if (msgUuid && lastAssistantUuid && msgUuid !== lastAssistantUuid) {
              if (response.trim()) {
                if (!sawNonAssistantSinceLastUuid) {
                  log.warn(`WARNING: Assistant UUID changed (${lastAssistantUuid.slice(0, 8)} -> ${msgUuid.slice(0, 8)}) with no visible tool_call/reasoning events between them. Tool call events may have been dropped by SDK transformMessage().`);
                }
                await finalizeMessage();
              }
              // Start tracking tool/reasoning visibility for the new assistant UUID.
              sawNonAssistantSinceLastUuid = false;
            } else if (msgUuid && !lastAssistantUuid) {
              // Clear any pre-assistant noise so the first UUID becomes a clean baseline.
              sawNonAssistantSinceLastUuid = false;
            }
            lastAssistantUuid = msgUuid || lastAssistantUuid;
            
            const assistantChunk = streamMsg.content || '';
            response += assistantChunk;
            streamedAssistantText += assistantChunk;
            
            // Live-edit streaming for channels that support it
            // Hold back streaming edits while response could still be <no-reply/> or <actions> block
            const canEdit = adapter.supportsEditing?.() ?? false;
            const trimmed = response.trim();
            const mayBeHidden = '<no-reply/>'.startsWith(trimmed)
              || '<actions>'.startsWith(trimmed)
              || (trimmed.startsWith('<actions') && !trimmed.includes('</actions>'));
            // Strip any completed <actions> block from the streaming text
            const streamText = stripActionsBlock(response).trim();
            if (canEdit && !mayBeHidden && !suppressDelivery && !this.cancelledKeys.has(convKey) && streamText.length > 0 && Date.now() - lastUpdate > 1500 && Date.now() > rateLimitedUntil) {
              try {
                const prefixedStream = this.prefixResponse(streamText);
                if (messageId) {
                  await adapter.editMessage(msg.chatId, messageId, prefixedStream);
                } else {
                  const result = await adapter.sendMessage({ chatId: msg.chatId, text: prefixedStream, threadId: msg.threadId });
                  messageId = result.messageId;
                  sentAnyMessage = true;
                }
              } catch (editErr: any) {
                log.warn('Streaming edit failed:', editErr instanceof Error ? editErr.message : editErr);
                // Detect 429 rate limit and suppress further streaming edits
                const errStr = String(editErr?.message ?? editErr);
                const retryMatch = errStr.match(/retry after (\d+)/i);
                if (errStr.includes('429') || retryMatch) {
                  const retryAfter = retryMatch ? Number(retryMatch[1]) : 30;
                  rateLimitedUntil = Date.now() + retryAfter * 1000;
                  log.warn(`Rate limited -- suppressing streaming edits for ${retryAfter}s`);
                }
              }
              lastUpdate = Date.now();
            }
          }
          
          if (streamMsg.type === 'result') {
            // Discard cancelled run results -- the server flushes accumulated
            // content from a previously cancelled run as the result for the
            // next message. Discard it and retry so the message gets processed.
            if (streamMsg.stopReason === 'cancelled') {
              log.info(`Discarding cancelled run result (seq=${seq}, len=${typeof streamMsg.result === 'string' ? streamMsg.result.length : 0})`);
              this.sessionManager.invalidateSession(convKey);
              session = null;
              if (!retried) {
                return this.processMessage(msg, adapter, true);
              }
              break;
            }

            const resultRunState = this.classifyResultRun(convKey, streamMsg);
            if (resultRunState === 'stale') {
              this.sessionManager.invalidateSession(convKey);
              session = null;
              if (!retried) {
                log.warn(`Retrying message after stale duplicate result (seq=${seq}, key=${convKey})`);
                return this.processMessage(msg, adapter, true);
              }
              response = '';
              break;
            }

            sawForegroundResult = true;

            const resultText = typeof streamMsg.result === 'string' ? streamMsg.result : '';
            if (resultText.trim().length > 0) {
              const streamedTextTrimmed = streamedAssistantText.trim();
              const resultTextTrimmed = resultText.trim();
              // Decision tree:
              // 1) Diverged from streamed output -> prefer streamed text (active fix today)
              // 2) No streamed assistant text -> use result text as fallback
              // 3) Streamed text exists but nothing was delivered -> allow one result resend
              // Compare against all streamed assistant text, not the current
              // response buffer (which can be reset between assistant turns).
              if (streamedTextTrimmed.length > 0 && resultTextTrimmed !== streamedTextTrimmed) {
                log.warn(
                  `Result text diverges from streamed content ` +
                  `(resultLen=${resultText.length}, streamLen=${streamedAssistantText.length}). ` +
                  `Preferring streamed content to avoid n-1 desync.`
                );
              } else if (streamedTextTrimmed.length === 0 && streamMsg.success !== false && !streamMsg.error) {
                // Fallback for models/providers that only populate result text.
                // Skip on error results -- the result field may contain reasoning
                // text or other non-deliverable content (e.g. llm_api_error).
                response = resultText;
              } else if (!sentAnyMessage && response.trim().length === 0 && streamMsg.success !== false && !streamMsg.error) {
                // Safety fallback: if we streamed text but nothing was
                // delivered yet, allow a single result-based resend.
                // Skip on error results for the same reason as above.
                response = resultText;
              }
            }
            const hasResponse = response.trim().length > 0;
            log.info(`Stream result: seq=${seq} success=${streamMsg.success}, hasResponse=${hasResponse}, resultLen=${resultText.length}`);
            if (response.trim().length > 0) {
              log.debug(`Stream result preview: seq=${seq} responsePreview=${response.trim().slice(0, 60)}`);
            }
            log.info(`Stream message counts:`, msgTypeCounts);
            if (filteredRunEventCount > 0) {
              log.info(`Filtered ${filteredRunEventCount} non-foreground event(s) from stream (seq=${seq}, key=${convKey}, expectedRunId=${expectedForegroundRunId || 'unknown'})`);
            }
            if (ignoredNonForegroundResultCount > 0) {
              log.info(`Ignored ${ignoredNonForegroundResultCount} non-foreground result event(s) (seq=${seq}, key=${convKey}, expectedRunId=${expectedForegroundRunId || 'unknown'})`);
            }
            if (bufferedDisplayFlushCount > 0 || bufferedDisplayDropCount > 0) {
              log.info(`Buffered display events: flushed=${bufferedDisplayFlushCount}, dropped=${bufferedDisplayDropCount} (seq=${seq}, key=${convKey}, expectedRunId=${expectedForegroundRunId || 'unknown'})`);
            }
            if (streamMsg.error) {
              const detail = resultText.trim();
              const parts = [`error=${streamMsg.error}`];
              if (streamMsg.stopReason) parts.push(`stopReason=${streamMsg.stopReason}`);
              if (streamMsg.durationMs !== undefined) parts.push(`duration=${streamMsg.durationMs}ms`);
              if (streamMsg.conversationId) parts.push(`conv=${streamMsg.conversationId}`);
              if (detail) parts.push(`detail=${detail.slice(0, 300)}`);
              log.error(`Result error: ${parts.join(', ')}`);
            }

            // Retry once when stream ends without any assistant text.
            // This catches both empty-success and terminal-error runs.
            // TODO(letta-code-sdk#31): Remove once SDK handles HITL approvals in bypassPermissions mode.
            // Only retry if we never sent anything to the user. hasResponse tracks
            // the current buffer, but finalizeMessage() clears it on type changes.
            // sentAnyMessage is the authoritative "did we deliver output" flag.
            const retryConvKey = this.resolveConversationKey(msg.channel, msg.chatId);
            const retryConvIdFromStore = (retryConvKey === 'shared'
              ? this.store.conversationId
              : this.store.getConversationId(retryConvKey)) ?? undefined;
            const retryConvId = (typeof streamMsg.conversationId === 'string' && streamMsg.conversationId.length > 0)
              ? streamMsg.conversationId
              : retryConvIdFromStore;
            const initialRetryDecision = this.buildResultRetryDecision(
              streamMsg,
              resultText,
              hasResponse,
              sentAnyMessage,
              lastErrorDetail,
            );

            // Enrich opaque error detail from run metadata (single fast API call).
            // The wire protocol's stop_reason often just says "error" -- the run
            // metadata has the actual detail (e.g. "waiting for approval on a tool call").
            if (initialRetryDecision.isTerminalError && this.store.agentId &&
                (!lastErrorDetail || lastErrorDetail.message === 'Agent stopped: error')) {
              const enriched = await getLatestRunError(this.store.agentId, retryConvId);
              if (enriched) {
                lastErrorDetail = {
                  message: enriched.message,
                  stopReason: enriched.stopReason,
                  isApprovalError: enriched.isApprovalError,
                };
              }
            }

            const retryDecision = this.buildResultRetryDecision(
              streamMsg,
              resultText,
              hasResponse,
              sentAnyMessage,
              lastErrorDetail,
            );

            // For approval-specific conflicts, attempt recovery directly (don't
            // enter the generic retry path which would just get another CONFLICT).
            // Use isApprovalError from run metadata as a fallback when the
            // error message doesn't contain the expected strings (e.g. when
            // the type=error event was lost and enrichment detected a stuck run).
            if (retryDecision.isApprovalConflict && !retried && this.store.agentId) {
              if (retryConvId) {
                log.info('Approval conflict detected -- attempting targeted recovery...');
                this.sessionManager.invalidateSession(retryConvKey);
                session = null;
                clearInterval(typingInterval);
                const convResult = await recoverOrphanedConversationApproval(
                  this.store.agentId, retryConvId, true /* deepScan */
                );
                if (convResult.recovered) {
                  log.info(`Approval recovery succeeded (${convResult.details}), retrying message...`);
                  return this.processMessage(msg, adapter, true);
                }
                log.warn(`Approval recovery failed: ${convResult.details}`);
                log.info('Retrying once with a fresh session after approval conflict...');
                return this.processMessage(msg, adapter, true);
              }
            }

            if (retryDecision.shouldRetryForEmptyResult || retryDecision.shouldRetryForErrorResult) {
              if (retryDecision.shouldRetryForEmptyResult) {
                log.error(`Warning: Agent returned empty result with no response. stopReason=${streamMsg.stopReason || 'N/A'}, conv=${streamMsg.conversationId || 'N/A'}`);
              }
              if (retryDecision.shouldRetryForErrorResult) {
                log.error(`Warning: Agent returned terminal error (error=${streamMsg.error}, stopReason=${streamMsg.stopReason || 'N/A'}) with no response.`);
              }

              if (!retried && this.store.agentId && retryConvId) {
                const reason = retryDecision.shouldRetryForErrorResult ? 'error result' : 'empty result';
                log.info(`${reason} - attempting orphaned approval recovery...`);
                this.sessionManager.invalidateSession(retryConvKey);
                session = null;
                clearInterval(typingInterval);
                const convResult = await recoverOrphanedConversationApproval(
                  this.store.agentId,
                  retryConvId
                );
                if (convResult.recovered) {
                  log.info(`Recovery succeeded (${convResult.details}), retrying message...`);
                  return this.processMessage(msg, adapter, true);
                }
                log.warn(`No orphaned approvals found: ${convResult.details}`);

                // Some client-side approval failures do not surface as pending approvals.
                // Retry once anyway in case the previous run terminated mid-tool cycle.
                if (retryDecision.shouldRetryForErrorResult) {
                  log.info('Retrying once after terminal error (no orphaned approvals detected)...');
                  return this.processMessage(msg, adapter, true);
                }
              }
            }

            if (retryDecision.isTerminalError && !hasResponse && !sentAnyMessage) {
              if (lastErrorDetail) {
                response = formatApiErrorForUser(lastErrorDetail);
              } else {
                const err = streamMsg.error || 'unknown error';
                const reason = streamMsg.stopReason ? ` [${streamMsg.stopReason}]` : '';
                response = `(Agent run failed: ${err}${reason}. Try sending your message again.)`;
              }
            }
            
            break;
          }
        }
      } finally {
        clearInterval(typingInterval);
        adapter.stopTypingIndicator?.(msg.chatId)?.catch(() => {});
      }
      lap('stream complete');

      // If cancelled, clean up partial state and return early
      if (this.cancelledKeys.has(convKey)) {
        if (messageId) {
          try {
            await adapter.editMessage(msg.chatId, messageId, '(Run cancelled.)');
          } catch { /* best effort */ }
        }
        log.info(`Skipping post-stream delivery -- cancelled (key=${convKey})`);
        return;
      }

      const missingForegroundTerminalResult =
        expectedForegroundRunId !== null &&
        !sawForegroundResult &&
        sawCompetingRunEvent &&
        !sentAnyMessage;

      if (missingForegroundTerminalResult) {
        log.warn(`Foreground run ended without terminal result after competing run activity (seq=${seq}, key=${convKey}, expectedRunId=${expectedForegroundRunId})`);
        this.sessionManager.invalidateSession(convKey);
        session = null;
        response = '';
        reasoningBuffer = '';
        if (!retried) {
          return this.processMessage(msg, adapter, true);
        }
        response = '(The agent stream ended before a foreground result was received. Please try again.)';
      }

      // Parse and execute XML directives (e.g. <actions><react emoji="eyes" /></actions>)
      await parseAndHandleDirectives();

      // Handle no-reply marker AFTER directive parsing
      if (response.trim() === '<no-reply/>') {
        sentAnyMessage = true;
        response = '';
      }

      // Detect unsupported multimodal
      if (Array.isArray(messageToSend) && response.includes('[Image omitted]')) {
        log.warn('Model does not support images -- consider a vision-capable model or features.inlineImages: false');
      }

      // Listening mode: agent processed for memory, suppress response delivery
      if (suppressDelivery) {
        log.info(`Listening mode: processed ${msg.channel}:${msg.chatId} for memory (response suppressed)`);
        return;
      }

      lap('directives done');
      // Send final response
      if (response.trim()) {
        // Wait out any active rate limit before sending the final message
        const rateLimitRemaining = rateLimitedUntil - Date.now();
        if (rateLimitRemaining > 0) {
          const waitMs = Math.min(rateLimitRemaining, 30_000); // Cap at 30s
          log.info(`Waiting ${(waitMs / 1000).toFixed(1)}s for rate limit before final send`);
          await new Promise(resolve => setTimeout(resolve, waitMs));
        }
        const prefixedFinal = this.prefixResponse(response);
        try {
          if (messageId) {
            await adapter.editMessage(msg.chatId, messageId, prefixedFinal);
          } else {
            await adapter.sendMessage({ chatId: msg.chatId, text: prefixedFinal, threadId: msg.threadId });
          }
          sentAnyMessage = true;
          this.store.resetRecoveryAttempts();
        } catch (sendErr) {
          // Edit failed -- send as new message so user isn't left with truncated text
          log.warn('Final message delivery failed:', sendErr instanceof Error ? sendErr.message : sendErr);
          try {
            await adapter.sendMessage({ chatId: msg.chatId, text: prefixedFinal, threadId: msg.threadId });
            sentAnyMessage = true;
            this.store.resetRecoveryAttempts();
          } catch (retryError) {
            log.error('Retry send also failed:', retryError);
          }
        }
      }
      
      lap('message delivered');
      await this.deliverNoVisibleResponseIfNeeded(msg, adapter, sentAnyMessage, receivedAnyData, msgTypeCounts);
      
    } catch (error) {
      log.error('Error processing message:', error);
      try {
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          threadId: msg.threadId,
        });
      } catch (sendError) {
        log.error('Failed to send error message to channel:', sendError);
      }
    } finally {
      const finalConvKey = this.resolveConversationKey(msg.channel, msg.chatId);
      // When session reuse is disabled, invalidate after every message to
      // eliminate any possibility of stream state bleed between sequential
      // sends. Costs ~5s subprocess init overhead per message.
      if (this.config.reuseSession === false) {
        this.sessionManager.invalidateSession(finalConvKey);
      }
      this.cancelledKeys.delete(finalConvKey);
    }
  }

  // =========================================================================
  // sendToAgent - Background triggers (heartbeats, cron, webhooks)
  // =========================================================================
  
  /**
   * Acquire the appropriate lock for a conversation key.
   * In per-channel mode, wait for that key's queue to drain before proceeding.
   * In shared mode, use the global processing flag.
   * All keys — including 'heartbeat' — are serialized to prevent concurrent
   * sends on the same Session object, which the SDK does not support.
   */
  private async acquireLock(convKey: string): Promise<boolean> {
    if (convKey !== 'shared') {
      while (this.processingKeys.has(convKey)) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      this.processingKeys.add(convKey);
    } else {
      while (this.processing) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      this.processing = true;
    }
    return true;
  }

  private releaseLock(convKey: string, acquired: boolean): void {
    if (!acquired) return;
    if (convKey !== 'shared') {
      this.processingKeys.delete(convKey);
      // Heartbeats/sendToAgent may hold a channel key while user messages for
      // that same key queue up. Kick the keyed worker after unlock so queued
      // messages are not left waiting for another inbound message to arrive.
      const queue = this.keyedQueues.get(convKey);
      if (queue && queue.length > 0) {
        this.processKeyedQueue(convKey).catch(err =>
          log.error(`Fatal error in processKeyedQueue(${convKey}) after lock release:`, err)
        );
      }
    } else {
      this.processing = false;
      this.processQueue();
    }
  }

  async sendToAgent(
    text: string,
    context?: TriggerContext
  ): Promise<string> {
    const isSilent = context?.outputMode === 'silent';
    const convKey = this.resolveHeartbeatConversationKey();
    const acquired = await this.acquireLock(convKey);
    
    try {
      let retried = false;
      while (true) {
        const { stream } = await this.sessionManager.runSession(text, { convKey, retried });

        try {
          let response = '';
          let sawStaleDuplicateResult = false;
          let approvalRetryPending = false;
          let usedMessageCli = false;
          let lastErrorDetail: StreamErrorDetail | undefined;
          for await (const msg of stream()) {
            if (msg.type === 'tool_call') {
              this.sessionManager.syncTodoToolCall(msg);
              if (isSilent && msg.toolName === 'Bash') {
                const cmd = String((msg as any).toolInput?.command ?? msg.rawArguments ?? '');
                if (cmd.includes('lettabot-message send')) usedMessageCli = true;
              }
            }
            if (msg.type === 'error') {
              lastErrorDetail = {
                message: (msg as any).message || 'unknown',
                stopReason: (msg as any).stopReason || 'error',
                apiError: (msg as any).apiError,
              };
            }
            if (msg.type === 'assistant') {
              response += msg.content || '';
            }
            if (msg.type === 'result') {
              const resultRunState = this.classifyResultRun(convKey, msg);
              if (resultRunState === 'stale') {
                sawStaleDuplicateResult = true;
                break;
              }

              // TODO(letta-code-sdk#31): Remove once SDK handles HITL approvals in bypassPermissions mode.
              if (msg.success === false || msg.error) {
                // Enrich opaque errors from run metadata (mirrors processMessage logic).
                const convId = typeof msg.conversationId === 'string' ? msg.conversationId : undefined;
                if (this.store.agentId &&
                    (!lastErrorDetail || lastErrorDetail.message === 'Agent stopped: error')) {
                  const enriched = await getLatestRunError(this.store.agentId, convId);
                  if (enriched) {
                    lastErrorDetail = {
                      message: enriched.message,
                      stopReason: enriched.stopReason,
                      isApprovalError: enriched.isApprovalError,
                    };
                  }
                }
                const isApprovalIssue = lastErrorDetail?.isApprovalError === true
                  || ((lastErrorDetail?.message?.toLowerCase().includes('conflict') || false)
                  && (lastErrorDetail?.message?.toLowerCase().includes('waiting for approval') || false));
                if (isApprovalIssue && !retried) {
                  log.info('sendToAgent: approval issue detected -- retrying once with fresh session...');
                  this.sessionManager.invalidateSession(convKey);
                  retried = true;
                  approvalRetryPending = true;
                  break;
                }
                const errMsg = lastErrorDetail?.message || msg.error || 'error';
                const errReason = lastErrorDetail?.stopReason || msg.error || 'error';
                const detail = typeof msg.result === 'string' ? msg.result.trim() : '';
                throw new Error(detail ? `Agent run failed: ${errReason} (${errMsg})` : `Agent run failed: ${errReason} -- ${errMsg}`);
              }
              break;
            }
          }

          if (approvalRetryPending) {
            continue;
          }

          if (sawStaleDuplicateResult) {
            this.sessionManager.invalidateSession(convKey);
            if (retried) {
              throw new Error('Agent stream returned stale duplicate result after retry');
            }
            log.warn(`Retrying sendToAgent after stale duplicate result (key=${convKey})`);
            retried = true;
            continue;
          }

          // Parse and execute directives from the response.
          // Targeted directives (send-message, cross-channel send-file) work in any context.
          // Non-targeted directives work when source adapter context is available.
          let executedDirectives = false;
          if (response.trim()) {
            const parsed = parseDirectives(response);
            if (parsed.directives.length > 0) {
              const sourceAdapter = context?.sourceChannel ? this.channels.get(context.sourceChannel) : undefined;
              const sourceChatId = context?.sourceChatId ?? '';

              // Without a valid source adapter, only explicitly targeted directives can run.
              // Non-targeted directives (react, voice, untargeted send-file) need a source
              // chat context and must be filtered out to avoid executing against a wrong channel.
              const directives = sourceAdapter
                ? parsed.directives
                : parsed.directives.filter(d =>
                    d.type === 'send-message' || (d.type === 'send-file' && d.channel && d.chat)
                  );

              if (directives.length > 0) {
                // Targeted directives resolve their own adapter; the fallback here is only
                // used by non-targeted directives (which are filtered out when no source).
                const adapter = sourceAdapter ?? this.channels.values().next().value;
                if (adapter) {
                  executedDirectives = await this.executeDirectives(
                    directives, adapter, sourceChatId,
                  );
                }
              }
              response = parsed.cleanText;
            }
          }

          if (isSilent && response.trim()) {
            if (usedMessageCli || executedDirectives) {
              log.info(`Silent mode: agent delivered via ${[usedMessageCli && 'CLI', executedDirectives && 'directives'].filter(Boolean).join(' + ')}, remaining text (${response.length} chars) not delivered`);
            } else {
              log.warn(`Silent mode: agent produced ${response.length} chars but did NOT use lettabot-message CLI or directives — response discarded. If this keeps happening, the agent's model may not be following silent mode instructions.`);
            }
          }
          return response;
        } catch (error) {
          // Invalidate on stream errors so next call gets a fresh subprocess
          this.sessionManager.invalidateSession(convKey);
          throw error;
        }

      }
    } finally {
      if (this.config.reuseSession === false) {
        this.sessionManager.invalidateSession(convKey);
      }
      this.releaseLock(convKey, acquired);
    }
  }

  /**
   * Stream a message to the agent, yielding chunks as they arrive.
   * Same lifecycle as sendToAgent() but yields StreamMsg instead of accumulating.
   */
  async *streamToAgent(
    text: string,
    context?: TriggerContext
  ): AsyncGenerator<StreamMsg> {
    const convKey = this.resolveHeartbeatConversationKey();
    const acquired = await this.acquireLock(convKey);

    try {
      const { stream } = await this.sessionManager.runSession(text, { convKey });

      try {
        yield* stream();
      } catch (error) {
        this.sessionManager.invalidateSession(convKey);
        throw error;
      }
    } finally {
      if (this.config.reuseSession === false) {
        this.sessionManager.invalidateSession(convKey);
      }
      this.releaseLock(convKey, acquired);
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
      kind?: 'image' | 'file' | 'audio';
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

  getStatus(): { agentId: string | null; conversationId: string | null; channels: string[] } {
    this.store.refresh();
    return {
      agentId: this.store.agentId,
      conversationId: this.store.conversationId,
      channels: Array.from(this.channels.keys()),
    };
  }
  
  setAgentId(agentId: string): void {
    this.store.agentId = agentId;
    log.info(`Agent ID set to: ${agentId}`);
  }
  
  reset(): void {
    this.store.reset();
    log.info('Agent reset');
  }
  
  getLastMessageTarget(): { channel: string; chatId: string } | null {
    return this.store.lastMessageTarget || null;
  }
  
  getLastUserMessageTime(): Date | null {
    return this.lastUserMessageTime;
  }
}

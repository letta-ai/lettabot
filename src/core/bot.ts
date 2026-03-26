/**
 * LettaBot Core - Handles agent communication
 * 
 * Single agent, single conversation - chat continues across all channels.
 */

import { imageFromBase64, type ImageContent, type Session, type MessageContentItem, type SendMessage, type CanUseToolCallback } from '@letta-ai/letta-code-sdk';
import { mkdirSync, existsSync } from 'node:fs';
import { readFile, access, unlink, realpath, stat, constants } from 'node:fs/promises';
import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { extname, resolve, join } from 'node:path';
import type { ChannelAdapter } from '../channels/types.js';
import type { BotConfig, InboundMessage, TriggerContext, TriggerType, StreamMsg } from './types.js';
import { formatApiErrorForUser } from './errors.js';
import { formatToolCallDisplay, formatReasoningDisplay, formatQuestionsForChannel } from './display.js';
import type { AgentSession } from './interfaces.js';
import { Store } from './store.js';
import { getPendingApprovals, rejectApproval, approvePendingApproval, cancelRuns, cancelConversation, recoverOrphanedConversationApproval, getLatestRunError, getAgentModel, updateAgentModel, isRecoverableConversationId, recoverPendingApprovalsForAgent } from '../tools/letta-api.js';
import { getAgentSkillExecutableDirs, isVoiceMemoConfigured } from '../skills/loader.js';
import { formatMessageEnvelope, formatGroupBatchEnvelope, type SessionContextOptions } from './formatter.js';
import type { GroupBatcher } from './group-batcher.js';
import { recoverPendingApprovalsWithSdk } from './session-sdk-compat.js';
import { redactOutbound } from './redact.js';
import {
  hasIncompleteActionsTag,
  hasUnclosedActionsBlock,
  parseDirectives,
  stripActionsBlock,
  type Directive,
} from './directives.js';
import { resolveEmoji } from './emoji.js';
import { SessionManager } from './session-manager.js';
import { createDisplayPipeline, type DisplayEvent, type CompleteEvent, type ErrorEvent } from './display-pipeline.js';
import { TurnLogger, TurnAccumulator, generateTurnId, type TurnRecord } from './turn-logger.js';


import { createLogger, type Logger } from '../logger.js';

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

/** Anthropic recommends max 1568px on longest side; larger images waste bandwidth for no benefit. */
const MAX_IMAGE_DIMENSION = 1568;

const MIME_FROM_EXT: Record<string, ImageContent['source']['media_type']> = {
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

/**
 * Read, resize (if needed), and base64-encode an image for the LLM.
 * Returns null on any failure so the caller can skip gracefully.
 */
async function prepareImage(
  source: { localPath?: string; url?: string; mimeType?: string; name?: string },
  logger: Logger,
): Promise<ImageContent | null> {
  let buffer: Buffer;
  let mediaType: ImageContent['source']['media_type'];

  // Resolve media type from attachment metadata or file extension
  const resolveMime = (hint?: string, path?: string): ImageContent['source']['media_type'] => {
    if (hint && SUPPORTED_IMAGE_MIMES.has(hint)) return hint as ImageContent['source']['media_type'];
    if (path) {
      const ext = extname(path).toLowerCase();
      if (MIME_FROM_EXT[ext]) return MIME_FROM_EXT[ext];
    }
    return 'image/jpeg'; // safe default
  };

  if (source.localPath) {
    buffer = await readFile(source.localPath);
    mediaType = resolveMime(source.mimeType, source.localPath);
  } else if (source.url) {
    const response = await fetch(source.url);
    if (!response.ok) {
      logger.warn(`Failed to fetch image from ${source.url}: HTTP ${response.status}`);
      return null;
    }
    buffer = Buffer.from(await response.arrayBuffer());
    const ct = response.headers.get('content-type') ?? undefined;
    mediaType = resolveMime(ct ?? source.mimeType, source.url);
  } else {
    return null;
  }

  // Resize if the longest side exceeds the threshold
  const metadata = await sharp(buffer).metadata();
  const longest = Math.max(metadata.width ?? 0, metadata.height ?? 0);

  if (longest > MAX_IMAGE_DIMENSION) {
    logger.info(`Resizing image ${source.name || 'unknown'} from ${metadata.width}x${metadata.height} (max side → ${MAX_IMAGE_DIMENSION}px)`);
    buffer = await sharp(buffer)
      .resize({ width: MAX_IMAGE_DIMENSION, height: MAX_IMAGE_DIMENSION, fit: 'inside', withoutEnlargement: true })
      .toBuffer();
  }

  const data = buffer.toString('base64');
  return imageFromBase64(data, mediaType);
}

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
  logger: Logger,
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
      const item = await prepareImage(attachment, logger);
      if (item) content.push(item);
    } catch (err) {
      logger.warn(`Failed to load image ${attachment.name || 'unknown'}: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (content.length > 1) {
    logger.info(`Sending ${content.length - 1} inline image(s) to LLM`);
  }

  return content.length > 1 ? content : formattedText;
}

export { type StreamMsg } from './types.js';

export function isResponseDeliverySuppressed(msg: Pick<InboundMessage, 'isListeningMode'>): boolean {
  return msg.isListeningMode === true;
}

/**
 * Combine multiple pending messages into a single synthetic message.
 * Text is joined with newlines; metadata comes from the last message.
 * Used when rapid-fire DM messages accumulate while a turn is processing.
 */
export function combinePendingMessages(messages: InboundMessage[]): InboundMessage {
  if (messages.length === 1) return messages[0];
  const last = messages[messages.length - 1];
  const combinedText = messages.map(m => m.text).filter(Boolean).join('\n');
  const allAttachments = messages.flatMap(m => m.attachments || []);
  return {
    ...last,
    text: combinedText,
    ...(allAttachments.length > 0 ? { attachments: allAttachments } : {}),
    isBatch: true,
    batchedMessages: messages,
  };
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
  forcePerChat?: boolean,
): string {
  if (conversationMode === 'disabled') return 'default';
  const normalized = channel.toLowerCase();
  if ((conversationMode === 'per-chat' || forcePerChat) && chatId) return `${normalized}:${chatId}`;
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
  private readonly log: Logger;
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
  private backgroundCancelledKeys: Set<string> = new Set(); // Tracks background runs cancelled by live user activity
  private activeBackgroundTriggerByKey: Map<string, string> = new Map();
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
  private readonly turnLogger: TurnLogger | null;

  constructor(config: BotConfig) {
    this.config = config;
    this.log = createLogger('Bot', config.agentName);
    mkdirSync(config.workingDir, { recursive: true });
    this.store = new Store('lettabot-agent.json', config.agentName);
    this.turnLogger = config.logging?.turnLogFile
      ? new TurnLogger(config.logging.turnLogFile, config.logging.maxTurns)
      : null;
    if (config.reuseSession === false) {
      this.log.warn('Session reuse disabled (conversations.reuseSession=false): each foreground/background message uses a fresh SDK subprocess (~5s overhead per turn).');
    }
    if (config.conversationOverrides?.length) {
      this.conversationOverrides = new Set(config.conversationOverrides.map((ch) => ch.toLowerCase()));
    }
    this.sessionManager = new SessionManager(this.store, config, this.processingKeys, this.lastResultRunFingerprints);
    this.log.info(`LettaBot initialized. Agent ID: ${this.store.agentId || '(new)'}`);
  }

  // =========================================================================
  // Per-channel display resolution
  // =========================================================================

  /**
   * Resolve display settings for a channel, with per-channel overrides.
   * channelDisplay overrides take precedence over agent-level display.
   */
  private getDisplayConfig(channelId: string): { showToolCalls: boolean; showReasoning: boolean; reasoningMaxChars?: number } {
    const base = this.config.display;
    const override = this.config.channelDisplay?.[channelId];
    return {
      showToolCalls: override?.showToolCalls ?? base?.showToolCalls ?? false,
      showReasoning: override?.showReasoning ?? base?.showReasoning ?? false,
      reasoningMaxChars: override?.reasoningMaxChars ?? base?.reasoningMaxChars,
    };
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
      this.log.warn(`Detected stale duplicate result (key=${convKey}, runIds=${fingerprint})`);
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
          this.log.warn(`Directive react skipped: ${adapter.name} does not support addReaction`);
          continue;
        }
        if (targetId) {
          // Resolve text aliases (thumbsup, eyes, etc.) to Unicode characters.
          // The LLM typically outputs names; channel APIs need actual emoji.
          const resolved = resolveEmoji(directive.emoji);
          try {
            await adapter.addReaction(chatId, targetId, resolved.unicode);
            acted = true;
            this.log.info(`Directive: reacted with ${resolved.unicode} (${directive.emoji})`);
          } catch (err) {
            this.log.warn('Directive react failed:', err instanceof Error ? err.message : err);
          }
        }
        continue;
      }

      if (directive.type === 'send-message') {
        // Targeted message delivery to a specific channel:chat.
        try {
          const targetAdapter = this.channels.get(directive.channel);
          if (!targetAdapter) {
            this.log.warn(`Directive send-message skipped: channel "${directive.channel}" not registered`);
            continue;
          }
          await targetAdapter.sendMessage({ chatId: directive.chat, text: this.prefixResponse(directive.text) });
          acted = true;
          this.log.info(`Directive: sent message to ${directive.channel}:${directive.chat} (${directive.text.length} chars)`);
        } catch (err) {
          this.log.warn('Directive send-message failed:', err instanceof Error ? err.message : err);
        }
        continue;
      }

      if (directive.type === 'send-file') {
        // Reject partial targeting: both channel and chat must be set together.
        // Without this guard, a missing field silently falls back to the triggering chat.
        if ((directive.channel && !directive.chat) || (!directive.channel && directive.chat)) {
          this.log.warn(`Directive send-file skipped: cross-channel targeting requires both channel and chat (got channel=${directive.channel || 'missing'}, chat=${directive.chat || 'missing'})`);
          continue;
        }

        // Resolve target adapter: use cross-channel targeting if both channel and chat are set,
        // otherwise fall back to the adapter/chatId that triggered this response.
        const targetAdapter = (directive.channel && directive.chat)
          ? this.channels.get(directive.channel)
          : adapter;
        const targetChatId = (directive.channel && directive.chat) ? directive.chat : chatId;

        if (!targetAdapter) {
          this.log.warn(`Directive send-file skipped: channel "${directive.channel}" not registered`);
          continue;
        }
        if (typeof targetAdapter.sendFile !== 'function') {
          this.log.warn(`Directive send-file skipped: ${targetAdapter.name} does not support sendFile`);
          continue;
        }

        // Path sandboxing: resolve both config and directive paths relative to workingDir.
        // This keeps behavior consistent when process.cwd differs from agent workingDir.
        const allowedDirConfig = this.config.sendFileDir || join('data', 'outbound');
        const allowedDir = resolve(this.config.workingDir, allowedDirConfig);
        const resolvedPath = resolve(this.config.workingDir, directive.path);
        if (!await isPathAllowed(resolvedPath, allowedDir)) {
          this.log.warn(`Directive send-file blocked: ${directive.path} is outside allowed directory ${allowedDir}`);
          continue;
        }

        // Async file existence + readability check
        try {
          await access(resolvedPath, constants.R_OK);
        } catch {
          this.log.warn(`Directive send-file skipped: file not found or not readable at ${directive.path}`);
          continue;
        }

        // File size guard (default: 50MB)
        const maxSize = this.config.sendFileMaxSize ?? 50 * 1024 * 1024;
        try {
          const fileStat = await stat(resolvedPath);
          if (fileStat.size > maxSize) {
            this.log.warn(`Directive send-file blocked: ${directive.path} is ${fileStat.size} bytes (max: ${maxSize})`);
            continue;
          }
        } catch {
          this.log.warn(`Directive send-file skipped: could not stat ${directive.path}`);
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
          this.log.info(`Directive: sent file ${resolvedPath}${target}`);

          // Optional cleanup: delete file after successful send.
          // Only honored when sendFileCleanup is enabled in config (defense-in-depth).
          if (directive.cleanup && this.config.sendFileCleanup) {
            try {
              await unlink(resolvedPath);
              this.log.warn(`Directive: cleaned up ${resolvedPath}`);
            } catch (cleanupErr) {
              this.log.warn('Directive send-file cleanup failed:', cleanupErr instanceof Error ? cleanupErr.message : cleanupErr);
            }
          }
        } catch (err) {
          this.log.warn('Directive send-file failed:', err instanceof Error ? err.message : err);
        }
      }

      if (directive.type === 'voice') {
        if (!isVoiceMemoConfigured()) {
          this.log.warn('Directive voice skipped: no TTS credentials configured');
          continue;
        }
        if (typeof adapter.sendFile !== 'function') {
          this.log.warn(`Directive voice skipped: ${adapter.name} does not support sendFile`);
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
          this.log.warn('Directive voice skipped: lettabot-tts not found in skill dirs');
          continue;
        }

        this.log.info(
          `Directive voice: generating memo (provider=${ttsProvider}, model=${ttsModel}, voice=${ttsVoice}, textLen=${directive.text.length})`,
        );
        this.log.info(`Directive voice: helper=${ttsPath}`);

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
                  this.log.warn('Directive voice: lettabot-tts stderr:', stderr.trim());
                }
                resolve(output.split('\n').at(-1)?.trim() || output);
              }
            });
          });

          const outputStats = await stat(outputPath);
          if (!outputStats.isFile()) {
            throw new Error(`Generated TTS output is not a file: ${outputPath}`);
          }
          this.log.info(`Directive voice: generated file ${outputPath} (${outputStats.size} bytes)`);

          await adapter.sendFile({
            chatId,
            filePath: outputPath,
            kind: 'audio',
            threadId,
          });
          acted = true;
          this.log.info(`Directive: sent voice memo (${directive.text.length} chars)`);

          // Clean up generated file
          try { await unlink(outputPath); } catch {}
        } catch (err) {
          const execErr = err as Error & {
            code?: string | number | null;
            signal?: NodeJS.Signals;
            stdout?: string;
            stderr?: string;
          };
          this.log.warn('Directive voice failed:', {
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
  private resolveConversationKey(channel: string, chatId?: string, forcePerChat?: boolean): string {
    return resolveConversationKey(channel, this.config.conversationMode, this.conversationOverrides, chatId, forcePerChat);
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
    adapter.onCommand = (cmd, chatId, args, forcePerChat) => this.handleCommand(cmd, adapter.id, chatId, args, forcePerChat);

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
    this.log.info(`Registered channel: ${adapter.name}`);
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
    this.log.info('Group batcher configured');
  }

  processGroupBatch(msg: InboundMessage, adapter: ChannelAdapter): void {
    const count = msg.batchedMessages?.length || 0;
    this.log.info(`Group batch: ${count} messages from ${msg.channel}:${msg.chatId}`);
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

    const convKey = this.resolveConversationKey(effective.channel, effective.chatId, effective.forcePerChat);
    if (convKey !== 'shared') {
      this.enqueueForKey(convKey, effective, adapter);
    } else {
      this.messageQueue.push({ msg: effective, adapter });
      if (!this.processing) {
        this.processQueue().catch(err => this.log.error('Fatal error in processQueue:', err));
      }
    }
  }

  // =========================================================================
  // Commands
  // =========================================================================

  private async handleCommand(command: string, channelId?: string, chatId?: string, args?: string, forcePerChat?: boolean): Promise<string | null> {
    this.log.info(`Received: /${command}${args ? ` ${args}` : ''}`);
    switch (command) {
      case 'status': {
        const info = this.store.getInfo();
        const memfsState = this.config.memfs === true
          ? 'on'
          : this.config.memfs === false
            ? 'off'
            : 'unknown';
        const serverUrl = info.baseUrl || process.env.LETTA_BASE_URL || 'https://api.letta.com';
        const conversationId = info.conversationId || '(none)';
        const conversationKeys = info.conversations
          ? Object.keys(info.conversations).sort()
          : [];
        const channels = Array.from(this.channels.keys());
        const lines = [
          `*Status*`,
          `Agent ID: \`${info.agentId || '(none)'}\``,
          `Conversation ID: \`${conversationId}\``,
          `Conversation keys: ${conversationKeys.length > 0 ? conversationKeys.join(', ') : '(none)'}`,
          `Memfs: ${memfsState}`,
          `Server: ${serverUrl}`,
          `Created: ${info.createdAt || 'N/A'}`,
          `Last used: ${info.lastUsedAt || 'N/A'}`,
          `Channels: ${channels.length > 0 ? channels.join(', ') : '(none)'}`,
        ];
        return lines.join('\n');
      }
      case 'heartbeat': {
        if (!this.onTriggerHeartbeat) {
          return '⚠️ Heartbeat service not configured';
        }
        this.onTriggerHeartbeat().catch(err => {
          this.log.error('Manual trigger failed:', err);
        });
        return '⏰ Heartbeat triggered (silent mode - check server logs)';
      }
      case 'reset': {
        // Always scope the reset to the caller's conversation key so that
        // other channels/chats' conversations are never silently destroyed.
        // resolveConversationKey returns 'shared' for non-override channels,
        // the channel id for per-channel, or channel:chatId for per-chat.
        const convKey = channelId ? this.resolveConversationKey(channelId, chatId, forcePerChat) : 'shared';

        // In disabled mode the bot always uses the agent's built-in default
        // conversation -- there's nothing to reset locally.
        if (convKey === 'default') {
          return 'Conversations are disabled -- nothing to reset.';
        }

        this.store.clearConversation(convKey);
        this.store.resetRecoveryAttempts();
        this.sessionManager.invalidateSession(convKey);
        this.log.info(`/reset - conversation cleared for key="${convKey}"`);
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
        const convKey = channelId ? this.resolveConversationKey(channelId, chatId, forcePerChat) : 'shared';

        // Check if there's actually an active run for this conversation key
        if (!this.processingKeys.has(convKey) && !this.processing) {
          return '(Nothing to cancel -- no active run.)';
        }

        // Signal the stream loop to break
        this.cancelledKeys.add(convKey);

        // Abort client-side stream and kill the session subprocess.
        // abort() sends an interrupt control_request, but the CLI may not
        // handle it if blocked on a long-running tool (e.g., Task subagent).
        // invalidateSession() calls session.close() which kills the subprocess,
        // closes the transport pump, and resolves all stream waiters with null
        // -- guaranteeing the for-await loop in processMessage breaks.
        const session = this.sessionManager.getSession(convKey);
        if (session) {
          session.abort().catch(() => {});
          this.log.info(`/cancel - aborted session stream (key=${convKey})`);
        }
        this.sessionManager.invalidateSession(convKey);

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

        this.log.info(`/cancel - run cancelled (key=${convKey})`);
        return '(Run cancelled.)';
      }
      case 'approve': {
        const agentId = this.store.agentId;
        if (!agentId) return '(No agent configured.)';

        const convKey = channelId ? this.resolveConversationKey(channelId, chatId, forcePerChat) : 'shared';
        const convId = convKey === 'shared'
          ? this.store.conversationId || undefined
          : this.store.getConversationId(convKey) || undefined;

        const pendingApprovals = await getPendingApprovals(agentId, convId);
        if (pendingApprovals.length === 0) {
          return '(No pending approvals found for this conversation.)';
        }

        const byRun = new Map<string, Array<{ toolCallId: string; reason?: string }>>();
        for (const approval of pendingApprovals) {
          const key = approval.runId || 'unknown';
          if (!byRun.has(key)) byRun.set(key, []);
          byRun.get(key)!.push({ toolCallId: approval.toolCallId });
        }

        let approvedCount = 0;
        const failedRuns: string[] = [];
        for (const [runId, batch] of byRun) {
          const ok = await approvePendingApproval(agentId, batch, convId);
          if (ok) approvedCount += batch.length;
          else failedRuns.push(runId);
        }

        if (failedRuns.length > 0) {
          return `(Approved ${approvedCount}/${pendingApprovals.length} pending tool call(s). Failed runs: ${failedRuns.join(', ')})`;
        }
        return `(Approved ${approvedCount} pending tool call(s).)`;
      }
      case 'disapprove': {
        const agentId = this.store.agentId;
        if (!agentId) return '(No agent configured.)';

        const convKey = channelId ? this.resolveConversationKey(channelId, chatId, forcePerChat) : 'shared';
        const convId = convKey === 'shared'
          ? this.store.conversationId || undefined
          : this.store.getConversationId(convKey) || undefined;

        const pendingApprovals = await getPendingApprovals(agentId, convId);
        if (pendingApprovals.length === 0) {
          return '(No pending approvals found for this conversation.)';
        }

        const reason = args?.trim() || 'Denied by user from chat command';
        const byRun = new Map<string, Array<{ toolCallId: string; reason?: string }>>();
        for (const approval of pendingApprovals) {
          const key = approval.runId || 'unknown';
          if (!byRun.has(key)) byRun.set(key, []);
          byRun.get(key)!.push({ toolCallId: approval.toolCallId, reason });
        }

        let deniedCount = 0;
        const failedRuns: string[] = [];
        for (const [runId, batch] of byRun) {
          const ok = await rejectApproval(agentId, batch, convId);
          if (ok) deniedCount += batch.length;
          else failedRuns.push(runId);
        }

        if (failedRuns.length > 0) {
          return `(Denied ${deniedCount}/${pendingApprovals.length} pending tool call(s). Failed runs: ${failedRuns.join(', ')})`;
        }
        return `(Denied ${deniedCount} pending tool call(s).)`;
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
        this.log.info(`Starting channel: ${adapter.name}...`);
        await adapter.start();
        this.log.info(`Started channel: ${adapter.name}`);
      } catch (e) {
        this.log.error(`Failed to start channel ${id}:`, e);
      }
    });
    await Promise.all(startPromises);
  }
  
  async stop(): Promise<void> {
    for (const adapter of this.channels.values()) {
      try {
        await adapter.stop();
      } catch (e) {
        this.log.error(`Failed to stop channel ${adapter.id}:`, e);
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
    
    this.log.info('Checking for pending approvals...');
    
    try {
      const pendingApprovals = await getPendingApprovals(
        this.store.agentId,
        this.store.conversationId || undefined
      );
      
      if (pendingApprovals.length === 0) {
        if (isRecoverableConversationId(this.store.conversationId)) {
          const convResult = await recoverOrphanedConversationApproval(
            this.store.agentId!,
            this.store.conversationId
          );
          if (convResult.recovered) {
            this.log.info(`Conversation-level recovery succeeded: ${convResult.details}`);
            return { recovered: true, shouldReset: false };
          }
        }
        this.store.resetRecoveryAttempts();
        return { recovered: false, shouldReset: false };
      }
      
      const attempts = this.store.recoveryAttempts;
      if (attempts >= maxAttempts) {
        this.log.error(`Recovery failed after ${attempts} attempts. Still have ${pendingApprovals.length} pending approval(s).`);
        return { recovered: false, shouldReset: true };
      }
      
      this.log.info(`Found ${pendingApprovals.length} pending approval(s), attempting recovery (attempt ${attempts + 1}/${maxAttempts})...`);
      this.store.incrementRecoveryAttempts();
      
      // Group approvals by run_id and batch-deny (server requires all parallel
      // tool calls from the same run to be denied in a single request).
      const byRun = new Map<string, Array<{ toolCallId: string; reason: string }>>();
      for (const approval of pendingApprovals) {
        const key = approval.runId || 'unknown';
        if (!byRun.has(key)) byRun.set(key, []);
        byRun.get(key)!.push({ toolCallId: approval.toolCallId, reason: 'Session was interrupted - retrying request' });
      }
      for (const [runId, batch] of byRun) {
        this.log.info(`Batch-denying ${batch.length} approval(s) from run ${runId}`);
        await rejectApproval(
          this.store.agentId,
          batch,
          this.store.conversationId || undefined
        );
      }
      
      const runIds = [...new Set(pendingApprovals.map(a => a.runId))];
      if (runIds.length > 0) {
        this.log.info(`Cancelling ${runIds.length} active run(s)...`);
        await cancelRuns(this.store.agentId, runIds);
      }
      
      this.log.info('Recovery completed');
      return { recovered: true, shouldReset: false };
      
    } catch (error) {
      this.log.error('Recovery failed:', error);
      this.store.incrementRecoveryAttempts();
      return { recovered: false, shouldReset: this.store.recoveryAttempts >= maxAttempts };
    }
  }

  // =========================================================================
  // Message queue
  // =========================================================================

  private maybePreemptHeartbeatForUserMessage(convKey: string): void {
    if (this.config.interruptHeartbeatOnUserMessage === false) {
      return;
    }

    if (this.activeBackgroundTriggerByKey.get(convKey) !== 'heartbeat') {
      return;
    }

    this.backgroundCancelledKeys.add(convKey);
    const session = this.sessionManager.getSession(convKey);
    if (session) {
      session.abort().catch(() => {});
    }
    this.log.info(`Preempted in-flight heartbeat due to user message (key=${convKey})`);
  }
  
  private async handleMessage(msg: InboundMessage, adapter: ChannelAdapter): Promise<void> {
    // AskUserQuestion support: if the agent is waiting for a user answer,
    // intercept this message and resolve the pending promise instead of
    // queuing it for normal processing. This prevents a deadlock where
    // the stream is paused waiting for user input while the processing
    // flag blocks new messages from being handled.
    const incomingConvKey = this.resolveConversationKey(msg.channel, msg.chatId, msg.forcePerChat);
    const pendingResolver = this.pendingQuestionResolvers.get(incomingConvKey);
    if (pendingResolver) {
      this.log.info(`Intercepted message as AskUserQuestion answer from ${msg.userId} (key=${incomingConvKey})`);
      pendingResolver(msg.text || '');
      this.pendingQuestionResolvers.delete(incomingConvKey);
      return;
    }

    this.maybePreemptHeartbeatForUserMessage(incomingConvKey);

    this.log.info(`Message from ${msg.userId} on ${msg.channel}: ${msg.text}`);

    if (msg.isGroup && this.groupBatcher) {
      const isInstant = this.instantGroupIds.has(`${msg.channel}:${msg.chatId}`)
        || (msg.serverId && this.instantGroupIds.has(`${msg.channel}:${msg.serverId}`));
      const debounceMs = isInstant ? 0 : (this.groupIntervals.get(msg.channel) ?? 5000);
      this.log.info(`Group message routed to batcher (debounce=${debounceMs}ms, mentioned=${msg.wasMentioned}, instant=${!!isInstant})`);
      this.groupBatcher.enqueue(msg, adapter, debounceMs);
      return;
    }

    const convKey = this.resolveConversationKey(msg.channel, msg.chatId, msg.forcePerChat);
    if (convKey !== 'shared') {
      // Per-channel, per-chat, or override mode: messages on different keys can run in parallel.
      this.enqueueForKey(convKey, msg, adapter);
    } else {
      // Shared mode: single global queue (existing behavior)
      this.messageQueue.push({ msg, adapter });
      if (!this.processing) {
        this.processQueue().catch(err => this.log.error('Fatal error in processQueue:', err));
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
        this.log.error(`Fatal error in processKeyedQueue(${key}):`, err)
      );
    }
  }

  private async processKeyedQueue(key: string): Promise<void> {
    if (this.processingKeys.has(key)) return;
    this.processingKeys.add(key);

    const queue = this.keyedQueues.get(key);
    while (queue && queue.length > 0) {
      // Drain all pending messages. If multiple accumulated while the previous
      // turn was processing, combine them into a single processMessage call so
      // the agent sees one turn with all the user's text.
      const items = queue.splice(0, queue.length);
      const { msg, adapter } = items.length === 1
        ? items[0]
        : { msg: combinePendingMessages(items.map(i => i.msg)), adapter: items[items.length - 1].adapter };
      if (items.length > 1) {
        this.log.info(`Batched ${items.length} queued DM messages for key=${key}`);
      }
      try {
        await this.processMessage(msg, adapter);
      } catch (error) {
        this.log.error(`Error processing message (key=${key}):`, error);
      }
    }

    this.processingKeys.delete(key);
    this.keyedQueues.delete(key);
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.messageQueue.length === 0) return;
    
    this.processing = true;
    
    while (this.messageQueue.length > 0) {
      const items = this.messageQueue.splice(0, this.messageQueue.length);
      const { msg, adapter } = items.length === 1
        ? items[0]
        : { msg: combinePendingMessages(items.map(i => i.msg)), adapter: items[items.length - 1].adapter };
      if (items.length > 1) {
        this.log.info(`Batched ${items.length} queued messages (shared mode)`);
      }
      try {
        await this.processMessage(msg, adapter);
      } catch (error) {
        this.log.error('Error processing message:', error);
      }
    }
    
    this.log.info('Finished processing all messages');
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
        this.log.info(`AskUserQuestion: sending ${questions.length} question(s) to ${msg.channel}:${msg.chatId}`);
        await adapter.sendMessage({ chatId: msg.chatId, text: questionText, threadId: msg.threadId });

        // Wait for the user's next message (intercepted by handleMessage).
        // Key by convKey so each chat resolves independently in per-chat mode.
        const questionConvKey = this.resolveConversationKey(msg.channel, msg.chatId, msg.forcePerChat);
        const answer = await new Promise<string>((resolve) => {
          this.pendingQuestionResolvers.set(questionConvKey, resolve);
        });
        this.log.info(`AskUserQuestion: received answer (${answer.length} chars)`);

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

    const formattedText = msg.isBatch && msg.batchedMessages && msg.isGroup
      ? formatGroupBatchEnvelope(msg.batchedMessages, {}, msg.isListeningMode)
      : formatMessageEnvelope(msg, {}, sessionContext);
    const messageToSend = await buildMultimodalMessage(formattedText, msg, this.log);
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
      this.log.error('Stream received NO DATA - possible stuck state');
      await adapter.sendMessage({
        chatId: msg.chatId,
        text: '(No response received -- the connection may have dropped or the server may be busy. Please try again. If this persists, /reset will start a fresh conversation.)',
        threadId: msg.threadId,
      });
      return;
    }

    const hadToolActivity = (msgTypeCounts['tool_call'] || 0) > 0 || (msgTypeCounts['tool_result'] || 0) > 0;
    if (hadToolActivity) {
      this.log.info('Agent had tool activity but no assistant message - likely sent via tool');
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
    const t0 = performance.now();
    const lap = (label: string) => {
      this.log.debug(`${label}: ${(performance.now() - t0).toFixed(0)}ms`);
    };
    const suppressDelivery = isResponseDeliverySuppressed(msg);
    const displayConfig = this.getDisplayConfig(adapter.id);
    const prepared = await this.prepareMessageForRun(msg, adapter, suppressDelivery, lap);
    if (!prepared) {
      return;
    }
    const { messageToSend, canUseTool } = prepared;

    // Run session
    let session: Session | null = null;
    try {
      const convKey = this.resolveConversationKey(msg.channel, msg.chatId, msg.forcePerChat);
      const seq = ++this.sendSequence;
      const userText = msg.text || '';
      this.log.info(`processMessage seq=${seq} key=${convKey} retried=${retried} user=${msg.userId} textLen=${userText.length}`);
      if (userText.length > 0) {
        this.log.debug(`processMessage seq=${seq} textPreview=${userText.slice(0, 80)}`);
      }
      const run = await this.sessionManager.runSession(messageToSend, { retried, canUseTool, convKey });
      lap('session send');
      session = run.session;

      // Stream response with delivery via DisplayPipeline
      let response = '';
      let lastUpdate = 0;
      let rateLimitedUntil = 0;
      let messageId: string | null = null;
      let lastAssistantUuid: string | null = null;
      let sentAnyMessage = false;
      let receivedAnyData = false;
      let sawNonAssistantSinceLastUuid = false;
      let lastErrorDetail: StreamErrorDetail | null = null;
      let retryInfo: { attempt: number; maxAttempts: number; reason: string } | null = null;
      let sawForegroundResult = false;
      const msgTypeCounts: Record<string, number> = {};
      const bashCommandByToolCallId = new Map<string, string>();
      let lastBashCommand = '';
      let repeatedBashFailureKey: string | null = null;
      let repeatedBashFailureCount = 0;
      const maxRepeatedBashFailures = 3;
      let lastEventType: string | null = null;
      let abortedWithMessage = false;
      let turnError: string | undefined;

      const parseAndHandleDirectives = async () => {
        if (!response.trim()) return;
        const { cleanText, directives } = parseDirectives(response);
        response = cleanText;

        // Auto-voice: if enabled and no explicit <voice> directive, inject one
        if (this.config.autoVoice &&
            cleanText.trim() &&
            !directives.some(d => d.type === 'voice')) {
          directives.push({ type: 'voice', text: cleanText.trim() });
        }

        if (directives.length === 0) return;

        if (suppressDelivery) {
          this.log.info(`Listening mode: skipped ${directives.length} directive(s)`);
          return;
        }

        if (await this.executeDirectives(directives, adapter, msg.chatId, msg.messageId, msg.threadId)) {
          sentAnyMessage = true;
        }
      };

      const finalizeMessage = async () => {
        await parseAndHandleDirectives();

        if (response.trim() === '<no-reply/>') {
          this.log.info('Agent chose not to reply (no-reply marker)');
          sentAnyMessage = true;
          response = '';
          messageId = null;
          lastUpdate = Date.now();
          return;
        }

        if (!suppressDelivery && response.trim()) {
          const rlRemaining = rateLimitedUntil - Date.now();
          if (rlRemaining > 0) {
            const waitMs = Math.min(rlRemaining, 30_000);
            this.log.info(`Waiting ${(waitMs / 1000).toFixed(1)}s for rate limit before finalize`);
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
              sentAnyMessage = true;
            } else {
              this.log.warn('finalizeMessage send failed:', finalizeErr instanceof Error ? finalizeErr.message : finalizeErr);
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

      const turnId = this.turnLogger ? generateTurnId() : '';
      const turnAcc = this.turnLogger ? new TurnAccumulator() : null;
      let turnWritten = false;

      try {
        let firstChunkLogged = false;
        const pipeline = createDisplayPipeline(run.stream(), {
          convKey,
          resultFingerprints: this.lastResultRunFingerprints,
          botName: this.config.agentName,
        });

        for await (const event of pipeline) {
          turnAcc?.feed(event);
          // Check for /cancel before processing each event
          if (this.cancelledKeys.has(convKey)) {
            this.log.info(`Stream cancelled by /cancel (key=${convKey})`);
            break;
          }
          if (!firstChunkLogged) { lap('first stream chunk'); firstChunkLogged = true; }
          receivedAnyData = true;
          msgTypeCounts[event.type] = (msgTypeCounts[event.type] || 0) + 1;

          switch (event.type) {
            case 'reasoning': {
              // Finalize any pending assistant text on type transition
              if (lastEventType === 'text' && response.trim()) {
                await finalizeMessage();
              }
              lastEventType = 'reasoning';
              sawNonAssistantSinceLastUuid = true;
              if (displayConfig.showReasoning && !suppressDelivery && event.content.trim()) {
                this.log.info(`Reasoning: ${event.content.trim().slice(0, 100)}`);
                try {
                  const reasoning = formatReasoningDisplay(event.content, adapter.id, displayConfig.reasoningMaxChars);
                  await adapter.sendMessage({
                    chatId: msg.chatId,
                    text: reasoning.text,
                    threadId: msg.threadId,
                    parseMode: reasoning.parseMode,
                  });
                } catch (err) {
                  this.log.warn('Failed to send reasoning display:', err instanceof Error ? err.message : err);
                }
              }
              break;
            }

            case 'tool_call': {
              // Discard any unsent assistant text accumulated before this tool call.
              // Mid-turn assistant content (model scratch notes) must not leak to the
              // user. The real response will follow after the tool loop completes.
              if (lastEventType === 'text' && response.trim()) {
                this.log.info(`Discarding pre-tool assistant text (${response.trim().length} chars)`);
                response = '';
                messageId = null;
              }
              lastEventType = 'tool_call';
              this.sessionManager.syncTodoToolCall(event.raw);
              this.log.info(`>>> TOOL CALL: ${event.name} (id: ${event.id.slice(0, 12) || '?'})`);
              sawNonAssistantSinceLastUuid = true;

              // Tool loop detection
              const maxToolCalls = this.config.maxToolCalls ?? 100;
              if ((msgTypeCounts['tool_call'] || 0) >= maxToolCalls) {
                this.log.error(`Agent stuck in tool loop (${msgTypeCounts['tool_call']} calls), aborting`);
                session?.abort().catch(() => {});
                response = '(Agent got stuck in a tool loop and was stopped. Try sending your message again.)';
                turnError = `tool loop abort after ${msgTypeCounts['tool_call'] || 0} tool calls`;
                abortedWithMessage = true;
                break;
              }

              // Bash command tracking for repeated failure detection
              if (event.name === 'Bash') {
                const command = typeof event.args?.command === 'string' ? event.args.command : '';
                if (command) {
                  lastBashCommand = command;
                  if (event.id) bashCommandByToolCallId.set(event.id, command);
                }
              }

              // Display
              if (displayConfig.showToolCalls && !suppressDelivery) {
                try {
                  const text = formatToolCallDisplay(event.raw);
                  await adapter.sendMessage({ chatId: msg.chatId, text, threadId: msg.threadId });
                } catch (err) {
                  this.log.warn('Failed to send tool call display:', err instanceof Error ? err.message : err);
                }
              }
              break;
            }

            case 'tool_result': {
              lastEventType = 'tool_result';
              this.log.info(`<<< TOOL RESULT: error=${event.isError}, len=${event.content.length}`);
              sawNonAssistantSinceLastUuid = true;

              // Repeated Bash failure detection
              const mappedCommand = event.toolCallId ? bashCommandByToolCallId.get(event.toolCallId) : undefined;
              if (event.toolCallId) bashCommandByToolCallId.delete(event.toolCallId);
              const bashCommand = (mappedCommand || lastBashCommand || '').trim();
              const lowerContent = event.content.toLowerCase();
              const isLettabotCliCall = /^lettabot(?:-[a-z0-9-]+)?\b/i.test(bashCommand);
              const looksCliCommandError = lowerContent.includes('unknown command')
                || lowerContent.includes('command not found')
                || lowerContent.includes('usage: lettabot')
                || lowerContent.includes('usage: lettabot-bluesky')
                || lowerContent.includes('error: --agent is required for bluesky commands');

              if (event.isError && bashCommand && isLettabotCliCall && looksCliCommandError) {
                const errorKind = lowerContent.includes('unknown command') || lowerContent.includes('command not found')
                  ? 'unknown-command' : 'usage-error';
                const failureKey = `${bashCommand.toLowerCase()}::${errorKind}`;
                if (repeatedBashFailureKey === failureKey) {
                  repeatedBashFailureCount += 1;
                } else {
                  repeatedBashFailureKey = failureKey;
                  repeatedBashFailureCount = 1;
                }
                if (repeatedBashFailureCount >= maxRepeatedBashFailures) {
                  this.log.error(`Stopping run after repeated Bash command failures (${repeatedBashFailureCount}) for: ${bashCommand}`);
                  session?.abort().catch(() => {});
                  response = `(I stopped after repeated CLI command failures while running: ${bashCommand}. The command path appears mismatched. Please confirm Bluesky CLI commands are available, then resend your request.)`;
                  turnError = `repeated Bash failure abort (${repeatedBashFailureCount}x): ${bashCommand}`;
                  abortedWithMessage = true;
                  break;
                }
              } else {
                repeatedBashFailureKey = null;
                repeatedBashFailureCount = 0;
              }
              break;
            }

            case 'text': {
              lastEventType = 'text';
              // Detect assistant UUID change (multi-turn response boundary)
              if (event.uuid && lastAssistantUuid && event.uuid !== lastAssistantUuid) {
                if (response.trim()) {
                  if (!sawNonAssistantSinceLastUuid) {
                    this.log.warn(`WARNING: Assistant UUID changed (${lastAssistantUuid.slice(0, 8)} -> ${event.uuid.slice(0, 8)}) with no visible tool_call/reasoning events between them.`);
                  }
                  await finalizeMessage();
                }
                sawNonAssistantSinceLastUuid = false;
              } else if (event.uuid && !lastAssistantUuid) {
                sawNonAssistantSinceLastUuid = false;
              }
              lastAssistantUuid = event.uuid || lastAssistantUuid;

              response += event.delta;

              // Live-edit streaming for channels that support it
              const canEdit = adapter.supportsEditing?.() ?? false;
              const trimmed = response.trim();
              const mayBeHidden = '<no-reply/>'.startsWith(trimmed)
                || hasIncompleteActionsTag(response)
                || hasUnclosedActionsBlock(response);
              const streamText = stripActionsBlock(response).trim();
              if (canEdit && !mayBeHidden && !suppressDelivery && !this.cancelledKeys.has(convKey)
                && streamText.length > 0 && Date.now() - lastUpdate > 1500 && Date.now() > rateLimitedUntil) {
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
                  this.log.warn('Streaming edit failed:', editErr instanceof Error ? editErr.message : editErr);
                  const errStr = String(editErr?.message ?? editErr);
                  const retryMatch = errStr.match(/retry after (\d+)/i);
                  if (errStr.includes('429') || retryMatch) {
                    const retryAfter = retryMatch ? Number(retryMatch[1]) : 30;
                    rateLimitedUntil = Date.now() + retryAfter * 1000;
                    this.log.warn(`Rate limited -- suppressing streaming edits for ${retryAfter}s`);
                  }
                }
                lastUpdate = Date.now();
              }
              break;
            }

            case 'complete': {
              sawForegroundResult = true;

              // Handle cancelled results
              if (event.cancelled) {
                this.log.info(`Discarding cancelled run result (seq=${seq})`);
                this.sessionManager.invalidateSession(convKey);
                session = null;
                if (!retried) {
                  clearInterval(typingInterval);
                  return this.processMessage(msg, adapter, true);
                }
                break;
              }

              // Handle stale duplicate results
              if (event.stale) {
                this.sessionManager.invalidateSession(convKey);
                session = null;
                if (!retried) {
                  this.log.warn(`Retrying message after stale duplicate result (seq=${seq}, key=${convKey})`);
                  clearInterval(typingInterval);
                  return this.processMessage(msg, adapter, true);
                }
                response = '';
                break;
              }

              // Result text handling: only use the pipeline's result text as a
              // FALLBACK when no assistant text was streamed. If text events were
              // already yielded and possibly finalized (sent), don't override.
              if (event.text.trim() && !event.hadStreamedText && event.success && !event.error) {
                response = event.text;
              } else if (!sentAnyMessage && response.trim().length === 0 && event.success && !event.error) {
                // Safety fallback: if nothing was delivered yet and response is empty.
                // Prefer the raw result field when the pipeline's text came from
                // pre-tool assistant content that was discarded (hadStreamedText is
                // true but response was cleared by the tool_call discard logic).
                const rawResult = typeof event.raw.result === 'string' ? event.raw.result.trim() : '';
                if (!event.hadStreamedText && event.text.trim()) {
                  response = event.text;
                } else if (rawResult) {
                  response = rawResult;
                }
              }

              const hasResponse = response.trim().length > 0;
              const resultText = typeof event.raw.result === 'string' ? event.raw.result : '';
              this.log.info(`Stream result: seq=${seq} success=${event.success}, hasResponse=${hasResponse}, resultLen=${resultText.length}`);
              if (event.error) {
                const parts = [`error=${event.error}`];
                if (event.stopReason) parts.push(`stopReason=${event.stopReason}`);
                if (event.durationMs !== undefined) parts.push(`duration=${event.durationMs}ms`);
                if (event.conversationId) parts.push(`conv=${event.conversationId}`);
                this.log.error(`Result error: ${parts.join(', ')}`);
              }

              // Retry/recovery logic
              const retryConvKey = this.resolveConversationKey(msg.channel, msg.chatId, msg.forcePerChat);
              const retryConvIdFromStore = (retryConvKey === 'shared'
                ? this.store.conversationId
                : this.store.getConversationId(retryConvKey)) ?? undefined;
              const retryConvIdRaw = (event.conversationId && event.conversationId.length > 0)
                ? event.conversationId
                : retryConvIdFromStore;
              const retryConvId = isRecoverableConversationId(retryConvIdRaw)
                ? retryConvIdRaw
                : undefined;

              const initialRetryDecision = this.buildResultRetryDecision(
                event.raw, resultText, hasResponse, sentAnyMessage, lastErrorDetail,
              );

              // Enrich opaque error detail from run metadata
              if (initialRetryDecision.isTerminalError && this.store.agentId &&
                  (!lastErrorDetail || lastErrorDetail.message === 'Agent stopped: error')) {
                const enriched = await getLatestRunError(this.store.agentId, retryConvId);
                if (enriched) {
                  this.log.info(`Enriched error detail: ${enriched.message} [${enriched.stopReason}]`);
                  lastErrorDetail = {
                    message: enriched.message,
                    stopReason: enriched.stopReason,
                    isApprovalError: enriched.isApprovalError,
                  };
                }
              }

              const retryDecision = this.buildResultRetryDecision(
                event.raw, resultText, hasResponse, sentAnyMessage, lastErrorDetail,
              );

              // Approval conflict recovery
              if (retryDecision.isApprovalConflict && !retried && this.store.agentId) {
                this.log.info('Approval conflict detected -- attempting SDK recovery...');
                clearInterval(typingInterval);

                // Try SDK-level recovery first (through CLI control protocol)
                if (session) {
                  const sdkResult = await recoverPendingApprovalsWithSdk(session, 10_000);
                  if (sdkResult.recovered) {
                    this.log.info('SDK approval recovery succeeded, retrying message...');
                    this.sessionManager.invalidateSession(retryConvKey);
                    session = null;
                    return this.processMessage(msg, adapter, true);
                  }
                  this.log.warn(`SDK recovery did not resolve (${sdkResult.detail ?? 'unknown'}), trying API-level recovery...`);
                }

                // Fall back to API-level recovery
                this.sessionManager.invalidateSession(retryConvKey);
                session = null;
                const result = (retryConvId && isRecoverableConversationId(retryConvId))
                  ? await recoverOrphanedConversationApproval(this.store.agentId, retryConvId, true)
                  : await recoverPendingApprovalsForAgent(this.store.agentId);
                if (result.recovered) {
                  this.log.info(`API-level recovery succeeded (${result.details}), retrying message...`);
                } else {
                  this.log.warn(`API-level recovery failed: ${result.details}`);
                }
                return this.processMessage(msg, adapter, true);
              }

              // Empty/error result retry
              if (retryDecision.shouldRetryForEmptyResult || retryDecision.shouldRetryForErrorResult) {
                if (!retried && this.store.agentId && retryConvId) {
                  const reason = retryDecision.shouldRetryForErrorResult ? 'error result' : 'empty result';
                  this.log.info(`${reason} - attempting orphaned approval recovery...`);
                  this.sessionManager.invalidateSession(retryConvKey);
                  session = null;
                  clearInterval(typingInterval);
                  const convResult = await recoverOrphanedConversationApproval(this.store.agentId, retryConvId);
                  if (convResult.recovered) {
                    this.log.info(`Recovery succeeded (${convResult.details}), retrying message...`);
                    return this.processMessage(msg, adapter, true);
                  }
                  if (retryDecision.shouldRetryForErrorResult) {
                    this.log.info('Retrying once after terminal error...');
                    return this.processMessage(msg, adapter, true);
                  }
                }
              }

              // Terminal error with no response
              if (retryDecision.isTerminalError && !hasResponse && !sentAnyMessage) {
                if (lastErrorDetail) {
                  const formatted = formatApiErrorForUser(lastErrorDetail);
                  if (formatted) response = formatted;
                  // null = suppressed error (e.g. 409 conflict) — no visible response
                } else {
                  const err = event.error || 'unknown error';
                  const reason = event.stopReason ? ` [${event.stopReason}]` : '';
                  response = `(Agent run failed: ${err}${reason}. Try sending your message again.)`;
                }
              }
              break;
            }

            case 'error': {
              lastErrorDetail = {
                message: event.message,
                stopReason: event.stopReason || 'error',
                apiError: event.apiError,
              };
              this.log.error(`Stream error detail: ${event.message} [${event.stopReason || 'error'}]`);
              sawNonAssistantSinceLastUuid = true;
              break;
            }

            case 'retry': {
              retryInfo = { attempt: event.attempt, maxAttempts: event.maxAttempts, reason: event.reason };
              this.log.info(`Retrying (${event.attempt}/${event.maxAttempts}): ${event.reason}`);
              sawNonAssistantSinceLastUuid = true;
              break;
            }
          }

          if (abortedWithMessage) {
            this.log.info(`Stopping stream consumption after explicit abort (seq=${seq}, key=${convKey})`);
            break;
          }
        }
      } finally {
        clearInterval(typingInterval);
        adapter.stopTypingIndicator?.(msg.chatId)?.catch(() => {});
        // Write turn record (even partial turns on cancel/error)
        if (this.turnLogger && turnAcc && !turnWritten) {
          turnWritten = true;
          const { events, output } = turnAcc.finalize();
          this.turnLogger.write({
            ts: new Date().toISOString(),
            turnId,
            trigger: 'user_message' as const,
            channel: msg.channel,
            chatId: msg.chatId,
            userId: msg.userId,
            input: typeof messageToSend === 'string' ? messageToSend : '[multimodal]',
            events,
            output: output || response,
            durationMs: Math.round(performance.now() - t0),
            error: turnError ?? lastErrorDetail?.message,
          }).catch(() => {});
        }
      }
      lap('stream complete');

      // If cancelled, clean up partial state and return early.
      // Invalidate defensively in case the cancel handler's invalidation
      // didn't fire (e.g., race with command dispatch).
      if (this.cancelledKeys.has(convKey)) {
        this.sessionManager.invalidateSession(convKey);
        session = null;
        if (messageId) {
          try {
            await adapter.editMessage(msg.chatId, messageId, '(Run cancelled.)');
          } catch { /* best effort */ }
        }
        this.log.info(`Skipping post-stream delivery -- cancelled (key=${convKey})`);
        return;
      }

      // If pipeline ended without a complete event, something went wrong.
      // Exception: if we aborted with an explicit message (tool loop, bash failure),
      // just deliver that message.
      if (!sawForegroundResult && !sentAnyMessage && !abortedWithMessage) {
        this.log.warn(`Stream ended without result (seq=${seq}, key=${convKey})`);
        this.sessionManager.invalidateSession(convKey);
        session = null;
        response = '';
        if (!retried) {
          return this.processMessage(msg, adapter, true);
        }
        response = '(The agent stream ended before a result was received. Please try again.)';
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
        this.log.warn('Model does not support images -- consider a vision-capable model or features.inlineImages: false');
      }

      // Listening mode: agent processed for memory, suppress response delivery
      if (suppressDelivery) {
        this.log.info(`Listening mode: processed ${msg.channel}:${msg.chatId} for memory (response suppressed)`);
        return;
      }

      lap('directives done');
      // Send final response
      if (response.trim()) {
        const rateLimitRemaining = rateLimitedUntil - Date.now();
        if (rateLimitRemaining > 0) {
          const waitMs = Math.min(rateLimitRemaining, 30_000);
          this.log.info(`Waiting ${(waitMs / 1000).toFixed(1)}s for rate limit before final send`);
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
          this.log.warn('Final message delivery failed:', sendErr instanceof Error ? sendErr.message : sendErr);
          try {
            await adapter.sendMessage({ chatId: msg.chatId, text: prefixedFinal, threadId: msg.threadId });
            sentAnyMessage = true;
            this.store.resetRecoveryAttempts();
          } catch (retryError) {
            this.log.error('Retry send also failed:', retryError);
          }
        }
      }

      lap('message delivered');
      await this.deliverNoVisibleResponseIfNeeded(msg, adapter, sentAnyMessage, receivedAnyData, msgTypeCounts);
      
    } catch (error) {
      this.log.error('Error processing message:', error);
      try {
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          threadId: msg.threadId,
        });
      } catch (sendError) {
        this.log.error('Failed to send error message to channel:', sendError);
      }
    } finally {
      const finalConvKey = this.resolveConversationKey(msg.channel, msg.chatId, msg.forcePerChat);
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
          this.log.error(`Fatal error in processKeyedQueue(${convKey}) after lock release:`, err)
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
    const triggerType = context?.type ?? 'heartbeat';
    const acquired = await this.acquireLock(convKey);
    this.activeBackgroundTriggerByKey.set(convKey, triggerType);
    
    const sendT0 = performance.now();
    const sendTurnId = this.turnLogger ? generateTurnId() : '';
    const sendTurnAcc = this.turnLogger ? new TurnAccumulator() : null;
    let sendTurnWritten = false;

    try {
      let retried = false;

      while (true) {
        if (this.backgroundCancelledKeys.has(convKey)) {
          this.log.info(`sendToAgent: background run pre-cancelled by live user activity (key=${convKey})`);
          return '';
        }
        const { session, stream } = await this.sessionManager.runSession(text, { convKey, retried });

        try {
          if (this.backgroundCancelledKeys.has(convKey)) {
            session.abort().catch(() => {});
            this.log.info(`sendToAgent: background run cancelled before stream start (key=${convKey})`);
            return '';
          }
          let response = '';
          let sawStaleDuplicateResult = false;
          let approvalRetryPending = false;
          let usedMessageCli = false;
          let lastErrorDetail: StreamErrorDetail | undefined;
          for await (const msg of stream()) {
            if (this.backgroundCancelledKeys.has(convKey)) {
              session.abort().catch(() => {});
              this.log.info(`sendToAgent: cancelled in-flight background stream (key=${convKey})`);
              return '';
            }
            sendTurnAcc?.feedRaw(msg);
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
            if (msg.type === 'reasoning') {
              // Skip reasoning -- internal thinking should not leak into delivery
            } else if (msg.type === 'assistant') {
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
                if (this.backgroundCancelledKeys.has(convKey)) {
                  this.log.info(`sendToAgent: cancelled heartbeat produced terminal error result; suppressing (key=${convKey})`);
                  return '';
                }
                // Enrich opaque errors from run metadata (mirrors processMessage logic).
                const convId = typeof msg.conversationId === 'string' ? msg.conversationId : undefined;
                if (this.store.agentId &&
                    (!lastErrorDetail || lastErrorDetail.message === 'Agent stopped: error')) {
                  const enriched = await getLatestRunError(this.store.agentId, convId);
                  if (enriched) {
                    this.log.info(`Enriched error detail: ${enriched.message} [${enriched.stopReason}]`);
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
                  this.log.info('sendToAgent: approval conflict detected -- attempting SDK recovery...');
                  const sdkResult = await recoverPendingApprovalsWithSdk(session, 10_000);
                  if (sdkResult.recovered) {
                    this.log.info('sendToAgent: SDK approval recovery succeeded');
                  } else {
                    this.log.warn(`sendToAgent: SDK recovery did not resolve (${sdkResult.detail ?? 'unknown'}), trying API-level recovery...`);
                    if (this.store.agentId) {
                      const recovery = await recoverPendingApprovalsForAgent(this.store.agentId);
                      if (recovery.recovered) {
                        this.log.info(`sendToAgent: API-level recovery succeeded (${recovery.details})`);
                      } else {
                        this.log.warn(`sendToAgent: API-level recovery failed (${recovery.details})`);
                      }
                    }
                  }
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
            this.log.warn(`Retrying sendToAgent after stale duplicate result (key=${convKey})`);
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

          // Strip <no-reply/> marker so callers (cron, webhooks) see empty string
          if (response.trim() === '<no-reply/>') {
            this.log.info('sendToAgent: agent responded with <no-reply/> marker, suppressing');
            response = '';
          }

          if (isSilent && response.trim()) {
            if (usedMessageCli || executedDirectives) {
              this.log.info(`Silent mode: agent delivered via ${[usedMessageCli && 'CLI', executedDirectives && 'directives'].filter(Boolean).join(' + ')}, remaining text (${response.length} chars) not delivered`);
            } else {
              this.log.warn(`Silent mode: agent produced ${response.length} chars but did NOT use lettabot-message CLI or directives — response discarded. If this keeps happening, the agent's model may not be following silent mode instructions.`);
            }
          }
          return response;
        } catch (error) {
          // Invalidate on stream errors so next call gets a fresh subprocess
          this.sessionManager.invalidateSession(convKey);
          if (this.backgroundCancelledKeys.has(convKey)) {
            this.log.info(`sendToAgent: background run ended after cancellation (key=${convKey})`);
            return '';
          }
          throw error;
        }

      }
    } finally {
      this.activeBackgroundTriggerByKey.delete(convKey);
      this.backgroundCancelledKeys.delete(convKey);
      if (this.config.reuseSession === false) {
        this.sessionManager.invalidateSession(convKey);
      }
      // Write turn record
      if (this.turnLogger && sendTurnAcc && !sendTurnWritten) {
        sendTurnWritten = true;
        const { events, output } = sendTurnAcc.finalize();
        this.turnLogger.write({
          ts: new Date().toISOString(),
          turnId: sendTurnId,
          trigger: context?.type ?? 'heartbeat',
          channel: context?.sourceChannel,
          input: text,
          events,
          output,
          durationMs: Math.round(performance.now() - sendT0),
        }).catch(() => {});
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
    const streamT0 = performance.now();
    const streamTurnId = this.turnLogger ? generateTurnId() : '';
    const streamTurnAcc = this.turnLogger ? new TurnAccumulator() : null;
    let streamTurnError: string | undefined;

    try {
      const { stream } = await this.sessionManager.runSession(text, { convKey });

      try {
        for await (const msg of stream()) {
          streamTurnAcc?.feedRaw(msg);
          yield msg;
        }
      } catch (error) {
        this.sessionManager.invalidateSession(convKey);
        streamTurnError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    } finally {
      if (this.config.reuseSession === false) {
        this.sessionManager.invalidateSession(convKey);
      }
      if (this.turnLogger && streamTurnAcc) {
        const { events, output } = streamTurnAcc.finalize();
        this.turnLogger.write({
          ts: new Date().toISOString(),
          turnId: streamTurnId,
          trigger: context?.type ?? 'heartbeat',
          channel: context?.sourceChannel,
          input: text,
          events,
          output,
          durationMs: Math.round(performance.now() - streamT0),
          error: streamTurnError,
        }).catch(() => {});
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
    this.log.info(`Agent ID set to: ${agentId}`);
  }
  
  reset(): void {
    this.store.reset();
    this.log.info('Agent reset');
  }
  
  getLastMessageTarget(): { channel: string; chatId: string } | null {
    return this.store.lastMessageTarget || null;
  }
  
  getLastUserMessageTime(): Date | null {
    return this.lastUserMessageTime;
  }
}

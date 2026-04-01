/**
 * DisplayPipeline — transforms raw SDK stream events into clean,
 * high-level display events for channel delivery.
 *
 * Encapsulates:
 *  - Run ID filtering (foreground tracking, rebinding)
 *  - Reasoning chunk accumulation (flushed on type transitions)
 *  - stream_event skipping
 *  - Type transition tracking
 *  - Result text selection (streamed vs result field)
 *  - Stale/cancelled result classification
 */

import type { StreamMsg } from './types.js';
import { createLogger, type Logger } from '../logger.js';

const log = createLogger('DisplayPipeline');

// ─── Display event types ────────────────────────────────────────────────────

export interface ReasoningEvent {
  type: 'reasoning';
  /** Complete accumulated reasoning block. */
  content: string;
}

export interface ToolCallEvent {
  type: 'tool_call';
  name: string;
  args: Record<string, unknown>;
  id: string;
  /** The raw StreamMsg for consumers that need extra fields. */
  raw: StreamMsg;
}

export interface ToolResultEvent {
  type: 'tool_result';
  toolCallId: string;
  content: string;
  isError: boolean;
  raw: StreamMsg;
}

export interface TextEvent {
  type: 'text';
  /** Full accumulated assistant text for this turn. */
  content: string;
  /** Just this chunk's addition. */
  delta: string;
  /** Assistant message UUID (changes on multi-turn responses). */
  uuid: string;
}

export interface CompleteEvent {
  type: 'complete';
  /** Final response text (after streamed-vs-result selection). */
  text: string;
  success: boolean;
  error?: string;
  stopReason?: string;
  conversationId?: string;
  runIds: string[];
  durationMs?: number;
  /** True if this is a stale duplicate result (same run fingerprint as last time). */
  stale: boolean;
  /** True if this result came from a cancelled run (should be discarded + retried). */
  cancelled: boolean;
  /** Whether any assistant text was accumulated during streaming. */
  hadStreamedText: boolean;
  /** The raw StreamMsg for consumers that need extra fields. */
  raw: StreamMsg;
}

export interface ErrorEvent {
  type: 'error';
  message: string;
  stopReason?: string;
  apiError?: Record<string, unknown>;
  runId?: string;
}

export interface RetryEvent {
  type: 'retry';
  attempt: number;
  maxAttempts: number;
  reason: string;
  delayMs?: number;
}

export type DisplayEvent =
  | ReasoningEvent
  | ToolCallEvent
  | ToolResultEvent
  | TextEvent
  | CompleteEvent
  | ErrorEvent
  | RetryEvent;

// ─── Run fingerprinting (stale detection) ───────────────────────────────────

function classifyResult(
  convKey: string,
  runIds: string[],
  fingerprints: Map<string, string>,
  logger: Logger,
): 'fresh' | 'stale' | 'unknown' {
  if (runIds.length === 0) return 'unknown';
  const fingerprint = [...new Set(runIds)].sort().join(',');
  const previous = fingerprints.get(convKey);
  if (previous === fingerprint) {
    logger.warn(`Stale duplicate result detected (key=${convKey}, runIds=${fingerprint})`);
    return 'stale';
  }
  fingerprints.set(convKey, fingerprint);
  return 'fresh';
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function extractRunIds(msg: StreamMsg): string[] {
  const ids: string[] = [];
  const rawId = (msg as StreamMsg & { runId?: unknown; run_id?: unknown }).runId
    ?? (msg as StreamMsg & { run_id?: unknown }).run_id;
  if (typeof rawId === 'string' && rawId.trim()) ids.push(rawId.trim());

  const rawIds = (msg as StreamMsg & { runIds?: unknown; run_ids?: unknown }).runIds
    ?? (msg as StreamMsg & { run_ids?: unknown }).run_ids;
  if (Array.isArray(rawIds)) {
    for (const id of rawIds) {
      if (typeof id === 'string' && id.trim()) ids.push(id.trim());
    }
  }
  return ids.length > 0 ? [...new Set(ids)] : [];
}

// ─── Pipeline ───────────────────────────────────────────────────────────────

export interface DisplayPipelineOptions {
  /** Conversation key for stale-result detection. */
  convKey: string;
  /** Shared fingerprint map for stale-result detection (instance-level, not module-level). */
  resultFingerprints: Map<string, string>;
  /** Bot name for log context (e.g. "DisplayPipeline/MyAgent"). */
  botName?: string;
}

/**
 * Wraps an SDK stream (already deduped by session-manager) and yields
 * clean DisplayEvents. All run-ID filtering, reasoning accumulation,
 * and result classification happens inside.
 */
export async function* createDisplayPipeline(
  stream: AsyncIterable<StreamMsg>,
  opts: DisplayPipelineOptions,
): AsyncGenerator<DisplayEvent> {
  const pipeLog = opts.botName ? createLogger('DisplayPipeline', opts.botName) : log;
  const { convKey, resultFingerprints } = opts;

  // ── Foreground run tracking ──
  let foregroundRunId: string | null = null;
  let foregroundSource: string | null = null;

  // ── Reasoning accumulation ──
  let reasoningBuffer = '';

  // ── Assistant text accumulation ──
  let assistantText = '';
  let lastAssistantUuid: string | null = null;
  let lastSemanticType: string | null = null;

  // ── All run IDs seen (for result) ──
  const allRunIds = new Set<string>();

  // ── Stats ──
  let filteredCount = 0;

  // ── Helpers ──
  function* flushReasoning(): Generator<DisplayEvent> {
    if (reasoningBuffer.trim()) {
      yield { type: 'reasoning', content: reasoningBuffer };
      reasoningBuffer = '';
    }
  }

  // ── Main loop ──
  for await (const msg of stream) {
    const eventRunIds = extractRunIds(msg);
    for (const id of eventRunIds) allRunIds.add(id);

    // Skip stream_event (low-level deltas, not semantic)
    if (msg.type === 'stream_event') continue;

    pipeLog.trace(`raw: type=${msg.type} runIds=${eventRunIds.join(',') || 'none'} fg=${foregroundRunId || 'unlocked'}`);

    // ── Run ID filtering ──
    // Lock types: substantive events that prove this run is the foreground turn.
    // Error/retry are excluded -- they're transient signals that could come
    // from a failed run before the real foreground starts.
    const isLockType = msg.type === 'reasoning' || msg.type === 'tool_call'
      || msg.type === 'tool_result' || msg.type === 'assistant' || msg.type === 'result';

    if (foregroundRunId === null && eventRunIds.length > 0 && isLockType) {
      // Lock foreground on the first substantive event with a run ID.
      // Background Tasks use separate sessions and cannot produce events in
      // this stream, so the first run-scoped event is always from the current
      // turn's run. This eliminates buffering delay -- reasoning and tool calls
      // display immediately instead of waiting for the first assistant event.
      foregroundRunId = eventRunIds[0];
      foregroundSource = msg.type;
      pipeLog.info(`Foreground run locked: ${foregroundRunId} (source=${foregroundSource})`);
      // Fall through to type transitions and dispatch for immediate processing.
    } else if (foregroundRunId === null && eventRunIds.length > 0 && !isLockType) {
      // Pre-foreground error/retry events are filtered. If passed through,
      // they set lastErrorDetail in the consumer and can spuriously trigger
      // approval recovery or suppress legitimate retries.
      filteredCount++;
      continue;
    } else if (foregroundRunId && eventRunIds.length > 0 && !eventRunIds.includes(foregroundRunId)) {
      // Event from a different run. The Letta agent creates a new run ID per
      // step in its tool loop, so within a single turn the foreground run
      // changes on every tool call. Rebind on any substantive event type to
      // avoid filtering legitimate intermediate tool calls. Background Tasks
      // use separate sessions and cannot produce events in this stream.
      if (isLockType) {
        const newRunId = eventRunIds[0];
        pipeLog.info(`Foreground run rebind: ${foregroundRunId} -> ${newRunId}`);
        foregroundRunId = newRunId;
        foregroundSource = msg.type;
      } else {
        filteredCount++;
        continue;
      }
    }

    // ── Type transitions ──
    // (stream_event is already `continue`d above, so all events here are semantic.)
    if (lastSemanticType && lastSemanticType !== msg.type) {
      if (lastSemanticType === 'reasoning') {
        yield* flushReasoning();
      }
    }
    lastSemanticType = msg.type;

    // ── Dispatch by type ──
    switch (msg.type) {
      case 'reasoning': {
        const chunk = msg.content || '';
        // When a new chunk starts with a markdown block indicator (bold header,
        // heading, list item), insert a newline to prevent it running into the
        // previous text. This separates complete reasoning blocks (common with
        // OpenAI models that emit whole sections) without affecting token-level
        // streaming where tokens don't start with these patterns.
        if (chunk && reasoningBuffer && !reasoningBuffer.endsWith('\n')
          && /^(\*\*|#{1,6}\s|[-*]\s|\d+\.\s)/.test(chunk)) {
          reasoningBuffer += '\n';
        }
        reasoningBuffer += chunk;
        break;
      }

      case 'tool_call': {
        yield {
          type: 'tool_call',
          name: msg.toolName || 'unknown',
          args: (msg.toolInput && typeof msg.toolInput === 'object' ? msg.toolInput : {}) as Record<string, unknown>,
          id: msg.toolCallId || '',
          raw: msg,
        };
        break;
      }

      case 'tool_result': {
        yield {
          type: 'tool_result',
          toolCallId: msg.toolCallId || '',
          content: typeof (msg as any).content === 'string'
            ? (msg as any).content
            : typeof (msg as any).result === 'string'
              ? (msg as any).result
              : '',
          isError: !!msg.isError,
          raw: msg,
        };
        break;
      }

      case 'assistant': {
        const delta = msg.content || '';
        const uuid = msg.uuid || '';
        lastAssistantUuid = uuid || lastAssistantUuid;

        assistantText += delta;
        yield {
          type: 'text',
          content: assistantText,
          delta,
          uuid: lastAssistantUuid || '',
        };
        break;
      }

      case 'result': {
        // Flush any remaining reasoning
        yield* flushReasoning();

        const resultText = typeof msg.result === 'string' ? msg.result : '';
        const streamedTrimmed = assistantText.trim();
        const resultTrimmed = resultText.trim();
        const runIds = extractRunIds(msg);

        // Result text selection: prefer streamed text over result field
        let finalText = assistantText;
        if (streamedTrimmed.length > 0 && resultTrimmed !== streamedTrimmed) {
          // Diverged — prefer streamed (avoid n-1 desync)
          pipeLog.warn(`Result diverges from streamed (resultLen=${resultText.length}, streamLen=${assistantText.length}), preferring streamed`);
        } else if (streamedTrimmed.length === 0 && msg.success !== false && !msg.error) {
          // No streamed text — use result as fallback
          finalText = resultText;
        }

        // Classify
        const cancelled = (msg as any).stopReason === 'cancelled';
        const staleState = classifyResult(convKey, runIds.length > 0 ? runIds : [...allRunIds], resultFingerprints, pipeLog);
        const stale = staleState === 'stale';

        if (filteredCount > 0) {
          pipeLog.info(`Filtered ${filteredCount} non-foreground event(s) (key=${convKey})`);
        }

        yield {
          type: 'complete',
          text: finalText,
          success: msg.success !== false,
          error: typeof msg.error === 'string' ? msg.error : undefined,
          stopReason: typeof (msg as any).stopReason === 'string' ? (msg as any).stopReason : undefined,
          conversationId: typeof (msg as any).conversationId === 'string' ? (msg as any).conversationId : undefined,
          runIds: runIds.length > 0 ? runIds : [...allRunIds],
          durationMs: typeof (msg as any).durationMs === 'number' ? (msg as any).durationMs : undefined,
          stale,
          cancelled,
          hadStreamedText: streamedTrimmed.length > 0,
          raw: msg,
        };
        break;
      }

      case 'error': {
        yield {
          type: 'error',
          message: (msg as any).message || 'unknown',
          stopReason: (msg as any).stopReason,
          apiError: (msg as any).apiError,
          runId: (msg as any).runId,
        };
        break;
      }

      case 'retry': {
        yield {
          type: 'retry',
          attempt: (msg as any).attempt ?? 0,
          maxAttempts: (msg as any).maxAttempts ?? 0,
          reason: (msg as any).reason || 'unknown',
          delayMs: (msg as any).delayMs,
        };
        break;
      }

      default:
        // Unhandled event types — skip
        break;
    }
  }

  // Flush any trailing reasoning that wasn't followed by a type change
  yield* flushReasoning();
}

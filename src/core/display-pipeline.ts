/**
 * DisplayPipeline — transforms raw SDK stream events into clean,
 * high-level display events for channel delivery.
 *
 * Encapsulates:
 *  - Run ID filtering (foreground tracking, buffering, rebinding)
 *  - Reasoning chunk accumulation (flushed on type transitions)
 *  - stream_event skipping
 *  - Type transition tracking
 *  - Result text selection (streamed vs result field)
 *  - Stale/cancelled result classification
 */

import type { StreamMsg } from './types.js';
import { createLogger } from '../logger.js';

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
): 'fresh' | 'stale' | 'unknown' {
  if (runIds.length === 0) return 'unknown';
  const fingerprint = [...new Set(runIds)].sort().join(',');
  const previous = fingerprints.get(convKey);
  if (previous === fingerprint) {
    log.warn(`Stale duplicate result detected (key=${convKey}, runIds=${fingerprint})`);
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
  const { convKey, resultFingerprints } = opts;

  // ── Foreground run tracking ──
  let foregroundRunId: string | null = null;
  let foregroundSource: 'assistant' | 'result' | null = null;

  // Buffered events received before we know which run is foreground.
  // Once we lock the foreground run, matching events are flushed and
  // non-matching events are dropped.
  type BufferedEvent =
    | { kind: 'reasoning'; runId: string; content: string }
    | { kind: 'tool_call'; runId: string; msg: StreamMsg };
  const buffered: BufferedEvent[] = [];
  let bufferedFlushed = false;

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
  function* flushBuffered(): Generator<DisplayEvent> {
    // Flush ALL buffered events regardless of run ID.
    // Pre-foreground events are always from the current session's turn --
    // background Tasks use separate sessions and don't leak events here.
    // The server often assigns different run IDs for the tool-calling
    // phase vs the continuation (response) phase of the same turn.
    for (const evt of buffered) {
      if (evt.kind === 'reasoning') {
        yield { type: 'reasoning', content: evt.content };
      } else {
        const raw = evt.msg;
        yield {
          type: 'tool_call',
          name: raw.toolName || 'unknown',
          args: (raw.toolInput && typeof raw.toolInput === 'object' ? raw.toolInput : {}) as Record<string, unknown>,
          id: raw.toolCallId || '',
          raw,
        };
      }
    }
    buffered.length = 0;
    bufferedFlushed = true;
  }

  function* flushReasoning(): Generator<DisplayEvent> {
    if (reasoningBuffer.trim()) {
      yield { type: 'reasoning', content: reasoningBuffer };
      reasoningBuffer = '';
    }
  }

  function* flushAssistantTextOnTypeChange(): Generator<DisplayEvent> {
    // Nothing to do here — text events are emitted inline as deltas.
    // But we do need to track that text finalized so the consumer can
    // handle multi-turn responses (uuid change).
  }

  // ── Main loop ──
  for await (const msg of stream) {
    const eventRunIds = extractRunIds(msg);
    for (const id of eventRunIds) allRunIds.add(id);

    // Skip stream_event (low-level deltas, not semantic)
    if (msg.type === 'stream_event') continue;

    log.trace(`raw: type=${msg.type} runIds=${eventRunIds.join(',') || 'none'} fg=${foregroundRunId || 'unlocked'}`);

    // ── Run ID filtering ──
    if (foregroundRunId === null && eventRunIds.length > 0) {
      // Lock to foreground on the first assistant or result event.
      if (msg.type === 'assistant' || msg.type === 'result') {
        foregroundRunId = eventRunIds[0];
        foregroundSource = msg.type === 'assistant' ? 'assistant' : 'result';
        log.info(`Foreground run locked: ${foregroundRunId} (source=${foregroundSource})`);
        if (!bufferedFlushed && buffered.length > 0) {
          yield* flushBuffered();
        }
      } else if (msg.type === 'reasoning' || msg.type === 'tool_call') {
        // Buffer pre-foreground display events
        const runId = eventRunIds[0];
        if (runId && msg.type === 'reasoning') {
          const chunk = typeof msg.content === 'string' ? msg.content : '';
          if (chunk) {
            const last = buffered[buffered.length - 1];
            if (last && last.kind === 'reasoning' && last.runId === runId) {
              last.content += chunk;
            } else {
              buffered.push({ kind: 'reasoning', runId, content: chunk });
            }
          }
        } else if (runId && msg.type === 'tool_call') {
          buffered.push({ kind: 'tool_call', runId, msg });
        }
        filteredCount++;
        continue;
      } else {
        // Other pre-foreground events (error, retry, etc.) — pass through
      }
    } else if (foregroundRunId && eventRunIds.length > 0 && !eventRunIds.includes(foregroundRunId)) {
      // Event from a different run. Rebind on assistant events only
      // (background Tasks don't produce assistant events in the foreground stream).
      if (msg.type === 'assistant') {
        const newRunId = eventRunIds[0];
        log.info(`Foreground run rebind: ${foregroundRunId} -> ${newRunId}`);
        foregroundRunId = newRunId;
        foregroundSource = 'assistant';
        // Flush any buffered events for the new run
        if (buffered.length > 0) {
          yield* flushBuffered();
        }
      } else {
        filteredCount++;
        continue;
      }
    }

    // ── Type transitions ──
    const isSemanticType = msg.type !== 'stream_event';
    if (isSemanticType && lastSemanticType && lastSemanticType !== msg.type) {
      // Flush reasoning on transition away from reasoning
      if (lastSemanticType === 'reasoning') {
        yield* flushReasoning();
      }
    }
    if (isSemanticType) lastSemanticType = msg.type;

    // ── Dispatch by type ──
    switch (msg.type) {
      case 'reasoning': {
        reasoningBuffer += msg.content || '';
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

        // Detect assistant UUID change (multi-turn response boundary)
        if (uuid && lastAssistantUuid && uuid !== lastAssistantUuid && assistantText.trim()) {
          // Yield a finalize-like text event with empty delta to signal turn boundary
          // The consumer can use this to finalize the previous message
        }
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
          log.warn(`Result diverges from streamed (resultLen=${resultText.length}, streamLen=${assistantText.length}), preferring streamed`);
        } else if (streamedTrimmed.length === 0 && msg.success !== false && !msg.error) {
          // No streamed text — use result as fallback
          finalText = resultText;
        }

        // Classify
        const cancelled = (msg as any).stopReason === 'cancelled';
        const staleState = classifyResult(convKey, runIds.length > 0 ? runIds : [...allRunIds], resultFingerprints);
        const stale = staleState === 'stale';

        if (filteredCount > 0) {
          log.info(`Filtered ${filteredCount} non-foreground event(s) (key=${convKey})`);
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
        // tool_result and other types we don't surface — skip
        break;
    }
  }

  // Flush any trailing reasoning that wasn't followed by a type change
  yield* flushReasoning();
}

/**
 * Turn logger -- writes one JSONL record per agent turn.
 *
 * TurnLogger handles file I/O with write serialization and bounded retention.
 * TurnAccumulator collects DisplayEvents during a turn and produces a TurnRecord.
 */

import { appendFile, readFile, writeFile, rename } from 'node:fs/promises';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../logger.js';
import type { DisplayEvent } from './display-pipeline.js';
import type { TriggerType, StreamMsg } from './types.js';

const log = createLogger('TurnLogger');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TurnEvent =
  | { type: 'reasoning'; content: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; content: string; isError: boolean };

export interface TurnRecord {
  ts: string;
  turnId: string;
  trigger: TriggerType;
  channel?: string;
  chatId?: string;
  userId?: string;
  input: string;
  events: TurnEvent[];
  output: string;
  durationMs?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TURNS = 1000;
const MAX_TOOL_RESULT_BYTES = 4 * 1024;

// ---------------------------------------------------------------------------
// TurnAccumulator
// ---------------------------------------------------------------------------

/**
 * Collects DisplayEvents during a single agent turn and produces a TurnRecord.
 * Works with the DisplayPipeline's event types -- no raw StreamMsg handling.
 */
export class TurnAccumulator {
  private _events: TurnEvent[] = [];
  private _output = '';
  // For feedRaw() only (sendToAgent/streamToAgent paths)
  private _reasoningAcc = '';
  private _lastRawType: string | null = null;

  /** Feed a DisplayEvent from the pipeline. */
  feed(event: DisplayEvent): void {
    switch (event.type) {
      case 'reasoning':
        // Pipeline already accumulates and flushes reasoning chunks,
        // so each reasoning event is a complete block.
        this._events.push({ type: 'reasoning', content: event.content });
        break;
      case 'tool_call':
        this._events.push({
          type: 'tool_call',
          id: event.id,
          name: event.name,
          args: event.args,
        });
        break;
      case 'tool_result': {
        const content = event.content.length > MAX_TOOL_RESULT_BYTES
          ? event.content.slice(0, MAX_TOOL_RESULT_BYTES) + '…[truncated]'
          : event.content;
        this._events.push({
          type: 'tool_result',
          id: event.toolCallId,
          content,
          isError: event.isError,
        });
        break;
      }
      case 'text':
        this._output += event.delta;
        break;
    }
  }

  /**
   * Feed a raw StreamMsg (for sendToAgent/streamToAgent which don't use DisplayPipeline).
   * Handles reasoning accumulation inline since there's no pipeline to do it.
   */
  feedRaw(msg: StreamMsg): void {
    // Flush reasoning on transition away from reasoning
    if (this._lastRawType === 'reasoning' && msg.type !== 'reasoning' && this._reasoningAcc.trim()) {
      this._events.push({ type: 'reasoning', content: this._reasoningAcc.trim() });
      this._reasoningAcc = '';
    }
    switch (msg.type) {
      case 'reasoning':
        this._reasoningAcc += msg.content || '';
        break;
      case 'tool_call':
        this._events.push({
          type: 'tool_call',
          id: msg.toolCallId || '',
          name: msg.toolName || 'unknown',
          args: (msg as any).toolInput ?? (msg as any).rawArguments ?? null,
        });
        break;
      case 'tool_result': {
        const raw = (msg as any).content ?? '';
        const str = typeof raw === 'string' ? raw : JSON.stringify(raw);
        this._events.push({
          type: 'tool_result',
          id: msg.toolCallId || '',
          content: str.length > MAX_TOOL_RESULT_BYTES
            ? str.slice(0, MAX_TOOL_RESULT_BYTES) + '…[truncated]'
            : str,
          isError: !!msg.isError,
        });
        break;
      }
      case 'assistant':
        this._output += msg.content || '';
        break;
    }
    if (msg.type !== 'stream_event') this._lastRawType = msg.type;
  }

  /** Return the accumulated events and output text. */
  finalize(): { events: TurnEvent[]; output: string } {
    // Flush trailing reasoning
    if (this._reasoningAcc.trim()) {
      this._events.push({ type: 'reasoning', content: this._reasoningAcc.trim() });
      this._reasoningAcc = '';
    }
    return { events: this._events, output: this._output };
  }
}

// ---------------------------------------------------------------------------
// TurnLogger
// ---------------------------------------------------------------------------

export class TurnLogger {
  private filePath: string;
  private maxTurns: number;
  private ready = false;
  private lineCount = 0;
  private writeQueue = Promise.resolve();

  constructor(filePath: string, maxTurns = DEFAULT_MAX_TURNS) {
    this.filePath = filePath;
    if (!Number.isInteger(maxTurns) || maxTurns <= 0) {
      throw new Error(`TurnLogger: maxTurns must be a positive integer (got ${maxTurns})`);
    }
    this.maxTurns = maxTurns;
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      this.ready = true;
      try {
        const existing = readFileSync(filePath, 'utf8');
        this.lineCount = existing.split('\n').filter(l => l.trim()).length;
      } catch {
        this.lineCount = 0;
      }
    } catch (err) {
      log.warn(`Failed to create log directory for ${filePath}:`, err instanceof Error ? err.message : err);
    }
  }

  /** Serialized write -- prevents concurrent trim races. */
  async write(record: TurnRecord): Promise<void> {
    if (!this.ready) return;
    this.writeQueue = this.writeQueue.then(() => this._write(record)).catch(() => {});
    return this.writeQueue;
  }

  private async _write(record: TurnRecord): Promise<void> {
    try {
      await appendFile(this.filePath, JSON.stringify(record) + '\n');
      this.lineCount++;
      if (this.lineCount > this.maxTurns) {
        await this.trim();
      }
    } catch (err) {
      log.warn(`Failed to write turn record:`, err instanceof Error ? err.message : err);
    }
  }

  private async trim(): Promise<void> {
    try {
      const content = await readFile(this.filePath, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());
      const trimmed = lines.slice(lines.length - this.maxTurns).join('\n') + '\n';
      const tmp = this.filePath + '.tmp';
      await writeFile(tmp, trimmed);
      await rename(tmp, this.filePath);
      this.lineCount = this.maxTurns;
    } catch (err) {
      log.warn(`Failed to trim turn log:`, err instanceof Error ? err.message : err);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a unique turn ID. */
export function generateTurnId(): string {
  return randomUUID();
}

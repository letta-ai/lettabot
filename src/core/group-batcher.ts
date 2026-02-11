/**
 * Group Message Batcher
 *
 * Debounces group chat messages and flushes after a quiet period or on @mention.
 * Channel-agnostic: works with any ChannelAdapter.
 */

import type { ChannelAdapter } from '../channels/types.js';
import type { InboundMessage } from './types.js';

export interface BufferEntry {
  messages: InboundMessage[];
  adapter: ChannelAdapter;
  timer: ReturnType<typeof setTimeout> | null;
}

export type OnFlushCallback = (msg: InboundMessage, adapter: ChannelAdapter) => void;

export class GroupBatcher {
  private buffer: Map<string, BufferEntry> = new Map();
  private onFlush: OnFlushCallback;

  constructor(onFlush: OnFlushCallback) {
    this.onFlush = onFlush;
  }

  /**
   * Add a group message to the buffer.
   * If wasMentioned, flush immediately.
   * If debounceMs is 0, flush on every message (no batching).
   * Otherwise, debounce: reset timer on every message, flush after quiet period.
   */
  enqueue(msg: InboundMessage, adapter: ChannelAdapter, debounceMs: number): void {
    const key = `${msg.channel}:${msg.chatId}`;

    let entry = this.buffer.get(key);
    if (!entry) {
      entry = { messages: [], adapter, timer: null };
      this.buffer.set(key, entry);
    }

    entry.messages.push(msg);
    entry.adapter = adapter; // Update adapter reference

    // Immediate flush: @mention or debounceMs=0
    if (msg.wasMentioned || debounceMs === 0) {
      this.flush(key);
      return;
    }

    // Debounce: reset timer on every message
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    entry.timer = setTimeout(() => {
      this.flush(key);
    }, debounceMs);
  }

  /**
   * Flush buffered messages for a key, building a synthetic batch InboundMessage.
   */
  flush(key: string): void {
    const entry = this.buffer.get(key);
    if (!entry || entry.messages.length === 0) return;

    // Clear timer
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }

    const messages = entry.messages;
    const adapter = entry.adapter;

    // Remove from buffer
    this.buffer.delete(key);

    // Use the last message as the base for the synthetic batch message
    const last = messages[messages.length - 1];

    const batchMsg: InboundMessage = {
      channel: last.channel,
      chatId: last.chatId,
      userId: last.userId,
      userName: last.userName,
      userHandle: last.userHandle,
      messageId: last.messageId,
      text: messages.map((m) => m.text).join('\n'),
      timestamp: last.timestamp,
      isGroup: true,
      groupName: last.groupName,
      wasMentioned: messages.some((m) => m.wasMentioned),
      // Preserve listening-mode intent only if every message in the batch is non-mentioned listen mode.
      isListeningMode: messages.every((m) => m.isListeningMode === true) ? true : undefined,
      isBatch: true,
      batchedMessages: messages,
    };

    this.onFlush(batchMsg, adapter);
  }

  /**
   * Clear all timers on shutdown.
   */
  stop(): void {
    for (const [, entry] of this.buffer) {
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
    }
    this.buffer.clear();
  }
}

import { describe, expect, it } from 'vitest';
import type { InboundMessage } from './types.js';
import type { ChannelAdapter } from '../channels/types.js';

/**
 * Tests for listening mode detection in processGroupBatch.
 *
 * processGroupBatch is a public method on LettaBot that:
 * 1. Checks if the group is in listeningGroupIds
 * 2. If listening and NOT mentioned, sets isListeningMode = true
 * 3. If mentioned, does NOT set isListeningMode (agent should reply)
 *
 * We test the detection logic directly since the full processGroupBatch
 * requires an SDK session. The logic under test:
 *   const isListening = listeningGroupIds.has(`${channel}:${chatId}`)
 *     || (serverId && listeningGroupIds.has(`${channel}:${serverId}`));
 *   if (isListening && !wasMentioned) msg.isListeningMode = true;
 */

function createGroupMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: 'discord',
    chatId: '123456',
    userId: 'user1',
    userName: 'Alice',
    text: 'Hello everyone',
    timestamp: new Date('2026-02-02T12:00:00Z'),
    isGroup: true,
    groupName: 'general',
    isBatch: true,
    batchedMessages: [{
      channel: 'discord',
      chatId: '123456',
      userId: 'user1',
      userName: 'Alice',
      text: 'Hello everyone',
      timestamp: new Date('2026-02-02T12:00:00Z'),
      isGroup: true,
    }],
    ...overrides,
  };
}

/**
 * Simulate the listening mode detection from processGroupBatch.
 * Extracted logic from src/core/bot.ts lines 149-154.
 */
function applyListeningMode(
  msg: InboundMessage,
  listeningGroupIds: Set<string>,
): InboundMessage {
  const effective = (msg.batchedMessages?.length === 1 && msg.batchedMessages)
    ? msg.batchedMessages[0]
    : msg;

  const isListening = listeningGroupIds.has(`${msg.channel}:${msg.chatId}`)
    || (msg.serverId && listeningGroupIds.has(`${msg.channel}:${msg.serverId}`));
  if (isListening && !msg.wasMentioned) {
    effective.isListeningMode = true;
  }

  return effective;
}

describe('listening mode detection', () => {
  describe('group matching', () => {
    it('sets isListeningMode when chatId matches a listening group', () => {
      const msg = createGroupMessage({ channel: 'discord', chatId: '123456' });
      const listeningIds = new Set(['discord:123456']);
      const result = applyListeningMode(msg, listeningIds);
      expect(result.isListeningMode).toBe(true);
    });

    it('sets isListeningMode when serverId matches a listening group', () => {
      const msg = createGroupMessage({
        channel: 'discord',
        chatId: '123456',
        serverId: 'server789',
      });
      const listeningIds = new Set(['discord:server789']);
      const result = applyListeningMode(msg, listeningIds);
      expect(result.isListeningMode).toBe(true);
    });

    it('does not set isListeningMode when group is not in listening set', () => {
      const msg = createGroupMessage({ channel: 'discord', chatId: '123456' });
      const listeningIds = new Set(['discord:999999']);
      const result = applyListeningMode(msg, listeningIds);
      expect(result.isListeningMode).toBeUndefined();
    });

    it('does not set isListeningMode for different channel with same chatId', () => {
      const msg = createGroupMessage({ channel: 'telegram', chatId: '123456' });
      const listeningIds = new Set(['discord:123456']);
      const result = applyListeningMode(msg, listeningIds);
      expect(result.isListeningMode).toBeUndefined();
    });
  });

  describe('mention override', () => {
    it('does NOT set isListeningMode when bot is mentioned in a listening group', () => {
      const msg = createGroupMessage({
        channel: 'discord',
        chatId: '123456',
        wasMentioned: true,
      });
      const listeningIds = new Set(['discord:123456']);
      const result = applyListeningMode(msg, listeningIds);
      expect(result.isListeningMode).toBeUndefined();
    });

    it('does NOT set isListeningMode when bot is mentioned via serverId match', () => {
      const msg = createGroupMessage({
        channel: 'discord',
        chatId: '123456',
        serverId: 'server789',
        wasMentioned: true,
      });
      const listeningIds = new Set(['discord:server789']);
      const result = applyListeningMode(msg, listeningIds);
      expect(result.isListeningMode).toBeUndefined();
    });
  });

  describe('empty listening set', () => {
    it('does not set isListeningMode when no listening groups configured', () => {
      const msg = createGroupMessage();
      const listeningIds = new Set<string>();
      const result = applyListeningMode(msg, listeningIds);
      expect(result.isListeningMode).toBeUndefined();
    });
  });

  describe('single-message batch unwrapping', () => {
    it('applies isListeningMode to the unwrapped single message', () => {
      const inner: InboundMessage = {
        channel: 'discord',
        chatId: '123456',
        userId: 'user1',
        userName: 'Alice',
        text: 'Hello',
        timestamp: new Date(),
        isGroup: true,
      };
      const batch = createGroupMessage({
        batchedMessages: [inner],
      });
      const listeningIds = new Set(['discord:123456']);
      const result = applyListeningMode(batch, listeningIds);
      // Should return the unwrapped inner message with isListeningMode set
      expect(result).toBe(inner);
      expect(result.isListeningMode).toBe(true);
    });

    it('applies isListeningMode to batch wrapper for multi-message batches', () => {
      const msgs: InboundMessage[] = [
        { channel: 'discord', chatId: '123456', userId: 'u1', text: 'a', timestamp: new Date(), isGroup: true },
        { channel: 'discord', chatId: '123456', userId: 'u2', text: 'b', timestamp: new Date(), isGroup: true },
      ];
      const batch = createGroupMessage({ batchedMessages: msgs });
      const listeningIds = new Set(['discord:123456']);
      const result = applyListeningMode(batch, listeningIds);
      // Multi-message batch returns the wrapper
      expect(result).toBe(batch);
      expect(result.isListeningMode).toBe(true);
    });
  });
});

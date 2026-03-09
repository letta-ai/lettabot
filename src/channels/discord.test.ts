import { describe, expect, it } from 'vitest';
import {
  buildDiscordGroupKeys,
  resolveDiscordAutoCreateThreadOnMention,
  resolveDiscordThreadMode,
  shouldProcessDiscordBotMessage,
} from './discord.js';
import type { GroupModeConfig } from './group-mode.js';

describe('buildDiscordGroupKeys', () => {
  it('includes chat, parent, and server IDs in priority order', () => {
    expect(buildDiscordGroupKeys({
      chatId: 'thread-1',
      parentChatId: 'channel-1',
      serverId: 'guild-1',
    })).toEqual(['thread-1', 'channel-1', 'guild-1']);
  });

  it('deduplicates repeated IDs', () => {
    expect(buildDiscordGroupKeys({
      chatId: 'channel-1',
      parentChatId: 'channel-1',
      serverId: 'guild-1',
    })).toEqual(['channel-1', 'guild-1']);
  });
});

describe('resolveDiscordThreadMode', () => {
  it('resolves from the first matching key', () => {
    const groups: Record<string, GroupModeConfig> = {
      'channel-1': { threadMode: 'thread-only' },
      'guild-1': { threadMode: 'any' },
    };
    expect(resolveDiscordThreadMode(groups, ['channel-1', 'guild-1'])).toBe('thread-only');
  });

  it('falls back to wildcard when no explicit key matches', () => {
    const groups: Record<string, GroupModeConfig> = {
      '*': { threadMode: 'thread-only' },
    };
    expect(resolveDiscordThreadMode(groups, ['channel-1', 'guild-1'])).toBe('thread-only');
  });

  it('defaults to any when unset', () => {
    expect(resolveDiscordThreadMode(undefined, ['channel-1'])).toBe('any');
  });
});

describe('resolveDiscordAutoCreateThreadOnMention', () => {
  it('resolves from matching key before wildcard', () => {
    const groups: Record<string, GroupModeConfig> = {
      'channel-1': { autoCreateThreadOnMention: true },
      '*': { autoCreateThreadOnMention: false },
    };
    expect(resolveDiscordAutoCreateThreadOnMention(groups, ['channel-1', 'guild-1'])).toBe(true);
  });

  it('defaults to false when unset', () => {
    expect(resolveDiscordAutoCreateThreadOnMention(undefined, ['channel-1'])).toBe(false);
  });
});

describe('shouldProcessDiscordBotMessage', () => {
  it('allows non-bot messages', () => {
    expect(shouldProcessDiscordBotMessage({
      isFromBot: false,
      isGroup: true,
      keys: ['chat-1'],
    })).toBe(true);
  });

  it('drops bot DMs', () => {
    expect(shouldProcessDiscordBotMessage({
      isFromBot: true,
      isGroup: false,
      keys: ['dm-1'],
    })).toBe(false);
  });

  it('drops this bot own messages to prevent self-echo loops', () => {
    const groups: Record<string, GroupModeConfig> = {
      'chat-1': { mode: 'open', receiveBotMessages: true },
    };
    expect(shouldProcessDiscordBotMessage({
      isFromBot: true,
      isGroup: true,
      authorId: 'bot-self',
      selfUserId: 'bot-self',
      groups,
      keys: ['chat-1'],
    })).toBe(false);
  });

  it('drops other bot messages when receiveBotMessages is not enabled', () => {
    const groups: Record<string, GroupModeConfig> = {
      'chat-1': { mode: 'open' },
    };
    expect(shouldProcessDiscordBotMessage({
      isFromBot: true,
      isGroup: true,
      authorId: 'bot-other',
      selfUserId: 'bot-self',
      groups,
      keys: ['chat-1'],
    })).toBe(false);
  });

  it('allows other bot messages when receiveBotMessages is enabled', () => {
    const groups: Record<string, GroupModeConfig> = {
      'chat-1': { mode: 'open', receiveBotMessages: true },
    };
    expect(shouldProcessDiscordBotMessage({
      isFromBot: true,
      isGroup: true,
      authorId: 'bot-other',
      selfUserId: 'bot-self',
      groups,
      keys: ['chat-1'],
    })).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { shouldProcessDiscordBotMessage } from './discord.js';
import type { GroupModeConfig } from './group-mode.js';

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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramAdapter } from './telegram.js';

describe('TelegramAdapter reactions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('strips variation selectors before sending unicode heart reactions', async () => {
    const adapter = new TelegramAdapter({ token: 'test-token' });
    const setReaction = vi
      .spyOn(adapter.getBot().api, 'setMessageReaction')
      .mockImplementation(async () => true as any);

    await adapter.addReaction('123', '456', '❤️');

    expect(setReaction).toHaveBeenCalledWith('123', 456, [
      { type: 'emoji', emoji: '❤' },
    ]);
  });

  it("normalizes the heart alias to Telegram's bare-heart reaction", async () => {
    const adapter = new TelegramAdapter({ token: 'test-token' });
    const setReaction = vi
      .spyOn(adapter.getBot().api, 'setMessageReaction')
      .mockImplementation(async () => true as any);

    await adapter.addReaction('123', '456', 'heart');

    expect(setReaction).toHaveBeenCalledWith('123', 456, [
      { type: 'emoji', emoji: '❤' },
    ]);
  });
});

describe('TelegramAdapter audio fallback', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to sendAudio for VOICE_MESSAGES_FORBIDDEN errors', async () => {
    const adapter = new TelegramAdapter({ token: 'test-token' });
    const sendVoice = vi
      .spyOn(adapter.getBot().api, 'sendVoice')
      .mockRejectedValue({ description: 'Bad Request: VOICE_MESSAGES_FORBIDDEN' } as any);
    const sendAudio = vi
      .spyOn(adapter.getBot().api, 'sendAudio')
      .mockResolvedValue({ message_id: 987 } as any);

    const result = await adapter.sendFile({
      chatId: '123',
      filePath: '/tmp/voice.ogg',
      kind: 'audio',
    });

    expect(sendVoice).toHaveBeenCalledTimes(1);
    expect(sendAudio).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ messageId: '987' });
  });

  it('does not fall back to sendAudio for non-voice transport failures', async () => {
    const adapter = new TelegramAdapter({ token: 'test-token' });
    const timeoutError = new Error('socket hang up');
    const sendVoice = vi
      .spyOn(adapter.getBot().api, 'sendVoice')
      .mockRejectedValue(timeoutError);
    const sendAudio = vi
      .spyOn(adapter.getBot().api, 'sendAudio')
      .mockResolvedValue({ message_id: 999 } as any);

    await expect(adapter.sendFile({
      chatId: '123',
      filePath: '/tmp/voice.ogg',
      kind: 'audio',
    })).rejects.toBe(timeoutError);

    expect(sendVoice).toHaveBeenCalledTimes(1);
    expect(sendAudio).not.toHaveBeenCalled();
  });
});

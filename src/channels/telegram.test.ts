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

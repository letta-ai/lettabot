import { describe, it, expect, vi } from 'vitest';
import { sendWhatsAppFile, type LidMapper } from './outbound.js';

describe('sendWhatsAppFile', () => {
  it('sends audio as native voice note payload', async () => {
    const sock = {
      sendMessage: vi.fn(async () => ({ key: { id: '' } })),
    } as any;

    const lidMapper: LidMapper = {
      selfChatLid: '',
      myNumber: '',
      lidToJid: new Map(),
    };

    await sendWhatsAppFile(
      sock,
      {
        chatId: '12345@s.whatsapp.net',
        filePath: '/tmp/voice.ogg',
        caption: 'hello',
        kind: 'audio',
      },
      lidMapper,
      new Set<string>(),
    );

    expect(sock.sendMessage).toHaveBeenCalledWith(
      '12345@s.whatsapp.net',
      {
        audio: { url: '/tmp/voice.ogg' },
        ptt: true,
      },
    );
  });
});

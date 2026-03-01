import { describe, it, expect, vi } from 'vitest';
import { SignalAdapter } from './signal.js';

describe('SignalAdapter sendFile', () => {
  function createAdapter(phone = '+15555555555') {
    return new SignalAdapter({ phoneNumber: phone });
  }

  it('sends attachment to a direct message recipient', async () => {
    const adapter = createAdapter();
    const rpcSpy = vi.spyOn(adapter as any, 'rpcRequest').mockResolvedValue({ timestamp: 12345 });

    const result = await adapter.sendFile({
      chatId: '+12223334444',
      filePath: '/tmp/voice.ogg',
    });

    expect(rpcSpy).toHaveBeenCalledWith('send', {
      attachment: ['/tmp/voice.ogg'],
      account: '+15555555555',
      recipient: ['+12223334444'],
    });
    expect(result.messageId).toBe('12345');
  });

  it('sends attachment to a group', async () => {
    const adapter = createAdapter();
    const rpcSpy = vi.spyOn(adapter as any, 'rpcRequest').mockResolvedValue({ timestamp: 99 });

    await adapter.sendFile({
      chatId: 'group:abc123',
      filePath: '/tmp/photo.png',
      kind: 'image',
    });

    expect(rpcSpy).toHaveBeenCalledWith('send', {
      attachment: ['/tmp/photo.png'],
      account: '+15555555555',
      groupId: 'abc123',
    });
  });

  it('includes caption as message text', async () => {
    const adapter = createAdapter();
    const rpcSpy = vi.spyOn(adapter as any, 'rpcRequest').mockResolvedValue({ timestamp: 1 });

    await adapter.sendFile({
      chatId: '+12223334444',
      filePath: '/tmp/report.pdf',
      caption: 'Here is the report',
    });

    expect(rpcSpy).toHaveBeenCalledWith('send', {
      attachment: ['/tmp/report.pdf'],
      message: 'Here is the report',
      account: '+15555555555',
      recipient: ['+12223334444'],
    });
  });

  it('sends to own number for note-to-self', async () => {
    const adapter = createAdapter('+19998887777');
    const rpcSpy = vi.spyOn(adapter as any, 'rpcRequest').mockResolvedValue({ timestamp: 42 });

    await adapter.sendFile({
      chatId: 'note-to-self',
      filePath: '/tmp/memo.ogg',
      kind: 'audio',
    });

    expect(rpcSpy).toHaveBeenCalledWith('send', {
      attachment: ['/tmp/memo.ogg'],
      account: '+19998887777',
      recipient: ['+19998887777'],
    });
  });

  it('returns unknown when no timestamp in response', async () => {
    const adapter = createAdapter();
    vi.spyOn(adapter as any, 'rpcRequest').mockResolvedValue({});

    const result = await adapter.sendFile({
      chatId: '+12223334444',
      filePath: '/tmp/file.txt',
    });

    expect(result.messageId).toBe('unknown');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../pairing/store.js', () => ({
  isUserAllowed: vi.fn(),
  upsertPairingRequest: vi.fn(),
  approvePairingCode: vi.fn(),
}));

import { TelegramMTProtoAdapter } from '../telegram-mtproto.js';
import { isUserAllowed, upsertPairingRequest } from '../../pairing/store.js';

const mockedIsUserAllowed = vi.mocked(isUserAllowed);
const mockedUpsertPairingRequest = vi.mocked(upsertPairingRequest);

function makeAdapter(overrides: Partial<ConstructorParameters<typeof TelegramMTProtoAdapter>[0]> = {}) {
  return new TelegramMTProtoAdapter({
    phoneNumber: '+15551234567',
    apiId: 12345,
    apiHash: 'test-hash',
    dmPolicy: 'pairing',
    ...overrides,
  });
}

function makeIncomingTextMessage(overrides: Record<string, unknown> = {}) {
  return {
    is_outgoing: false,
    chat_id: 1001,
    id: 5001,
    date: Math.floor(Date.now() / 1000),
    sender_id: { _: 'messageSenderUser', user_id: 42 },
    content: {
      _: 'messageText',
      text: { text: 'hello', entities: [] },
    },
    ...overrides,
  };
}

describe('TelegramMTProtoAdapter pairing flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedIsUserAllowed.mockResolvedValue(false);
  });

  it('sends queue-full notice when no pairing code can be allocated', async () => {
    const adapter = makeAdapter();
    adapter.onMessage = vi.fn().mockResolvedValue(undefined);

    mockedUpsertPairingRequest.mockResolvedValue({ code: '', created: false });
    const sendSpy = vi.spyOn(adapter, 'sendMessage').mockResolvedValue({ messageId: '1' });

    await (adapter as any).handleNewMessage(makeIncomingTextMessage());

    expect(mockedUpsertPairingRequest).toHaveBeenCalledWith('telegram-mtproto', '42');
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith({
      chatId: '1001',
      text: 'Too many pending pairing requests. Please try again later.',
    });
    expect(adapter.onMessage).not.toHaveBeenCalled();
  });

  it('silently deduplicates existing pending pairing requests', async () => {
    const adapter = makeAdapter();
    adapter.onMessage = vi.fn().mockResolvedValue(undefined);

    mockedUpsertPairingRequest.mockResolvedValue({ code: 'ABC123', created: false });
    const sendSpy = vi.spyOn(adapter, 'sendMessage').mockResolvedValue({ messageId: '1' });

    await (adapter as any).handleNewMessage(makeIncomingTextMessage());

    expect(mockedUpsertPairingRequest).toHaveBeenCalledWith('telegram-mtproto', '42');
    expect(sendSpy).not.toHaveBeenCalled();
    expect(adapter.onMessage).not.toHaveBeenCalled();
  });

  it('notifies user and admin once for newly created pairing requests', async () => {
    const adapter = makeAdapter({ adminChatId: 9999 });
    adapter.onMessage = vi.fn().mockResolvedValue(undefined);

    mockedUpsertPairingRequest.mockResolvedValue({ code: 'ABC123', created: true });
    vi.spyOn(adapter as any, 'getUserInfo').mockResolvedValue({ username: 'alice', firstName: null });
    const sendSpy = vi.spyOn(adapter, 'sendMessage')
      .mockResolvedValueOnce({ messageId: '100' }) // user notice
      .mockResolvedValueOnce({ messageId: '200' }); // admin notice

    await (adapter as any).handleNewMessage(
      makeIncomingTextMessage({
        content: {
          _: 'messageText',
          text: { text: 'can you help?', entities: [] },
        },
      })
    );

    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(sendSpy.mock.calls[0][0]).toEqual({
      chatId: '1001',
      text: 'Your request has been passed on to the admin.',
    });
    expect(sendSpy.mock.calls[1][0].chatId).toBe('9999');

    const pendingApprovals = (adapter as any).pendingPairingApprovals as Map<number, { code: string }>;
    expect(pendingApprovals.size).toBe(1);
    expect([...pendingApprovals.values()][0].code).toBe('ABC123');
  });
});

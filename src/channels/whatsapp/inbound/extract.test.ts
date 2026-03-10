import { describe, expect, it, vi } from 'vitest';

import type { GroupMetaCache } from '../utils.js';
import { extractInboundMessage } from './extract.js';

const REMOTE_LID = '210501234567890@lid';

function createMessage(
  overrides: {
    key?: Record<string, unknown>;
    message?: Record<string, unknown>;
    messageTimestamp?: number;
    pushName?: string;
  } = {}
): Record<string, unknown> {
  const { key: keyOverrides, message: messageOverrides, ...rest } = overrides;
  return {
    key: {
      remoteJid: REMOTE_LID,
      id: 'msg-1',
      ...keyOverrides,
    },
    message: {
      conversation: 'hello from web',
      ...messageOverrides,
    },
    messageTimestamp: 1700000000,
    pushName: 'Alice',
    ...rest,
  };
}

function createSocket(options: { lidMapping?: Map<string, string> } = {}): Record<string, unknown> {
  return {
    user: { id: '19998887777@s.whatsapp.net' },
    signalRepository: options.lidMapping ? { lidMapping: options.lidMapping } : {},
    groupMetadata: vi.fn(),
  };
}

function createGroupMetaCache(): GroupMetaCache {
  return {
    get: vi.fn(async () => ({ expires: Date.now() + 60_000 })),
    clear: vi.fn(),
  };
}

describe('extractInboundMessage (LID DM resolution)', () => {
  it('resolves LID DMs via senderPn and normalizes chatId to a PN JID', async () => {
    const msg = createMessage({
      key: {
        senderPn: '15551234567@s.whatsapp.net',
      },
    });
    const sock = createSocket();

    const extracted = await extractInboundMessage(
      msg as any,
      sock as any,
      createGroupMetaCache()
    );

    expect(extracted?.chatId).toBe('15551234567@s.whatsapp.net');
    expect(extracted?.from).toBe('15551234567');
    expect(extracted?.senderE164).toBe('15551234567');
  });

  it('falls back to signalRepository.lidMapping when senderPn is missing', async () => {
    const msg = createMessage();
    const sock = createSocket({
      lidMapping: new Map([[REMOTE_LID, '16667778888@s.whatsapp.net']]),
    });

    const extracted = await extractInboundMessage(
      msg as any,
      sock as any,
      createGroupMetaCache()
    );

    expect(extracted?.chatId).toBe('16667778888@s.whatsapp.net');
    expect(extracted?.from).toBe('16667778888');
    expect(extracted?.senderE164).toBe('16667778888');
  });

  it('falls back to the LID-derived number when no mapping is available', async () => {
    const msg = createMessage();
    const sock = createSocket();

    const extracted = await extractInboundMessage(
      msg as any,
      sock as any,
      createGroupMetaCache()
    );

    expect(extracted?.chatId).toBe(REMOTE_LID);
    expect(extracted?.from).toBe('210501234567890');
    expect(extracted?.senderE164).toBe('210501234567890');
  });

  it('accepts plain phone-number senderPn values by converting them to PN JIDs', async () => {
    const msg = createMessage({
      key: {
        senderPn: '+1 (555) 222-3333',
      },
    });
    const sock = createSocket();

    const extracted = await extractInboundMessage(
      msg as any,
      sock as any,
      createGroupMetaCache()
    );

    expect(extracted?.chatId).toBe('15552223333@s.whatsapp.net');
    expect(extracted?.from).toBe('15552223333');
    expect(extracted?.senderE164).toBe('15552223333');
  });
});

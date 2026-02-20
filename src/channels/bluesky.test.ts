import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { BlueskyAdapter } from './bluesky.js';

const listUri = 'at://did:plc:tester/app.bsky.graph.list/abcd';

function makeAdapter(overrides: Partial<ConstructorParameters<typeof BlueskyAdapter>[0]> = {}) {
  return new BlueskyAdapter({
    enabled: true,
    agentName: 'TestAgent',
    groups: { '*': { mode: 'listen' } },
    ...overrides,
  });
}

describe('BlueskyAdapter', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('uses groups wildcard and explicit overrides when resolving mode', () => {
    const adapter = makeAdapter({
      groups: {
        '*': { mode: 'open' },
        'did:plc:explicit': { mode: 'disabled' },
      },
    });

    const getDidMode = (adapter as any).getDidMode.bind(adapter);
    expect(getDidMode('did:plc:explicit')).toBe('disabled');
    expect(getDidMode('did:plc:other')).toBe('open');
  });

  it('expands list DIDs and respects explicit group overrides', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          { subject: { did: 'did:plc:one' } },
          { subject: { did: 'did:plc:two' } },
        ],
      }),
      text: async () => '',
    });

    const adapter = makeAdapter({
      lists: {
        [listUri]: { mode: 'open' },
      },
      groups: {
        '*': { mode: 'listen' },
        'did:plc:two': { mode: 'disabled' },
      },
      appViewUrl: 'https://public.api.bsky.app',
    });

    await (adapter as any).expandLists();

    const listModes = (adapter as any).listModes as Record<string, string>;
    expect(listModes['did:plc:one']).toBe('open');
    expect(listModes['did:plc:two']).toBeUndefined();
  });

  it('mention-only replies only on mention notifications', async () => {
    const adapter = makeAdapter({
      groups: { '*': { mode: 'mention-only' } },
    });

    const messages: any[] = [];
    adapter.onMessage = async (msg) => {
      messages.push(msg);
    };

    const notificationBase = {
      uri: 'at://did:plc:author/app.bsky.feed.post/aaa',
      cid: 'cid1',
      author: { did: 'did:plc:author', handle: 'author.bsky.social' },
      record: {
        $type: 'app.bsky.feed.post',
        text: 'Hello',
        createdAt: new Date().toISOString(),
      },
      indexedAt: new Date().toISOString(),
    };

    await (adapter as any).processNotification({
      ...notificationBase,
      reason: 'mention',
    });

    await (adapter as any).processNotification({
      ...notificationBase,
      reason: 'reply',
    });

    expect(messages).toHaveLength(2);
    expect(messages[0].isListeningMode).toBe(false);
    expect(messages[1].isListeningMode).toBe(true);
  });

  it('excludes disabled DIDs from wantedDids', () => {
    const adapter = makeAdapter({
      wantedDids: ['did:plc:disabled'],
      groups: {
        '*': { mode: 'listen' },
        'did:plc:disabled': { mode: 'disabled' },
      },
    });

    const wanted = (adapter as any).getWantedDids();
    expect(wanted).toEqual([]);
  });
});

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { BlueskyAdapter } from './bluesky.js';
import { splitPostText } from './bluesky/utils.js';

vi.mock('../config/io.js', () => ({
  loadConfig: vi.fn(),
}));

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

  it('uses post uri as chatId and defaults notification reply root to the post itself', async () => {
    const adapter = makeAdapter();

    const notification = {
      uri: 'at://did:plc:author/app.bsky.feed.post/abc',
      cid: 'cid-post',
      author: { did: 'did:plc:author', handle: 'author.bsky.social' },
      reason: 'reply',
      record: {
        $type: 'app.bsky.feed.post',
        text: 'Hello',
        createdAt: new Date().toISOString(),
      },
      indexedAt: new Date().toISOString(),
    };

    const messages: any[] = [];
    adapter.onMessage = async (msg) => {
      messages.push(msg);
    };

    await (adapter as any).processNotification(notification);

    expect(messages[0].chatId).toBe(notification.uri);

    const lastPostByChatId = (adapter as any).lastPostByChatId as Map<string, any>;
    const entry = lastPostByChatId.get(notification.uri);
    expect(entry?.rootUri).toBe(notification.uri);
    expect(entry?.rootCid).toBe(notification.cid);
  });

  it('deduplicates Jetstream delivery after notifications', async () => {
    const adapter = makeAdapter();

    const messages: any[] = [];
    adapter.onMessage = async (msg) => {
      messages.push(msg);
    };

    const cid = 'cid-dup';
    const notification = {
      uri: 'at://did:plc:author/app.bsky.feed.post/dup',
      cid,
      author: { did: 'did:plc:author', handle: 'author.bsky.social' },
      reason: 'mention',
      record: {
        $type: 'app.bsky.feed.post',
        text: 'Hello',
        createdAt: new Date().toISOString(),
      },
      indexedAt: new Date().toISOString(),
    };

    await (adapter as any).processNotification(notification);

    const event = {
      data: JSON.stringify({
        did: 'did:plc:author',
        time_us: Date.now() * 1000,
        identity: { handle: 'author.bsky.social' },
        commit: {
          collection: 'app.bsky.feed.post',
          rkey: 'dup',
          cid,
          record: {
            $type: 'app.bsky.feed.post',
            text: 'Hello',
            createdAt: new Date().toISOString(),
          },
        },
      }),
    };

    await (adapter as any).handleMessageEvent(event);

    expect(messages).toHaveLength(1);
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

  it('splits long replies into multiple posts', () => {
    const text = Array.from({ length: 120 }, () => 'word').join(' ');
    const chunks = splitPostText(text);
    expect(chunks.length).toBeGreaterThan(1);
    const segmenter = new Intl.Segmenter();
    const graphemeCount = (s: string) => [...segmenter.segment(s)].length;
    expect(chunks.every(chunk => graphemeCount(chunk) <= 300)).toBe(true);
    const total = chunks.reduce((sum, chunk) => sum + graphemeCount(chunk), 0);
    expect(total).toBeGreaterThan(300);
  });

  it('non-post Jetstream events are dropped without calling onMessage', async () => {
    const adapter = makeAdapter({ wantedDids: ['did:plc:author'] });
    const messages: any[] = [];
    adapter.onMessage = async (msg) => { messages.push(msg); };

    const likeEvent = {
      data: JSON.stringify({
        did: 'did:plc:author',
        time_us: Date.now() * 1000,
        commit: {
          operation: 'create',
          collection: 'app.bsky.feed.like',
          rkey: 'aaa',
          cid: 'cid-like',
          record: {
            $type: 'app.bsky.feed.like',
            subject: { uri: 'at://did:plc:other/app.bsky.feed.post/xyz', cid: 'cid-post' },
            createdAt: new Date().toISOString(),
          },
        },
      }),
    };

    await (adapter as any).handleMessageEvent(likeEvent);
    expect(messages).toHaveLength(0);
  });

  it('embedLines are included in extraContext for posts with images', async () => {
    const adapter = makeAdapter({ wantedDids: ['did:plc:author'] });
    const messages: any[] = [];
    adapter.onMessage = async (msg) => { messages.push(msg); };

    const eventWithEmbed = {
      data: JSON.stringify({
        did: 'did:plc:author',
        time_us: Date.now() * 1000,
        commit: {
          operation: 'create',
          collection: 'app.bsky.feed.post',
          rkey: 'bbb',
          cid: 'cid-embed',
          record: {
            $type: 'app.bsky.feed.post',
            text: 'Check this out',
            createdAt: new Date().toISOString(),
            embed: {
              $type: 'app.bsky.embed.images',
              images: [{ alt: 'A cat photo' }],
            },
          },
        },
      }),
    };

    await (adapter as any).handleMessageEvent(eventWithEmbed);
    expect(messages).toHaveLength(1);
    expect(messages[0].extraContext?.['Embeds']).toContain('1 image');
  });

  it('sendMessage throws when kill switch is active', async () => {
    const adapter = makeAdapter();
    (adapter as any).runtimeDisabled = true;

    await expect(adapter.sendMessage({ chatId: 'some-chat', text: 'hello' }))
      .rejects.toThrow('kill switch');
  });

  it('reloadConfig preserves handle and appPassword when new config omits them', async () => {
    const { loadConfig } = await import('../config/io.js');
    vi.mocked(loadConfig).mockReturnValue({
      channels: {
        bluesky: {
          enabled: true,
          groups: { '*': { mode: 'open' } },
          // handle and appPassword intentionally absent (set via env vars)
        },
      },
    } as any);

    const adapter = makeAdapter({ handle: 'env@bsky.social', appPassword: 'env-pass' });
    (adapter as any).reloadConfig();

    expect((adapter as any).config.handle).toBe('env@bsky.social');
    expect((adapter as any).config.appPassword).toBe('env-pass');
    expect((adapter as any).config.groups?.['*']?.mode).toBe('open');
  });
});

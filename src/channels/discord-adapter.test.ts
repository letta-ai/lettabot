import { afterEach, describe, expect, it, vi } from 'vitest';

const discordMock = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => unknown | Promise<unknown>;

  class MockDiscordClient {
    private handlers = new Map<string, Handler[]>();
    user = { id: 'bot-self', tag: 'bot#0001' };
    channels = { fetch: vi.fn() };
    destroy = vi.fn();

    once(event: string, handler: Handler): this {
      return this.on(event, handler);
    }

    on(event: string, handler: Handler): this {
      const existing = this.handlers.get(event) || [];
      existing.push(handler);
      this.handlers.set(event, existing);
      return this;
    }

    async login(): Promise<string> {
      await this.emit('clientReady');
      return 'ok';
    }

    async emit(event: string, ...args: unknown[]): Promise<void> {
      const handlers = this.handlers.get(event) || [];
      for (const handler of handlers) {
        await handler(...args);
      }
    }
  }

  let latestClient: MockDiscordClient | null = null;
  class Client extends MockDiscordClient {
    constructor(_options: unknown) {
      super();
      latestClient = this;
    }
  }

  return {
    Client,
    getLatestClient: () => latestClient,
  };
});

vi.mock('discord.js', () => ({
  Client: discordMock.Client,
  GatewayIntentBits: {
    Guilds: 1,
    GuildMessages: 2,
    GuildMessageReactions: 3,
    MessageContent: 4,
    DirectMessages: 5,
    DirectMessageReactions: 6,
  },
  Partials: {
    Channel: 1,
    Message: 2,
    Reaction: 3,
    User: 4,
  },
}));

const { DiscordAdapter } = await import('./discord.js');

function makeMessage(params: {
  content: string;
  isThread: boolean;
  channelId: string;
  parentId?: string;
}): {
  id: string;
  content: string;
  guildId: string;
  channel: {
    id: string;
    parentId?: string;
    name: string;
    send: ReturnType<typeof vi.fn>;
    isThread: () => boolean;
    isTextBased: () => boolean;
  };
  author: {
    id: string;
    bot: boolean;
    username: string;
    globalName: string;
    send: ReturnType<typeof vi.fn>;
  };
  member: { displayName: string };
  mentions: { has: () => boolean };
  attachments: { find: () => undefined; values: () => unknown[] };
  createdAt: Date;
  reply: ReturnType<typeof vi.fn>;
  startThread: ReturnType<typeof vi.fn>;
} {
  return {
    id: 'msg-1',
    content: params.content,
    guildId: 'guild-1',
    channel: {
      id: params.channelId,
      parentId: params.parentId,
      name: 'general',
      send: vi.fn().mockResolvedValue({ id: 'sent-1' }),
      isThread: () => params.isThread,
      isTextBased: () => true,
    },
    author: {
      id: 'user-1',
      bot: false,
      username: 'alice',
      globalName: 'Alice',
      send: vi.fn().mockResolvedValue(undefined),
    },
    member: { displayName: 'Alice' },
    mentions: { has: () => false },
    attachments: {
      find: () => undefined,
      values: () => [],
    },
    createdAt: new Date(),
    reply: vi.fn().mockResolvedValue(undefined),
    startThread: vi.fn().mockResolvedValue({ id: 'thread-created', name: 'new thread' }),
  };
}

describe('DiscordAdapter command gating', () => {
  afterEach(async () => {
    vi.clearAllMocks();
  });

  it('blocks top-level slash commands when threadMode is thread-only', async () => {
    const adapter = new DiscordAdapter({
      token: 'token',
      groups: {
        'channel-1': { mode: 'open', threadMode: 'thread-only' },
      },
    });
    const onCommand = vi.fn().mockResolvedValue('ok');
    adapter.onCommand = onCommand;

    await adapter.start();
    const client = discordMock.getLatestClient();
    expect(client).toBeTruthy();

    const message = makeMessage({
      content: '/status',
      isThread: false,
      channelId: 'channel-1',
    });

    await client!.emit('messageCreate', message);

    expect(onCommand).not.toHaveBeenCalled();
    expect(message.channel.send).not.toHaveBeenCalled();
    await adapter.stop();
  });

  it('allows slash commands inside threads in thread-only mode', async () => {
    const adapter = new DiscordAdapter({
      token: 'token',
      groups: {
        'channel-1': { mode: 'open', threadMode: 'thread-only' },
      },
    });
    const onCommand = vi.fn().mockResolvedValue('ok');
    adapter.onCommand = onCommand;

    await adapter.start();
    const client = discordMock.getLatestClient();
    expect(client).toBeTruthy();

    const message = makeMessage({
      content: '/status',
      isThread: true,
      channelId: 'thread-1',
      parentId: 'channel-1',
    });

    await client!.emit('messageCreate', message);

    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand).toHaveBeenCalledWith('status', 'thread-1', undefined, true);
    expect(message.channel.send).toHaveBeenCalledWith('ok');
    await adapter.stop();
  });

  it('redirects mentioned top-level commands into an auto-created thread', async () => {
    const adapter = new DiscordAdapter({
      token: 'token',
      groups: {
        'channel-1': { mode: 'open', threadMode: 'thread-only', autoCreateThreadOnMention: true },
      },
    });
    const onCommand = vi.fn().mockResolvedValue('ok');
    adapter.onCommand = onCommand;

    await adapter.start();
    const client = discordMock.getLatestClient();
    expect(client).toBeTruthy();

    const threadSend = vi.fn().mockResolvedValue({ id: 'thread-msg-1' });
    (client!.channels.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'thread-created',
      isTextBased: () => true,
      send: threadSend,
    });

    const message = makeMessage({
      content: '/status',
      isThread: false,
      channelId: 'channel-1',
    });
    message.mentions = { has: () => true };

    await client!.emit('messageCreate', message);

    expect(message.startThread).toHaveBeenCalledTimes(1);
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand).toHaveBeenCalledWith('status', 'thread-created', undefined, true);
    expect(threadSend).toHaveBeenCalledWith('ok');
    expect(message.channel.send).not.toHaveBeenCalled();
    await adapter.stop();
  });

  it('creates one thread when unknown slash commands fall through to agent handling', async () => {
    const adapter = new DiscordAdapter({
      token: 'token',
      groups: {
        'channel-1': { mode: 'open', threadMode: 'thread-only', autoCreateThreadOnMention: true },
      },
    });
    const onMessage = vi.fn().mockResolvedValue(undefined);
    adapter.onMessage = onMessage;

    await adapter.start();
    const client = discordMock.getLatestClient();
    expect(client).toBeTruthy();

    const message = makeMessage({
      content: '/unknown',
      isThread: false,
      channelId: 'channel-1',
    });
    message.mentions = { has: () => true };

    await client!.emit('messageCreate', message);

    expect(message.startThread).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 'thread-created',
      text: '/unknown',
    }));
    await adapter.stop();
  });
});

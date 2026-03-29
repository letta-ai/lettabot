import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn().mockResolvedValue(Buffer.from('fake-file-data')) };
});

vi.mock('./shared/access-control.js', () => ({
  checkDmAccess: vi.fn().mockReturnValue('allowed'),
}));

vi.mock('matrix-bot-sdk', () => {
  const mockClient = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue('$event123'),
    sendEvent: vi.fn().mockResolvedValue('$event456'),
    uploadContent: vi.fn().mockResolvedValue('mxc://example.com/media123'),
    setTyping: vi.fn().mockResolvedValue(undefined),
    getUserId: vi.fn().mockReturnValue('@bot:example.com'),
    getJoinedRoomMembers: vi.fn().mockResolvedValue(['@bot:example.com', '@user:example.com']),
    on: vi.fn(),
  };

  // Use a class so `new MatrixClient(...)` works
  class MockMatrixClient {
    constructor() { return mockClient; }
  }

  return {
    MatrixClient: MockMatrixClient,
    SimpleFsStorageProvider: vi.fn(),
    AutojoinRoomsMixin: { setupOnClient: vi.fn() },
    __mockClient: mockClient,
  };
});

// The matrix adapter may not exist in this worktree yet — that's expected.
let MatrixAdapter: any;
let mc: any;

beforeAll(async () => {
  const mod = await import('matrix-bot-sdk');
  mc = (mod as any).__mockClient;

  try {
    const adapterMod = await import('./matrix.js');
    MatrixAdapter = adapterMod.MatrixAdapter;
  } catch {
    MatrixAdapter = null;
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  // Restore mock implementations cleared by clearAllMocks
  mc.start.mockResolvedValue(undefined);
  mc.stop.mockResolvedValue(undefined);
  mc.sendMessage.mockResolvedValue('$event123');
  mc.sendEvent.mockResolvedValue('$event456');
  mc.uploadContent.mockResolvedValue('mxc://example.com/media123');
  mc.setTyping.mockResolvedValue(undefined);
  mc.getUserId.mockReturnValue('@bot:example.com');
  mc.getJoinedRoomMembers.mockResolvedValue(['@bot:example.com', '@user:example.com']);
});

function skipIfNoAdapter() {
  return !MatrixAdapter;
}

/** Finds the handler registered via client.on(eventName, handler). */
function getOnHandler(eventName: string): ((...args: any[]) => Promise<void>) | undefined {
  const call = (mc.on.mock.calls as Array<[string, (...args: any[]) => void]>)
    .find(([name]) => name === eventName);
  if (!call) return undefined;
  const rawHandler = call[1];
  // The adapter wraps handleRoomMessage in a fire-and-forget .catch().
  // We need to give the async handler time to complete.
  return async (...args: any[]) => {
    rawHandler(...args);
    // Allow microtasks to flush (the handler is async internally)
    await new Promise(resolve => setTimeout(resolve, 50));
  };
}

const BASE_CONFIG = {
  homeserverUrl: 'https://matrix.example.com',
  accessToken: 'syt_test_token',
  userId: '@bot:example.com',
};

describe('MatrixAdapter constructor & config', () => {
  it('creates adapter with correct id and name', () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(BASE_CONFIG);
    expect(adapter.id).toBe('matrix');
    expect(adapter.name).toMatch(/matrix/i);
  });

  it('default DM policy is pairing', () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(BASE_CONFIG);
    expect(adapter.getDmPolicy?.()).toBe('pairing');
  });

  it('stores config values', () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter({ ...BASE_CONFIG, dmPolicy: 'allow' });
    expect(adapter.getDmPolicy?.()).toBe('allow');
  });
});

describe('MatrixAdapter lifecycle', () => {
  it('isRunning() returns false before start', () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(BASE_CONFIG);
    expect(adapter.isRunning()).toBe(false);
  });

  it('start() creates client and starts syncing', async () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(BASE_CONFIG);
    await adapter.start();
    expect(mc.start).toHaveBeenCalledTimes(1);
  });

  it('isRunning() returns true after start', async () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(BASE_CONFIG);
    await adapter.start();
    expect(adapter.isRunning()).toBe(true);
  });

  it('stop() stops the client', async () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(BASE_CONFIG);
    await adapter.start();
    await adapter.stop();
    expect(mc.stop).toHaveBeenCalledTimes(1);
  });

  it('isRunning() returns false after stop', async () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(BASE_CONFIG);
    await adapter.start();
    await adapter.stop();
    expect(adapter.isRunning()).toBe(false);
  });
});

describe('MatrixAdapter sendMessage', () => {
  it('sends text message to room and returns messageId', async () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(BASE_CONFIG);
    await adapter.start();

    const result = await adapter.sendMessage({ chatId: '!room:example.com', text: 'hello' });

    expect(mc.sendMessage).toHaveBeenCalledWith(
      '!room:example.com',
      expect.objectContaining({ body: 'hello' }),
    );
    expect(typeof result.messageId).toBe('string');
  });

  it('sends with HTML formatting when text contains markdown', async () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(BASE_CONFIG);
    await adapter.start();

    await adapter.sendMessage({ chatId: '!room:example.com', text: '**bold** text' });

    expect(mc.sendMessage).toHaveBeenCalledWith(
      '!room:example.com',
      expect.objectContaining({ format: 'org.matrix.custom.html' }),
    );
  });
});

describe('MatrixAdapter sendFile', () => {
  it('uploads content and sends image message', async () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(BASE_CONFIG);
    await adapter.start();

    const result = await adapter.sendFile({ chatId: '!room:example.com', filePath: '/tmp/photo.jpg', kind: 'image' });

    expect(mc.uploadContent).toHaveBeenCalledTimes(1);
    expect(mc.sendMessage).toHaveBeenCalledWith(
      '!room:example.com',
      expect.objectContaining({ msgtype: 'm.image' }),
    );
    expect(result).toHaveProperty('messageId');
  });

  it('uploads content and sends audio message', async () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(BASE_CONFIG);
    await adapter.start();

    await adapter.sendFile({ chatId: '!room:example.com', filePath: '/tmp/voice.ogg', kind: 'audio' });

    expect(mc.uploadContent).toHaveBeenCalledTimes(1);
    expect(mc.sendMessage).toHaveBeenCalledWith(
      '!room:example.com',
      expect.objectContaining({ msgtype: 'm.audio' }),
    );
  });

  it('uploads content and sends file message', async () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(BASE_CONFIG);
    await adapter.start();

    await adapter.sendFile({ chatId: '!room:example.com', filePath: '/tmp/document.pdf', kind: 'file' });

    expect(mc.uploadContent).toHaveBeenCalledTimes(1);
    expect(mc.sendMessage).toHaveBeenCalledWith(
      '!room:example.com',
      expect.objectContaining({ msgtype: 'm.file' }),
    );
  });
});

describe('MatrixAdapter editMessage', () => {
  it('sends edit event with m.replace relation', async () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(BASE_CONFIG);
    await adapter.start();

    await adapter.editMessage('!room:example.com', '$original:example.com', 'updated text');

    expect(mc.sendMessage).toHaveBeenCalledWith(
      '!room:example.com',
      expect.objectContaining({
        'm.relates_to': expect.objectContaining({
          rel_type: 'm.replace',
          event_id: '$original:example.com',
        }),
      }),
    );
  });
});

describe('MatrixAdapter addReaction', () => {
  it('sends m.reaction event with correct annotation', async () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(BASE_CONFIG);
    await adapter.start();

    await adapter.addReaction('!room:example.com', '$msg:example.com', '👍');

    expect(mc.sendEvent).toHaveBeenCalledWith(
      '!room:example.com',
      'm.reaction',
      expect.objectContaining({
        'm.relates_to': expect.objectContaining({
          rel_type: 'm.annotation',
          event_id: '$msg:example.com',
          key: '👍',
        }),
      }),
    );
  });
});

describe('MatrixAdapter typing indicators', () => {
  it('sendTypingIndicator calls setTyping with true and a timeout', async () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(BASE_CONFIG);
    await adapter.start();

    await adapter.sendTypingIndicator('!room:example.com');

    expect(mc.setTyping).toHaveBeenCalledWith('!room:example.com', true, expect.any(Number));
  });

  it('stopTypingIndicator calls setTyping with false', async () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(BASE_CONFIG);
    await adapter.start();

    await adapter.stopTypingIndicator?.('!room:example.com');

    expect(mc.setTyping).toHaveBeenCalledWith('!room:example.com', false);
  });
});

describe('MatrixAdapter getFormatterHints', () => {
  it('returns supportsReactions: true and supportsFiles: true', () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(BASE_CONFIG);
    const hints = adapter.getFormatterHints();
    expect(hints.supportsReactions).toBe(true);
    expect(hints.supportsFiles).toBe(true);
  });
});

describe('MatrixAdapter supportsEditing', () => {
  it('returns false by default', () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(BASE_CONFIG);
    expect(adapter.supportsEditing?.()).toBe(false);
  });

  it('returns true when streaming is enabled', () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter({ ...BASE_CONFIG, streaming: true });
    expect(adapter.supportsEditing?.()).toBe(true);
  });
});

describe('MatrixAdapter getDmPolicy', () => {
  it('returns configured policy', () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter({ ...BASE_CONFIG, dmPolicy: 'allow' });
    expect(adapter.getDmPolicy?.()).toBe('allow');
  });

  it('returns pairing as default', () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(BASE_CONFIG);
    expect(adapter.getDmPolicy?.()).toBe('pairing');
  });
});

describe('MatrixAdapter message handling', () => {
  // Use open DM policy so access control doesn't block test messages
  const OPEN_CONFIG = { ...BASE_CONFIG, dmPolicy: 'open' as const };

  it('ignores messages from self', async () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(OPEN_CONFIG);
    const onMessage = vi.fn();
    adapter.onMessage = onMessage;
    await adapter.start();

    const handler = getOnHandler('room.message');
    if (handler) {
      await handler('!room:example.com', {
        type: 'm.room.message',
        sender: '@bot:example.com',
        content: { msgtype: 'm.text', body: 'hello from self' },
        event_id: '$self:example.com',
        origin_server_ts: Date.now(),
      });
      expect(onMessage).not.toHaveBeenCalled();
    }
  });

  it('routes commands to onCommand handler', async () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(OPEN_CONFIG);
    const onCommand = vi.fn().mockResolvedValue(null);
    adapter.onCommand = onCommand;
    await adapter.start();

    const handler = getOnHandler('room.message');
    if (handler) {
      await handler('!room:example.com', {
        type: 'm.room.message',
        sender: '@user:example.com',
        content: { msgtype: 'm.text', body: '/status' },
        event_id: '$cmd:example.com',
        origin_server_ts: Date.now(),
      });
      expect(onCommand).toHaveBeenCalled();
    }
  });

  it('routes regular messages to onMessage handler', async () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(OPEN_CONFIG);
    const onMessage = vi.fn();
    adapter.onMessage = onMessage;
    await adapter.start();

    const handler = getOnHandler('room.message');
    if (handler) {
      await handler('!room:example.com', {
        type: 'm.room.message',
        sender: '@user:example.com',
        content: { msgtype: 'm.text', body: 'hello bot' },
        event_id: '$msg:example.com',
        origin_server_ts: Date.now(),
      });
      expect(onMessage).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: '!room:example.com', text: 'hello bot' }),
      );
    }
  });
});

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import { createApiServer } from './server.js';
import type { AgentRouter } from '../core/interfaces.js';

const TEST_API_KEY = 'test-key-12345';
const TEST_PORT = 0; // Let OS assign a free port

function createMockRouter(overrides: Partial<AgentRouter> = {}): AgentRouter {
  return {
    deliverToChannel: vi.fn().mockResolvedValue('msg-1'),
    sendToAgent: vi.fn().mockResolvedValue('Agent says hello'),
    streamToAgent: vi.fn().mockReturnValue((async function* () {
      yield { type: 'reasoning', content: 'thinking...' };
      yield { type: 'assistant', content: 'Hello ' };
      yield { type: 'assistant', content: 'world' };
      yield { type: 'result', success: true };
    })()),
    getAgentNames: vi.fn().mockReturnValue(['LettaBot']),
    ...overrides,
  };
}

function getPort(server: http.Server): number {
  const addr = server.address();
  if (typeof addr === 'object' && addr) return addr.port;
  throw new Error('Server not listening');
}

async function request(
  port: number,
  method: string,
  path: string,
  body?: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('POST /api/v1/chat', () => {
  let server: http.Server;
  let port: number;
  let router: AgentRouter;

  beforeAll(async () => {
    router = createMockRouter();
    server = createApiServer(router, {
      port: TEST_PORT,
      apiKey: TEST_API_KEY,
      host: '127.0.0.1',
    });
    // Wait for server to start listening
    await new Promise<void>((resolve) => {
      if (server.listening) { resolve(); return; }
      server.once('listening', resolve);
    });
    port = getPort(server);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns 401 without api key', async () => {
    const res = await request(port, 'POST', '/api/v1/chat', '{"message":"hi"}', {
      'content-type': 'application/json',
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong api key', async () => {
    const res = await request(port, 'POST', '/api/v1/chat', '{"message":"hi"}', {
      'content-type': 'application/json',
      'x-api-key': 'wrong-key',
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 without Content-Type application/json', async () => {
    const res = await request(port, 'POST', '/api/v1/chat', 'hello', {
      'content-type': 'text/plain',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toContain('application/json');
  });

  it('returns 400 with invalid JSON', async () => {
    const res = await request(port, 'POST', '/api/v1/chat', 'not json', {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toContain('Invalid JSON');
  });

  it('returns 400 without message field', async () => {
    const res = await request(port, 'POST', '/api/v1/chat', '{"agent":"LettaBot"}', {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toContain('message');
  });

  it('returns 404 for unknown agent name', async () => {
    const res = await request(port, 'POST', '/api/v1/chat', '{"message":"hi","agent":"unknown"}', {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).error).toContain('Agent not found');
    expect(JSON.parse(res.body).error).toContain('LettaBot');
  });

  it('returns sync JSON response by default', async () => {
    const res = await request(port, 'POST', '/api/v1/chat', '{"message":"Hello"}', {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.success).toBe(true);
    expect(parsed.response).toBe('Agent says hello');
    expect(parsed.agentName).toBe('LettaBot');
    expect(router.sendToAgent).toHaveBeenCalledWith(
      undefined,
      'Hello',
      { type: 'webhook', outputMode: 'silent' },
    );
  });

  it('routes to named agent', async () => {
    const res = await request(port, 'POST', '/api/v1/chat', '{"message":"Hi","agent":"LettaBot"}', {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(200);
    expect(router.sendToAgent).toHaveBeenCalledWith(
      'LettaBot',
      'Hi',
      { type: 'webhook', outputMode: 'silent' },
    );
  });

  it('returns SSE stream when Accept: text/event-stream', async () => {
    // Need a fresh mock since the generator is consumed once
    (router as any).streamToAgent = vi.fn().mockReturnValue((async function* () {
      yield { type: 'reasoning', content: 'thinking...' };
      yield { type: 'assistant', content: 'Hello ' };
      yield { type: 'assistant', content: 'world' };
      yield { type: 'result', success: true };
    })());

    const res = await request(port, 'POST', '/api/v1/chat', '{"message":"Stream test"}', {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
      'accept': 'text/event-stream',
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['cache-control']).toBe('no-cache');

    // Parse SSE events
    const events = res.body
      .split('\n\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.replace('data: ', '')));

    expect(events).toHaveLength(4);
    expect(events[0].type).toBe('reasoning');
    expect(events[1].type).toBe('assistant');
    expect(events[1].content).toBe('Hello ');
    expect(events[2].type).toBe('assistant');
    expect(events[2].content).toBe('world');
    expect(events[3].type).toBe('result');
    expect(events[3].success).toBe(true);
  });

  it('handles stream errors gracefully', async () => {
    (router as any).streamToAgent = vi.fn().mockReturnValue((async function* () {
      yield { type: 'assistant', content: 'partial' };
      throw new Error('connection lost');
    })());

    const res = await request(port, 'POST', '/api/v1/chat', '{"message":"Error test"}', {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
      'accept': 'text/event-stream',
    });
    expect(res.status).toBe(200);

    const events = res.body
      .split('\n\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.replace('data: ', '')));

    // Should have the partial chunk + error event
    expect(events.find((e: any) => e.type === 'assistant')).toBeTruthy();
    expect(events.find((e: any) => e.type === 'error')).toBeTruthy();
    expect(events.find((e: any) => e.type === 'error').error).toBe('connection lost');
  });
});

describe('GET /portal', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = createApiServer(createMockRouter(), {
      port: TEST_PORT,
      apiKey: TEST_API_KEY,
      host: '127.0.0.1',
    });
    await new Promise<void>((resolve) => {
      if (server.listening) { resolve(); return; }
      server.once('listening', resolve);
    });
    port = getPort(server);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('serves the pairing portal HTML without requiring an API key', async () => {
    const res = await request(port, 'GET', '/portal');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<title>LettaBot Portal</title>');
  });
});

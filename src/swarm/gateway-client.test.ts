/**
 * GatewayClient Tests
 *
 * Mirrors hub-client.test.ts: mock fetch, verify JSON-RPC targets
 * thoughtbox_gateway, test session ID persistence, test each method.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GatewayClient } from './gateway-client.js';

function mockFetch(responseBody: unknown, headers?: Record<string, string>) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Map(Object.entries(headers || {})),
    json: async () => ({
      jsonrpc: '2.0',
      result: {
        content: [{ type: 'text', text: JSON.stringify(responseBody) }],
      },
      id: 1,
    }),
  });
}

describe('GatewayClient', () => {
  let client: GatewayClient;
  let fetchMock: ReturnType<typeof mockFetch>;

  beforeEach(() => {
    fetchMock = mockFetch({});
    client = new GatewayClient('http://localhost:1731/mcp', fetchMock as unknown as typeof fetch);
  });

  it('startNew() sends JSON-RPC tools/call with operation=start_new targeting thoughtbox_gateway', async () => {
    fetchMock = mockFetch({ sessionId: 'sess-123' });
    client = new GatewayClient('http://localhost:1731/mcp', fetchMock as unknown as typeof fetch);

    const result = await client.startNew('test-session', ['tag1']);
    expect(result.sessionId).toBe('sess-123');

    // Check second call (first is initialize handshake)
    const call = fetchMock.mock.calls[1];
    const body = JSON.parse(call[1].body);
    expect(body.method).toBe('tools/call');
    expect(body.params.name).toBe('thoughtbox_gateway');
    expect(body.params.arguments.operation).toBe('start_new');
    expect(body.params.arguments.args.title).toBe('test-session');
    expect(body.params.arguments.args.tags).toEqual(['tag1']);
  });

  it('loadContext() sends operation=load_context with sessionId', async () => {
    fetchMock = mockFetch({ sessionId: 'sess-456' });
    client = new GatewayClient('http://localhost:1731/mcp', fetchMock as unknown as typeof fetch);

    const result = await client.loadContext('sess-456');
    expect(result.sessionId).toBe('sess-456');

    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.params.arguments.operation).toBe('load_context');
    expect(body.params.arguments.args.sessionId).toBe('sess-456');
  });

  it('cipher() sends operation=cipher, returns stage', async () => {
    fetchMock = mockFetch({ stage: 2 });
    client = new GatewayClient('http://localhost:1731/mcp', fetchMock as unknown as typeof fetch);

    const result = await client.cipher();
    expect(result.stage).toBe(2);

    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.params.arguments.operation).toBe('cipher');
  });

  it('thought() sends operation=thought with input fields', async () => {
    fetchMock = mockFetch({ thoughtNumber: 1, branchId: 'main', sessionId: 'sess-1' });
    client = new GatewayClient('http://localhost:1731/mcp', fetchMock as unknown as typeof fetch);

    const result = await client.thought({
      thought: 'test reasoning',
      branchId: 'telegram-coding',
      agentId: 'agent-1',
    });
    expect(result.thoughtNumber).toBe(1);
    expect(result.branchId).toBe('main');

    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.params.arguments.operation).toBe('thought');
    expect(body.params.arguments.args.thought).toBe('test reasoning');
    expect(body.params.arguments.args.branchId).toBe('telegram-coding');
  });

  it('readThoughts() sends operation=session with read sub-operation', async () => {
    const thoughts = [
      { thoughtNumber: 1, thought: 'hello', thoughtType: 'reasoning', branchId: 'main' },
    ];
    fetchMock = mockFetch(thoughts);
    client = new GatewayClient('http://localhost:1731/mcp', fetchMock as unknown as typeof fetch);

    const result = await client.readThoughts({ branchId: 'main', last: 5 });
    expect(result).toEqual(thoughts);

    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.params.arguments.operation).toBe('session');
    expect(body.params.arguments.args.operation).toBe('read');
    expect(body.params.arguments.args.branchId).toBe('main');
  });

  it('readThoughts() handles { thoughts: [...] } response shape', async () => {
    fetchMock = mockFetch({
      thoughts: [
        { thoughtNumber: 1, thought: 'test', thoughtType: 'reasoning', branchId: 'main' },
      ],
    });
    client = new GatewayClient('http://localhost:1731/mcp', fetchMock as unknown as typeof fetch);

    const result = await client.readThoughts({ last: 3 });
    expect(result).toHaveLength(1);
    expect(result[0].thought).toBe('test');
  });

  it('getStructure() sends operation=session with structure sub-operation', async () => {
    fetchMock = mockFetch({
      sessionId: 'sess-1',
      branches: [{ branchId: 'main', thoughtCount: 5 }],
      totalThoughts: 5,
    });
    client = new GatewayClient('http://localhost:1731/mcp', fetchMock as unknown as typeof fetch);

    const result = await client.getStructure();
    expect(result.totalThoughts).toBe(5);

    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.params.arguments.operation).toBe('session');
    expect(body.params.arguments.args.operation).toBe('structure');
  });

  it('session ID from first response header is persisted in subsequent requests', async () => {
    const sessionId = 'session-gateway-789';
    fetchMock = mockFetch(
      { sessionId: 'sess-1' },
      { 'mcp-session-id': sessionId },
    );
    client = new GatewayClient('http://localhost:1731/mcp', fetchMock as unknown as typeof fetch);

    await client.startNew('test');

    // Second call should include the session ID
    fetchMock = mockFetch({ stage: 2 });
    (client as any).fetchFn = fetchMock;

    await client.cipher();

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['mcp-session-id']).toBe(sessionId);
  });

  it('throws on RPC error', async () => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => ({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Invalid request' },
        id: 1,
      }),
    });
    client = new GatewayClient('http://localhost:1731/mcp', fetchMock as unknown as typeof fetch);

    await expect(client.startNew('test')).rejects.toThrow('Gateway RPC error');
  });
});

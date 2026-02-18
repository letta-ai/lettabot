import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import { createApiServer } from './server.js';
import type { AgentRouter } from '../core/interfaces.js';
import {
  generateCompletionId,
  extractLastUserMessage,
  buildCompletion,
  buildChunk,
  buildToolCallChunk,
  formatSSE,
  SSE_DONE,
  buildErrorResponse,
  buildModelList,
  validateChatRequest,
} from './openai-compat.js';
import type { OpenAIChatMessage } from './openai-compat.js';

const TEST_API_KEY = 'test-key-12345';
const TEST_PORT = 0;

function createMockRouter(overrides: Partial<AgentRouter> = {}): AgentRouter {
  return {
    deliverToChannel: vi.fn().mockResolvedValue('msg-1'),
    sendToAgent: vi.fn().mockResolvedValue('Agent says hello'),
    streamToAgent: vi.fn().mockReturnValue(
      (async function* () {
        yield { type: 'reasoning', content: 'thinking...' };
        yield { type: 'assistant', content: 'Hello ' };
        yield { type: 'assistant', content: 'world' };
        yield { type: 'result', success: true };
      })(),
    ),
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
    const req = http.request(
      { hostname: '127.0.0.1', port, method, path, headers },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode!, headers: res.headers, body: data }),
        );
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ============================================================================
// UNIT TESTS FOR UTILITY FUNCTIONS
// ============================================================================

describe('openai-compat utilities', () => {
  describe('generateCompletionId', () => {
    it('returns a string starting with chatcmpl-', () => {
      const id = generateCompletionId();
      expect(id).toMatch(/^chatcmpl-/);
    });

    it('returns unique IDs', () => {
      const id1 = generateCompletionId();
      const id2 = generateCompletionId();
      expect(id1).not.toBe(id2);
    });

    it('returns IDs with reasonable length', () => {
      const id = generateCompletionId();
      expect(id.length).toBeGreaterThan(10);
    });
  });

  describe('extractLastUserMessage', () => {
    it('returns the last user message content', () => {
      const messages: OpenAIChatMessage[] = [
        { role: 'user', content: 'First message' },
        { role: 'assistant', content: 'Response' },
        { role: 'user', content: 'Last message' },
      ];
      expect(extractLastUserMessage(messages)).toBe('Last message');
    });

    it('returns null when no user messages', () => {
      const messages: OpenAIChatMessage[] = [
        { role: 'system', content: 'System prompt' },
        { role: 'assistant', content: 'Hello' },
      ];
      expect(extractLastUserMessage(messages)).toBeNull();
    });

    it('skips system and assistant messages', () => {
      const messages: OpenAIChatMessage[] = [
        { role: 'system', content: 'System' },
        { role: 'assistant', content: 'Assistant' },
        { role: 'user', content: 'User message' },
        { role: 'assistant', content: 'Another assistant' },
      ];
      expect(extractLastUserMessage(messages)).toBe('User message');
    });

    it('returns null for empty array', () => {
      expect(extractLastUserMessage([])).toBeNull();
    });

    it('handles only one user message', () => {
      const messages: OpenAIChatMessage[] = [{ role: 'user', content: 'Only message' }];
      expect(extractLastUserMessage(messages)).toBe('Only message');
    });
  });

  describe('buildCompletion', () => {
    it('builds a valid completion response', () => {
      const result = buildCompletion('chatcmpl-1', 'LettaBot', 'Hello!');
      expect(result.object).toBe('chat.completion');
      expect(result.id).toBe('chatcmpl-1');
      expect(result.model).toBe('LettaBot');
      expect(result.choices).toHaveLength(1);
      expect(result.choices[0].index).toBe(0);
      expect(result.choices[0].message.role).toBe('assistant');
      expect(result.choices[0].message.content).toBe('Hello!');
      expect(result.choices[0].finish_reason).toBe('stop');
      expect(result.usage).toBeNull();
      expect(result.created).toBeGreaterThan(0);
    });

    it('respects custom finish_reason', () => {
      const result = buildCompletion('chatcmpl-2', 'bot', 'text', 'tool_calls');
      expect(result.choices[0].finish_reason).toBe('tool_calls');
    });

    it('sets created timestamp', () => {
      const before = Math.floor(Date.now() / 1000);
      const result = buildCompletion('chatcmpl-3', 'bot', 'text');
      const after = Math.floor(Date.now() / 1000);
      expect(result.created).toBeGreaterThanOrEqual(before);
      expect(result.created).toBeLessThanOrEqual(after);
    });
  });

  describe('buildChunk', () => {
    it('builds a valid streaming chunk', () => {
      const chunk = buildChunk('chatcmpl-1', 'LettaBot', { content: 'Hello' });
      expect(chunk.object).toBe('chat.completion.chunk');
      expect(chunk.id).toBe('chatcmpl-1');
      expect(chunk.model).toBe('LettaBot');
      expect(chunk.choices).toHaveLength(1);
      expect(chunk.choices[0].index).toBe(0);
      expect(chunk.choices[0].delta).toEqual({ content: 'Hello' });
      expect(chunk.choices[0].finish_reason).toBeNull();
      expect(chunk.created).toBeGreaterThan(0);
    });

    it('includes finish_reason when provided', () => {
      const chunk = buildChunk('chatcmpl-2', 'bot', { content: 'Done' }, 'stop');
      expect(chunk.choices[0].finish_reason).toBe('stop');
    });

    it('handles role delta', () => {
      const chunk = buildChunk('chatcmpl-3', 'bot', { role: 'assistant' });
      expect(chunk.choices[0].delta).toEqual({ role: 'assistant' });
    });
  });

  describe('buildToolCallChunk', () => {
    it('builds a tool call chunk with correct structure', () => {
      const chunk = buildToolCallChunk(
        'chatcmpl-1',
        'LettaBot',
        0,
        'call_123',
        'web_search',
        '{"query":"test"}',
      );
      expect(chunk.object).toBe('chat.completion.chunk');
      expect(chunk.choices[0].delta.tool_calls).toHaveLength(1);
      expect(chunk.choices[0].delta.tool_calls![0]).toEqual({
        index: 0,
        id: 'call_123',
        type: 'function',
        function: {
          name: 'web_search',
          arguments: '{"query":"test"}',
        },
      });
    });

    it('handles different tool indices', () => {
      const chunk = buildToolCallChunk(
        'chatcmpl-2',
        'bot',
        2,
        'call_456',
        'calculator',
        '{}',
      );
      expect(chunk.choices[0].delta.tool_calls![0].index).toBe(2);
    });
  });

  describe('formatSSE', () => {
    it('formats data as SSE line', () => {
      expect(formatSSE({ test: 1 })).toBe('data: {"test":1}\n\n');
    });

    it('handles complex objects', () => {
      const data = { nested: { value: 'test' }, array: [1, 2, 3] };
      const result = formatSSE(data);
      expect(result).toMatch(/^data: /);
      expect(result).toMatch(/\n\n$/);
      expect(JSON.parse(result.replace('data: ', '').trim())).toEqual(data);
    });

    it('SSE_DONE constant is correct', () => {
      expect(SSE_DONE).toBe('data: [DONE]\n\n');
    });
  });

  describe('buildErrorResponse', () => {
    it('builds error with default values', () => {
      const result = buildErrorResponse('Something went wrong');
      expect(result.status).toBe(400);
      expect(result.body.error.message).toBe('Something went wrong');
      expect(result.body.error.type).toBe('invalid_request_error');
    });

    it('respects custom status and type', () => {
      const result = buildErrorResponse('Not found', 'model_not_found', 404);
      expect(result.status).toBe(404);
      expect(result.body.error.type).toBe('model_not_found');
      expect(result.body.error.message).toBe('Not found');
    });

    it('includes null code field', () => {
      const result = buildErrorResponse('Test');
      expect(result.body.error.code).toBeNull();
    });
  });

  describe('buildModelList', () => {
    it('builds model list from agent names', () => {
      const list = buildModelList(['bot1', 'bot2']);
      expect(list.object).toBe('list');
      expect(list.data).toHaveLength(2);
      expect(list.data[0].id).toBe('bot1');
      expect(list.data[0].object).toBe('model');
      expect(list.data[0].owned_by).toBe('lettabot');
      expect(list.data[1].id).toBe('bot2');
    });

    it('handles empty agent list', () => {
      const list = buildModelList([]);
      expect(list.object).toBe('list');
      expect(list.data).toHaveLength(0);
    });

    it('sets created timestamps', () => {
      const list = buildModelList(['bot1']);
      expect(list.data[0].created).toBeGreaterThan(0);
    });
  });

  describe('validateChatRequest', () => {
    it('returns null for valid request', () => {
      expect(
        validateChatRequest({ messages: [{ role: 'user', content: 'hi' }] }),
      ).toBeNull();
    });

    it('returns error for missing messages', () => {
      const err = validateChatRequest({});
      expect(err).not.toBeNull();
      expect(err!.status).toBe(400);
      expect(err!.body.error.message).toContain('messages');
    });

    it('returns error for empty messages', () => {
      const err = validateChatRequest({ messages: [] });
      expect(err).not.toBeNull();
      expect(err!.status).toBe(400);
      expect(err!.body.error.message).toContain('non-empty array');
    });

    it('returns error for non-object body', () => {
      const err1 = validateChatRequest(null);
      expect(err1).not.toBeNull();
      expect(err1!.status).toBe(400);

      const err2 = validateChatRequest('string');
      expect(err2).not.toBeNull();
      expect(err2!.status).toBe(400);
    });

    it('returns error for non-array messages', () => {
      const err = validateChatRequest({ messages: 'not an array' });
      expect(err).not.toBeNull();
      expect(err!.status).toBe(400);
    });

    it('accepts request with multiple messages', () => {
      const result = validateChatRequest({
        messages: [
          { role: 'system', content: 'You are helpful' },
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi!' },
          { role: 'user', content: 'How are you?' },
        ],
      });
      expect(result).toBeNull();
    });
  });
});

// ============================================================================
// SERVER ROUTE TESTS: GET /v1/models
// ============================================================================

describe('GET /v1/models', () => {
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
    await new Promise<void>((resolve) => {
      if (server.listening) {
        resolve();
        return;
      }
      server.once('listening', resolve);
    });
    port = getPort(server);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns 401 without auth', async () => {
    const res = await request(port, 'GET', '/v1/models');
    expect(res.status).toBe(401);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.type).toBe('invalid_request_error');
  });

  it('accepts Bearer token auth', async () => {
    const res = await request(port, 'GET', '/v1/models', undefined, {
      authorization: `Bearer ${TEST_API_KEY}`,
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.object).toBe('list');
    expect(parsed.data).toHaveLength(1);
    expect(parsed.data[0].id).toBe('LettaBot');
  });

  it('accepts X-Api-Key header', async () => {
    const res = await request(port, 'GET', '/v1/models', undefined, {
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.object).toBe('list');
  });

  it('returns model list with correct structure', async () => {
    const res = await request(port, 'GET', '/v1/models', undefined, {
      authorization: `Bearer ${TEST_API_KEY}`,
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.object).toBe('list');
    expect(parsed.data).toHaveLength(1);
    expect(parsed.data[0]).toMatchObject({
      id: 'LettaBot',
      object: 'model',
      owned_by: 'lettabot',
    });
    expect(parsed.data[0].created).toBeGreaterThan(0);
  });

  it('returns 401 with wrong API key', async () => {
    const res = await request(port, 'GET', '/v1/models', undefined, {
      authorization: 'Bearer wrong-key',
    });
    expect(res.status).toBe(401);
  });
});

// ============================================================================
// SERVER ROUTE TESTS: POST /v1/chat/completions
// ============================================================================

describe('POST /v1/chat/completions', () => {
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
    await new Promise<void>((resolve) => {
      if (server.listening) {
        resolve();
        return;
      }
      server.once('listening', resolve);
    });
    port = getPort(server);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns 401 without auth', async () => {
    const body = JSON.stringify({
      model: 'LettaBot',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    const res = await request(port, 'POST', '/v1/chat/completions', body, {
      'content-type': 'application/json',
    });
    expect(res.status).toBe(401);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.type).toBe('invalid_request_error');
  });

  it('accepts Bearer auth', async () => {
    const body = JSON.stringify({
      model: 'LettaBot',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    const res = await request(port, 'POST', '/v1/chat/completions', body, {
      'content-type': 'application/json',
      authorization: `Bearer ${TEST_API_KEY}`,
    });
    expect(res.status).toBe(200);
  });

  it('accepts X-Api-Key header', async () => {
    const body = JSON.stringify({
      model: 'LettaBot',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    const res = await request(port, 'POST', '/v1/chat/completions', body, {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(200);
  });

  it('returns sync completion by default', async () => {
    const body = JSON.stringify({
      model: 'LettaBot',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    const res = await request(port, 'POST', '/v1/chat/completions', body, {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.object).toBe('chat.completion');
    expect(parsed.id).toMatch(/^chatcmpl-/);
    expect(parsed.model).toBe('LettaBot');
    expect(parsed.choices).toHaveLength(1);
    expect(parsed.choices[0].index).toBe(0);
    expect(parsed.choices[0].message.role).toBe('assistant');
    expect(parsed.choices[0].message.content).toBe('Agent says hello');
    expect(parsed.choices[0].finish_reason).toBe('stop');
    expect(parsed.usage).toBeNull();
    expect(parsed.created).toBeGreaterThan(0);
  });

  it('returns 404 for unknown model', async () => {
    const body = JSON.stringify({
      model: 'UnknownBot',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const res = await request(port, 'POST', '/v1/chat/completions', body, {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(404);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.type).toBe('model_not_found');
    expect(parsed.error.message).toContain('UnknownBot');
  });

  it('returns 400 for missing messages', async () => {
    const body = JSON.stringify({ model: 'LettaBot' });
    const res = await request(port, 'POST', '/v1/chat/completions', body, {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.type).toBe('invalid_request_error');
    expect(parsed.error.message).toContain('messages');
  });

  it('returns 400 for empty messages array', async () => {
    const body = JSON.stringify({ model: 'LettaBot', messages: [] });
    const res = await request(port, 'POST', '/v1/chat/completions', body, {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid JSON', async () => {
    const res = await request(
      port,
      'POST',
      '/v1/chat/completions',
      'not valid json',
      {
        'content-type': 'application/json',
        'x-api-key': TEST_API_KEY,
      },
    );
    expect(res.status).toBe(400);
  });

  it('extracts last user message from messages array', async () => {
    const body = JSON.stringify({
      model: 'LettaBot',
      messages: [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'First message' },
        { role: 'assistant', content: 'I see' },
        { role: 'user', content: 'Second message' },
      ],
    });
    const res = await request(port, 'POST', '/v1/chat/completions', body, {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(200);
    expect(router.sendToAgent).toHaveBeenCalledWith(
      'LettaBot',
      'Second message',
      expect.any(Object),
    );
  });

  it('returns SSE stream when stream: true', async () => {
    // Reset mock for streaming
    (router as any).streamToAgent = vi.fn().mockReturnValue(
      (async function* () {
        yield { type: 'reasoning', content: 'thinking...' };
        yield { type: 'assistant', content: 'Hello ' };
        yield { type: 'assistant', content: 'world' };
        yield {
          type: 'tool_call',
          toolCallId: 'call_1',
          toolName: 'web_search',
          toolInput: { query: 'test' },
        };
        yield { type: 'tool_result', content: 'result data' };
        yield { type: 'assistant', content: '!' };
        yield { type: 'result', success: true };
      })(),
    );

    const body = JSON.stringify({
      model: 'LettaBot',
      messages: [{ role: 'user', content: 'Stream' }],
      stream: true,
    });
    const res = await request(port, 'POST', '/v1/chat/completions', body, {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['connection']).toBe('keep-alive');

    // Parse SSE events
    const events = res.body
      .split('\n\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.replace('data: ', ''))
      .filter((line) => line !== '[DONE]')
      .map((line) => JSON.parse(line));

    // Should have: role announcement, content chunks, tool_call, final chunk
    expect(events.length).toBeGreaterThanOrEqual(5);

    // First chunk: role
    expect(events[0].object).toBe('chat.completion.chunk');
    expect(events[0].choices[0].delta.role).toBe('assistant');
    expect(events[0].choices[0].finish_reason).toBeNull();

    // Content deltas (reasoning should be skipped, tool_result should be skipped)
    const contentChunks = events.filter(
      (e: any) => e.choices[0].delta.content !== undefined,
    );
    const contentParts = contentChunks.map((e: any) => e.choices[0].delta.content);
    expect(contentParts).toContain('Hello ');
    expect(contentParts).toContain('world');
    expect(contentParts).toContain('!');
    expect(contentParts).not.toContain('thinking...'); // reasoning filtered

    // Tool call chunk
    const toolChunks = events.filter((e: any) => e.choices[0].delta.tool_calls);
    expect(toolChunks).toHaveLength(1);
    expect(toolChunks[0].choices[0].delta.tool_calls[0].function.name).toBe(
      'web_search',
    );
    expect(toolChunks[0].choices[0].delta.tool_calls[0].id).toBe('call_1');
    expect(
      JSON.parse(toolChunks[0].choices[0].delta.tool_calls[0].function.arguments),
    ).toEqual({ query: 'test' });

    // Final chunk has finish_reason
    const lastEvent = events[events.length - 1];
    expect(lastEvent.choices[0].finish_reason).toBe('stop');

    // data: [DONE] should be present
    expect(res.body).toContain('data: [DONE]');
  });

  it('handles stream with only assistant content', async () => {
    (router as any).streamToAgent = vi.fn().mockReturnValue(
      (async function* () {
        yield { type: 'assistant', content: 'Simple ' };
        yield { type: 'assistant', content: 'response' };
        yield { type: 'result', success: true };
      })(),
    );

    const body = JSON.stringify({
      model: 'LettaBot',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });
    const res = await request(port, 'POST', '/v1/chat/completions', body, {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(200);

    const events = res.body
      .split('\n\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.replace('data: ', ''))
      .filter((line) => line !== '[DONE]')
      .map((line) => JSON.parse(line));

    // Role + 2 content chunks + final chunk
    expect(events.length).toBe(4);
    expect(events[0].choices[0].delta.role).toBe('assistant');
    expect(events[1].choices[0].delta.content).toBe('Simple ');
    expect(events[2].choices[0].delta.content).toBe('response');
    expect(events[3].choices[0].finish_reason).toBe('stop');
  });

  it('calls streamToAgent with correct parameters', async () => {
    (router as any).streamToAgent = vi.fn().mockReturnValue(
      (async function* () {
        yield { type: 'assistant', content: 'test' };
        yield { type: 'result', success: true };
      })(),
    );

    const body = JSON.stringify({
      model: 'LettaBot',
      messages: [{ role: 'user', content: 'Test message' }],
      stream: true,
    });
    await request(port, 'POST', '/v1/chat/completions', body, {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
    });

    expect(router.streamToAgent).toHaveBeenCalledWith(
      'LettaBot',
      'Test message',
      expect.any(Object),
    );
  });

  it('filters out reasoning events in stream', async () => {
    (router as any).streamToAgent = vi.fn().mockReturnValue(
      (async function* () {
        yield { type: 'reasoning', content: 'This should not appear' };
        yield { type: 'reasoning', content: 'Neither should this' };
        yield { type: 'assistant', content: 'But this should' };
        yield { type: 'result', success: true };
      })(),
    );

    const body = JSON.stringify({
      model: 'LettaBot',
      messages: [{ role: 'user', content: 'Test' }],
      stream: true,
    });
    const res = await request(port, 'POST', '/v1/chat/completions', body, {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
    });

    const events = res.body
      .split('\n\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.replace('data: ', ''))
      .filter((line) => line !== '[DONE]')
      .map((line) => JSON.parse(line));

    // Should only have role, content, and final chunk (no reasoning)
    const allContent = events
      .map((e: any) => e.choices[0].delta.content)
      .filter(Boolean)
      .join('');
    expect(allContent).not.toContain('This should not appear');
    expect(allContent).not.toContain('Neither should this');
    expect(allContent).toBe('But this should');
  });

  it('filters out tool_result events in stream', async () => {
    (router as any).streamToAgent = vi.fn().mockReturnValue(
      (async function* () {
        yield {
          type: 'tool_call',
          toolCallId: 'call_1',
          toolName: 'test',
          toolInput: {},
        };
        yield { type: 'tool_result', content: 'This should be hidden' };
        yield { type: 'assistant', content: 'Final answer' };
        yield { type: 'result', success: true };
      })(),
    );

    const body = JSON.stringify({
      model: 'LettaBot',
      messages: [{ role: 'user', content: 'Test' }],
      stream: true,
    });
    const res = await request(port, 'POST', '/v1/chat/completions', body, {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
    });

    const events = res.body
      .split('\n\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.replace('data: ', ''))
      .filter((line) => line !== '[DONE]')
      .map((line) => JSON.parse(line));

    const allContent = events
      .map((e: any) => e.choices[0].delta.content)
      .filter(Boolean)
      .join('');
    expect(allContent).not.toContain('This should be hidden');
    expect(allContent).toBe('Final answer');
  });

  it('handles multiple tool calls in stream', async () => {
    (router as any).streamToAgent = vi.fn().mockReturnValue(
      (async function* () {
        yield {
          type: 'tool_call',
          toolCallId: 'call_1',
          toolName: 'tool1',
          toolInput: { arg: 1 },
        };
        yield {
          type: 'tool_call',
          toolCallId: 'call_2',
          toolName: 'tool2',
          toolInput: { arg: 2 },
        };
        yield { type: 'assistant', content: 'Done' };
        yield { type: 'result', success: true };
      })(),
    );

    const body = JSON.stringify({
      model: 'LettaBot',
      messages: [{ role: 'user', content: 'Test' }],
      stream: true,
    });
    const res = await request(port, 'POST', '/v1/chat/completions', body, {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
    });

    const events = res.body
      .split('\n\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.replace('data: ', ''))
      .filter((line) => line !== '[DONE]')
      .map((line) => JSON.parse(line));

    const toolChunks = events.filter((e: any) => e.choices[0].delta.tool_calls);
    expect(toolChunks).toHaveLength(2);
    expect(toolChunks[0].choices[0].delta.tool_calls[0].function.name).toBe('tool1');
    expect(toolChunks[1].choices[0].delta.tool_calls[0].function.name).toBe('tool2');
  });
});

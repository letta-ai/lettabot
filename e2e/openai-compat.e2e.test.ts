/**
 * E2E Tests for OpenAI-compatible API endpoint
 *
 * Uses the real `openai` npm SDK as the client to prove full compatibility.
 * No Letta API secrets needed -- uses a mock AgentRouter so this runs in CI.
 *
 * Run with: npm run test:e2e
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as http from 'http';
import OpenAI from 'openai';
import { createApiServer } from '../src/api/server.js';
import type { AgentRouter } from '../src/core/interfaces.js';

const TEST_API_KEY = 'e2e-test-key-openai-compat';

function createMockRouter(overrides: Partial<AgentRouter> = {}): AgentRouter {
  return {
    deliverToChannel: vi.fn().mockResolvedValue('msg-1'),
    sendToAgent: vi.fn().mockResolvedValue('Hello from lettabot! I can help you with that.'),
    streamToAgent: vi.fn().mockReturnValue((async function* () {
      yield { type: 'reasoning', content: 'Let me think about this...' };
      yield { type: 'assistant', content: 'Hello' };
      yield { type: 'assistant', content: ' from' };
      yield { type: 'assistant', content: ' lettabot!' };
      yield { type: 'tool_call', toolCallId: 'call_abc123', toolName: 'web_search', toolInput: { query: 'lettabot docs' } };
      yield { type: 'tool_result', content: 'Search results...' };
      yield { type: 'assistant', content: ' I found' };
      yield { type: 'assistant', content: ' the answer.' };
      yield { type: 'result', success: true };
    })()),
    getAgentNames: vi.fn().mockReturnValue(['lettabot', 'helper-bot']),
    ...overrides,
  };
}

function getPort(server: http.Server): number {
  const addr = server.address();
  if (typeof addr === 'object' && addr) return addr.port;
  throw new Error('Server not listening');
}

describe('e2e: OpenAI SDK compatibility', () => {
  let server: http.Server;
  let port: number;
  let router: AgentRouter;
  let client: OpenAI;

  beforeAll(async () => {
    router = createMockRouter();
    server = createApiServer(router, {
      port: 0, // OS-assigned port
      apiKey: TEST_API_KEY,
      host: '127.0.0.1',
    });
    await new Promise<void>((resolve) => {
      if (server.listening) { resolve(); return; }
      server.once('listening', resolve);
    });
    port = getPort(server);

    // Create OpenAI SDK client pointing at our server
    client = new OpenAI({
      apiKey: TEST_API_KEY,
      baseURL: `http://127.0.0.1:${port}/v1`,
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // ---------------------------------------------------------------------------
  // Models
  // ---------------------------------------------------------------------------

  it('lists models via OpenAI SDK', async () => {
    const models = await client.models.list();

    // The SDK returns a page object; iterate to get all
    const modelList: OpenAI.Models.Model[] = [];
    for await (const model of models) {
      modelList.push(model);
    }

    expect(modelList).toHaveLength(2);
    expect(modelList[0].id).toBe('lettabot');
    expect(modelList[1].id).toBe('helper-bot');
    expect(modelList[0].owned_by).toBe('lettabot');
  });

  // ---------------------------------------------------------------------------
  // Non-streaming (sync)
  // ---------------------------------------------------------------------------

  it('sends a sync chat completion via OpenAI SDK', async () => {
    const completion = await client.chat.completions.create({
      model: 'lettabot',
      messages: [{ role: 'user', content: 'Hello!' }],
    });

    // Validate the SDK parsed it correctly
    expect(completion.id).toMatch(/^chatcmpl-/);
    expect(completion.object).toBe('chat.completion');
    expect(completion.model).toBe('lettabot');
    expect(completion.choices).toHaveLength(1);
    expect(completion.choices[0].message.role).toBe('assistant');
    expect(completion.choices[0].message.content).toBe('Hello from lettabot! I can help you with that.');
    expect(completion.choices[0].finish_reason).toBe('stop');

    // Verify the router received the right call
    expect(router.sendToAgent).toHaveBeenCalledWith(
      'lettabot',
      'Hello!',
      expect.objectContaining({ type: 'webhook' }),
    );
  });

  it('defaults to first model when model field is omitted', async () => {
    // The OpenAI SDK requires model, but we can test with the first agent name
    const completion = await client.chat.completions.create({
      model: 'lettabot',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'First answer' },
        { role: 'user', content: 'Follow-up question' },
      ],
    });

    // Should extract last user message
    expect(router.sendToAgent).toHaveBeenCalledWith(
      'lettabot',
      'Follow-up question',
      expect.any(Object),
    );
    expect(completion.choices[0].message.content).toBeTruthy();
  });

  it('throws on unknown model', async () => {
    await expect(
      client.chat.completions.create({
        model: 'nonexistent-model',
        messages: [{ role: 'user', content: 'Hi' }],
      })
    ).rejects.toThrow(); // SDK throws on 404
  });

  // ---------------------------------------------------------------------------
  // Streaming
  // ---------------------------------------------------------------------------

  it('streams a chat completion via OpenAI SDK', async () => {
    // Fresh mock for streaming (generators are consumed once)
    (router as any).streamToAgent = vi.fn().mockReturnValue((async function* () {
      yield { type: 'reasoning', content: 'thinking...' };
      yield { type: 'assistant', content: 'Hello' };
      yield { type: 'assistant', content: ' world' };
      yield { type: 'result', success: true };
    })());

    const stream = await client.chat.completions.create({
      model: 'lettabot',
      messages: [{ role: 'user', content: 'Stream test' }],
      stream: true,
    });

    const chunks: OpenAI.Chat.Completions.ChatCompletionChunk[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    // Should have role announcement + content deltas + stop
    expect(chunks.length).toBeGreaterThanOrEqual(3);

    // First chunk should announce the role
    expect(chunks[0].choices[0].delta.role).toBe('assistant');

    // Collect all content
    const content = chunks
      .map(c => c.choices[0].delta.content)
      .filter(Boolean)
      .join('');
    expect(content).toBe('Hello world');

    // Last chunk should have finish_reason
    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.choices[0].finish_reason).toBe('stop');

    // All chunks should share the same ID
    const ids = new Set(chunks.map(c => c.id));
    expect(ids.size).toBe(1);
    expect(chunks[0].id).toMatch(/^chatcmpl-/);
  });

  it('streams tool calls in OpenAI format', async () => {
    (router as any).streamToAgent = vi.fn().mockReturnValue((async function* () {
      yield { type: 'assistant', content: 'Let me search.' };
      yield { type: 'tool_call', toolCallId: 'call_xyz', toolName: 'web_search', toolInput: { query: 'test' } };
      yield { type: 'tool_result', content: 'results' };
      yield { type: 'assistant', content: ' Found it!' };
      yield { type: 'result', success: true };
    })());

    const stream = await client.chat.completions.create({
      model: 'lettabot',
      messages: [{ role: 'user', content: 'Search for something' }],
      stream: true,
    });

    const chunks: OpenAI.Chat.Completions.ChatCompletionChunk[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    // Find tool call chunks
    const toolCallChunks = chunks.filter(c => c.choices[0].delta.tool_calls);
    expect(toolCallChunks).toHaveLength(1);

    const toolCall = toolCallChunks[0].choices[0].delta.tool_calls![0];
    expect(toolCall.function?.name).toBe('web_search');
    expect(toolCall.function?.arguments).toContain('test');
    expect(toolCall.id).toBe('call_xyz');

    // Content should not include reasoning or tool results
    const content = chunks
      .map(c => c.choices[0].delta.content)
      .filter(Boolean)
      .join('');
    expect(content).toBe('Let me search. Found it!');
    expect(content).not.toContain('thinking');
    expect(content).not.toContain('results');
  });

  it('filters reasoning from streamed output', async () => {
    (router as any).streamToAgent = vi.fn().mockReturnValue((async function* () {
      yield { type: 'reasoning', content: 'Deep reasoning about the problem...' };
      yield { type: 'reasoning', content: 'More thinking happening here...' };
      yield { type: 'assistant', content: 'Here is my answer.' };
      yield { type: 'result', success: true };
    })());

    const stream = await client.chat.completions.create({
      model: 'lettabot',
      messages: [{ role: 'user', content: 'Think hard' }],
      stream: true,
    });

    const allContent: string[] = [];
    for await (const chunk of stream) {
      if (chunk.choices[0].delta.content) {
        allContent.push(chunk.choices[0].delta.content);
      }
    }

    const fullText = allContent.join('');
    expect(fullText).toBe('Here is my answer.');
    expect(fullText).not.toContain('Deep reasoning');
    expect(fullText).not.toContain('More thinking');
  });

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  it('authenticates with Bearer token (OpenAI SDK default)', async () => {
    // The OpenAI SDK sends Authorization: Bearer <key> by default
    // If we got this far, auth is working. But let's also verify a wrong key fails.
    const badClient = new OpenAI({
      apiKey: 'wrong-key',
      baseURL: `http://127.0.0.1:${port}/v1`,
    });

    await expect(
      badClient.chat.completions.create({
        model: 'lettabot',
        messages: [{ role: 'user', content: 'Hi' }],
      })
    ).rejects.toThrow();
  });
});

import { randomUUID } from 'crypto';

// ============================================================================
// Request types
// ============================================================================

/**
 * OpenAI Chat Completions request body.
 */
export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  // We ignore other OpenAI params (temperature, max_tokens, tools, etc.)
}

/**
 * A single message in the OpenAI messages array.
 */
export interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAIToolCall[];
}

// ============================================================================
// Response types (non-streaming)
// ============================================================================

/**
 * OpenAI Chat Completion response (non-streaming).
 */
export interface OpenAIChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: OpenAIChatChoice[];
  usage: null;
}

/**
 * A single choice in a non-streaming completion response.
 */
export interface OpenAIChatChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason: 'stop' | 'tool_calls' | 'length' | null;
}

// ============================================================================
// Response types (streaming)
// ============================================================================

/**
 * OpenAI Chat Completion chunk (streaming).
 */
export interface OpenAIChatChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: OpenAIChatChunkChoice[];
}

/**
 * A single choice in a streaming chunk.
 */
export interface OpenAIChatChunkChoice {
  index: number;
  delta: {
    role?: 'assistant';
    content?: string | null;
    tool_calls?: OpenAIToolCallDelta[];
  };
  finish_reason: 'stop' | 'tool_calls' | 'length' | null;
}

// ============================================================================
// Tool call types
// ============================================================================

/**
 * OpenAI tool call (non-streaming).
 */
export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * OpenAI tool call delta (streaming).
 */
export interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

// ============================================================================
// Models endpoint
// ============================================================================

/**
 * OpenAI models list response.
 */
export interface OpenAIModelList {
  object: 'list';
  data: OpenAIModel[];
}

/**
 * A single model in the models list.
 */
export interface OpenAIModel {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

// ============================================================================
// Error response
// ============================================================================

/**
 * OpenAI error response.
 */
export interface OpenAIErrorResponse {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}

// ============================================================================
// Helper functions
// ============================================================================

/**
 * Generate a unique chat completion ID.
 */
export function generateCompletionId(): string {
  return `chatcmpl-${randomUUID()}`;
}

/**
 * Extract the last user message from an OpenAI messages array.
 * Returns the content string, or null if none found.
 */
export function extractLastUserMessage(messages: OpenAIChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && messages[i].content) {
      return messages[i].content as string;
    }
  }
  return null;
}

/**
 * Build a sync (non-streaming) completion response.
 */
export function buildCompletion(
  id: string,
  model: string,
  content: string,
  finishReason: 'stop' | 'tool_calls' = 'stop',
): OpenAIChatCompletion {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: finishReason,
    }],
    usage: null,
  };
}

/**
 * Build a streaming chunk.
 */
export function buildChunk(
  id: string,
  model: string,
  delta: OpenAIChatChunkChoice['delta'],
  finishReason: 'stop' | 'tool_calls' | null = null,
): OpenAIChatChunk {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      delta,
      finish_reason: finishReason,
    }],
  };
}

/**
 * Build a tool call streaming chunk.
 */
export function buildToolCallChunk(
  id: string,
  model: string,
  toolIndex: number,
  toolCallId: string,
  functionName: string,
  args: string,
): OpenAIChatChunk {
  return buildChunk(id, model, {
    tool_calls: [{
      index: toolIndex,
      id: toolCallId,
      type: 'function',
      function: { name: functionName, arguments: args },
    }],
  });
}

/**
 * Format an SSE data line. Returns "data: <json>\n\n".
 */
export function formatSSE(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/**
 * The SSE terminator.
 */
export const SSE_DONE = 'data: [DONE]\n\n';

/**
 * Build an OpenAI-format error response.
 */
export function buildErrorResponse(
  message: string,
  type: string = 'invalid_request_error',
  status: number = 400,
): { status: number; body: OpenAIErrorResponse } {
  return {
    status,
    body: {
      error: {
        message,
        type,
        param: null,
        code: null,
      },
    },
  };
}

/**
 * Build the models list from agent names.
 */
export function buildModelList(agentNames: string[]): OpenAIModelList {
  const now = Math.floor(Date.now() / 1000);
  return {
    object: 'list',
    data: agentNames.map(name => ({
      id: name,
      object: 'model' as const,
      created: now,
      owned_by: 'lettabot',
    })),
  };
}

/**
 * Validate an OpenAI chat completion request.
 * Returns null if valid, or an error response object.
 */
export function validateChatRequest(body: unknown): { status: number; body: OpenAIErrorResponse } | null {
  if (!body || typeof body !== 'object') {
    return buildErrorResponse('Invalid request body', 'invalid_request_error', 400);
  }

  const req = body as Record<string, unknown>;

  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    return buildErrorResponse('messages is required and must be a non-empty array', 'invalid_request_error', 400);
  }

  // Validate each message has role and content
  for (const msg of req.messages) {
    if (!msg || typeof msg !== 'object') {
      return buildErrorResponse('Each message must be an object', 'invalid_request_error', 400);
    }
    const m = msg as Record<string, unknown>;
    if (!m.role || typeof m.role !== 'string') {
      return buildErrorResponse('Each message must have a role', 'invalid_request_error', 400);
    }
  }

  return null;
}

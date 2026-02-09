/**
 * Request/response types for LettaBot HTTP API
 */

export interface SendMessageRequest {
  channel: string;
  chatId: string;
  text: string;
  threadId?: string;
}

export interface SendMessageResponse {
  success: boolean;
  messageId?: string;
  error?: string;
  field?: string;
}

export interface SendFileRequest {
  channel: string;
  chatId: string;
  filePath: string;  // Temporary file path on server
  caption?: string;
  kind?: 'image' | 'file';
  threadId?: string;
}

export interface SendFileResponse {
  success: boolean;
  messageId?: string;
  error?: string;
  field?: string;
}

/**
 * POST /api/v1/chat - Send a message to the agent
 */
export interface ChatRequest {
  message: string;
  agent?: string;  // Agent name, defaults to first configured agent
}

export interface ChatResponse {
  success: boolean;
  response?: string;
  agentName?: string;
  error?: string;
}

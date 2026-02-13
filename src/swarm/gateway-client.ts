/**
 * GatewayClient — Thin HTTP client for Thoughtbox Gateway
 *
 * Calls Thoughtbox Gateway via JSON-RPC to localhost:1731/mcp,
 * persisting the mcp-session-id header across calls.
 * Mirrors hub-client.ts pattern exactly.
 */

export interface ThoughtInput {
  thought: string;
  thoughtType?: string;
  branchId?: string;
  branchFromThought?: number;
  agentId?: string;
}

export interface ThoughtResult {
  thoughtNumber: number;
  branchId: string;
  sessionId: string;
}

export interface ReadThoughtsInput {
  sessionId?: string;
  branchId?: string;
  last?: number;
}

export interface ThoughtEntry {
  thoughtNumber: number;
  thought: string;
  thoughtType: string;
  branchId: string;
  agentId?: string;
  timestamp: string;
}

export interface SessionStructure {
  sessionId: string;
  branches: Array<{ branchId: string; thoughtCount: number }>;
  totalThoughts: number;
}

export class GatewayClient {
  private url: string;
  private fetchFn: typeof fetch;
  private sessionId: string | null = null;
  private requestId = 0;
  private initialized = false;

  constructor(url: string, fetchFn?: typeof fetch) {
    this.url = url;
    this.fetchFn = fetchFn || globalThis.fetch;
  }

  /**
   * Send the MCP initialize handshake if not already done.
   * Must happen before any tools/call request.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    this.requestId++;
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'lettabot-gateway-client', version: '1.0.0' },
      },
      id: this.requestId,
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };

    const response = await this.fetchFn(this.url, {
      method: 'POST',
      headers,
      body,
    });

    const respHeaders = response.headers;
    const newSessionId = typeof respHeaders.get === 'function'
      ? respHeaders.get('mcp-session-id')
      : (respHeaders as any).get?.('mcp-session-id');
    if (newSessionId) {
      this.sessionId = newSessionId;
    }

    await response.json();
    this.initialized = true;
  }

  private async call(operation: string, args: Record<string, unknown> = {}): Promise<any> {
    await this.ensureInitialized();
    this.requestId++;
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'thoughtbox_gateway',
        arguments: { operation, args },
      },
      id: this.requestId,
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };
    if (this.sessionId) {
      headers['mcp-session-id'] = this.sessionId;
    }

    const response = await this.fetchFn(this.url, {
      method: 'POST',
      headers,
      body,
    });

    // Capture session ID from response headers
    const respHeaders = response.headers;
    const newSessionId = typeof respHeaders.get === 'function'
      ? respHeaders.get('mcp-session-id')
      : (respHeaders as any).get?.('mcp-session-id');
    if (newSessionId) {
      this.sessionId = newSessionId;
    }

    const json = await response.json();
    if (json.error) {
      throw new Error(`Gateway RPC error: ${JSON.stringify(json.error)}`);
    }

    // Parse the result content text
    const content = json.result?.content;
    if (content && Array.isArray(content) && content.length > 0) {
      const text = content[0]?.text;
      if (text) {
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      }
    }
    return json.result;
  }

  // ─── Gateway Operations ───────────────────────────────────────────────────────

  async startNew(title: string, tags?: string[], project?: string): Promise<{ sessionId: string }> {
    return this.call('start_new', { title, tags, project });
  }

  async loadContext(sessionId: string): Promise<{ sessionId: string }> {
    return this.call('load_context', { sessionId });
  }

  async cipher(): Promise<{ stage: number }> {
    return this.call('cipher');
  }

  async thought(input: ThoughtInput): Promise<ThoughtResult> {
    return this.call('thought', input as unknown as Record<string, unknown>);
  }

  async readThoughts(input: ReadThoughtsInput): Promise<ThoughtEntry[]> {
    const result = await this.call('session', { operation: 'read', ...input });
    return Array.isArray(result) ? result : result?.thoughts ?? [];
  }

  async getStructure(sessionId?: string): Promise<SessionStructure> {
    return this.call('session', { operation: 'structure', sessionId });
  }
}

/**
 * HubClient — Thin HTTP client for Thoughtbox Hub
 *
 * Calls Thoughtbox Hub via JSON-RPC to localhost:1731/mcp,
 * persisting the mcp-session-id header across calls.
 */

export class HubClient {
  private url: string;
  private fetchFn: typeof fetch;
  private sessionId: string | null = null;
  private requestId = 0;

  constructor(url: string, fetchFn?: typeof fetch) {
    this.url = url;
    this.fetchFn = fetchFn || globalThis.fetch;
  }

  private async call(operation: string, args: Record<string, unknown> = {}): Promise<any> {
    this.requestId++;
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'thoughtbox_hub',
        arguments: { operation, args },
      },
      id: this.requestId,
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
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
      throw new Error(`Hub RPC error: ${JSON.stringify(json.error)}`);
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

  // ─── Hub Operations ─────────────────────────────────────────────────────────

  async register(name: string, role: string): Promise<{ agentId: string; role: string }> {
    return this.call('register', { name, role });
  }

  async createWorkspace(name: string, description: string): Promise<{ workspaceId: string }> {
    return this.call('create_workspace', { name, description });
  }

  async createProblem(
    workspaceId: string,
    title: string,
    description: string,
  ): Promise<{ problemId: string }> {
    return this.call('create_problem', { workspaceId, title, description });
  }

  async claimProblem(
    problemId: string,
    branchId: string,
  ): Promise<{ branchFromThought: number }> {
    return this.call('claim_problem', { problemId, branchId });
  }

  async createProposal(
    problemId: string,
    title: string,
    sourceBranch: string,
    description: string,
  ): Promise<{ proposalId: string }> {
    return this.call('create_proposal', { problemId, title, sourceBranch, description });
  }

  async reviewProposal(
    proposalId: string,
    verdict: 'approve' | 'comment' | 'request-changes',
    comment: string,
  ): Promise<{ reviewId: string }> {
    return this.call('review_proposal', { proposalId, verdict, comment });
  }

  async mergeProposal(proposalId: string): Promise<{ merged: boolean }> {
    return this.call('merge_proposal', { proposalId });
  }

  async markConsensus(
    name: string,
    thoughtRef: number,
  ): Promise<{ consensusId: string }> {
    return this.call('mark_consensus', { name, thoughtRef });
  }

  async postMessage(
    channel: string,
    content: string,
    thoughtRef?: number,
  ): Promise<{ messageId: string }> {
    return this.call('post_message', { channel, content, thoughtRef });
  }

  async readChannel(channel: string): Promise<any[]> {
    return this.call('read_channel', { channel });
  }
}

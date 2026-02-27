/**
 * HTTP API server for LettaBot
 * Provides endpoints for CLI to send messages across Docker boundaries
 */

import * as http from 'http';
import * as fs from 'fs';
import { validateApiKey } from './auth.js';
import type { SendMessageRequest, SendMessageResponse, SendFileResponse, ChatRequest, ChatResponse, PairingListResponse, PairingApproveRequest, PairingApproveResponse } from './types.js';
import { listPairingRequests, approvePairingCode } from '../pairing/store.js';
import { parseMultipart } from './multipart.js';
import type { AgentRouter } from '../core/interfaces.js';
import type { ChannelId } from '../core/types.js';
import {
  generateCompletionId, extractLastUserMessage, buildCompletion,
  buildChunk, buildToolCallChunk, formatSSE, SSE_DONE,
  buildErrorResponse, buildModelList, validateChatRequest,
} from './openai-compat.js';
import type { OpenAIChatRequest } from './openai-compat.js';

import { createLogger } from '../logger.js';

const log = createLogger('API');
const VALID_CHANNELS: ChannelId[] = ['telegram', 'slack', 'discord', 'whatsapp', 'signal'];
const MAX_BODY_SIZE = 10 * 1024; // 10KB
const MAX_TEXT_LENGTH = 10000; // 10k chars
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

interface ServerOptions {
  port: number;
  apiKey: string;
  host?: string; // Bind address (default: 127.0.0.1 for security)
  corsOrigin?: string; // CORS origin (default: same-origin only)
}

/**
 * Create and start the HTTP API server
 */
export function createApiServer(deliverer: AgentRouter, options: ServerOptions): http.Server {
  const server = http.createServer(async (req, res) => {
    // Set CORS headers (configurable origin, defaults to same-origin for security)
    const corsOrigin = options.corsOrigin || req.headers.origin || 'null';
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key, Authorization');

    // Handle OPTIONS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Route: GET /health or GET /
    if ((req.url === '/health' || req.url === '/') && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    // Route: POST /api/v1/messages (unified: supports both text and files)
    if (req.url === '/api/v1/messages' && req.method === 'POST') {
      try {
        // Validate authentication
        if (!validateApiKey(req.headers, options.apiKey)) {
          sendError(res, 401, 'Unauthorized');
          return;
        }

        const contentType = req.headers['content-type'] || '';

        // Parse multipart/form-data (supports both text-only and file uploads)
        if (!contentType.includes('multipart/form-data')) {
          sendError(res, 400, 'Content-Type must be multipart/form-data');
          return;
        }

        // Parse multipart data
        const { fields, files } = await parseMultipart(req, MAX_FILE_SIZE);

        // Validate required fields
        if (!fields.channel || !fields.chatId) {
          sendError(res, 400, 'Missing required fields: channel, chatId');
          return;
        }

        if (!VALID_CHANNELS.includes(fields.channel as ChannelId)) {
          sendError(res, 400, `Invalid channel: ${fields.channel}`, 'channel');
          return;
        }

        // Validate that either text or file is provided
        if (!fields.text && files.length === 0) {
          sendError(res, 400, 'Either text or file must be provided');
          return;
        }

        const file = files.length > 0 ? files[0] : undefined;

        // Send via unified deliverer method
        const messageId = await deliverer.deliverToChannel(
          fields.channel as ChannelId,
          fields.chatId,
          {
            text: fields.text,
            filePath: file?.tempPath,
            kind: fields.kind as 'image' | 'file' | 'audio' | undefined,
          }
        );

        // Cleanup temp file if any
        if (file) {
          try {
            fs.unlinkSync(file.tempPath);
          } catch (err) {
            log.warn('Failed to cleanup temp file:', err);
          }
        }

        // Success response
        const response: SendMessageResponse = {
          success: true,
          messageId,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (error: any) {
        log.error('Error handling request:', error);
        sendError(res, 500, error.message || 'Internal server error');
      }
      return;
    }

    // Route: POST /api/v1/chat (send a message to the agent, get response)
    if (req.url === '/api/v1/chat' && req.method === 'POST') {
      try {
        if (!validateApiKey(req.headers, options.apiKey)) {
          sendError(res, 401, 'Unauthorized');
          return;
        }

        const contentType = req.headers['content-type'] || '';
        if (!contentType.includes('application/json')) {
          sendError(res, 400, 'Content-Type must be application/json');
          return;
        }

        const body = await readBody(req, MAX_BODY_SIZE);
        let chatReq: ChatRequest;
        try {
          chatReq = JSON.parse(body);
        } catch {
          sendError(res, 400, 'Invalid JSON body');
          return;
        }

        if (!chatReq.message || typeof chatReq.message !== 'string') {
          sendError(res, 400, 'Missing required field: message');
          return;
        }

        if (chatReq.message.length > MAX_TEXT_LENGTH) {
          sendError(res, 400, `Message too long (max ${MAX_TEXT_LENGTH} chars)`);
          return;
        }

        // Resolve agent name (defaults to first agent)
        const agentName = chatReq.agent;
        const agentNames = deliverer.getAgentNames();
        const resolvedName = agentName || agentNames[0];

        if (agentName && !agentNames.includes(agentName)) {
          sendError(res, 404, `Agent not found: ${agentName}. Available: ${agentNames.join(', ')}`);
          return;
        }

        log.info(`Chat request for agent "${resolvedName}": ${chatReq.message.slice(0, 100)}...`);

        const context = { type: 'webhook' as const, outputMode: 'silent' as const };
        const wantsStream = (req.headers.accept || '').includes('text/event-stream');

        if (wantsStream) {
          // SSE streaming: forward SDK stream chunks as events
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });

          let clientDisconnected = false;
          req.on('close', () => { clientDisconnected = true; });

          try {
            for await (const msg of deliverer.streamToAgent(agentName, chatReq.message, context)) {
              if (clientDisconnected) break;
              res.write(`data: ${JSON.stringify(msg)}\n\n`);
              if (msg.type === 'result') break;
            }
          } catch (streamError: any) {
            if (!clientDisconnected) {
              res.write(`data: ${JSON.stringify({ type: 'error', error: streamError.message })}\n\n`);
            }
          }
          res.end();
        } else {
          // Sync: wait for full response
          const response = await deliverer.sendToAgent(agentName, chatReq.message, context);

          const chatRes: ChatResponse = {
            success: true,
            response,
            agentName: resolvedName,
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(chatRes));
        }
      } catch (error: any) {
        log.error('Chat error:', error);
        const chatRes: ChatResponse = {
          success: false,
          error: error.message || 'Internal server error',
        };
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(chatRes));
      }
      return;
    }

    // Route: GET /api/v1/pairing/:channel - List pending pairing requests
    const pairingListMatch = req.url?.match(/^\/api\/v1\/pairing\/([a-z0-9-]+)$/);
    if (pairingListMatch && req.method === 'GET') {
      try {
        if (!validateApiKey(req.headers, options.apiKey)) {
          sendError(res, 401, 'Unauthorized');
          return;
        }

        const channel = pairingListMatch[1];
        if (!VALID_CHANNELS.includes(channel as ChannelId)) {
          sendError(res, 400, `Invalid channel: ${channel}`, 'channel');
          return;
        }

        const requests = await listPairingRequests(channel);
        const response: PairingListResponse = { requests };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (error: any) {
        log.error('Pairing list error:', error);
        sendError(res, 500, error.message || 'Internal server error');
      }
      return;
    }

    // Route: POST /api/v1/pairing/:channel/approve - Approve a pairing code
    const pairingApproveMatch = req.url?.match(/^\/api\/v1\/pairing\/([a-z0-9-]+)\/approve$/);
    if (pairingApproveMatch && req.method === 'POST') {
      try {
        if (!validateApiKey(req.headers, options.apiKey)) {
          sendError(res, 401, 'Unauthorized');
          return;
        }

        const channel = pairingApproveMatch[1];
        if (!VALID_CHANNELS.includes(channel as ChannelId)) {
          sendError(res, 400, `Invalid channel: ${channel}`, 'channel');
          return;
        }

        const contentType = req.headers['content-type'] || '';
        if (!contentType.includes('application/json')) {
          sendError(res, 400, 'Content-Type must be application/json');
          return;
        }

        const body = await readBody(req, MAX_BODY_SIZE);
        let approveReq: PairingApproveRequest;
        try {
          approveReq = JSON.parse(body);
        } catch {
          sendError(res, 400, 'Invalid JSON body');
          return;
        }

        if (!approveReq.code || typeof approveReq.code !== 'string') {
          sendError(res, 400, 'Missing required field: code');
          return;
        }

        const result = await approvePairingCode(channel, approveReq.code);
        if (!result) {
          const response: PairingApproveResponse = {
            success: false,
            error: 'Code not found or expired',
          };
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
          return;
        }

        log.info(`Pairing approved: ${channel} user ${result.userId}`);
        const response: PairingApproveResponse = {
          success: true,
          userId: result.userId,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (error: any) {
        log.error('Pairing approve error:', error);
        sendError(res, 500, error.message || 'Internal server error');
      }
      return;
    }

    // Route: GET /v1/models (OpenAI-compatible)
    if (req.url === '/v1/models' && req.method === 'GET') {
      try {
        if (!validateApiKey(req.headers, options.apiKey)) {
          const err = buildErrorResponse('Invalid API key', 'invalid_request_error', 401);
          res.writeHead(err.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(err.body));
          return;
        }

        const models = buildModelList(deliverer.getAgentNames());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(models));
      } catch (error: any) {
        log.error('Models error:', error);
        const err = buildErrorResponse(error.message || 'Internal server error', 'server_error', 500);
        res.writeHead(err.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(err.body));
      }
      return;
    }

    // Route: POST /v1/chat/completions (OpenAI-compatible)
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      try {
        if (!validateApiKey(req.headers, options.apiKey)) {
          const err = buildErrorResponse('Invalid API key', 'invalid_request_error', 401);
          res.writeHead(err.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(err.body));
          return;
        }

        const contentType = req.headers['content-type'] || '';
        if (!contentType.includes('application/json')) {
          const err = buildErrorResponse('Content-Type must be application/json', 'invalid_request_error', 400);
          res.writeHead(err.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(err.body));
          return;
        }

        const body = await readBody(req, MAX_BODY_SIZE);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          const err = buildErrorResponse('Invalid JSON body', 'invalid_request_error', 400);
          res.writeHead(err.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(err.body));
          return;
        }

        // Validate OpenAI request shape
        const validationError = validateChatRequest(parsed);
        if (validationError) {
          res.writeHead(validationError.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(validationError.body));
          return;
        }

        const chatReq = parsed as OpenAIChatRequest;

        // Extract the last user message
        const userMessage = extractLastUserMessage(chatReq.messages);
        if (!userMessage) {
          const err = buildErrorResponse('No user message found in messages array', 'invalid_request_error', 400);
          res.writeHead(err.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(err.body));
          return;
        }

        if (userMessage.length > MAX_TEXT_LENGTH) {
          const err = buildErrorResponse(`Message too long (max ${MAX_TEXT_LENGTH} chars)`, 'invalid_request_error', 400);
          res.writeHead(err.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(err.body));
          return;
        }

        // Resolve agent from model field
        const agentNames = deliverer.getAgentNames();
        const modelName = chatReq.model || agentNames[0];
        const agentName = agentNames.includes(modelName) ? modelName : undefined;

        // If an explicit model was requested but doesn't match any agent, error
        if (chatReq.model && !agentNames.includes(chatReq.model)) {
          const err = buildErrorResponse(
            `Model not found: ${chatReq.model}. Available: ${agentNames.join(', ')}`,
            'model_not_found',
            404,
          );
          res.writeHead(err.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(err.body));
          return;
        }

        const completionId = generateCompletionId();
        const context = { type: 'webhook' as const, outputMode: 'silent' as const };

        log.info(`OpenAI chat: model="${modelName}", stream=${!!chatReq.stream}, msg="${userMessage.slice(0, 100)}..."`);

        if (chatReq.stream) {
          // ---- Streaming response ----
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });

          let clientDisconnected = false;
          req.on('close', () => { clientDisconnected = true; });

          // First chunk: role announcement
          res.write(formatSSE(buildChunk(completionId, modelName, { role: 'assistant' })));

          try {
            let toolIndex = 0;

            for await (const msg of deliverer.streamToAgent(agentName, userMessage, context)) {
              if (clientDisconnected) break;

              if (msg.type === 'assistant' && msg.content) {
                // Text content delta
                res.write(formatSSE(buildChunk(completionId, modelName, { content: msg.content })));
              } else if (msg.type === 'tool_call') {
                // Tool call delta (emit name + args in one chunk)
                const toolCallId = msg.toolCallId || `call_${msg.uuid || 'unknown'}`;
                const toolName = msg.toolName || 'unknown';
                const args = msg.toolInput ? JSON.stringify(msg.toolInput) : '{}';
                res.write(formatSSE(buildToolCallChunk(
                  completionId, modelName, toolIndex++, toolCallId, toolName, args,
                )));
              } else if (msg.type === 'result') {
                if (!(msg as any).success) {
                  const errMsg = (msg as any).error || 'Agent run failed';
                  res.write(formatSSE(buildChunk(completionId, modelName, {
                    content: `\n\n[Error: ${errMsg}]`,
                  })));
                }
                break;
              }
              // Skip 'reasoning', 'tool_result', and other internal types
            }
          } catch (streamError: any) {
            if (!clientDisconnected) {
              // Emit error as a content delta so clients see it
              res.write(formatSSE(buildChunk(completionId, modelName, {
                content: `\n\n[Error: ${streamError.message}]`,
              })));
            }
          }

          // Finish chunk + done sentinel
          if (!clientDisconnected) {
            res.write(formatSSE(buildChunk(completionId, modelName, {}, 'stop')));
            res.write(SSE_DONE);
          }
          res.end();
        } else {
          // ---- Sync response ----
          const response = await deliverer.sendToAgent(agentName, userMessage, context);
          const completion = buildCompletion(completionId, modelName, response);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(completion));
        }
      } catch (error: any) {
        log.error('OpenAI chat error:', error);
        const err = buildErrorResponse(error.message || 'Internal server error', 'server_error', 500);
        res.writeHead(err.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(err.body));
      }
      return;
    }

    // Route: GET /portal - Admin portal for pairing approvals
    if ((req.url === '/portal' || req.url === '/portal/') && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(portalHtml);
      return;
    }

    // Route: 404 Not Found
    sendError(res, 404, 'Not found');
  });

  // Bind to localhost by default for security (prevents network exposure on bare metal)
  // Use API_HOST=0.0.0.0 in Docker to expose on all interfaces
  const host = options.host || '127.0.0.1';
  server.listen(options.port, host, () => {
    log.info(`Server listening on ${host}:${options.port}`);
  });

  return server;
}

/**
 * Read request body with size limit
 */
function readBody(req: http.IncomingMessage, maxSize: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) {
        req.destroy();
        reject(new Error(`Request body too large (max ${maxSize} bytes)`));
        return;
      }
      body += chunk.toString();
    });

    req.on('end', () => {
      resolve(body);
    });

    req.on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * Validate send message request
 */
function validateRequest(request: SendMessageRequest): { message: string; field?: string } | null {
  if (!request.channel) {
    return { message: 'Missing required field: channel', field: 'channel' };
  }

  if (!request.chatId) {
    return { message: 'Missing required field: chatId', field: 'chatId' };
  }

  if (!request.text) {
    return { message: 'Missing required field: text', field: 'text' };
  }

  if (!VALID_CHANNELS.includes(request.channel as ChannelId)) {
    return { message: `Invalid channel: ${request.channel}`, field: 'channel' };
  }

  if (typeof request.text !== 'string') {
    return { message: 'Field "text" must be a string', field: 'text' };
  }

  if (request.text.length > MAX_TEXT_LENGTH) {
    return { message: `Text too long (max ${MAX_TEXT_LENGTH} chars)`, field: 'text' };
  }

  return null;
}

/**
 * Send error response
 */
function sendError(res: http.ServerResponse, status: number, message: string, field?: string): void {
  const response: SendMessageResponse = {
    success: false,
    error: message,
    field,
  };
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(response));
}

/**
 * Admin portal HTML - self-contained page for pairing approvals
 */
const portalHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LettaBot Portal</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0a0a0a; color: #e0e0e0; min-height: 100vh; }
  .container { max-width: 640px; margin: 0 auto; padding: 24px 16px; }
  h1 { font-size: 18px; font-weight: 600; margin-bottom: 24px; color: #fff; }
  h1 span { color: #666; font-weight: 400; }

  /* Auth */
  .auth { background: #141414; border: 1px solid #222; border-radius: 8px; padding: 24px; margin-bottom: 24px; }
  .auth label { display: block; font-size: 13px; color: #888; margin-bottom: 8px; }
  .auth input { width: 100%; padding: 10px 12px; background: #0a0a0a; border: 1px solid #333; border-radius: 6px; color: #fff; font-size: 14px; font-family: monospace; }
  .auth input:focus { outline: none; border-color: #555; }
  .auth button { margin-top: 12px; padding: 8px 20px; background: #fff; color: #000; border: none; border-radius: 6px; font-size: 13px; font-weight: 500; cursor: pointer; }
  .auth button:hover { background: #ddd; }

  /* Tabs */
  .tabs { display: flex; gap: 4px; margin-bottom: 16px; }
  .tab { padding: 6px 14px; background: #141414; border: 1px solid #222; border-radius: 6px; font-size: 13px; cursor: pointer; color: #888; }
  .tab:hover { color: #ccc; border-color: #333; }
  .tab.active { background: #1a1a1a; color: #fff; border-color: #444; }
  .tab .count { background: #333; color: #aaa; font-size: 11px; padding: 1px 6px; border-radius: 10px; margin-left: 6px; }
  .tab.active .count { background: #fff; color: #000; }

  /* Table */
  .requests { background: #141414; border: 1px solid #222; border-radius: 8px; overflow: hidden; }
  .request { display: flex; align-items: center; padding: 14px 16px; border-bottom: 1px solid #1a1a1a; gap: 16px; }
  .request:last-child { border-bottom: none; }
  .code { font-family: monospace; font-size: 15px; font-weight: 600; color: #fff; min-width: 90px; }
  .meta { flex: 1; }
  .meta .name { font-size: 13px; color: #ccc; }
  .meta .time { font-size: 12px; color: #555; margin-top: 2px; }
  .approve-btn { padding: 6px 16px; background: #1a7f37; color: #fff; border: none; border-radius: 6px; font-size: 13px; cursor: pointer; white-space: nowrap; }
  .approve-btn:hover { background: #238636; }
  .approve-btn:disabled { background: #333; color: #666; cursor: default; }

  /* Empty */
  .empty { padding: 40px 16px; text-align: center; color: #555; font-size: 14px; }

  /* Toast */
  .toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); padding: 10px 20px; border-radius: 8px; font-size: 13px; opacity: 0; transition: opacity 0.3s; pointer-events: none; }
  .toast.show { opacity: 1; }
  .toast.ok { background: #1a7f37; color: #fff; }
  .toast.err { background: #d1242f; color: #fff; }

  /* Status bar */
  .status { font-size: 12px; color: #444; text-align: center; margin-top: 16px; }

  .hidden { display: none; }
</style>
</head>
<body>
<div class="container">
  <h1>LettaBot <span>Portal</span></h1>

  <div class="auth" id="auth">
    <label for="key">API Key</label>
    <input type="password" id="key" placeholder="Paste your LETTABOT_API_KEY" autocomplete="off" onkeydown="if(event.key==='Enter')login()">
    <button onclick="login()">Connect</button>
  </div>

  <div id="app" class="hidden">
    <div class="tabs" id="tabs"></div>
    <div class="requests" id="list"></div>
    <div class="status" id="status"></div>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
const CHANNELS = ['telegram', 'discord', 'slack'];
let apiKey = sessionStorage.getItem('lbkey') || '';
let activeChannel = 'telegram';
let data = {};
let refreshTimer;

function login() {
  apiKey = document.getElementById('key').value.trim();
  if (!apiKey) return;
  sessionStorage.setItem('lbkey', apiKey);
  init();
}

async function init() {
  document.getElementById('auth').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  await refresh();
  refreshTimer = setInterval(refresh, 10000);
}

async function apiFetch(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json', ...opts.headers } });
  if (res.status === 401) { sessionStorage.removeItem('lbkey'); apiKey = ''; document.getElementById('auth').classList.remove('hidden'); document.getElementById('app').classList.add('hidden'); clearInterval(refreshTimer); toast('Invalid API key', true); throw new Error('Unauthorized'); }
  return res;
}

async function refresh() {
  for (const ch of CHANNELS) {
    try {
      const res = await apiFetch('/api/v1/pairing/' + ch);
      const json = await res.json();
      data[ch] = json.requests || [];
    } catch (e) { if (e.message === 'Unauthorized') return; data[ch] = []; }
  }
  renderTabs();
  renderList();
  document.getElementById('status').textContent = 'Updated ' + new Date().toLocaleTimeString();
}

function renderTabs() {
  const el = document.getElementById('tabs');
  el.innerHTML = CHANNELS.map(ch => {
    const n = (data[ch] || []).length;
    const cls = ch === activeChannel ? 'tab active' : 'tab';
    const count = n > 0 ? '<span class="count">' + n + '</span>' : '';
    return '<div class="' + cls + '" onclick="switchTab(\\'' + ch + '\\')">' + ch.charAt(0).toUpperCase() + ch.slice(1) + count + '</div>';
  }).join('');
}

function renderList() {
  const el = document.getElementById('list');
  const items = data[activeChannel] || [];
  if (items.length === 0) { el.innerHTML = '<div class="empty">No pending pairing requests</div>'; return; }
  el.innerHTML = items.map(r => {
    const name = r.meta?.username ? '@' + r.meta.username : r.meta?.firstName || 'User ' + r.id;
    const ago = timeAgo(r.createdAt);
    return '<div class="request"><div class="code">' + esc(r.code) + '</div><div class="meta"><div class="name">' + esc(name) + '</div><div class="time">' + ago + '</div></div><button class="approve-btn" onclick="approve(\\'' + activeChannel + '\\',\\'' + r.code + '\\', this)">Approve</button></div>';
  }).join('');
}

function switchTab(ch) { activeChannel = ch; renderTabs(); renderList(); }

async function approve(channel, code, btn) {
  btn.disabled = true; btn.textContent = '...';
  try {
    const res = await apiFetch('/api/v1/pairing/' + channel + '/approve', { method: 'POST', body: JSON.stringify({ code }) });
    const json = await res.json();
    if (json.success) { toast('Approved'); await refresh(); }
    else { toast(json.error || 'Failed', true); btn.disabled = false; btn.textContent = 'Approve'; }
  } catch (e) { toast('Error: ' + e.message, true); btn.disabled = false; btn.textContent = 'Approve'; }
}

function toast(msg, err) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = 'toast show ' + (err ? 'err' : 'ok');
  setTimeout(() => el.className = 'toast', 2500);
}

function timeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return s + 's ago'; if (s < 3600) return Math.floor(s/60) + 'm ago';
  return Math.floor(s/3600) + 'h ago';
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

if (apiKey) init();
</script>
</body>
</html>`;


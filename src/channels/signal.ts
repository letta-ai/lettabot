/**
 * Signal Channel Adapter
 * 
 * Uses signal-cli in daemon mode for Signal messaging.
 * Based on moltbot's implementation.
 */

import type { ChannelAdapter } from './types.js';
import type { InboundAttachment, InboundMessage, OutboundMessage } from '../core/types.js';
import type { DmPolicy } from '../pairing/types.js';
import {
  isUserAllowed,
  upsertPairingRequest,
} from '../pairing/store.js';
import { buildAttachmentPath } from './attachments.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { copyFile, stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';

export interface SignalConfig {
  phoneNumber: string;        // Bot's phone number (E.164 format, e.g., +15551234567)
  cliPath?: string;           // Path to signal-cli binary (default: "signal-cli")
  httpHost?: string;          // Daemon HTTP host (default: "127.0.0.1")
  httpPort?: number;          // Daemon HTTP port (default: 8090)
  startupTimeoutMs?: number;  // Max time to wait for daemon startup (default: 30000)
  // Security
  dmPolicy?: DmPolicy;        // 'pairing' (default), 'allowlist', or 'open'
  allowedUsers?: string[];    // Phone numbers (config allowlist)
  selfChatMode?: boolean;     // Respond to Note to Self (default: true)
  attachmentsDir?: string;
  attachmentsMaxBytes?: number;
}

type SignalRpcResponse<T> = {
  jsonrpc?: string;
  result?: T;
  error?: { code?: number; message?: string };
  id?: string | number | null;
};

type SignalSseEvent = {
  envelope?: {
    source?: string;
    sourceUuid?: string;
    timestamp?: number;
    dataMessage?: {
      message?: string;
      timestamp?: number;
      groupInfo?: {
        groupId?: string;
        groupName?: string;
      };
      attachments?: Array<{
        contentType?: string;
        filename?: string;
        id?: string;
        size?: number;
        width?: number;
        height?: number;
        caption?: string;
      }>;
    };
    syncMessage?: {
      sentMessage?: {
        destination?: string;
        destinationUuid?: string;
        message?: string;
        timestamp?: number;
        groupInfo?: {
          groupId?: string;
          groupName?: string;
        };
        attachments?: Array<{
          contentType?: string;
          filename?: string;
          id?: string;
          size?: number;
          width?: number;
          height?: number;
          caption?: string;
        }>;
      };
    };
    typingMessage?: {
      action?: string;
    };
  };
};

/**
 * Wait for a file to exist on disk with exponential backoff.
 * Signal-cli may still be downloading attachments when the SSE event fires.
 *
 * @param filePath - Path to check
 * @param maxWaitMs - Maximum time to wait (default: 5000ms)
 * @param intervalMs - Initial polling interval (default: 100ms)
 * @returns true if file exists, false if timeout exceeded
 */
async function waitForFile(filePath: string, maxWaitMs = 5000, intervalMs = 100): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    try {
      await access(filePath, constants.R_OK);
      return true;
    } catch {
      // File not ready yet, wait and retry
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      // Exponential backoff: double the interval, cap at 500ms
      intervalMs = Math.min(intervalMs * 2, 500);
    }
  }

  return false;
}

export class SignalAdapter implements ChannelAdapter {
  readonly id = 'signal' as const;
  readonly name = 'Signal';
  
  private config: SignalConfig;
  private running = false;
  private daemonProcess: ChildProcess | null = null;
  private sseAbortController: AbortController | null = null;
  private baseUrl: string;
  
  onMessage?: (msg: InboundMessage) => Promise<void>;
  
  constructor(config: SignalConfig) {
    this.config = {
      ...config,
      dmPolicy: config.dmPolicy || 'pairing',
      selfChatMode: config.selfChatMode !== false, // Default true
    };
    const host = config.httpHost || '127.0.0.1';
    const port = config.httpPort || 8090;
    this.baseUrl = `http://${host}:${port}`;
  }
  
  /**
   * Check if a user is authorized based on dmPolicy
   * Returns 'allowed', 'blocked', or 'pairing'
   */
  private async checkAccess(userId: string): Promise<'allowed' | 'blocked' | 'pairing'> {
    const policy = this.config.dmPolicy || 'pairing';
    
    // Open policy: everyone allowed
    if (policy === 'open') {
      return 'allowed';
    }
    
    // Check if already allowed (config or store)
    const allowed = await isUserAllowed('signal', userId, this.config.allowedUsers);
    if (allowed) {
      return 'allowed';
    }
    
    // Allowlist policy: not allowed if not in list
    if (policy === 'allowlist') {
      return 'blocked';
    }
    
    // Pairing policy: needs pairing
    return 'pairing';
  }
  
  /**
   * Format pairing message for Signal
   */
  private formatPairingMessage(code: string): string {
    return `Hi! This bot requires pairing.

Your code: *${code}*

Ask the owner to run:
\`lettabot pairing approve signal ${code}\`

This code expires in 1 hour.`;
  }
  
  async start(): Promise<void> {
    if (this.running) return;
    
    console.log('[Signal] Starting adapter...');
    
    // Spawn signal-cli daemon
    await this.startDaemon();
    
    // Wait for daemon to be ready
    await this.waitForDaemon();
    
    // Start SSE event loop for incoming messages
    this.startEventLoop();
    
    this.running = true;
    console.log('[Signal] Adapter started successfully');
  }
  
  async stop(): Promise<void> {
    if (!this.running) return;
    
    console.log('[Signal] Stopping adapter...');
    
    // Stop SSE loop
    this.sseAbortController?.abort();
    this.sseAbortController = null;
    
    // Stop daemon
    if (this.daemonProcess && !this.daemonProcess.killed) {
      this.daemonProcess.kill('SIGTERM');
      this.daemonProcess = null;
    }
    
    this.running = false;
    console.log('[Signal] Adapter stopped');
  }
  
  isRunning(): boolean {
    return this.running;
  }
  
  async sendMessage(msg: OutboundMessage): Promise<{ messageId: string }> {
    const { markdownToSignal, formatStylesForCli } = await import('./signal-format.js');
    
    let target = msg.chatId;
    const rawText = msg.text;
    
    if (!rawText?.trim()) {
      throw new Error('Signal requires message text');
    }
    
    // Handle Note to Self - send to our own number
    if (target === 'note-to-self') {
      target = this.config.phoneNumber;
    }
    
    // Convert markdown to Signal formatted text with style ranges
    const formatted = markdownToSignal(rawText);
    
    const params: Record<string, unknown> = {
      message: formatted.text,
    };
    
    // Add style ranges if any
    if (formatted.styles.length > 0) {
      params['text-style'] = formatStylesForCli(formatted.styles);
    }
    
    if (this.config.phoneNumber) {
      params.account = this.config.phoneNumber;
    }
    
    // Determine if this is a group or direct message
    if (target.startsWith('group:')) {
      params.groupId = target.slice('group:'.length);
    } else {
      // Direct message - recipient is a phone number or UUID
      params.recipient = [target];
    }
    
    const result = await this.rpcRequest<{ timestamp?: number }>('send', params);
    const timestamp = result?.timestamp;
    
    return {
      messageId: timestamp ? String(timestamp) : 'unknown',
    };
  }
  
  supportsEditing(): boolean {
    return false;
  }
  
  async editMessage(_chatId: string, _messageId: string, _text: string): Promise<void> {
    // Signal doesn't support editing messages - no-op
  }
  
  async sendTypingIndicator(chatId: string): Promise<void> {
    try {
      let target = chatId;
      
      // Handle Note to Self
      if (target === 'note-to-self') {
        target = this.config.phoneNumber;
      }
      
      const params: Record<string, unknown> = {};
      
      if (this.config.phoneNumber) {
        params.account = this.config.phoneNumber;
      }
      
      if (target.startsWith('group:')) {
        params.groupId = target.slice('group:'.length);
      } else {
        params.recipient = [target];
      }
      
      await this.rpcRequest('sendTyping', params);
    } catch (err) {
      // Typing indicators are best-effort
      console.warn('[Signal] Failed to send typing indicator:', err);
    }
  }
  
  // --- Private methods ---
  
  private async startDaemon(): Promise<void> {
    const cliPath = this.config.cliPath || 'signal-cli';
    const host = this.config.httpHost || '127.0.0.1';
    const port = this.config.httpPort || 8090;
    
    const args: string[] = [];
    
    if (this.config.phoneNumber) {
      args.push('-a', this.config.phoneNumber);
    }
    
    args.push('daemon');
    args.push('--http', `${host}:${port}`);
    args.push('--no-receive-stdout');
    
    console.log(`[Signal] Spawning: ${cliPath} ${args.join(' ')}`);
    
    this.daemonProcess = spawn(cliPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    
    this.daemonProcess.stdout?.on('data', (data) => {
      const lines = data.toString().split(/\r?\n/).filter((l: string) => l.trim());
      for (const line of lines) {
        console.log(`[signal-cli] ${line}`);
      }
    });
    
    this.daemonProcess.stderr?.on('data', (data) => {
      const lines = data.toString().split(/\r?\n/).filter((l: string) => l.trim());
      for (const line of lines) {
        // signal-cli writes most logs to stderr
        if (/\b(ERROR|WARN|FAILED|SEVERE)\b/i.test(line)) {
          console.error(`[signal-cli] ${line}`);
        } else {
          console.log(`[signal-cli] ${line}`);
        }
      }
    });
    
    this.daemonProcess.on('error', (err) => {
      console.error('[Signal] Daemon spawn error:', err);
    });
    
    this.daemonProcess.on('exit', (code) => {
      console.log(`[Signal] Daemon exited with code ${code}`);
      if (this.running) {
        // Unexpected exit - mark as not running
        this.running = false;
      }
    });
  }
  
  private async waitForDaemon(): Promise<void> {
    const timeoutMs = this.config.startupTimeoutMs || 30000;
    const startTime = Date.now();
    const pollIntervalMs = 500;
    
    console.log('[Signal] Waiting for daemon to be ready...');
    
    while (Date.now() - startTime < timeoutMs) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      
      try {
        const res = await fetch(`${this.baseUrl}/api/v1/check`, {
          method: 'GET',
          signal: controller.signal,
        });
        
        clearTimeout(timeout);
        
        if (res.ok) {
          console.log('[Signal] Daemon is ready');
          return;
        }
      } catch {
        clearTimeout(timeout);
        // Daemon not ready yet
      }
      
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    
    throw new Error(`Signal daemon did not become ready within ${timeoutMs}ms`);
  }
  
  private startEventLoop(): void {
    this.sseAbortController = new AbortController();
    
    // Run SSE loop in background
    this.runSseLoop().catch((err) => {
      if (!this.sseAbortController?.signal.aborted) {
        console.error('[Signal] SSE loop error:', err);
      }
    });
  }
  
  private async runSseLoop(): Promise<void> {
    const url = new URL(`${this.baseUrl}/api/v1/events`);
    if (this.config.phoneNumber) {
      url.searchParams.set('account', this.config.phoneNumber);
    }
    
    console.log('[Signal] Starting SSE event loop:', url.toString());
    
    while (!this.sseAbortController?.signal.aborted) {
      // Create a new controller for this connection attempt
      const connectionController = new AbortController();
      
      // Abort this connection if the main controller is aborted
      const onMainAbort = () => connectionController.abort();
      this.sseAbortController?.signal.addEventListener('abort', onMainAbort, { once: true });
      
      try {
        console.log('[Signal] Connecting to SSE...');
        const res = await fetch(url, {
          method: 'GET',
          headers: { Accept: 'text/event-stream' },
          signal: connectionController.signal,
        });
        
        if (!res.ok || !res.body) {
          throw new Error(`SSE failed: ${res.status} ${res.statusText}`);
        }
        
        console.log('[Signal] SSE connected');
        
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        
        while (!this.sseAbortController?.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) {
            console.log('[Signal] SSE stream ended');
            break;
          }
          
          buffer += decoder.decode(value, { stream: true });
          
          // Process complete events (separated by double newline)
          const events = buffer.split('\n\n');
          buffer = events.pop() || ''; // Keep incomplete event in buffer
          
          for (const event of events) {
            if (!event.trim()) continue;
            
            // Extract data from SSE event (may be multiline)
            const lines = event.split('\n');
            let data = '';
            for (const line of lines) {
              if (line.startsWith('data:')) {
                data += line.slice(5).trim();
              }
            }
            if (data) {
              this.handleSseData(data).catch((err) => {
                console.error('[Signal] Error handling SSE data:', err);
              });
            }
          }
        }
        
        // Stream ended normally - wait before reconnecting
        console.log('[Signal] SSE disconnected, reconnecting in 2s...');
        await new Promise((resolve) => setTimeout(resolve, 2000));
        
      } catch (err) {
        if (this.sseAbortController?.signal.aborted) {
          return;
        }
        
        console.error('[Signal] SSE connection error, reconnecting in 5s:', err);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      } finally {
        // Clean up the listener
        this.sseAbortController?.signal.removeEventListener('abort', onMainAbort);
      }
    }
  }
  
  private async handleSseData(data: string): Promise<void> {
    try {
      const event = JSON.parse(data) as SignalSseEvent;
      const envelope = event.envelope;
      
      if (!envelope) return;
      
      // Debug: log when we receive any message
      if (envelope.dataMessage || envelope.syncMessage) {
        console.log('[Signal] Received envelope:', JSON.stringify(envelope, null, 2));
      }
      
      // Handle incoming data messages (from others)
      const dataMessage = envelope.dataMessage;
      
      // Handle sync messages (Note to Self, messages we sent from another device)
      const syncMessage = envelope.syncMessage?.sentMessage;
      
      // Get the message text and source from either type
      let messageText: string | undefined;
      let source: string | undefined;
      let chatId: string | undefined;
      let groupInfo: { groupId?: string; groupName?: string } | undefined;
      let attachments: Array<{ contentType?: string; filename?: string; id?: string }> | undefined;
      
      if (dataMessage?.message || dataMessage?.attachments?.length) {
        // Regular incoming message
        messageText = dataMessage.message;
        source = envelope.source || envelope.sourceUuid;
        groupInfo = dataMessage.groupInfo;
        attachments = dataMessage.attachments;
        
        if (groupInfo?.groupId) {
          chatId = `group:${groupInfo.groupId}`;
        } else {
          chatId = source;
        }
      } else if (syncMessage?.message || syncMessage?.attachments?.length) {
        // Sync message (Note to Self or sent from another device)
        messageText = syncMessage.message;
        source = syncMessage.destination || syncMessage.destinationUuid;
        groupInfo = syncMessage.groupInfo;
        attachments = syncMessage.attachments;
        
        // For Note to Self, destination is our own number
        const isNoteToSelf = source === this.config.phoneNumber || 
                            source === envelope.source ||
                            source === envelope.sourceUuid;
        
        if (isNoteToSelf) {
          chatId = 'note-to-self';
        } else if (groupInfo?.groupId) {
          chatId = `group:${groupInfo.groupId}`;
        } else {
          chatId = source;
        }
      }
      
      // Check if we have a valid message before attachment processing
      if (!source || !chatId) {
        return;
      }
      
      // Handle voice message attachments
      // Log all attachments for debugging
      if (attachments?.length) {
        console.log(`[Signal] Attachments received: ${JSON.stringify(attachments.map(a => ({ type: a.contentType, id: a.id })))}`);
      }
      
      const voiceAttachment = attachments?.find(a => a.contentType?.startsWith('audio/'));
      if (voiceAttachment?.id) {
        console.log(`[Signal] Voice attachment detected: ${voiceAttachment.contentType}, id: ${voiceAttachment.id}`);
        try {
          const { loadConfig } = await import('../config/index.js');
          const config = loadConfig();
          if (!config.transcription?.apiKey && !process.env.OPENAI_API_KEY) {
            if (chatId) {
              await this.sendMessage({ 
                chatId, 
                text: 'Voice messages require OpenAI API key for transcription. See: https://github.com/letta-ai/lettabot#voice-messages' 
              });
            }
          } else {
            // Read attachment from signal-cli attachments directory
            // Note: signal-cli may still be downloading when SSE event fires, so we wait
            const { readFileSync } = await import('node:fs');
            const { homedir } = await import('node:os');
            const { join } = await import('node:path');
            
            const attachmentPath = join(homedir(), '.local/share/signal-cli/attachments', voiceAttachment.id);
            console.log(`[Signal] Waiting for attachment: ${attachmentPath}`);
            
            // Wait for file to be available (signal-cli may still be downloading)
            const fileReady = await waitForFile(attachmentPath, 5000);
            if (!fileReady) {
              console.error(`[Signal] Attachment file not found after waiting: ${attachmentPath}`);
              throw new Error(`Attachment file not found after waiting: ${attachmentPath}`);
            }
            console.log(`[Signal] Attachment file ready: ${attachmentPath}`);
            
            const buffer = readFileSync(attachmentPath);
            console.log(`[Signal] Read ${buffer.length} bytes`);
            
            const { transcribeAudio } = await import('../transcription/index.js');
            const ext = voiceAttachment.contentType?.split('/')[1] || 'ogg';
            const transcript = await transcribeAudio(buffer, `voice.${ext}`);
            
            console.log(`[Signal] Transcribed voice message: "${transcript.slice(0, 50)}..."`);
            messageText = (messageText ? messageText + '\n' : '') + `[Voice message]: ${transcript}`;
          }
        } catch (error) {
          console.error('[Signal] Error transcribing voice message:', error);
        }
      } else if (attachments?.some(a => a.contentType?.startsWith('audio/'))) {
        // Audio attachment exists but has no ID
        console.warn(`[Signal] Audio attachment found but missing ID: ${JSON.stringify(voiceAttachment)}`);
      }
      
      // Collect non-voice attachments (images, files, etc.)
      const collectedAttachments = await this.collectSignalAttachments(attachments, chatId);
      
      // After processing attachments, check if we have any message content.
      // If this was a voice-only message and transcription failed/was disabled,
      // still forward a placeholder so the user knows we got it.
      if (!messageText && voiceAttachment?.id) {
        messageText = '[Voice message received]';
      }
      if (!messageText && collectedAttachments.length === 0) {
        return;
      }
      
      // Handle Note to Self - check selfChatMode
      console.log(`[Signal] Processing message: chatId=${chatId}, source=${source}, selfChatMode=${this.config.selfChatMode}`);
      if (chatId === 'note-to-self') {
        if (!this.config.selfChatMode) {
          // selfChatMode disabled - ignore Note to Self messages
          console.log('[Signal] Note to Self ignored (selfChatMode disabled)');
          return;
        }
        // selfChatMode enabled - allow the message through
        console.log('[Signal] Note to Self allowed (selfChatMode enabled)');
      } else {
        // External message - check access control
        console.log('[Signal] Checking access for external message');
        const access = await this.checkAccess(source);
        console.log(`[Signal] Access result: ${access}`);
        
        if (access === 'blocked') {
          console.log(`[Signal] Blocked message from unauthorized user: ${source}`);
          await this.sendMessage({ chatId: source, text: "Sorry, you're not authorized to use this bot." });
          return;
        }
        
        if (access === 'pairing') {
          // Create pairing request
          const { code, created } = await upsertPairingRequest('signal', source, {
            firstName: source, // Use phone number as name
          });
          
          if (!code) {
            await this.sendMessage({ 
              chatId: source, 
              text: "Too many pending pairing requests. Please try again later." 
            });
            return;
          }
          
          // Send pairing message on first contact
          if (created) {
            console.log(`[Signal] New pairing request from ${source}: ${code}`);
            await this.sendMessage({ chatId: source, text: this.formatPairingMessage(code) });
          }
          
          // Don't process the message
          return;
        }
      }
      
      const isGroup = chatId.startsWith('group:');
      const msg: InboundMessage = {
        channel: 'signal',
        chatId,
        userId: source,
        text: messageText || '',
        timestamp: new Date(envelope.timestamp || Date.now()),
        isGroup,
        groupName: groupInfo?.groupName,
        attachments: collectedAttachments.length > 0 ? collectedAttachments : undefined,
      };
      
      this.onMessage?.(msg).catch((err) => {
        console.error('[Signal] Error handling message:', err);
      });
      
    } catch (err) {
      console.error('[Signal] Failed to parse SSE event:', err, data);
    }
  }
  
  private async rpcRequest<T = unknown>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    const id = randomUUID();
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
      id,
    });
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/v1/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    
    if (res.status === 201) {
      return undefined as T;
    }
    
    const text = await res.text();
    if (!text) {
      throw new Error(`Signal RPC empty response (status ${res.status})`);
    }
    
    const parsed = JSON.parse(text) as SignalRpcResponse<T>;
    if (parsed.error) {
      const code = parsed.error.code ?? 'unknown';
      const msg = parsed.error.message ?? 'Signal RPC error';
      throw new Error(`Signal RPC ${code}: ${msg}`);
    }
    
    return parsed.result as T;
  }

  /**
   * Collect attachments from a Signal message
   * Copies from signal-cli's attachments directory to our attachments directory
   */
  private async collectSignalAttachments(
    attachments: Array<{ contentType?: string; filename?: string; id?: string; size?: number; width?: number; height?: number; caption?: string }> | undefined,
    chatId: string
  ): Promise<InboundAttachment[]> {
    if (!attachments || attachments.length === 0) return [];
    if (!this.config.attachmentsDir) return [];
    
    const results: InboundAttachment[] = [];
    const signalAttachmentsDir = join(homedir(), '.local/share/signal-cli/attachments');
    
    for (const attachment of attachments) {
      // Skip voice attachments - handled separately by transcription
      if (attachment.contentType?.startsWith('audio/')) continue;
      
      if (!attachment.id) continue;
      
      const sourcePath = join(signalAttachmentsDir, attachment.id);
      const name = attachment.filename || attachment.id;
      
      const entry: InboundAttachment = {
        id: attachment.id,
        name,
        mimeType: attachment.contentType,
        size: attachment.size,
        kind: attachment.contentType?.startsWith('image/') ? 'image' 
            : attachment.contentType?.startsWith('video/') ? 'video'
            : 'file',
      };
      
      // Check size limit
      if (this.config.attachmentsMaxBytes && this.config.attachmentsMaxBytes > 0) {
        try {
          const stats = await stat(sourcePath);
          if (stats.size > this.config.attachmentsMaxBytes) {
            console.warn(`[Signal] Attachment ${name} exceeds size limit, skipping download.`);
            results.push(entry);
            continue;
          }
        } catch {
          // File might not exist
        }
      }
      
      // Wait for file to be available (signal-cli may still be downloading)
      const fileReady = await waitForFile(sourcePath, 5000);
      if (!fileReady) {
        console.warn(`[Signal] Attachment ${name} not found after waiting, skipping.`);
        results.push(entry);
        continue;
      }
      
      // Copy to our attachments directory
      const target = buildAttachmentPath(this.config.attachmentsDir, 'signal', chatId, name);
      try {
        await copyFile(sourcePath, target);
        entry.localPath = target;
        console.log(`[Signal] Attachment saved to ${target}`);
      } catch (err) {
        console.warn('[Signal] Failed to copy attachment:', err);
      }
      
      results.push(entry);
    }
    
    return results;
  }
}

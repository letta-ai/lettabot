/**
 * Bluesky Jetstream Channel Adapter (read-only by default)
 *
 * Uses the Jetstream WebSocket API to ingest events for selected DID(s).
 * Messages are delivered to the agent in listening mode (no auto-replies).
 */

import { WebSocket } from 'undici';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChannelAdapter } from '../types.js';
import type { InboundMessage, OutboundFile, OutboundMessage } from '../../core/types.js';
import { getDataDir } from '../../utils/paths.js';
import { loadConfig } from '../../config/io.js';
import type { BlueskyConfig, DidMode, JetstreamEvent } from './types.js';
import {
  CURSOR_BACKTRACK_US,
  DEFAULT_APPVIEW_URL,
  DEFAULT_JETSTREAM_URL,
  DEFAULT_NOTIFICATIONS_INTERVAL_SEC,
  DEFAULT_NOTIFICATIONS_LIMIT,
  DEFAULT_SERVICE_URL,
  HANDLE_CACHE_MAX,
  LAST_POST_CACHE_MAX,
  POST_MAX_CHARS,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  STATE_FILENAME,
  STATE_FLUSH_INTERVAL_MS,
  STATE_VERSION,
} from './constants.js';
import { extractPostDetails } from './formatter.js';
import {
  buildAtUri,
  decodeJwtExp,
  isRecord,
  normalizeList,
  pruneMap,
  readString,
  truncate,
  uniqueList,
} from './utils.js';

export class BlueskyAdapter implements ChannelAdapter {
  readonly id = 'bluesky' as const;
  readonly name = 'Bluesky';

  private config: BlueskyConfig;
  private ws: WebSocket | null = null;
  private running = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private lastCursor?: number;
  private handleByDid = new Map<string, string>();
  private handleFetchInFlight = new Map<string, Promise<string | undefined>>();
  private lastHandleFetchAt = new Map<string, number>();
  private lastPostByChatId = new Map<string, {
    uri: string;
    cid?: string;
    rootUri?: string;
    rootCid?: string;
  }>();
  private statePath?: string;
  private stateDirty = false;
  private stateFlushTimer: ReturnType<typeof setInterval> | null = null;
  private accessJwt?: string;
  private refreshJwt?: string;
  private sessionDid?: string;
  private accessJwtExpiresAt?: number;
  private refreshJwtExpiresAt?: number;
  private didModes: Record<string, DidMode> = {};
  private notificationsTimer: ReturnType<typeof setInterval> | null = null;
  private notificationsCursor?: string;
  private notificationsInitialized = false;
  private listModes: Record<string, DidMode> = {};
  private listRefreshInFlight = false;
  private runtimePath?: string;
  private runtimeTimer: ReturnType<typeof setInterval> | null = null;
  private runtimeDisabled = false;
  private lastRuntimeRefreshAt?: string;
  private lastRuntimeReloadAt?: string;
  private readonly handleFetchCooldownMs = 5 * 60 * 1000;

  onMessage?: (msg: InboundMessage) => Promise<void>;
  onCommand?: (command: string) => Promise<string | null>;

  constructor(config: BlueskyConfig) {
    this.config = config;
    this.loadDidModes();
    if (config.agentName) {
      const baseDir = getDataDir();
      this.statePath = join(baseDir, STATE_FILENAME);
      this.runtimePath = join(baseDir, 'bluesky-runtime.json');
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.loadState();
    this.startStateFlushTimer();
    await this.maybeInitPostingIdentity();
    if (!this.running) return;
    await this.expandLists();
    if (!this.running) return;
    this.startRuntimeWatcher();
    await this.checkRuntimeState();
    if (!this.running) return;
    if (!this.runtimeDisabled) {
      this.startNotificationsPolling();
      if (this.hasJetstreamTargets()) {
        this.connect();
      } else {
        console.warn('[Bluesky] Jetstream disabled (no wantedDids or list-expanded DIDs).');
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.stateFlushTimer) {
      clearInterval(this.stateFlushTimer);
      this.stateFlushTimer = null;
    }
    if (this.notificationsTimer) {
      clearInterval(this.notificationsTimer);
      this.notificationsTimer = null;
    }
    if (this.runtimeTimer) {
      clearInterval(this.runtimeTimer);
      this.runtimeTimer = null;
    }
    this.flushState();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  async sendMessage(_msg: OutboundMessage): Promise<{ messageId: string }> {
    if (this.runtimeDisabled) {
      throw new Error('Bluesky runtime disabled via kill switch.');
    }

    const target = this.lastPostByChatId.get(_msg.chatId);
    if (!target) {
      throw new Error('No recent post target to reply to.');
    }

    const chunks = this.splitPostText(_msg.text);
    if (chunks.length === 0) {
      throw new Error('Refusing to post empty reply.');
    }

    const rootUri = target.rootUri || target.uri;
    const rootCid = target.rootCid || target.cid;
    if (!rootUri || !rootCid) {
      throw new Error('Missing reply root metadata.');
    }

    let currentTarget = {
      uri: target.uri,
      cid: target.cid,
      rootUri,
      rootCid,
    };
    let lastUri = '';
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const post = await this.createReply(chunk, currentTarget);
      const postUri = post?.uri;
      if (!postUri) {
        throw new Error('Reply post returned no URI.');
      }
      const isLast = i === chunks.length - 1;
      if (!isLast && !post?.cid) {
        throw new Error('Reply post returned no CID.');
      }
      lastUri = postUri;
      if (!isLast && post?.cid) {
        currentTarget = {
          uri: postUri,
          cid: post.cid,
          rootUri,
          rootCid,
        };
      }
    }
    return { messageId: lastUri };
  }

  async editMessage(_chatId: string, _messageId: string, _text: string): Promise<void> {
    console.warn('[Bluesky] editMessage is not supported (read-only channel).');
  }

  supportsEditing(): boolean {
    return false;
  }

  async sendTypingIndicator(_chatId: string): Promise<void> {
    // No typing indicator on Bluesky
  }

  async sendFile(_file: OutboundFile): Promise<{ messageId: string }>
  {
    console.warn('[Bluesky] sendFile is not supported (read-only channel).');
    return { messageId: '' };
  }

  private connect(): void {
    if (!this.running) return;
    if (!this.hasJetstreamTargets()) {
      console.warn('[Bluesky] Jetstream disabled (no wantedDids or list-expanded DIDs).');
      return;
    }

    const url = this.buildJetstreamUrl();
    console.log(`[Bluesky] Connecting to Jetstream: ${url}`);

    this.ws = new WebSocket(url);

    this.ws.addEventListener('open', () => {
      this.reconnectAttempts = 0;
      console.log('[Bluesky] Connected');
    });

    this.ws.addEventListener('message', (event) => {
      this.handleMessageEvent(event).catch(err => {
        console.error('[Bluesky] Failed to process event:', err);
      });
    });

    this.ws.addEventListener('error', (event) => {
      const error = (event as { error?: unknown; message?: string }).error
        || (event as { error?: unknown; message?: string }).message
        || 'Unknown WebSocket error';
      console.error('[Bluesky] WebSocket error:', {
        error,
        url: this.buildJetstreamUrl(),
        reconnectAttempts: this.reconnectAttempts,
      });
    });

    this.ws.addEventListener('close', () => {
      this.ws = null;
      console.warn('[Bluesky] Disconnected');
      if (!this.runtimeDisabled) {
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    if (this.reconnectTimer) return;
    if (!this.hasJetstreamTargets()) {
      console.warn('[Bluesky] Jetstream reconnect skipped (no wantedDids or list-expanded DIDs).');
      return;
    }

    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts));
    this.reconnectAttempts += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);

    console.log(`[Bluesky] Reconnecting in ${delay}ms...`);
  }

  private buildJetstreamUrl(): string {
    const base = this.config.jetstreamUrl || DEFAULT_JETSTREAM_URL;
    const url = new URL(base);

    const wantedDids = this.getWantedDids();
    url.searchParams.delete('wantedDids');
    for (const did of wantedDids) {
      url.searchParams.append('wantedDids', did);
    }

    const wantedCollections = normalizeList(this.config.wantedCollections);
    url.searchParams.delete('wantedCollections');
    for (const collection of wantedCollections) {
      url.searchParams.append('wantedCollections', collection);
    }

    const cursor = this.lastCursor !== undefined
      ? Math.max(0, this.lastCursor - CURSOR_BACKTRACK_US)
      : this.config.cursor;

    if (cursor !== undefined) {
      url.searchParams.set('cursor', String(cursor));
    }

    return url.toString();
  }

  private hasJetstreamTargets(): boolean {
    return this.getWantedDids().length > 0;
  }

  private getAppViewUrl(): string {
    const raw = this.config.appViewUrl || DEFAULT_APPVIEW_URL;
    return raw.replace(/\/+$/, '');
  }

  private async handleMessageEvent(event: { data: unknown }): Promise<void> {
    const raw = typeof event.data === 'string'
      ? event.data
      : Buffer.from(event.data as ArrayBuffer).toString('utf-8');

    let payload: JetstreamEvent;
    try {
      payload = JSON.parse(raw) as JetstreamEvent;
    } catch {
      console.warn('[Bluesky] Received non-JSON message');
      return;
    }

    if (typeof payload.time_us === 'number') {
      this.lastCursor = payload.time_us;
      this.stateDirty = true;
    }

    if (payload.did && payload.identity?.handle) {
      this.handleByDid.set(payload.did, payload.identity.handle);
      pruneMap(this.handleByDid, HANDLE_CACHE_MAX);
    }
    if (payload.did && payload.account?.handle) {
      this.handleByDid.set(payload.did, payload.account.handle);
      pruneMap(this.handleByDid, HANDLE_CACHE_MAX);
    }

    if (payload.did && !this.handleByDid.get(payload.did)) {
      const resolved = await this.resolveHandleForDid(payload.did);
      if (resolved) {
        this.handleByDid.set(payload.did, resolved);
        pruneMap(this.handleByDid, HANDLE_CACHE_MAX);
      }
    }

    if (!payload.commit) {
      return;
    }

    const did = payload.did || 'unknown';
    const handle = payload.did ? this.handleByDid.get(payload.did) : undefined;
    const { text, messageId, source } = this.formatCommit(payload, handle);
    if (!text) return;

    const timestamp = payload.time_us
      ? new Date(Math.floor(payload.time_us / 1000))
      : new Date();

    const didMode = this.getDidMode(did);
    if (didMode === 'disabled') {
      return;
    }

    const isPost = payload.commit?.collection === 'app.bsky.feed.post';
    const allowReplies = this.config.autoReply === true;
    const shouldReply = allowReplies && isPost && didMode === 'open';

    const inbound: InboundMessage = {
      channel: 'bluesky',
      chatId: did,
      userId: did,
      userHandle: handle,
      userName: handle ? `@${handle}` : undefined,
      messageId,
      text,
      timestamp,
      isGroup: false,
      isListeningMode: shouldReply ? false : true,
      source,
    };

    if (payload.commit?.collection === 'app.bsky.feed.post' && source?.uri) {
      this.lastPostByChatId.set(did, {
        uri: source.uri,
        cid: source.cid,
        rootUri: source.threadRootUri,
        rootCid: source.threadRootCid,
      });
      pruneMap(this.lastPostByChatId, LAST_POST_CACHE_MAX);
    }

    await this.onMessage?.(inbound);
  }

  private formatCommit(payload: JetstreamEvent, handle?: string): {
    text: string;
    messageId?: string;
    source?: InboundMessage['source'];
  } {
    const commit = payload.commit || {};
    const operation = commit.operation || 'commit';
    const collection = commit.collection || 'unknown';
    const uri = buildAtUri(payload.did, commit.collection, commit.rkey);

    const source: InboundMessage['source'] = {
      uri,
      collection: commit.collection,
      cid: commit.cid,
      rkey: commit.rkey,
    };

    const lines: string[] = [];
    lines.push(`[Bluesky] ${operation} ${collection}`);
    if (handle) {
      lines.push(`Handle: @${handle}`);
    }
    if (payload.did) {
      lines.push(`DID: ${payload.did}`);
    }
    if (uri) {
      lines.push(`URI: ${uri}`);
    }

    const record = isRecord(commit.record) ? commit.record : undefined;

    if (collection === 'app.bsky.feed.post' && record) {
      const details = extractPostDetails(record);

      if (details.text) {
        lines.push(`Text: ${details.text}`);
      }
      if (details.createdAt) {
        lines.push(`Created: ${details.createdAt}`);
      }
      if (details.langs.length > 0) {
        lines.push(`Langs: ${details.langs.join(', ')}`);
      }
      if (details.replyRefs.rootUri) {
        lines.push(`Thread root: ${details.replyRefs.rootUri}`);
      }
      if (details.replyRefs.parentUri) {
        lines.push(`Reply parent: ${details.replyRefs.parentUri}`);
      }
      if (details.embedLines.length > 0) {
        lines.push(...details.embedLines);
      }

      if (details.replyRefs.rootUri) source.threadRootUri = details.replyRefs.rootUri;
      if (details.replyRefs.rootCid) source.threadRootCid = details.replyRefs.rootCid;
      if (details.replyRefs.parentUri) source.threadParentUri = details.replyRefs.parentUri;
      if (details.replyRefs.parentCid) source.threadParentCid = details.replyRefs.parentCid;
      return {
        text: lines.join('\n'),
        messageId: commit.cid || commit.rkey,
        source,
      };
    } else if ((collection === 'app.bsky.feed.like' || collection === 'app.bsky.feed.repost') && record) {
      const subject = isRecord(record.subject) ? record.subject : undefined;
      const subjectUri = subject ? readString(subject.uri) : undefined;
      const subjectCid = subject ? readString(subject.cid) : undefined;
      const createdAt = readString(record.createdAt);

      if (subjectUri) {
        lines.push(`Subject: ${subjectUri}`);
      }
      if (createdAt) {
        lines.push(`Created: ${createdAt}`);
      }

      if (subjectUri) source.subjectUri = subjectUri;
      if (subjectCid) source.subjectCid = subjectCid;
    } else if ((collection === 'app.bsky.graph.follow' || collection === 'app.bsky.graph.block') && record) {
      const subjectDid = readString(record.subject);
      const createdAt = readString(record.createdAt);
      if (subjectDid) {
        lines.push(`Subject DID: ${subjectDid}`);
      }
      if (createdAt) {
        lines.push(`Created: ${createdAt}`);
      }
    } else if (record) {
      const createdAt = readString(record.createdAt);
      if (createdAt) {
        lines.push(`Created: ${createdAt}`);
      }
      lines.push(`Record: ${truncate(JSON.stringify(record))}`);
    }

    return {
      text: lines.join('\n'),
      messageId: commit.cid || commit.rkey,
      source,
    };
  }

  private splitPostText(text: string): string[] {
    const chars = Array.from(text);
    if (chars.length === 0) return [];
    if (chars.length <= POST_MAX_CHARS) {
      const trimmed = text.trim();
      return trimmed ? [trimmed] : [];
    }

    const chunks: string[] = [];
    let start = 0;

    while (start < chars.length) {
      let end = Math.min(start + POST_MAX_CHARS, chars.length);

      if (end < chars.length) {
        let split = end;
        for (let i = end - 1; i > start; i--) {
          if (/\s/.test(chars[i])) {
            split = i;
            break;
          }
        }
        end = split > start ? split : end;
      }

      let chunk = chars.slice(start, end).join('');
      chunk = chunk.replace(/^\s+/, '').replace(/\s+$/, '');
      if (chunk) chunks.push(chunk);

      start = end;
      while (start < chars.length && /\s/.test(chars[start])) {
        start++;
      }
    }

    return chunks;
  }

  private getServiceUrl(): string {
    const raw = this.config.serviceUrl || DEFAULT_SERVICE_URL;
    return raw.replace(/\/+$/, '');
  }

  private isExpired(expiryMs?: number, skewMs = 60_000): boolean {
    if (!expiryMs) return true;
    return expiryMs - skewMs <= Date.now();
  }

  private async maybeInitPostingIdentity(): Promise<void> {
    if (!this.config.handle && !this.refreshJwt) return;
    if (!this.config.appPassword && !this.refreshJwt) return;

    try {
      await this.ensureSession();
    } catch (err) {
      console.warn('[Bluesky] Posting identity init failed:', err);
    }
  }

  private async ensureSession(): Promise<void> {
    if (this.accessJwt && !this.isExpired(this.accessJwtExpiresAt)) {
      return;
    }

    if (this.refreshJwt && !this.isExpired(this.refreshJwtExpiresAt)) {
      try {
        await this.refreshSessionWithRetry();
        return;
      } catch (err) {
        console.warn('[Bluesky] refreshSession failed, falling back to createSession:', err);
      }
    }

    await this.createSessionWithRetry();
  }

  private async withRetry<T>(fn: () => Promise<T>, label: string, maxRetries = 3): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err as Error;
        if (attempt < maxRetries - 1) {
          const delay = Math.min(5000, 1000 * Math.pow(2, attempt));
          console.warn(`[Bluesky] ${label} failed (attempt ${attempt + 1}/${maxRetries}). Retrying in ${delay}ms.`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    throw lastError ?? new Error(`${label} failed`);
  }

  private async refreshSessionWithRetry(): Promise<void> {
    await this.withRetry(() => this.refreshSession(), 'refreshSession');
  }

  private async createSessionWithRetry(): Promise<void> {
    await this.withRetry(() => this.createSession(), 'createSession');
  }

  private async refreshSession(): Promise<void> {
    if (!this.refreshJwt) {
      throw new Error('Missing refreshJwt');
    }

    const res = await fetch(`${this.getServiceUrl()}/xrpc/com.atproto.server.refreshSession`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.refreshJwt}`,
      },
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`refreshSession failed: ${detail}`);
    }

    const data = await res.json() as { accessJwt: string; refreshJwt: string; did: string; handle?: string };
    this.applySession(data.accessJwt, data.refreshJwt, data.did, data.handle);
  }

  private async createSession(): Promise<void> {
    const identifier = this.config.handle;
    const password = this.config.appPassword;
    if (!identifier || !password) {
      throw new Error('Missing Bluesky handle/appPassword for posting.');
    }

    const res = await fetch(`${this.getServiceUrl()}/xrpc/com.atproto.server.createSession`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, password }),
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`createSession failed: ${detail}`);
    }

    const data = await res.json() as { accessJwt: string; refreshJwt: string; did: string; handle?: string };
    this.applySession(data.accessJwt, data.refreshJwt, data.did, data.handle);
  }

  private applySession(accessJwt: string, refreshJwt: string, did: string, handle?: string): void {
    this.accessJwt = accessJwt;
    this.refreshJwt = refreshJwt;
    this.sessionDid = did;
    this.accessJwtExpiresAt = decodeJwtExp(accessJwt);
    this.refreshJwtExpiresAt = decodeJwtExp(refreshJwt);
    if (handle) {
      this.handleByDid.set(did, handle);
    }
    this.stateDirty = true;
  }

  private loadDidModes(): void {
    const modes: Record<string, DidMode> = {};
    const groups = this.config.groups || {};
    for (const [did, config] of Object.entries(groups)) {
      if (did === '*') continue;
      const mode = config?.mode;
      if (mode === 'open' || mode === 'listen' || mode === 'mention-only' || mode === 'disabled') {
        modes[did] = mode;
      }
    }
    this.didModes = modes;
  }

  private getDidMode(did: string): DidMode {
    const explicit = this.didModes[did];
    if (explicit) return explicit;

    const listMode = this.listModes[did];
    if (listMode) return listMode;

    const wildcardMode = this.config.groups?.['*']?.mode;
    if (wildcardMode === 'open' || wildcardMode === 'listen' || wildcardMode === 'mention-only' || wildcardMode === 'disabled') {
      return wildcardMode;
    }

    return 'listen';
  }

  private getWantedDids(): string[] {
    const configured = normalizeList(this.config.wantedDids);
    const disabledDids = new Set(
      Object.entries(this.didModes)
        .filter(([, mode]) => mode === 'disabled')
        .map(([did]) => did),
    );
    const explicitAllowed = Object.entries(this.didModes)
      .filter(([, mode]) => mode !== 'disabled')
      .map(([did]) => did);
    const listAllowed = Object.entries(this.listModes)
      .filter(([, mode]) => mode !== 'disabled')
      .map(([did]) => did);
    const combined = uniqueList([...configured, ...explicitAllowed, ...listAllowed]);
    return combined.filter(did => !disabledDids.has(did));
  }

  private getNotificationsConfig(): {
    enabled: boolean;
    intervalMs: number;
    limit: number;
    priority?: boolean;
    reasons: string[];
  } | null {
    const config = this.config.notifications;
    if (config?.enabled === false) return null;

    const hasAuth = !!(this.config.handle && this.config.appPassword) || !!this.refreshJwt;
    if (!config?.enabled && !hasAuth) return null;
    if (config?.enabled && !hasAuth) {
      console.warn('[Bluesky] Notifications enabled but no auth configured.');
      return null;
    }

    const intervalSec = typeof config?.intervalSec === 'number' && config.intervalSec > 0
      ? config.intervalSec
      : DEFAULT_NOTIFICATIONS_INTERVAL_SEC;
    const limit = typeof config?.limit === 'number' && config.limit > 0
      ? config.limit
      : DEFAULT_NOTIFICATIONS_LIMIT;
    const reasons = config?.reasons && normalizeList(config.reasons).length > 0
      ? normalizeList(config.reasons)
      : ['mention', 'reply', 'quote'];
    return {
      enabled: true,
      intervalMs: intervalSec * 1000,
      limit,
      priority: config?.priority,
      reasons,
    };
  }

  private startNotificationsPolling(): void {
    const config = this.getNotificationsConfig();
    if (!config) return;
    if (this.notificationsTimer) return;
    this.notificationsTimer = setInterval(() => {
      this.pollNotifications().catch(err => {
        console.error('[Bluesky] Notifications poll failed:', err);
      });
    }, config.intervalMs);
    this.pollNotifications().catch(err => {
      console.error('[Bluesky] Notifications poll failed:', err);
    });
    console.log(`[Bluesky] Notifications polling every ${config.intervalMs / 1000}s`);
  }

  private async pollNotifications(): Promise<void> {
    const config = this.getNotificationsConfig();
    if (!config || !this.running) return;

    await this.ensureSession();
    if (!this.accessJwt) return;

    const params = new URLSearchParams();
    params.set('limit', String(config.limit));
    if (this.notificationsCursor) {
      params.set('cursor', this.notificationsCursor);
    }
    if (config.priority !== undefined) {
      params.set('priority', config.priority ? 'true' : 'false');
    }
    for (const reason of config.reasons) {
      params.append('reasons', reason);
    }

    const res = await fetch(`${this.getAppViewUrl()}/xrpc/app.bsky.notification.listNotifications?${params}`, {
      headers: { Authorization: `Bearer ${this.accessJwt}` },
    });

    if (res.status === 401) {
      this.accessJwt = undefined;
      this.accessJwtExpiresAt = undefined;
      await this.ensureSession();
      return;
    }

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`listNotifications failed: ${detail}`);
    }

    const data = await res.json() as {
      cursor?: string;
      notifications: Array<{
        uri: string;
        cid?: string;
        author?: { did: string; handle?: string; displayName?: string };
        reason: string;
        reasonSubject?: string;
        record?: Record<string, unknown>;
        indexedAt?: string;
        isRead?: boolean;
      }>;
    };

    if (!this.notificationsInitialized) {
      this.notificationsCursor = data.cursor;
      this.notificationsInitialized = true;
      this.stateDirty = true;
      console.log('[Bluesky] Notifications cursor initialized (skipping initial backlog).');
      return;
    }

    if (data.cursor) {
      this.notificationsCursor = data.cursor;
      this.stateDirty = true;
    }

    const notifications = Array.isArray(data.notifications) ? data.notifications : [];
    if (notifications.length === 0) return;

    // Deliver oldest first
    const ordered = [...notifications].reverse();
    for (const notification of ordered) {
      await this.processNotification(notification);
    }
  }

  private async expandLists(): Promise<void> {
    if (this.listRefreshInFlight) return;
    const lists = this.config.lists || {};
    const entries = Object.entries(lists).filter(([uri]) => uri && uri !== '*');
    if (entries.length === 0) return;

    this.listRefreshInFlight = true;
    try {
      if (!this.accessJwt && this.config.handle && this.config.appPassword) {
        try {
          await this.ensureSession();
        } catch (err) {
          console.warn('[Bluesky] List expansion auth failed:', err);
        }
      }

      const nextModes: Record<string, DidMode> = {};

      for (const [listUri, config] of entries) {
        const mode = config?.mode;
        if (mode !== 'open' && mode !== 'listen' && mode !== 'mention-only' && mode !== 'disabled') {
          continue;
        }

        const dids = await this.fetchListDids(listUri);
        for (const did of dids) {
          if (!did || this.didModes[did]) continue; // explicit DID overrides list
          if (!nextModes[did]) {
            nextModes[did] = mode;
          }
        }
      }

      this.listModes = nextModes;
    } catch (err) {
      console.error('[Bluesky] List expansion failed:', err);
    } finally {
      this.listRefreshInFlight = false;
    }
  }

  private async fetchListDids(listUri: string): Promise<string[]> {
    const dids: string[] = [];
    let cursor: string | undefined;
    const limit = 100;
    const base = this.getAppViewUrl();

    for (;;) {
      const params = new URLSearchParams();
      params.set('list', listUri);
      params.set('limit', String(limit));
      if (cursor) params.set('cursor', cursor);

      const res = await fetch(`${base}/xrpc/app.bsky.graph.getList?${params}`, {
        headers: this.accessJwt ? { Authorization: `Bearer ${this.accessJwt}` } : undefined,
      });

      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`getList failed: ${detail}`);
      }

      const data = await res.json() as {
        cursor?: string;
        items?: Array<{ subject?: { did?: string } }>;
      };

      const items = Array.isArray(data.items) ? data.items : [];
      for (const item of items) {
        const did = item?.subject?.did;
        if (did) dids.push(did);
      }

      if (!data.cursor) break;
      cursor = data.cursor;
    }

    return uniqueList(dids);
  }

  private startRuntimeWatcher(): void {
    if (!this.runtimePath || this.runtimeTimer) return;
    this.runtimeTimer = setInterval(() => {
      this.checkRuntimeState().catch(err => {
        console.error('[Bluesky] Runtime check failed:', err);
      });
    }, 5000);
    this.checkRuntimeState().catch(err => {
      console.error('[Bluesky] Runtime check failed:', err);
    });
  }

  private async checkRuntimeState(): Promise<void> {
    if (!this.runtimePath) return;
    if (!existsSync(this.runtimePath)) return;
    const raw = JSON.parse(readFileSync(this.runtimePath, 'utf-8')) as {
      agents?: Record<string, { disabled?: boolean; refreshListsAt?: string; reloadConfigAt?: string }>;
    };

    const agentKey = this.config.agentName || 'default';
    const agentState = raw.agents?.[agentKey];
    if (!agentState) return;

    if (typeof agentState.disabled === 'boolean' && agentState.disabled !== this.runtimeDisabled) {
      this.runtimeDisabled = agentState.disabled;
      if (this.runtimeDisabled) {
        this.pauseRuntime();
      } else {
        await this.resumeRuntime();
      }
    }

    if (agentState.refreshListsAt && agentState.refreshListsAt !== this.lastRuntimeRefreshAt) {
      this.lastRuntimeRefreshAt = agentState.refreshListsAt;
      await this.expandLists();
      if (!this.runtimeDisabled) {
        this.reconnectJetstream();
      }
    }

    if (agentState.reloadConfigAt && agentState.reloadConfigAt !== this.lastRuntimeReloadAt) {
      this.lastRuntimeReloadAt = agentState.reloadConfigAt;
      this.reloadConfig();
      await this.expandLists();
      if (!this.runtimeDisabled) {
        this.reconnectJetstream();
      }
    }
  }

  private reloadConfig(): void {
    try {
      const nextConfig = loadConfig();
      let nextBluesky: BlueskyConfig | undefined;
      if (nextConfig.agents && nextConfig.agents.length > 0) {
        const agent = nextConfig.agents.find(a => a.name === this.config.agentName);
        nextBluesky = agent?.channels?.bluesky as BlueskyConfig | undefined;
      } else {
        nextBluesky = nextConfig.channels?.bluesky as BlueskyConfig | undefined;
      }

      if (!nextBluesky) {
        console.warn('[Bluesky] Config reload skipped (no bluesky config found).');
        return;
      }

      this.config = {
        ...this.config,
        ...nextBluesky,
        agentName: this.config.agentName,
      };
      this.loadDidModes();
      this.listModes = {};
      this.maybeInitPostingIdentity().catch(err => {
        console.warn('[Bluesky] Posting identity init failed after reload:', err);
      });
      console.log('[Bluesky] Config reloaded.');
    } catch (err) {
      console.warn('[Bluesky] Config reload failed:', err);
    }
  }

  private pauseRuntime(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    if (this.notificationsTimer) {
      clearInterval(this.notificationsTimer);
      this.notificationsTimer = null;
    }
    console.log('[Bluesky] Runtime disabled via kill switch.');
  }

  private async resumeRuntime(): Promise<void> {
    await this.expandLists();
    this.startNotificationsPolling();
    if (this.hasJetstreamTargets()) {
      this.connect();
    } else {
      console.warn('[Bluesky] Jetstream disabled (no wantedDids or list-expanded DIDs).');
    }
    console.log('[Bluesky] Runtime re-enabled via kill switch.');
  }

  private reconnectJetstream(): void {
    if (!this.hasJetstreamTargets()) {
      console.warn('[Bluesky] Jetstream reconnect skipped (no wantedDids or list-expanded DIDs).');
      return;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    if (!this.runtimeDisabled) {
      this.connect();
    }
  }

  private async resolveHandleForDid(did: string): Promise<string | undefined> {
    if (!did || did === 'unknown') return undefined;
    const cached = this.handleByDid.get(did);
    if (cached) return cached;

    const lastFetched = this.lastHandleFetchAt.get(did);
    if (lastFetched && Date.now() - lastFetched < this.handleFetchCooldownMs) {
      return undefined;
    }

    const existing = this.handleFetchInFlight.get(did);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const url = `${this.getAppViewUrl()}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`;
        const headers: Record<string, string> = {};

        // Use authenticated endpoint if available for complete metadata
        if (this.accessJwt && !this.isExpired(this.accessJwtExpiresAt)) {
          headers['Authorization'] = `Bearer ${this.accessJwt}`;
        }

        const res = await fetch(url, { headers });
        if (!res.ok) {
          return undefined;
        }
        const data = await res.json() as { handle?: string };
        if (data.handle && typeof data.handle === 'string') {
          this.handleByDid.set(did, data.handle);
          pruneMap(this.handleByDid, HANDLE_CACHE_MAX);
          return data.handle;
        }
      } catch {
        return undefined;
      } finally {
        this.lastHandleFetchAt.set(did, Date.now());
        this.handleFetchInFlight.delete(did);
      }
      return undefined;
    })();

    this.handleFetchInFlight.set(did, promise);
    return promise;
  }

  private async processNotification(notification: {
    uri: string;
    cid?: string;
    author?: { did: string; handle?: string; displayName?: string };
    reason: string;
    reasonSubject?: string;
    record?: Record<string, unknown>;
    indexedAt?: string;
    isRead?: boolean;
  }): Promise<void> {
    const authorDid = notification.author?.did || 'unknown';
    let authorHandle = notification.author?.handle;
    if (authorDid && authorHandle) {
      this.handleByDid.set(authorDid, authorHandle);
      pruneMap(this.handleByDid, HANDLE_CACHE_MAX);
    }
    if (authorDid && !authorHandle) {
      authorHandle = await this.resolveHandleForDid(authorDid);
      if (authorHandle) {
        this.handleByDid.set(authorDid, authorHandle);
        pruneMap(this.handleByDid, HANDLE_CACHE_MAX);
      }
    }
    const record = isRecord(notification.record) ? notification.record : undefined;
    const recordType = record ? readString(record.$type) : undefined;
    const timestamp = notification.indexedAt ? new Date(notification.indexedAt) : new Date();

    const source: InboundMessage['source'] = {
      uri: notification.uri,
      cid: notification.cid,
    };

    const lines: string[] = [];
    lines.push(`[Bluesky] notification ${notification.reason}`);
    if (authorHandle) {
      lines.push(`Handle: @${authorHandle}`);
    }
    if (authorDid) {
      lines.push(`DID: ${authorDid}`);
    }
    if (notification.reasonSubject) {
      lines.push(`Subject: ${notification.reasonSubject}`);
    }
    if (notification.uri) {
      lines.push(`URI: ${notification.uri}`);
    }

    if (recordType === 'app.bsky.feed.post' && record) {
      const details = extractPostDetails(record);
      if (details.text) {
        lines.push(`Text: ${details.text}`);
      }
      if (details.createdAt) {
        lines.push(`Created: ${details.createdAt}`);
      }
      if (details.langs.length > 0) {
        lines.push(`Langs: ${details.langs.join(', ')}`);
      }
      if (details.replyRefs.rootUri) {
        lines.push(`Thread root: ${details.replyRefs.rootUri}`);
      }
      if (details.replyRefs.parentUri) {
        lines.push(`Reply parent: ${details.replyRefs.parentUri}`);
      }
      if (details.embedLines.length > 0) {
        lines.push(...details.embedLines);
      }

      if (details.replyRefs.rootUri) source.threadRootUri = details.replyRefs.rootUri;
      if (details.replyRefs.rootCid) source.threadRootCid = details.replyRefs.rootCid;
      if (details.replyRefs.parentUri) source.threadParentUri = details.replyRefs.parentUri;
      if (details.replyRefs.parentCid) source.threadParentCid = details.replyRefs.parentCid;

      this.lastPostByChatId.set(authorDid, {
        uri: notification.uri,
        cid: notification.cid,
        rootUri: source.threadRootUri,
        rootCid: source.threadRootCid,
      });
      pruneMap(this.lastPostByChatId, LAST_POST_CACHE_MAX);
    } else if (record) {
      lines.push(`Record: ${truncate(JSON.stringify(record))}`);
    }

    const didMode = this.getDidMode(authorDid);
    if (didMode === 'disabled') return;

    const actionable = notification.reason === 'mention'
      || notification.reason === 'reply'
      || notification.reason === 'quote';
    const allowReplies = this.config.autoReply === true;
    const shouldReply = allowReplies && actionable
      && recordType === 'app.bsky.feed.post'
      && (didMode === 'open' || (didMode === 'mention-only' && notification.reason === 'mention'));

    const inbound: InboundMessage = {
      channel: 'bluesky',
      chatId: authorDid,
      userId: authorDid,
      userHandle: authorHandle,
      userName: authorHandle ? `@${authorHandle}` : undefined,
      messageId: notification.cid || notification.uri,
      text: lines.join('\n'),
      timestamp,
      isGroup: false,
      isListeningMode: shouldReply ? false : true,
      source,
    };

    await this.onMessage?.(inbound);
  }

  private async createReply(text: string, target: { uri: string; cid?: string; rootUri?: string; rootCid?: string }): Promise<{ uri?: string; cid?: string } | undefined> {
    await this.ensureSession();

    const rootUri = target.rootUri || target.uri;
    const rootCid = target.rootCid || target.cid;
    const parentUri = target.uri;
    const parentCid = target.cid;

    if (!rootUri || !rootCid || !parentUri || !parentCid) {
      throw new Error('Missing reply root/parent metadata.');
    }

    const record = {
      text,
      createdAt: new Date().toISOString(),
      reply: {
        root: { uri: rootUri, cid: rootCid },
        parent: { uri: parentUri, cid: parentCid },
      },
    };

    const res = await fetch(`${this.getServiceUrl()}/xrpc/com.atproto.repo.createRecord`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.accessJwt}`,
      },
      body: JSON.stringify({
        repo: this.sessionDid,
        collection: 'app.bsky.feed.post',
        record,
      }),
    });

    if (res.status === 401) {
      this.accessJwt = undefined;
      this.sessionDid = undefined;
      this.accessJwtExpiresAt = undefined;
      await this.ensureSession();
      return this.createReply(text, target);
    }

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`createRecord failed: ${detail}`);
    }

    const data = await res.json() as { uri?: string; cid?: string };
    if (!data.cid && data.uri) {
      data.cid = await this.resolveRecordCid(data.uri);
    }
    return data;
  }

  private parseAtUri(uri: string): { did: string; collection: string; rkey: string } | undefined {
    if (!uri.startsWith('at://')) return undefined;
    const parts = uri.slice('at://'.length).split('/');
    if (parts.length < 3) return undefined;
    return {
      did: parts[0],
      collection: parts[1],
      rkey: parts[2],
    };
  }

  private async resolveRecordCid(uri: string): Promise<string | undefined> {
    const parsed = this.parseAtUri(uri);
    if (!parsed) return undefined;

    // Try PDS first (if on same server)
    const qs = new URLSearchParams({
      repo: parsed.did,
      collection: parsed.collection,
      rkey: parsed.rkey,
    });
    const res = await fetch(`${this.getServiceUrl()}/xrpc/com.atproto.repo.getRecord?${qs.toString()}`, {
      headers: this.accessJwt ? { 'Authorization': `Bearer ${this.accessJwt}` } : undefined,
    });
    if (res.ok) {
      const data = await res.json() as { cid?: string };
      return data.cid;
    }

    // Fallback to AppView for cross-PDS records
    try {
      const appViewRes = await fetch(`${this.getAppViewUrl()}/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(uri)}`, {
        headers: this.accessJwt ? { 'Authorization': `Bearer ${this.accessJwt}` } : undefined,
      });
      if (appViewRes.ok) {
        const data = await appViewRes.json() as { thread?: { post?: { cid?: string } } };
        return data.thread?.post?.cid;
      }
    } catch {
      return undefined;
    }

    return undefined;
  }

  private loadState(): void {
    if (!this.statePath || !this.config.agentName) return;
    if (!existsSync(this.statePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.statePath, 'utf-8')) as {
        version?: number;
        agents?: Record<string, {
          cursor?: number;
          wantedDids?: string[];
          wantedCollections?: string[];
          auth?: {
            did?: string;
            handle?: string;
            accessJwt?: string;
            refreshJwt?: string;
            accessJwtExpiresAt?: number;
            refreshJwtExpiresAt?: number;
          };
          notificationsCursor?: string;
        }>;
      };
      const state = this.migrateState(raw);
      const entry = state?.agents?.[this.config.agentName];
      if (entry?.cursor !== undefined) {
        this.lastCursor = entry.cursor;
      }
      if (entry?.wantedDids && entry.wantedDids.length > 0) {
        this.config.wantedDids = entry.wantedDids;
      }
      if (entry?.wantedCollections && entry.wantedCollections.length > 0) {
        this.config.wantedCollections = entry.wantedCollections;
      }
      if (entry?.auth?.accessJwt) {
        this.accessJwt = entry.auth.accessJwt;
        this.accessJwtExpiresAt = entry.auth.accessJwtExpiresAt || decodeJwtExp(entry.auth.accessJwt);
      }
      if (entry?.auth?.refreshJwt) {
        this.refreshJwt = entry.auth.refreshJwt;
        this.refreshJwtExpiresAt = entry.auth.refreshJwtExpiresAt || decodeJwtExp(entry.auth.refreshJwt);
      }
      if (entry?.auth?.did) {
        this.sessionDid = entry.auth.did;
      }
      if (entry?.auth?.handle && entry?.auth?.did) {
        this.handleByDid.set(entry.auth.did, entry.auth.handle);
      }
      if (entry?.notificationsCursor) {
        this.notificationsCursor = entry.notificationsCursor;
        this.notificationsInitialized = true;
      }
    } catch (err) {
      console.warn('[Bluesky] Failed to load cursor state:', err);
    }
  }

  private migrateState(raw: { version?: number; agents?: Record<string, unknown> } | null | undefined): {
    version: number;
    agents: Record<string, any>;
  } {
    if (!raw || typeof raw !== 'object') {
      return { version: STATE_VERSION, agents: {} };
    }
    if (!raw.version || raw.version === STATE_VERSION) {
      return { version: STATE_VERSION, agents: raw.agents && typeof raw.agents === 'object' ? raw.agents : {} };
    }
    return { version: STATE_VERSION, agents: raw.agents && typeof raw.agents === 'object' ? raw.agents : {} };
  }

  private startStateFlushTimer(): void {
    if (!this.statePath || !this.config.agentName) return;
    if (this.stateFlushTimer) return;
    this.stateFlushTimer = setInterval(() => this.flushState(), STATE_FLUSH_INTERVAL_MS);
  }

  private flushState(): void {
    if (!this.statePath || !this.config.agentName) return;
    if (!this.stateDirty && this.lastCursor === undefined) return;

    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      const existing = existsSync(this.statePath)
        ? JSON.parse(readFileSync(this.statePath, 'utf-8'))
        : {};
      const agents = typeof existing.agents === 'object' && existing.agents
        ? { ...existing.agents }
        : {};
      const auth = (this.accessJwt || this.refreshJwt || this.sessionDid)
        ? {
            did: this.sessionDid,
            handle: this.config.handle,
            accessJwt: this.accessJwt,
            refreshJwt: this.refreshJwt,
            accessJwtExpiresAt: this.accessJwtExpiresAt,
            refreshJwtExpiresAt: this.refreshJwtExpiresAt,
          }
        : undefined;

      agents[this.config.agentName] = {
        cursor: this.lastCursor,
        wantedDids: this.getWantedDids(),
        wantedCollections: normalizeList(this.config.wantedCollections),
        auth,
        notificationsCursor: this.notificationsCursor,
      };
      writeFileSync(this.statePath, JSON.stringify({
        version: STATE_VERSION,
        updatedAt: new Date().toISOString(),
        agents,
      }, null, 2));
      this.stateDirty = false;
    } catch (err) {
      console.warn('[Bluesky] Failed to persist cursor state:', err);
    }
  }
}

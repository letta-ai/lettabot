/**
 * WhatsApp Channel Adapter (Refactored)
 *
 * This file orchestrates the WhatsApp adapter using extracted modules.
 * It handles:
 * - Adapter lifecycle (start/stop)
 * - Monitor loop and reconnection logic
 * - Watchdog for detecting stale connections
 * - Crypto error handling
 * - Event delegation to extracted modules
 *
 * Extracted responsibilities:
 * - Socket creation -> session.ts
 * - Message extraction -> inbound/extract.ts
 * - Access control -> inbound/access-control.ts
 * - Message sending -> outbound.ts
 * - Utilities -> utils.ts
 */

import type { ChannelAdapter } from "../types.js";
import type { InboundMessage, OutboundMessage, OutboundFile } from "../../core/types.js";
import type {
  WhatsAppConfig,
  ReconnectState,
  ListenerRefs,
  BaileysSocket,
  BaileysMessage,
  BaileysDisconnectReasonType,
  MessagesUpsertData,
} from "./types.js";
import type { GroupMetadata, WAMessageKey } from '@whiskeysockets/baileys';
import type { CredsSaveQueue } from "../../utils/creds-queue.js";

// Session management
import { createWaSocket, installConsoleFilters, type SocketResult } from "./session.js";

// Inbound message handling
import { extractInboundMessage } from "./inbound/extract.js";
import {
  checkInboundAccess,
  formatPairingMessage,
} from "./inbound/access-control.js";
import { applyGroupGating } from "./inbound/group-gating.js";

// Outbound message handling
import {
  sendWhatsAppMessage,
  sendWhatsAppFile,
  sendTypingIndicator,
  stopTypingIndicator,
  sendReadReceipt,
  type LidMapper,
} from "./outbound.js";

// Utilities
import {
  jidToE164,
  isSelfChatMessage,
  createGroupMetaCache,
  isStatusOrBroadcast,
  isLid,
  type GroupMetaCache,
} from "./utils.js";

// Shared utilities
import {
  computeBackoff,
  sleepWithAbort,
  DEFAULT_RECONNECT_POLICY,
} from "../../utils/backoff.js";
import { createDedupeCache, type DedupeCache } from "../../utils/dedupe-cache.js";
import { createInboundDebouncer, type Debouncer } from "../../utils/debouncer.js";
import { normalizePhoneForStorage } from "../../utils/phone.js";
import { parseCommand, HELP_TEXT } from "../../core/commands.js";

// Node imports


import { createLogger } from '../../logger.js';

const log = createLogger('WhatsApp');
// ============================================================================
// CONSTANTS
// ============================================================================

/** Watchdog check interval (1 minute) */
const WATCHDOG_INTERVAL_MS = 60 * 1000;

/** Watchdog timeout - force reconnect if no messages received (30 minutes) */
const WATCHDOG_TIMEOUT_MS = 30 * 60 * 1000;

/** Session corruption threshold - clear session after N failures without QR */
const SESSION_CORRUPTION_THRESHOLD = 8;

/** Message deduplication TTL (20 minutes) */
const DEDUPE_TTL_MS = 20 * 60 * 1000;

/** Maximum dedupe cache size */
const DEDUPE_MAX_SIZE = 5000;

/** Sent message ID cleanup delay (1 minute) */
const SENT_MESSAGE_CLEANUP_MS = 60 * 1000;

/** Stop timeout (5 seconds) */
const STOP_TIMEOUT_MS = 5000;

/** Uptime threshold for resetting reconnect attempts (1 minute) */
const STABLE_CONNECTION_MS = 60 * 1000;

// ============================================================================
// ADAPTER CLASS
// ============================================================================

export class WhatsAppAdapter implements ChannelAdapter {
  readonly id = "whatsapp" as const;
  readonly name = "WhatsApp";

  private config: WhatsAppConfig;
  private running = false;
  private sessionPath: string;

  // Socket state
  private sock: BaileysSocket | null = null;
  private DisconnectReason: BaileysDisconnectReasonType | null = null;
  private myJid: string = "";
  private myLid: string = "";  // Linked Device ID (for Business/multi-device mentions)
  private myNumber: string = "";

  // LID mapping for message sending
  private selfChatLid: string = "";
  private lidToJid: Map<string, string> = new Map();

  // Message tracking
  private sentMessageIds: Set<string> = new Set();
  private dedupeCache: DedupeCache;
  private debouncer: Debouncer<InboundMessage>;

  // Group metadata cache
  private groupMetaCache: GroupMetaCache;

  // Message store for getMessage callback (populated on both send and receive for retry capability)
  private messageStore: Map<string, any> = new Map();

  // Attachment configuration
  private attachmentsDir?: string;
  private attachmentsMaxBytes?: number;
  private downloadContentFromMessage?: (message: any, type: string) => Promise<AsyncIterable<Uint8Array>>;

  // Reconnect state
  private reconnectState: ReconnectState = {
    attempts: 0,
    lastDisconnect: null,
    abortController: null,
    monitorTask: null,
  };

  // Watchdog timer for detecting stale connections
  private watchdogTimer: NodeJS.Timeout | null = null;
  private lastMessageTime: Date | null = null;

  // Connection timestamp (for filtering old messages on reconnect)
  private connectedAtMs: number = 0;

  // Event listener references
  private listenerRefs: ListenerRefs = {};

  // Crypto error handler
  private cryptoErrorHandler: ((reason: any) => void) | null = null;

  // Disconnect signal for monitor loop
  private disconnectSignal: (() => void) | null = null;

  // Consecutive failures without QR (session corruption indicator)
  private consecutiveNoQrFailures = 0;

  // One-time hint for missing groups config
  private loggedNoGroupsHint = false;

  // Credential save queue
  private credsSaveQueue: CredsSaveQueue | null = null;

  // Event handlers (set by bot core)
  onMessage?: (msg: InboundMessage) => Promise<void>;
  onCommand?: (command: string) => Promise<string | null>;

  // Pre-bound handlers (created once to avoid bind() overhead)
  private boundHandleConnectionUpdate: (update: Partial<import("@whiskeysockets/baileys").ConnectionState>) => void;
  private boundHandleMessagesUpsert: (data: MessagesUpsertData) => void;

  constructor(config: WhatsAppConfig) {
    this.config = {
      ...config,
      dmPolicy: config.dmPolicy || "pairing",
    };
    this.sessionPath = config.sessionPath || "./data/whatsapp-session";

    // Initialize dedupe cache
    this.dedupeCache = createDedupeCache({
      ttlMs: DEDUPE_TTL_MS,
      maxSize: DEDUPE_MAX_SIZE,
    });

    // Initialize group metadata cache
    this.groupMetaCache = createGroupMetaCache();

    // Initialize attachment configuration
    this.attachmentsDir = config.attachmentsDir;
    this.attachmentsMaxBytes = config.attachmentsMaxBytes;

    // Initialize message debouncer (batches rapid consecutive messages)
    this.debouncer = createInboundDebouncer({
      debounceMs: 2000, // 2 second window
      buildKey: (msg) => `${msg.chatId}:${msg.userId}`,
      shouldDebounce: (msg) => !msg.text.startsWith('/'), // Don't debounce commands
      onFlush: async (messages) => {
        const combined = this.combineMessages(messages);
        await this.onMessage?.(combined);
      },
      onError: (err) => {
        log.error('Debouncer error:', err);
      },
    });

    // Pre-bound handlers (avoid creating new functions each reconnect)
    this.boundHandleConnectionUpdate = this.handleConnectionUpdate.bind(this);
    this.boundHandleMessagesUpsert = this.handleMessagesUpsert.bind(this);
  }

  /**
   * Combine multiple rapid messages into a single message.
   * Used by debouncer to batch consecutive messages from same sender.
   */
  private combineMessages(messages: InboundMessage[]): InboundMessage {
    if (messages.length === 1) {
      return messages[0];
    }

    // Use the latest message as base
    const last = messages[messages.length - 1];

    // Combine all text with newlines
    const combinedText = messages.map((m) => m.text).join('\n');

    return {
      ...last,
      text: combinedText,
    };
  }

  // ==========================================================================
  // LIFECYCLE METHODS
  // ==========================================================================

  async start(): Promise<void> {
    if (this.running) return;

    // Suppress Baileys crypto noise from console
    installConsoleFilters();

    this.running = true;
    this.reconnectState.abortController = new AbortController();

    // Spawn background monitor (non-blocking)
    this.reconnectState.monitorTask = this.monitorConnection().catch((error) => {
      log.error("Monitor task failed:", error);
      this.running = false;
    });

    // Return immediately - critical for ChannelAdapter contract
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    log.info("Stopping...");

    // Signal monitor to stop
    this.reconnectState.abortController?.abort();

    // Force disconnect to unblock the monitor loop
    this.forceDisconnect("stop-requested");

    // Wait for monitor to finish (with timeout)
    if (this.reconnectState.monitorTask) {
      try {
        await Promise.race([
          this.reconnectState.monitorTask,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Stop timeout")), STOP_TIMEOUT_MS)
          ),
        ]);
      } catch (error) {
        log.warn("Stop timeout, forcing cleanup");
      }
    }

    // Cleanup
    this.detachListeners();
    // Flush pending credential saves before closing
    if (this.credsSaveQueue) {
      await this.credsSaveQueue.flush();
    }
    if (this.sock) {
      try {
        // Close WebSocket without logging out -- logout() invalidates the session
        // server-side, which destroys credentials and forces QR re-pair on restart
        this.sock.ws?.close();
      } catch (error) {
        log.warn("Disconnect error:", error);
      }
      this.sock = null;
    }

    this.running = false;
    log.info("Stopped");
  }

  isRunning(): boolean {
    return this.running;
  }

  // ==========================================================================
  // RECONNECTION MONITOR
  // ==========================================================================

  /**
   * Background monitor loop - handles reconnection with exponential backoff.
   * Runs continuously until aborted or max retries exceeded.
   */
  private async monitorConnection(): Promise<void> {
    const signal = this.reconnectState.abortController?.signal;
    const policy = DEFAULT_RECONNECT_POLICY;

    while (!signal?.aborted) {
      // Create disconnect signal BEFORE createSocket to avoid race condition
      let disconnectResolve: () => void;
      const disconnectPromise = new Promise<void>((resolve) => {
        disconnectResolve = resolve;
        this.disconnectSignal = resolve;
      });

      try {
        // Create socket with fresh listeners
        await this.createSocket();

        // Reset no-QR failure counter on successful connection
        this.consecutiveNoQrFailures = 0;

        // Wait for disconnect (blocks here)
        await disconnectPromise;

        // Calculate uptime to decide if we should reset attempt counter
        const uptime = this.lastMessageTime
          ? Date.now() - this.lastMessageTime.getTime()
          : 0;

        if (uptime > 60000) {
          // Healthy run for 1+ minute
          this.reconnectState.attempts = 0;
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("Connection closed during startup")) {
          log.warn(msg);
        } else {
          log.error("Socket error:", msg);
        }
        // Resolve the disconnect promise if it's still pending
        disconnectResolve!();
      }

      // Clear the signal reference
      this.disconnectSignal = null;

      // Check abort before reconnecting
      if (signal?.aborted) break;

      // Check if logged out
      if (!this.running) break;

      // Check for persistent session failures (only warn after many attempts -- 
      // 1-3 failures on startup is normal WhatsApp reconnection cooldown)
      if (this.consecutiveNoQrFailures >= SESSION_CORRUPTION_THRESHOLD) {
        log.warn(
          `${SESSION_CORRUPTION_THRESHOLD} consecutive connection failures without QR. Session may need re-pairing -- use /reset whatsapp if this persists.`
        );
        this.consecutiveNoQrFailures = 0;
      }

      // Increment and check retry limit
      this.reconnectState.attempts++;
      if (this.reconnectState.attempts >= policy.maxAttempts) {
        log.error("Max reconnect attempts reached");
        this.running = false;
        break;
      }

      // Exponential backoff
      const delay = computeBackoff(policy, this.reconnectState.attempts);
      log.info(
        `Reconnecting in ${delay}ms (attempt ${this.reconnectState.attempts}/${policy.maxAttempts})`
      );

      try {
        await sleepWithAbort(delay, signal);
      } catch {
        break; // Aborted during sleep
      }
    }

    log.info("Monitor loop exited");
    this.running = false;
  }

  // ==========================================================================
  // SOCKET CREATION & MANAGEMENT
  // ==========================================================================

  /**
   * Create a new WhatsApp socket using extracted session module.
   * Handles cleanup of old socket if present.
   */
  private async createSocket(): Promise<void> {
    // Cleanup old socket if exists
    if (this.sock) {
      this.detachListeners();
      try {
        if (this.sock.ws) {
          this.sock.ws.close();
        }
      } catch (error) {
        log.warn("Socket cleanup warning:", error);
      }
      this.sock = null;
    }

    // Check for competing WhatsApp bots
    try {
      const { execSync } = await import("node:child_process");
      const procs = execSync(
        'ps aux | grep -i "clawdbot\\|moltbot" | grep -v grep',
        { encoding: "utf-8" }
      );
      if (procs.trim()) {
        log.warn(
          "[WhatsApp] Warning: clawdbot/moltbot is running and may compete for WhatsApp connection."
        );
        log.warn(
          "[WhatsApp] Stop it with: launchctl unload ~/Library/LaunchAgents/com.clawdbot.gateway.plist"
        );
      }
    } catch {} // No competing bots found

    // Import Baileys download function for attachments
    if (!this.downloadContentFromMessage) {
      const { downloadContentFromMessage } = await import("@whiskeysockets/baileys");
      this.downloadContentFromMessage = downloadContentFromMessage as unknown as (
        message: any,
        type: string
      ) => Promise<AsyncIterable<Uint8Array>>;
    }

    // Track QR display for session corruption detection
    let qrWasShown = false;

    // Create socket using extracted session module
    const result: SocketResult = await createWaSocket({
      authDir: this.sessionPath,
      printQr: true,
      messageStore: this.messageStore, // Pass persistent store
      onQr: () => {
        qrWasShown = true;
      },
      onConnectionUpdate: (update) => {
        // Track connection close during initial connection (silent -- logged at session clear)
        if (update.connection === "close" && !qrWasShown) {
          this.consecutiveNoQrFailures++;

        }
      },
    });

    // Extract socket and helpers
    this.sock = result.sock;
    this.DisconnectReason = result.DisconnectReason;
    this.myJid = result.myJid;
    this.myLid = result.myLid;
    this.myNumber = result.myNumber;
    this.credsSaveQueue = result.credsQueue;

    // Track connection time (for filtering old messages on reconnect)
    this.connectedAtMs = Date.now();

    // Attach persistent listeners
    this.attachListeners();

    // Start watchdog and crypto error handler
    this.startWatchdog();
    this.registerCryptoErrorHandler();
  }

  /**
   * Get group metadata with caching (uses existing groupMetaCache).
   */
  private async getGroupMetadata(groupJid: string): Promise<GroupMetadata> {
    if (!this.sock) {
      throw new Error('Socket not connected');
    }
    return await this.sock.groupMetadata(groupJid);
  }

  /**
   * Attach event listeners to the socket.
   */
  private attachListeners(): void {
    if (!this.sock) return;

    // Store refs for cleanup
    this.listenerRefs.connectionUpdate = this.boundHandleConnectionUpdate;
    this.listenerRefs.messagesUpsert = this.boundHandleMessagesUpsert;

    // Attach listeners
    this.sock.ev.on("connection.update", this.listenerRefs.connectionUpdate);
    this.sock.ev.on("messages.upsert", this.listenerRefs.messagesUpsert);
  }

  /**
   * Detach event listeners from the socket.
   */
  private detachListeners(): void {
    if (!this.sock) return;

    if (this.listenerRefs.connectionUpdate) {
      this.sock.ev.off("connection.update", this.listenerRefs.connectionUpdate);
    }
    if (this.listenerRefs.messagesUpsert) {
      this.sock.ev.off("messages.upsert", this.listenerRefs.messagesUpsert);
    }

    this.listenerRefs = {};
    this.stopWatchdog();
    this.unregisterCryptoErrorHandler();
  }

  // ==========================================================================
  // EVENT HANDLERS
  // ==========================================================================

  /**
   * Handle connection update events (called after initial connection).
   * This handles disconnects that happen AFTER we're already connected.
   */
  private handleConnectionUpdate(update: Partial<import("@whiskeysockets/baileys").ConnectionState>): void {
    const { connection, lastDisconnect } = update;

    // Only handle close events - open/QR are handled during createSocket
    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      const isLoggedOut = statusCode === this.DisconnectReason?.loggedOut;

      log.info(
        `[WhatsApp] Connection closed (status: ${statusCode ?? "unknown"}, loggedOut: ${isLoggedOut})`
      );

      this.reconnectState.lastDisconnect = new Date();

      if (isLoggedOut) {
        // Logged out - stop monitor completely
        log.warn("Session logged out, stopping monitor");
        this.running = false;
        this.reconnectState.abortController?.abort();
      }

      // Signal monitor to proceed with reconnect
      this.forceDisconnect("connection-close");
    }
  }

  /**
   * Handle incoming messages using extracted modules.
   */
  private async handleMessagesUpsert(data: MessagesUpsertData): Promise<void> {
    const { type, messages } = data;
    this.lastMessageTime = new Date(); // Update for watchdog

    // Only process "notify" (new message) and "append" (history)
    if (type !== "notify" && type !== "append") {
      log.debug(`Skipped batch: type=${type} (not notify/append)`);
      return;
    }
    log.debug(`Processing ${messages.length} message(s), type=${type}`);

    for (const m of messages) {
      const messageId = m.key.id || "";
      const remoteJid = m.key.remoteJid || "";

      // Filter out status updates and broadcast messages
      if (isStatusOrBroadcast(remoteJid)) {
        log.debug(`Skipped status/broadcast: ${remoteJid}`);
        continue;
      }

      // Skip messages we sent (prevents loop in selfChatMode)
      if (this.sentMessageIds.has(messageId)) {
        log.debug(`Skipped own sent message: ${messageId}`);
        this.sentMessageIds.delete(messageId);
        continue;
      }

      // Store received message for getMessage retry capability (enables "Waiting for this message" fix)
      // Must happen early so even messages we skip are available for protocol-level retries
      if (m.key?.id && m.message) {
        this.messageStore.set(m.key.id, m);
        // Auto-cleanup after 24 hours
        const storedId = m.key.id;
        setTimeout(() => {
          this.messageStore.delete(storedId);
        }, 24 * 60 * 60 * 1000);
      }

      // Build dedupe key (but don't check yet - wait until after extraction succeeds)
      const dedupeKey = `whatsapp:${remoteJid}:${messageId}`;

      // Detect self-chat
      const isSelfChat = isSelfChatMessage(
        m,
        this.myJid,
        this.myNumber,
        this.config.selfChatMode || false
      );

      log.debug(`Message: remoteJid=${remoteJid}, fromMe=${m.key.fromMe}, isSelfChat=${isSelfChat}, selfChatMode=${this.config.selfChatMode}, myJid=${this.myJid}, myNumber=${this.myNumber}`);

      // Track self-chat LID for reply conversion
      if (isSelfChat && isLid(remoteJid)) {
        this.selfChatLid = remoteJid;
      }

      // Skip own messages (unless selfChatMode enabled for self-chat)
      if (m.key.fromMe) {
        if (!(this.config.selfChatMode && isSelfChat)) {
          log.debug(`DROPPED: fromMe=true but not (selfChatMode && isSelfChat)`);
          continue;
        }
      }

      // Capture LID -> real JID mapping from senderPn
      if (isLid(remoteJid) && (m.key as any).senderPn) {
        this.lidToJid.set(remoteJid, (m.key as any).senderPn);
      }

      // Type safety: Socket must be available
      if (!this.sock) continue;

      // CRITICAL: Extract message BEFORE deduplication
      // This allows failed messages (Bad MAC, decryption errors) to retry after session renegotiation
      let extracted;
      try {
        extracted = await extractInboundMessage(
          m,
          this.sock,
          this.groupMetaCache,
          // Pass attachment config if enabled
          this.attachmentsDir && this.downloadContentFromMessage ? {
            downloadContentFromMessage: this.downloadContentFromMessage,
            attachmentsDir: this.attachmentsDir,
            attachmentsMaxBytes: this.attachmentsMaxBytes,
          } : undefined
        );
      } catch (err) {
        // Extraction threw error (e.g., Bad MAC during session renegotiation)
        // Skip without marking as seen → WhatsApp will retry after session fix
        log.debug(`DROPPED: extraction threw error:`, err);
        continue;
      }

      if (!extracted) {
        // Extraction returned null (no text, invalid format, or decryption failure)
        // Skip without marking as seen → allows retry on next attempt
        log.debug(`DROPPED: extraction returned null (no text/media)`);
        continue;
      }

      // Deduplicate ONLY after successful extraction
      // Why: If we dedupe first, failed messages get marked as "seen" and are lost forever
      // With this order: Failed messages can retry after WhatsApp renegotiates the session
      if (this.dedupeCache.check(dedupeKey)) {
        log.debug(`DROPPED: duplicate message ${dedupeKey}`);
        continue; // Duplicate message - skip
      }

      const { body, from, chatId, pushName, senderE164, chatType, isSelfChat: isExtractedSelfChat } = extracted;
      const userId = normalizePhoneForStorage(from);
      const isGroup = chatType === "group";

      // CRITICAL: Skip messages older than connection time (prevents duplicate responses on reconnect)
      const messageTimestampMs = extracted.timestamp.getTime();
      if (messageTimestampMs < this.connectedAtMs) {
        log.debug(`DROPPED: old message (msgTime=${messageTimestampMs}, connectedAt=${this.connectedAtMs}, diff=${messageTimestampMs - this.connectedAtMs}ms)`);
        // This is an old message from before we connected - mark as read but don't auto-reply
        if (messageId && !isExtractedSelfChat && this.sock) {
          await sendReadReceipt(this.sock, remoteJid, messageId, m.key?.participant);
        }
        continue;
      }

      log.debug(`Post-extraction: from=${from}, chatId=${chatId}, isGroup=${isGroup}, isExtractedSelfChat=${isExtractedSelfChat}, body="${body.slice(0, 50)}"`);

      // Check access control for DMs only (groups are open, self-chat always allowed)
      if (!isGroup && !isExtractedSelfChat) {
        // If selfChatMode is enabled, ONLY respond to self-chat messages
        if (this.config.selfChatMode) {
          log.debug(`DROPPED: selfChatMode=true but isExtractedSelfChat=false (from=${from}, selfE164=${extracted.selfE164})`);
          continue; // Silently ignore all non-self messages
        }

        // Type safety: sock must be available for access control
        if (!this.sock) {
          log.warn('Socket not available for access control');
          continue;
        }

        const access = await checkInboundAccess({
          remoteJid,
          userId,
          pushName,
          isGroup,
          isSelfChat: isExtractedSelfChat || false,
          dmPolicy: this.config.dmPolicy || "pairing",
          allowedUsers: this.config.allowedUsers,
          selfChatMode: this.config.selfChatMode,
          sock: this.sock,
          // Group policy parameters
          senderE164: extracted.senderE164,
          groupPolicy: this.config.groupPolicy,
          groupAllowFrom: this.config.groupAllowFrom,
        });

        if (!access.allowed) {
          // Send pairing message if needed
          if (access.sendPairingMsg && access.pairingCode) {
            await this.sock.sendMessage(remoteJid, {
              text: formatPairingMessage(access.pairingCode),
            });
          }
          continue;
        }
      }

      // For Business accounts, extract LID from group participants if not already known
      if (isGroup && !this.myLid && this.sock) {
        try {
          const groupMetadata = await this.getGroupMetadata(remoteJid);
          const botParticipant = groupMetadata.participants?.find((p: any) =>
            p.jid?.includes(this.myNumber)
          );
          if (botParticipant?.lid) {
            this.myLid = botParticipant.lid;
            log.info(`Discovered bot LID from group participants`);
          }
        } catch (err) {
          log.warn('Could not fetch group metadata for LID extraction:', err);
        }
      }

      // Apply group gating (mention detection + allowlist)
      let wasMentioned = false;
      let isListeningMode = false;
      if (isGroup) {
        const gatingResult = applyGroupGating({
          msg: extracted,
          groupJid: remoteJid,
          senderId: userId,
          selfJid: this.myJid,
          selfLid: this.myLid,
          selfE164: this.myNumber,
          groupsConfig: this.config.groups,
          mentionPatterns: this.config.mentionPatterns,
        });

        if (!gatingResult.shouldProcess) {
          if (gatingResult.reason === 'no-groups-config' && !this.loggedNoGroupsHint) {
            log.info(`Group messages ignored (no groups config). Add a "groups" section to your agent config to enable.`);
            this.loggedNoGroupsHint = true;
          } else if (gatingResult.reason !== 'no-groups-config') {
            log.info(`Group message skipped: ${gatingResult.reason}`);
          }
          continue;
        }

        wasMentioned = gatingResult.wasMentioned ?? false;
        isListeningMode = gatingResult.mode === 'listen' && !wasMentioned;
      }

      // Set mention status for agent context
      extracted.wasMentioned = wasMentioned;

      // Skip auto-reply for history messages
      const isHistory = type === "append";

      // Send read receipts (unless self-chat)
      if (messageId && !isExtractedSelfChat && this.sock) {
        await sendReadReceipt(
          this.sock,
          remoteJid,
          messageId,
          m.key?.participant ?? undefined
        );
      }

      // Handle slash commands (before debouncing)
      const command = parseCommand(body);
      if (command && !isHistory) {
        if (command === 'help' || command === 'start') {
          await this.sendMessage({ chatId, text: HELP_TEXT });
        } else if (this.onCommand) {
          const result = await this.onCommand(command);
          if (result) await this.sendMessage({ chatId, text: result });
        }
        return; // Don't pass commands to agent
      }

      // Debounce and forward to bot core (unless history)
      if (!isHistory) {
        await this.debouncer.enqueue({
          channel: "whatsapp",
          chatId,
          userId,
          userName: pushName || undefined,
          messageId: m.key?.id || undefined,
          text: body,
          timestamp: extracted.timestamp,
          isGroup,
          groupName: extracted.groupSubject,
          wasMentioned: extracted.wasMentioned,
          isListeningMode,
          replyToUser: extracted.replyContext?.senderE164,
          attachments: extracted.attachments,
        });
      }
    }
  }

  // ==========================================================================
  // WATCHDOG TIMER
  // ==========================================================================

  /**
   * Start watchdog timer to detect stale connections.
   */
  private startWatchdog(): void {
    this.stopWatchdog();
    this.lastMessageTime = new Date();

    this.watchdogTimer = setInterval(() => {
      if (!this.lastMessageTime) return;

      const elapsed = Date.now() - this.lastMessageTime.getTime();
      const THIRTY_MINUTES = 30 * 60 * 1000;

      if (elapsed > THIRTY_MINUTES) {
        log.warn(
          "[WhatsApp] Watchdog: No messages in 30 minutes, forcing reconnect"
        );
        this.forceDisconnect("watchdog-timeout");
      }
    }, 60000); // Check every minute
  }

  /**
   * Stop watchdog timer.
   */
  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  // ==========================================================================
  // CRYPTO ERROR HANDLER
  // ==========================================================================

  /**
   * Check if an error is likely a WhatsApp crypto/session error.
   */
  private isLikelyWhatsAppCryptoError(reason: unknown): boolean {
    // Format the reason into a searchable string
    let raw = "";
    if (reason instanceof Error) {
      raw = `${reason.message}\n${reason.stack ?? ""}`;
    } else if (typeof reason === "string") {
      raw = reason;
    } else if (reason && typeof reason === "object") {
      try {
        raw = JSON.stringify(reason);
      } catch {
        raw = String(reason);
      }
    } else {
      raw = String(reason ?? "");
    }

    const haystack = raw.toLowerCase();

    // Check for auth/crypto error patterns
    const hasAuthError =
      haystack.includes("unsupported state or unable to authenticate data") ||
      haystack.includes("bad mac") ||
      haystack.includes("failed to decrypt") ||
      haystack.includes("session error");

    if (!hasAuthError) {
      return false;
    }

    // Verify it's from Baileys/signal library
    return (
      haystack.includes("@whiskeysockets/baileys") ||
      haystack.includes("baileys") ||
      haystack.includes("noise-handler") ||
      haystack.includes("aesdecryptgcm") ||
      haystack.includes("signal") ||
      haystack.includes("libsignal")
    );
  }

  /**
   * Register handler for crypto errors.
   *
   * IMPORTANT: "Bad MAC" and session renegotiation errors are NORMAL Signal Protocol behavior.
   * Baileys handles these internally - we just log them and mark as handled to prevent crashes.
   *
   * Based on OpenClaw's approach: log but DON'T force reconnect.
   */
  private registerCryptoErrorHandler(): void {
    this.cryptoErrorHandler = (reason: any) => {
      if (!this.isLikelyWhatsAppCryptoError(reason)) {
        return;
      }

      const errorStr =
        reason instanceof Error
          ? reason.message
          : String(reason ?? "").slice(0, 200);

      // Silently ignore - these are normal Signal Protocol session renegotiations
      // Forcing reconnect would destroy session keys and cause "Waiting for this message" errors
      // No logging needed - this is just crypto noise

      // Don't call forceDisconnect() - let Baileys handle it internally
    };

    process.on("unhandledRejection", this.cryptoErrorHandler);
  }

  /**
   * Unregister crypto error handler.
   */
  private unregisterCryptoErrorHandler(): void {
    if (this.cryptoErrorHandler) {
      process.off("unhandledRejection", this.cryptoErrorHandler);
      this.cryptoErrorHandler = null;
    }
  }

  /**
   * Force a disconnect to trigger reconnection.
   */
  private forceDisconnect(reason: string): void {
    log.info("Triggering disconnect:", reason);
    if (this.disconnectSignal) {
      this.disconnectSignal();
    }
  }

  // ==========================================================================
  // CHANNEL ADAPTER INTERFACE
  // ==========================================================================

  async sendMessage(msg: OutboundMessage): Promise<{ messageId: string }> {
    if (!this.sock) throw new Error("WhatsApp not connected");

    // Build LID mapper
    const lidMapper: LidMapper = {
      selfChatLid: this.selfChatLid,
      myNumber: this.myNumber,
      lidToJid: this.lidToJid,
      messageStore: this.messageStore, // Pass store for saving sent messages
    };

    // Delegate to extracted module
    return await sendWhatsAppMessage(
      this.sock,
      msg,
      lidMapper,
      this.sentMessageIds
    );
  }

  getDmPolicy(): string {
    return this.config.dmPolicy || 'pairing';
  }

  supportsEditing(): boolean {
    return false;
  }

  async editMessage(
    _chatId: string,
    _messageId: string,
    _text: string
  ): Promise<void> {
    // WhatsApp doesn't support editing messages - no-op
  }

  async addReaction(_chatId: string, _messageId: string, _emoji: string): Promise<void> {
    // WhatsApp reactions via Baileys are not supported here yet
    log.warn('addReaction not implemented -- directive skipped');
  }

  async sendFile(file: OutboundFile): Promise<{ messageId: string }> {
    if (!this.sock) {
      throw new Error("WhatsApp not connected");
    }

    const lidMapper: LidMapper = {
      selfChatLid: this.selfChatLid,
      myNumber: this.myNumber,
      lidToJid: this.lidToJid,
      messageStore: this.messageStore,
    };

    return await sendWhatsAppFile(this.sock, file, lidMapper, this.sentMessageIds);
  }

  async sendTypingIndicator(chatId: string): Promise<void> {
    if (!this.sock) return;
    await sendTypingIndicator(this.sock, chatId);
  }

  async stopTypingIndicator(chatId: string): Promise<void> {
    if (!this.sock) return;
    await stopTypingIndicator(this.sock, chatId);
  }
}

// Export types and config
export type { WhatsAppConfig };

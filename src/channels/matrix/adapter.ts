/**
 * Matrix Adapter - Main Implementation
 */

import type { ChannelAdapter } from "../types.js";
import type { InboundMessage, OutboundMessage, OutboundFile } from "../../core/types.js";
import { createLogger } from "../../logger.js";
import * as sdk from "matrix-js-sdk";
import { RoomMemberEvent, RoomEvent, ClientEvent } from "matrix-js-sdk";
import * as fs from "fs";

import { MatrixSessionManager } from "./session.js";
import { initE2EE, getCryptoCallbacks, checkAndRestoreKeyBackup } from "./crypto.js";
import { formatMatrixHTML } from "./html-formatter.js";
import { handleTextMessage } from "./handlers/message.js";
import { handleMembershipEvent } from "./handlers/invite.js";
import { handleReactionEvent } from "./handlers/reaction.js";
import { handleAudioMessage } from "./handlers/audio.js";
import { handleImageMessage } from "./handlers/image.js";
import { handleFileMessage } from "./handlers/file.js";
import { MatrixCommandProcessor } from "./commands.js";
// (pairing store used by handlers/message.ts directly)
import { synthesizeSpeech } from "./tts.js";
import { MatrixVerificationHandler } from "./verification.js";
type VerificationRequest = sdk.Crypto.VerificationRequest;

import type { MatrixAdapterConfig } from "./types.js";
import { DEFAULTS, SPECIAL_REACTIONS } from "./types.js";
import { MsgType } from "matrix-js-sdk";
import { MatrixStorage } from "./storage.js";
import { resolveEmoji } from "../shared/emoji.js";
import { buildAttachmentPath } from "../attachments.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

// Content types for Matrix events (using any to avoid import issues)
type RoomMessageEventContent = any;
type ReactionEventContent = any;

const log = createLogger('Matrix');

export class MatrixAdapter implements ChannelAdapter {
  readonly id = "matrix" as const;
  readonly name = "Matrix";

  private config: Required<Omit<MatrixAdapterConfig, "password" | "accessToken" | "deviceId" | "recoveryKey" | "sttUrl" | "ttsUrl" | "messagePrefix" | "userDeviceId" | "attachmentsDir" | "attachmentsMaxBytes" | "uploadDir">> & {
    password?: string;
    accessToken?: string;
    deviceId?: string;
    recoveryKey?: string;
    sttUrl?: string;
    ttsUrl?: string;
    messagePrefix?: string;
    userDeviceId?: string;
    attachmentsDir?: string;
    attachmentsMaxBytes?: number;
    uploadDir?: string;
  };

  private sessionManager: MatrixSessionManager;
  private client: sdk.MatrixClient | null = null;
  private deviceId: string | null = null;
  private running = false;
  private initialSyncDone = false;
  private pendingImages: Map<string, { eventId: string; roomId: string; imageData: Buffer; format: string; timestamp: number }> = new Map();
  private ourAudioEvents: Set<string> = new Set();
  // Rooms waiting for a TTS response — set when a voice message is received, consumed in sendMessage
  private pendingVoiceRooms: Set<string> = new Set();
  private verificationHandler: MatrixVerificationHandler | null = null;
  private pendingEncryptedEvents: Map<string, sdk.MatrixEvent> = new Map();
  private storage: MatrixStorage;
  private commandProcessor!: MatrixCommandProcessor;
  private _heartbeatEnabled = true;
  private _pruningTimer: NodeJS.Timeout | null = null;

  onMessage?: (msg: InboundMessage) => Promise<void>;
  onCommand?: (command: string, chatId?: string, args?: string) => Promise<string | null>;
  // Heartbeat toggle callbacks — wired by main.ts after heartbeatService is created
  onHeartbeatStop?: () => void;
  onHeartbeatStart?: () => void;
  onTimeoutHeartbeat?: () => void;

  constructor(config: MatrixAdapterConfig) {
    if (!config.homeserverUrl) throw new Error("homeserverUrl is required");
    if (!config.userId) throw new Error("userId is required");
    if (!config.password && !config.accessToken) {
      throw new Error("Either password or accessToken is required");
    }

    const storeDir = config.storeDir || config.sessionDir || "./data/matrix";
    this.config = {
      homeserverUrl: config.homeserverUrl,
      userId: config.userId,
      accessToken: config.accessToken ?? undefined,
      password: config.password ?? undefined,
      deviceId: config.deviceId ?? undefined,
      recoveryKey: config.recoveryKey ?? undefined,
      dmPolicy: config.dmPolicy || "pairing",
      allowedUsers: config.allowedUsers || [],
      selfChatMode: config.selfChatMode !== false,
      enableEncryption: config.enableEncryption !== false,
      storeDir,
      sessionFile: config.sessionFile || `${storeDir}/session.json`,
      transcriptionEnabled: config.transcriptionEnabled !== false,
      sttUrl: config.sttUrl ?? undefined,
      ttsUrl: config.ttsUrl ?? undefined,
      ttsVoice: config.ttsVoice || DEFAULTS.TTS_VOICE,
      enableAudioResponse: config.enableAudioResponse || false,
      audioRoomFilter: config.audioRoomFilter || DEFAULTS.AUDIO_ROOM_FILTER,
      imageMaxSize: config.imageMaxSize || DEFAULTS.IMAGE_MAX_SIZE,
      uploadDir: config.attachmentsDir ?? config.uploadDir ?? process.cwd(),
      enableReactions: config.enableReactions !== false,
      autoJoinRooms: config.autoJoinRooms !== false,
      messagePrefix: config.messagePrefix ?? undefined,
      userDeviceId: config.userDeviceId ?? undefined,
      enableStoragePruning: config.enableStoragePruning !== false,
      storageRetentionDays: config.storageRetentionDays ?? 30,
      storagePruningIntervalHours: config.storagePruningIntervalHours ?? 24,
      sessionDir: config.sessionDir ?? storeDir,
      streaming: config.streaming !== false,
      groupDebounceSec: config.groupDebounceSec ?? 5,
      instantGroups: config.instantGroups ?? [],
      listeningGroups: config.listeningGroups ?? [],
    };

    this.sessionManager = new MatrixSessionManager({ sessionFile: this.config.sessionFile });
    this.storage = new MatrixStorage({ dataDir: storeDir });

    log.info(`Adapter initialized for ${config.userId}`);
  }

  async start(): Promise<void> {
    if (this.running) return;

    log.info("Starting adapter...");
    await this.storage.init();

    // Instantiate command processor (after storage is ready)
    this.commandProcessor = new MatrixCommandProcessor(this.storage, {
      onHeartbeatStop: () => { this._heartbeatEnabled = false; this.onHeartbeatStop?.(); },
      onHeartbeatStart: () => { this._heartbeatEnabled = true; this.onHeartbeatStart?.(); },
      isHeartbeatEnabled: () => this._heartbeatEnabled,
      onTimeoutHeartbeat: () => this.onTimeoutHeartbeat?.(),
      onCommand: (cmd, chatId, args) => this.onCommand?.(cmd, chatId, args) ?? Promise.resolve(null),
    });

    await this.initClient();
    this.setupEventHandlers();
    await this.startSync();
    this.startPeriodicPruning();

    this.running = true;
    log.info("Adapter started successfully");
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    this.stopPeriodicPruning();

    if (this.client) {
      await this.client.stopClient();
      this.client = null;
    }

    this.running = false;
    log.info("Adapter stopped");
  }

  // ─── Storage Pruning ───────────────────────────────────────────────────────

  /**
   * Start periodic storage pruning
   */
  private startPeriodicPruning(): void {
    if (!this.config.enableStoragePruning) {
      log.info('Storage pruning disabled by config');
      return;
    }

    const intervalMs = this.config.storagePruningIntervalHours * 60 * 60 * 1000;
    log.info(`Starting periodic storage pruning (every ${this.config.storagePruningIntervalHours}h, retention ${this.config.storageRetentionDays} days)`);

    // Run immediately on startup
    this.runStoragePruning();

    // Then periodically
    this._pruningTimer = setInterval(() => {
      this.runStoragePruning();
    }, intervalMs);
  }

  /**
   * Stop periodic storage pruning
   */
  private stopPeriodicPruning(): void {
    if (this._pruningTimer) {
      clearInterval(this._pruningTimer);
      this._pruningTimer = null;
      log.info('Stopped periodic storage pruning');
    }
  }

  /**
   * Run storage pruning
   */
  private runStoragePruning(): void {
    try {
      const results = this.storage.pruneOldEntries(this.config.storageRetentionDays);

      // Log stats
      if (results && results.some(r => r.deletedCount > 0)) {
        const stats = this.storage.getPruningStats();
        log.info(`Storage stats: audio_messages=${stats.audioMessagesCount}, message_mappings=${stats.messageMappingsCount}`);
      }
    } catch (err) {
      log.error('Storage pruning error:', err);
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  async sendMessage(msg: OutboundMessage): Promise<{ messageId: string }> {
    if (!this.client) throw new Error("Matrix client not initialized");

    const { chatId, text } = msg;
    const { plain, html } = formatMatrixHTML(text);
    const htmlBody = (msg.htmlPrefix || '') + html;

    const content = {
      msgtype: MsgType.Text,
      body: this.config.messagePrefix ? `${this.config.messagePrefix}\n\n${plain}` : plain,
      format: "org.matrix.custom.html",
      formatted_body: this.config.messagePrefix ? `${this.config.messagePrefix}<br><br>${htmlBody}` : htmlBody,
    } as RoomMessageEventContent;

    const response = await this.client.sendMessage(chatId, content);
    const eventId = response.event_id;

    // Send TTS audio if this was a voice-input response or enableAudioResponse is set
    if (this.config.ttsUrl && this.shouldSendAudio(chatId)) {
      this.sendAudio(chatId, plain).catch(err => log.error('TTS failed (non-fatal):', err));
    }

    // Add 🎤 reaction so user can request TTS on demand
    if (this.config.ttsUrl) {
      this.addReaction(chatId, eventId, '🎤').catch(() => {});
    }

    return { messageId: eventId };
  }

  /**
   * Decide whether to send a TTS audio response for this room.
   * Consumes the pendingVoiceRooms flag if set (voice-input path).
   */
  private shouldSendAudio(chatId: string): boolean {
    // Voice-input path: always respond with audio regardless of audioRoomFilter
    if (this.pendingVoiceRooms.has(chatId)) {
      this.pendingVoiceRooms.delete(chatId);
      return true;
    }
    // Auto-TTS path: respect enableAudioResponse + audioRoomFilter
    if (!this.config.enableAudioResponse) return false;
    if (this.config.audioRoomFilter === 'none') return false;
    if (this.config.audioRoomFilter === 'dm_only') {
      const room = this.client?.getRoom(chatId);
      return room ? room.getJoinedMembers().length === 2 : false;
    }
    return true; // 'all'
  }

  async editMessage(chatId: string, messageId: string, text: string, htmlPrefix?: string): Promise<void> {
    if (!this.client) throw new Error("Matrix client not initialized");

    const { plain, html } = formatMatrixHTML(text);
    const htmlBody = (htmlPrefix || '') + html;
    const prefixedPlain = this.config.messagePrefix ? `${this.config.messagePrefix}\n\n${plain}` : plain;
    const prefixedHtml = this.config.messagePrefix ? `${this.config.messagePrefix}<br><br>${htmlBody}` : htmlBody;

    const editContent = {
      msgtype: MsgType.Text,
      body: `* ${prefixedPlain}`,
      format: "org.matrix.custom.html",
      formatted_body: prefixedHtml,
      "m.new_content": {
        msgtype: MsgType.Text,
        body: prefixedPlain,
        format: "org.matrix.custom.html",
        formatted_body: prefixedHtml,
      },
      "m.relates_to": {
        rel_type: sdk.RelationType.Replace,
        event_id: messageId,
      },
    } as RoomMessageEventContent;

    await this.client.sendMessage(chatId, editContent);
  }

  supportsEditing(): boolean {
    return this.config.streaming !== false; // Respect streaming config — false disables live edit updates
  }

  getDmPolicy(): string {
    return this.config.dmPolicy;
  }

  getFormatterHints(): import('../../core/types.js').FormatterHints {
    return {
      supportsReactions: true,
      supportsFiles: true,
      formatHint: 'Matrix HTML: **bold** _italic_ `code` ```code blocks``` — supports color {color|text}, spoilers ||text||, and @mentions',
    };
  }

  async sendTypingIndicator(chatId: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.sendTyping(chatId, true, 5000);
    } catch (err) {
      log.warn("Failed to send typing indicator:", err);
    }
  }

  async stopTypingIndicator(chatId: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.sendTyping(chatId, false, 0);
    } catch {
      // best-effort, ignore errors
    }
  }

  private async initClient(): Promise<void> {
    log.info("Initializing client...");

    const baseUrl = this.config.homeserverUrl;
    let session = this.sessionManager.loadSession();

    // If password is available, always do fresh login (delete old devices, create new one)
    if (this.config.password) {
      log.info('Password available, performing fresh login (deleting old devices)...');

      // Clear old session first since we're doing fresh login
      if (session) {
        log.info('Clearing old session file for fresh login...');
        try {
          fs.unlinkSync(this.config.sessionFile);
          log.info('Old session cleared');
        } catch (e) {
          // File might not exist
        }
        session = null; // Ensure we don't use old session data
      }

      const loginClient = sdk.createClient({ baseUrl: baseUrl });

      // Single login — creates one new device for this session
      const response = await loginClient.loginWithPassword(this.config.userId, this.config.password);

      this.client = sdk.createClient({
        baseUrl: baseUrl,
        userId: response.user_id,
        accessToken: response.access_token,
        deviceId: response.device_id ?? this.config.deviceId ?? undefined,
        cryptoCallbacks: this.config.recoveryKey ? getCryptoCallbacks(this.config.recoveryKey) : undefined,
      });

      this.deviceId = response.device_id || this.config.deviceId || null;
      log.info(`Fresh login complete (new device: ${this.deviceId})`);

      // Aggressive device cleanup (mirrors restart.sh logic):
      // Delete ALL devices except our new device and the user's Element session.
      // This catches ANI_*, lettabot*, and any other legacy/orphaned bot devices.
      try {
        const devices = await this.client.getDevices();
        const devicesToDelete = devices?.devices?.filter((d: any) => {
          // Keep our current device
          if (d.device_id === response.device_id) return false;
          // Keep the user's Element/Firefox session
          if (this.config.userDeviceId && d.device_id === this.config.userDeviceId) return false;
          // Delete everything else
          return true;
        }) || [];
        if (devicesToDelete.length > 0) {
          log.info(`Cleaning up ${devicesToDelete.length} old device(s): ${devicesToDelete.map((d: any) => d.device_id).join(', ')}`);
          for (const device of devicesToDelete) {
            try {
              await this.client.deleteDevice(device.device_id, {
                type: 'm.login.password',
                user: this.config.userId,
                password: this.config.password,
              });
              log.info(`✓ Deleted device: ${device.device_id}`);
            } catch (err) {
              log.warn(`Failed to delete device ${device.device_id}: ${err}`);
            }
          }
        } else {
          log.info('No old devices to clean up');
        }
      } catch (err) {
        log.warn(`Unable to fetch device list for cleanup: ${err}`);
      }

      this.sessionManager.saveSession({
        userId: response.user_id,
        deviceId: this.deviceId!,
        accessToken: response.access_token,
        homeserver: this.config.homeserverUrl,
        timestamp: new Date().toISOString(),
      });
    } else if (session?.accessToken) {
      // No password, try to restore existing session
      this.client = sdk.createClient({
        baseUrl: baseUrl,
        userId: session.userId,
        accessToken: session.accessToken,
        deviceId: session.deviceId ?? this.config.deviceId ?? undefined,
        cryptoCallbacks: this.config.recoveryKey ? getCryptoCallbacks(this.config.recoveryKey) : undefined,
      });
      this.deviceId = session.deviceId || this.config.deviceId || null;
      log.info(`Session restored (device: ${this.deviceId})`);
    } else {
      throw new Error("Either accessToken or password is required");
    }

    // Export Matrix credentials to env so lettabot-message CLI (used by agent
    // via Bash during heartbeat) can send messages without separate config.
    const clientAccessToken = this.client.getAccessToken();
    if (clientAccessToken) {
      process.env.MATRIX_ACCESS_TOKEN = clientAccessToken;
      process.env.MATRIX_HOMESERVER_URL = baseUrl;
      log.info('Exported MATRIX_ACCESS_TOKEN and MATRIX_HOMESERVER_URL to env');
    }

    // Initialize built-in E2EE
    if (this.config.enableEncryption) {
      await initE2EE(this.client, {
        enableEncryption: true,
        recoveryKey: this.config.recoveryKey,
        storeDir: this.config.storeDir,
        password: this.config.password,
        userId: this.config.userId,
      });

      // Register callback for when room keys are updated (received from other devices)
      const crypto = this.client.getCrypto();
      if (crypto && (crypto as any).registerRoomKeyUpdatedCallback) {
        (crypto as any).registerRoomKeyUpdatedCallback(() => {
          log.info("Room keys updated, retrying pending decryptions...");
          this.retryPendingDecryptions();
        });
      }

      // Restore keys from backup if recovery key is available
      if (this.config.recoveryKey) {
        log.info('Recovery key available, checking key backup...');
        await checkAndRestoreKeyBackup(this.client, this.config.recoveryKey);
      }
    }
  }

  /**
   * Retry decrypting pending encrypted events after receiving new keys
   */
  private async retryPendingDecryptions(): Promise<void> {
    if (!this.client || this.pendingEncryptedEvents.size === 0) return;

    log.info(`Retrying ${this.pendingEncryptedEvents.size} pending decryptions...`);
    const eventsToRetry = new Map(this.pendingEncryptedEvents);
    this.pendingEncryptedEvents.clear();

    for (const [eventId, event] of Array.from(eventsToRetry.entries())) {
      try {
        // Try to get decrypted content now
        const clearContent = event.getClearContent();
        if (clearContent) {
          log.info(`Successfully decrypted event ${eventId} after key arrival`);
          // Process as room message
          const room = this.client.getRoom(event.getRoomId()!);
          if (room) {
            await this.handleMessageEvent(event, room);
          }
        } else {
          // Still can't decrypt, put back in queue
          this.pendingEncryptedEvents.set(eventId, event);
        }
      } catch (err) {
        log.warn(`Failed to retry decryption for ${eventId}:`, err);
        // Put back in queue for next retry
        this.pendingEncryptedEvents.set(eventId, event);
      }
    }

    // Clean up old events (keep for 5 minutes max)
    const now = Date.now();
    const maxAge = 5 * 60 * 1000;
    for (const [eventId, event] of Array.from(this.pendingEncryptedEvents.entries())) {
      const eventTime = event.getTs();
      if (now - eventTime > maxAge) {
        this.pendingEncryptedEvents.delete(eventId);
        log.info(`Dropped old pending event ${eventId}`);
      }
    }
  }

  private setupEventHandlers(): void {
    if (!this.client) return;

    this.client.on(RoomMemberEvent.Membership, (event: any, member: any) => {
      if (!this.initialSyncDone) return;
      if (this.config.autoJoinRooms) {
        handleMembershipEvent({
          client: this.client!,
          event,
          member,
          dmPolicy: this.config.dmPolicy,
          allowedUsers: this.config.allowedUsers,
          autoAccept: true,
          ourUserId: this.client?.getUserId() ?? undefined,
        }).catch((err) => log.error("Unhandled error:", err));
      }
    });

    this.client.on(RoomEvent.Timeline, async (event: any, room: any, toStartOfTimeline: any) => {
      let eventType = event.getType();

      // Always process encrypted events to request keys if needed
      // Other events can be skipped during initial sync
      if (eventType !== 'm.room.encrypted' && (toStartOfTimeline || !this.initialSyncDone)) {
        log.debug(`Timeline event skipped: toStartOfTimeline=${toStartOfTimeline}, initialSyncDone=${this.initialSyncDone}`);
        return;
      }
      if (event.getSender() === this.client?.getUserId()) {
        log.debug(`Timeline event skipped: own message`);
        return;
      }
      if (!room) {
        log.debug(`Timeline event skipped: no room`);
        return;
      }

      log.debug(`Timeline event: type=${eventType}, sender=${event.getSender()}, room=${room.roomId}`);

      // Handle encrypted events - check if SDK has decrypted them
      if (eventType === 'm.room.encrypted') {
        log.debug(`Encrypted event received, checking for decrypted content...`);

        // Try to get decrypted content
        let clearContent;
        try {
          clearContent = event.getClearContent();
        } catch (err) {
          log.warn(`getClearContent failed (crypto transaction inactive during initial sync):`, err instanceof Error ? err.message : String(err));
          // Queue for later processing when crypto is ready
          event.once("Event.decrypted" as any, async (decryptedEvent: typeof event) => {
            let retryClearContent;
            try {
              retryClearContent = decryptedEvent.getClearContent();
            } catch (retryErr) {
              log.warn(`getClearContent failed on decrypted event:`, retryErr instanceof Error ? retryErr.message : String(retryErr));
              return;
            }
            if (retryClearContent) {
              log.info(`Event ${decryptedEvent.getId()} decrypted after crypto ready!`);
              // Process the now-decrypted event
              const decryptedRoom = this.client?.getRoom(decryptedEvent.getRoomId()!);
              if (decryptedRoom) {
                await this.handleMessageEvent(decryptedEvent, decryptedRoom);
              }
            }
          });
          this.requestRoomKey(event).catch((err) => {
            log.warn("Failed to request room key:", err instanceof Error ? err.message : String(err));
          });
          return;
        }

        if (clearContent) {
          // SDK has decrypted this event - get the actual event type from the decrypted content
          // We need to check if there's a msgtype to determine what kind of message this is
          const msgtype = (clearContent as any).msgtype;
          log.debug(`Event decrypted by SDK, msgtype=${msgtype}`);

          // Treat decrypted events as room messages for processing
          // The actual content will be extracted in handleMessageEvent
          eventType = sdk.EventType.RoomMessage;
        } else {
          log.debug(`SDK couldn't decrypt event yet, waiting for keys...`);
          // Listen for when this specific event gets decrypted
          event.once("Event.decrypted" as any, async (decryptedEvent: typeof event) => {
            let decryptedClearContent;
            try {
              decryptedClearContent = decryptedEvent.getClearContent();
            } catch (retryErr) {
              log.warn(`getClearContent failed on decrypted event:`, retryErr instanceof Error ? retryErr.message : String(retryErr));
              return;
            }
            if (decryptedClearContent) {
              log.info(`Event ${decryptedEvent.getId()} decrypted after key arrival!`);
              // Process the now-decrypted event
              const decryptedRoom = this.client?.getRoom(decryptedEvent.getRoomId()!);
              if (decryptedRoom) {
                await this.handleMessageEvent(decryptedEvent, decryptedRoom);
              }
            }
          });
          // Request keys from other devices
          this.requestRoomKey(event).catch((err) => {
            log.warn("Failed to request room key:", err instanceof Error ? err.message : String(err));
          });
          return; // Skip immediate processing - will handle when Event.decrypted fires
        }
      }

      try {
        // Handle verification requests that come through room timeline
        if (eventType === 'm.key.verification.request') {
          log.debug(`Verification request received in room timeline from ${event.getSender()}`);
          return; // Don't process as regular message - verification handler will handle it
        }

        // Handle room key events - these are crucial for decryption
        if (eventType === 'm.room_key' || eventType === 'm.forwarded_room_key') {
          const keyContent = event.getContent();
          log.debug(`Room key received from ${event.getSender()}:`);
          log.debug(`  Room: ${keyContent.room_id}`);
          log.debug(`  Session: ${keyContent.session_id}`);
          log.debug(`  Algorithm: ${keyContent.algorithm}`);
          log.debug(`  Sender Key: ${keyContent.sender_key?.substring(0, 16)}...`);
          // Retry any pending decryptions now that we have new keys
          this.retryPendingDecryptions();
          return;
        }

        switch (eventType) {
          case sdk.EventType.RoomMessage:
            await this.handleMessageEvent(event, room);
            break;
          case sdk.EventType.Reaction:
            await handleReactionEvent({
              client: this.client!,
              event,
              ourUserId: this.client!.getUserId()!,
              storage: this.storage,
              sendMessage: async (roomId, text) => {
                await this.sendMessage({ chatId: roomId, text });
              },
              regenerateTTS: async (text, roomId) => {
                await this.regenerateTTS(text, roomId);
              },
              forwardToLetta: async (text, roomId, sender) => {
                if (this.onMessage) {
                  await this.onMessage({
                    channel: 'matrix',
                    chatId: roomId,
                    userId: sender,
                    text,
                    timestamp: new Date(),
                  });
                }
              },
              sendPendingImageToAgent: (targetEventId, roomId, sender) => {
                // Check if this reaction targets a pending image (by eventId)
                if (!this.pendingImages.has(targetEventId)) return false;

                // Get the pending image and attach it to the synthetic message
                const pendingImage = this.getPendingImage(roomId);
                if (!pendingImage) return false;

                const isDm = room.getJoinedMembers().length === 2;
                setImmediate(() => {
                  const synthetic: InboundMessage = {
                    channel: 'matrix',
                    chatId: roomId,
                    userId: sender,
                    userName: room.getMember(sender)?.name || sender,
                    userHandle: sender,
                    text: '[Image]',
                    timestamp: new Date(),
                    isGroup: !isDm,
                    groupName: isDm ? undefined : (room.name || roomId),
                  };
                  // Save image to disk for upstream compatibility
                  const uploadDir = this.config.uploadDir ?? process.cwd();
                  const filename = `image-${Date.now()}.${pendingImage.format}`;
                  const localPath = buildAttachmentPath(uploadDir, 'matrix', roomId, filename);
                  try {
                    mkdirSync(localPath.substring(0, localPath.lastIndexOf('/')), { recursive: true });
                    writeFileSync(localPath, pendingImage.imageData);
                    synthetic.attachments = [{
                      kind: 'image',
                      mimeType: `image/${pendingImage.format}`,
                      localPath,
                    }];
                  } catch (saveErr) {
                    log.error(`Failed to save image to ${localPath}:`, saveErr);
                  }
                  this.onMessage?.(this.enrichWithConversation(synthetic, room));
                });
                return true;
              },
            });
            break;
        }
      } catch (err) {
        log.error("Error handling event:", err);
      }
    });

    this.client.on(ClientEvent.Sync, (state: any) => {
      log.info(`Sync state: ${state}`);
      if (state === "PREPARED" || state === "SYNCING") {
        if (!this.initialSyncDone) {
          this.initialSyncDone = true;
          log.info("Initial sync complete");
          // Run post-sync setup in background (non-blocking)
          this.runPostSyncSetup().catch((err) => {
            log.error("Post-sync setup failed:", err);
          });
        }
      }
    });
  }

  private setupVerificationHandler(): void {
    if (!this.client) return;

    this.verificationHandler = new MatrixVerificationHandler(this.client, {
      onShowSas: (emojis) => {
        log.info(`*** EMOJI VERIFICATION ***`);
        log.info(`${emojis.join(" | ")}`);
      },
      onComplete: () => {
        log.info(`*** VERIFICATION COMPLETE! ***`);
      },
      onCancel: (reason) => {
        log.info(`*** VERIFICATION CANCELLED: ${reason} ***`);
      },
      onError: (err) => {
        log.error(`Verification error:`, err);
      },
    });

    // CRITICAL: Setup event handlers for verification
    // This MUST be called before client.startClient()
    this.verificationHandler.setupEventHandlers();
  }

  /**
   * Auto-trust all devices for this user (similar to Python's TrustState.UNVERIFIED)
   * This allows the bot to decrypt messages without interactive verification
   */
  private async runPostSyncSetup(): Promise<void> {
    log.info("Running post-sync setup...");
    try {
      // Auto-trust all devices for this user
      await this.autoTrustDevices();
    } catch (err) {
      log.error("autoTrustDevices failed:", err);
    }
    try {
      // Check if backup exists before attempting restore (prevents uncaught errors)
      if (this.config.recoveryKey && this.client) {
        const crypto = this.client.getCrypto();
        if (crypto) {
          try {
            const backupVersion = await this.client.getKeyBackupVersion();
            if (backupVersion) {
              log.info("Key backup found on server, attempting restore...");
              await this.restoreKeysFromBackup();
            } else {
              log.info("No key backup on server, skipping restore");
            }
          } catch (backupErr: any) {
            if (backupErr.errcode === 'M_NOT_FOUND' || backupErr.httpStatus === 404) {
              log.info("Key backup not found on server, skipping restore");
            } else {
              log.warn("Error checking key backup:", backupErr);
            }
          }
        }
      }
    } catch (err) {
      log.error("restoreKeysFromBackup failed:", err);
    }
    try {
      // Import room keys from file if available
      await this.importRoomKeysFromFile();
    } catch (err) {
      log.error("importRoomKeysFromFile failed:", err);
    }
    try {
      // Initiate proactive verification
      await this.initiateProactiveVerification();
    } catch (err) {
      log.error("initiateProactiveVerification failed:", err);
    }
    log.info("Post-sync setup complete");
  }

  private async autoTrustDevices(): Promise<void> {
    if (!this.client) return;
    const crypto = this.client.getCrypto();
    if (!crypto) return;

    const userId = this.client.getUserId();
    if (!userId) return;

    try {
      log.info("Auto-trusting devices for", userId);

      // Get all devices for this user
      const devices = await crypto.getUserDeviceInfo([userId]);
      const userDevices = devices.get(userId);

      if (!userDevices) {
        log.info("No devices found for user");
        return;
      }

      for (const [deviceId, deviceInfo] of Array.from(userDevices.entries())) {
        if (deviceId === this.client.getDeviceId()) {
          // Skip our own device
          continue;
        }

        // Check if already verified
        const status = await crypto.getDeviceVerificationStatus(userId, deviceId);
        if (!status?.isVerified()) {
          log.info(`Marking device ${deviceId} as verified`);
          await crypto.setDeviceVerified(userId, deviceId, true);
        }
      }

      log.info("Device trust setup complete");
    } catch (err) {
      log.error("Failed to auto-trust devices:", err);
    }
  }

  /**
   * Import room keys from exported file
   * This allows decryption of messages from Element export
   */
  private async importRoomKeysFromFile(): Promise<void> {
    if (!this.client) return;

    const fs = await import('fs');
    const path = await import('path');

    // Check for pre-decrypted keys first (from import-casey-keys.ts)
    const storeDir = path.resolve(this.config.storeDir || './data/matrix');
    const decryptedKeysFile = path.join(storeDir, 'imported-keys.json');

    if (fs.existsSync(decryptedKeysFile)) {
      log.info("Found pre-decrypted keys at", decryptedKeysFile);
      try {
        const keysData = fs.readFileSync(decryptedKeysFile, 'utf8');
        const keys = JSON.parse(keysData);
        log.info(`Importing ${keys.length} pre-decrypted room keys...`);

        const crypto = this.client.getCrypto();
        if (crypto) {
          await crypto.importRoomKeys(keys);
          log.info("✓ Room keys imported successfully!");
          // Rename file to indicate it's been imported
          fs.renameSync(decryptedKeysFile, decryptedKeysFile + '.imported');
          return;
        }
      } catch (err) {
        log.warn("Failed to import pre-decrypted keys:", err);
      }
    }

    log.info("No pre-decrypted key file found");
  }

  /**
   * Decrypt Megolm export file using recovery key
   */
  private async decryptMegolmExport(data: Buffer, key: Uint8Array): Promise<string> {
    // Element exports use a specific format:
    // 1. Base64 encoded data
    // 2. Encrypted with AES-GCM
    // 3. Key derived from recovery key

    // Extract base64 content
    const content = data.toString('utf8');
    const lines = content.trim().split('\n');
    const base64Data = lines.slice(1, -1).join('');  // Remove BEGIN/END markers

    // Decode base64
    const encrypted = Buffer.from(base64Data, 'base64');

    // For now, just return as-is and let the SDK handle it
    // The SDK's importRoomKeys may handle the decryption
    return encrypted.toString('utf8');
  }

  /**
   * Restore room keys from backup after sync completes
   * This is needed to decrypt historical messages
   */
  private async restoreKeysFromBackup(): Promise<void> {
    if (!this.client || !this.config.recoveryKey) return;

    const crypto = this.client.getCrypto();
    if (!crypto) return;

    log.info("Checking key backup after sync...");
    try {
      // Get backup info without requiring it to be trusted
      const { decodeRecoveryKey } = await import("matrix-js-sdk/lib/crypto/recoverykey.js");
      const backupKey = decodeRecoveryKey(this.config.recoveryKey);

      // First, try to enable backup by storing the key
      try {
        await crypto.storeSessionBackupPrivateKey(backupKey);
        log.info("Backup key stored in session");
      } catch (e) {
        // Key might already be stored
      }

      // Check backup info
      try {
        const backupInfo = await crypto.checkKeyBackupAndEnable();
        if (backupInfo) {
          log.info("Key backup info retrieved, attempting restore...");
          try {
            const result = await (this.client as any).restoreKeyBackup(
              backupKey,
              undefined, // all rooms
              undefined, // all sessions
              backupInfo.backupInfo,
            );
            log.info(`Restored ${result.imported} keys from backup`);
            // Retry pending decryptions with newly restored keys
            if (result.imported > 0) {
              log.info("Retrying pending decryptions after backup restore...");
              await this.retryPendingDecryptions();
            }
          } catch (restoreErr: any) {
            log.warn("Failed to restore keys from backup:", restoreErr.message || restoreErr);
            log.info("Will try to get keys from other devices via key sharing");
          }
        } else {
          log.info("No trusted key backup available - will rely on key sharing from verified devices");
        }
      } catch (backupCheckErr: any) {
        log.warn("Key backup check failed (this is expected with a new device):", backupCheckErr.message || backupCheckErr);
      }

      // CRITICAL: Wait a bit for sync to complete before proceeding
      // This allows verification to work properly
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (err: any) {
      log.warn("Key backup check failed:", err?.message || err);
    }
  }

  /**
   * Request room key from other devices when decryption fails
   */
  private async requestRoomKey(event: sdk.MatrixEvent): Promise<void> {
    if (!this.client) return;

    const content = event.getContent();
    const sender = event.getSender();
    const roomId = event.getRoomId();

    if (!content?.sender_key || !content?.session_id || !roomId) {
      log.debug(`Cannot request key: missing sender_key, session_id, or roomId`);
      return;
    }

    log.info(`Requesting room key:`);
    log.info(`  Room: ${roomId}`);
    log.info(`  Session: ${content.session_id}`);
    log.info(`  Sender Key: ${content.sender_key?.substring(0, 16)}...`);
    log.info(`  Algorithm: ${content.algorithm}`);
    log.info(`  From user: ${sender}`);

    try {
      // Use the legacy crypto's requestRoomKey via the client
      // This sends m.room_key_request to other devices
      await (this.client as any).requestRoomKey({
        room_id: roomId,
        sender_key: content.sender_key,
        session_id: content.session_id,
        algorithm: content.algorithm,
      }, [
        { userId: sender!, deviceId: '*' } // Request from all devices of the sender
      ]);
      log.info(`Room key request sent successfully`);
    } catch (err) {
      // requestRoomKey might not exist in rust crypto, that's ok
      log.info(`Room key request not supported or failed (this is expected with rust crypto)`);
    }
  }

  /**
   * Request verification with a specific device
   * Useful for proactive verification
   */
  async requestDeviceVerification(userId: string, deviceId: string): Promise<VerificationRequest> {
    if (!this.verificationHandler) {
      throw new Error("Verification handler not initialized");
    }

    log.info(`Requesting verification with ${userId}:${deviceId}`);
    return this.verificationHandler.requestVerification(userId, deviceId);
  }

  /**
   * Get current verification requests for a user
   */
  getVerificationRequests(userId: string): VerificationRequest[] {
    if (!this.verificationHandler) return [];
    return this.verificationHandler.getVerificationRequests(userId);
  }

  /**
   * Proactively initiate verification with user devices
   * This triggers Element to show the emoji verification UI
   */
  private async initiateProactiveVerification(): Promise<void> {
    if (!this.client || !this.verificationHandler) return;
    const crypto = this.client.getCrypto();
    if (!crypto) return;

    const userId = this.client.getUserId();
    if (!userId) return;

    const ownDeviceId = this.client.getDeviceId();

    try {
      log.info(`*** INITIATING PROACTIVE VERIFICATION ***`);

      // If userDeviceId is configured, send verification request directly to it
      if (this.config.userDeviceId && this.config.userDeviceId.trim()) {
        const targetDeviceId = this.config.userDeviceId.trim();

        if (targetDeviceId === ownDeviceId) {
          log.info(`userDeviceId (${targetDeviceId}) is the same as bot's device ID - skipping`);
          return;
        }

        log.info(`Using configured userDeviceId: ${targetDeviceId}`);

        try {
          log.info(`*** REQUESTING VERIFICATION with user device ${targetDeviceId} ***`);
          await this.requestDeviceVerification(userId, targetDeviceId);
          log.info(`✓ Verification request sent to ${targetDeviceId}`);
          log.info(`*** Check Element - the emoji verification UI should now appear! ***`);
          return; // Done - targeted device verified successfully
        } catch (err) {
          log.error(`Failed to request verification with configured device ${targetDeviceId}:`, err);
          log.info(`Falling back to automatic device discovery...`);
        }
        // Fall through to auto-discovery if direct request fails
      }

      // The device list query is async and may not be complete yet
      // Retry a few times with delays to get the full device list
      let userDevices: Map<string, sdk.Device> | undefined;
      let retryCount = 0;
      const maxRetries = 5;

      while (retryCount < maxRetries) {
        log.info(`Fetching device list (attempt ${retryCount + 1}/${maxRetries})...`);

        const devices = await crypto.getUserDeviceInfo([userId]);
        userDevices = devices.get(userId);

        if (!userDevices || userDevices.size === 0) {
          log.info(`No devices found for user ${userId}, retrying...`);
          await new Promise((resolve) => setTimeout(resolve, 3000));
          retryCount++;
        } else {
          log.info(`Found ${userDevices.size} device(s) for user ${userId}`);
          // Log all device IDs
          for (const [deviceId] of Array.from(userDevices.entries())) {
            log.info(`  - Device: ${deviceId}`);
          }
          break;
        }
      }

      if (!userDevices || userDevices.size === 0) {
        log.info(`No devices found for user ${userId} after ${maxRetries} attempts`);
        return;
      }

      let initiatedCount = 0;

      // Request verification with each of the user's other devices (not the bot's device)
      for (const [deviceId, deviceInfo] of Array.from(userDevices.entries())) {
        // Skip our own device
        if (deviceId === ownDeviceId) {
          log.info(`Skipping own device ${deviceId}`);
          continue;
        }

        log.info(`Checking device ${deviceId} for verification...`);
        log.info(`Device info:`, JSON.stringify(deviceInfo)); // Debug logging

        // Check if this device is already verified from our perspective
        const status = await crypto.getDeviceVerificationStatus(userId, deviceId);
        log.info(`Device ${deviceId} verification status:`, {
          isVerified: status?.isVerified(),
          localVerified: status?.localVerified,
          crossSigningVerified: status?.crossSigningVerified,
        });

        if (status && status.isVerified()) {
          log.info(`Device ${deviceId} is already verified`);
          continue;
        }

        log.info(`*** REQUESTING VERIFICATION with user device ${deviceId} ***`);
        try {
          await this.requestDeviceVerification(userId, deviceId);
          initiatedCount++;
          log.info(`✓ Verification request sent to ${deviceId}`);
        } catch (err) {
          log.warn(`Failed to request verification with ${deviceId}:`, err);
        }
      }

      if (initiatedCount > 0) {
        log.info(`✓ Successfully initiated ${initiatedCount} verification request(s)`);
        log.info(`*** Check Element - the emoji verification UI should now appear! ***`);
      } else {
        log.info(`No new verification requests initiated (all devices may be verified)`);
      }
    } catch (err) {
      log.error(`Failed to initiate proactive verification:`, err);
    }
  }

  private async handleMessageEvent(event: sdk.MatrixEvent, room: sdk.Room): Promise<void> {
    // For encrypted events, use clear content if available
    let content;
    try {
      content = event.getClearContent() || event.getContent();
    } catch (err) {
      // If crypto transaction is inactive, fall back to encrypted content
      log.warn(`Failed to get clear content, using encrypted content:`, err instanceof Error ? err.message : String(err));
      content = event.getContent();
    }
    const msgtype = content?.msgtype;
    const ourUserId = this.client!.getUserId();
    log.debug(`handleMessageEvent: msgtype=${msgtype}, ourUserId=${ourUserId}`);
    if (!ourUserId) return;

    if (msgtype === "m.text" || msgtype === "m.notice") {
      log.debug(`Processing text message from ${event.getSender()}: ${content.body?.substring(0, 50)}`);
      const result = await handleTextMessage({
        client: this.client!,
        room,
        event,
        ourUserId,
        config: {
          selfChatMode: this.config.selfChatMode,
          dmPolicy: this.config.dmPolicy,
          allowedUsers: this.config.allowedUsers,
        },
        sendMessage: async (roomId, text) => {
          await this.sendMessage({ chatId: roomId, text });
        },
        onCommand: this.onCommand,
        commandProcessor: this.commandProcessor,
      });

      if (result) {
        // Check for pending image to attach
        const pendingImage = this.getPendingImage(result.chatId);
        if (pendingImage) {
          log.debug(`Attaching pending image (${pendingImage.format}, ${pendingImage.imageData.length} bytes) to text message`);
          // Save image to disk for upstream compatibility
          const uploadDir = this.config.uploadDir ?? process.cwd();
          const filename = `image-${Date.now()}.${pendingImage.format}`;
          const localPath = buildAttachmentPath(uploadDir, 'matrix', result.chatId, filename);
          log.debug(`Writing image: ${localPath}, size=${pendingImage.imageData.length} bytes, format=${pendingImage.format}`);

          try {
            // Ensure directory exists
            const dirPath = localPath.substring(0, localPath.lastIndexOf('/'));
            mkdirSync(dirPath, { recursive: true });

            // Write image data - this MUST succeed for image handling to work
            writeFileSync(localPath, pendingImage.imageData);

            // Verify the file was written
            const fs = await import('node:fs');
            let stats = null;
            try {
              stats = fs.statSync(localPath);
            } catch {
              // statSync failed, stats stays null
            }
            if (!stats) {
              log.error(`CRITICAL: File write verification failed for ${localPath}`);
            } else {
              log.debug(`Image written successfully: ${localPath}, size=${stats.size} bytes`);
            }

            result.attachments = [{
              kind: 'image',
              mimeType: `image/${pendingImage.format}`,
              localPath,
            }];
            log.debug(`Image attached to message`);
          } catch (saveErr) {
            // Log detailed error for debugging (NOT silent - this means image is lost)
            log.error(`Failed to save image to ${localPath}:`, saveErr);
            log.error(`Error details:`, {
              error: saveErr instanceof Error ? saveErr.message : String(saveErr),
              localPath,
              imageDataLength: pendingImage?.imageData?.length ?? 0,
              format: pendingImage?.format ?? 'unknown',
              stack: saveErr instanceof Error ? saveErr.stack : undefined,
            });
            // Image is lost - this is a critical failure, re-throw for visibility
            throw saveErr;
          }
        }

        log.debug(`Sending to onMessage: chatId=${result.chatId}, text=${result.text?.substring(0, 50)}, attachments=${result.attachments?.length ?? 0}, onMessage defined=${!!this.onMessage}`);
        if (this.onMessage) {
          await this.onMessage(this.enrichWithConversation(result, room));
        } else {
          log.debug(`onMessage is not defined!`);
        }
      } else {
        log.debug(`handleTextMessage returned null - message not sent to bot`);
      }
    } else if (msgtype === "m.audio") {
      // Skip audio from known bots (their TTS) — no @mention check for audio
      const audioSender = event.getSender();
      if (audioSender && this.commandProcessor?.isIgnoredBot(audioSender)) {
        log.info(`Skipping audio from known bot ${audioSender}`);
      } else {
        await this.handleAudioMessage(event, room);
      }
    } else if (msgtype === "m.image") {
      await this.handleImageMessage(event, room);
    } else if (msgtype === "m.file") {
      await this.handleFileMessage(event, room);
    }
  }

  /**
   * Per-chat mode: chatId=roomId is all bot.ts needs to route per-room.
   * The bot derives key 'matrix:{roomId}' automatically via conversationMode: 'per-chat'.
   * This method is retained as a pass-through so call sites don't need updating.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private enrichWithConversation(result: InboundMessage, _room: sdk.Room): InboundMessage {
    return result;
  }

  private async handleFileMessage(event: sdk.MatrixEvent, room: sdk.Room): Promise<void> {
    if (!this.client) return;

    const ourUserId = this.client.getUserId();
    if (!ourUserId) return;

    const result = await handleFileMessage({
      client: this.client,
      room,
      event,
      ourUserId,
      uploadDir: this.config.uploadDir ?? process.cwd(),
      sendTyping: async (roomId, typing) => {
        await this.client!.sendTyping(roomId, typing, 30000);
      },
    });

    if (result) {
      await this.onMessage?.(this.enrichWithConversation(result, room));
    }
  }

  private async handleAudioMessage(event: sdk.MatrixEvent, room: sdk.Room): Promise<void> {
    if (!this.client) return;

    const ourUserId = this.client.getUserId();
    if (!ourUserId) return;

    const result = await handleAudioMessage({
      client: this.client,
      room,
      event,
      ourUserId,
      transcriptionEnabled: this.config.transcriptionEnabled,
      sttUrl: this.config.sttUrl,
      sendTyping: async (roomId, typing) => {
        await this.client!.sendTyping(roomId, typing, 60000);
      },
      sendMessage: async (roomId, text) => {
        await this.sendMessage({ chatId: roomId, text });
      },
    });

    if (result) {
      // Flag this room for TTS response BEFORE onMessage fires so sendMessage() sees it
      if (result.isVoiceInput) {
        this.pendingVoiceRooms.add(result.chatId);
      }
      await this.onMessage?.(this.enrichWithConversation(result, room));
    }
  }

  private async handleImageMessage(event: sdk.MatrixEvent, room: sdk.Room): Promise<void> {
    if (!this.client) return;

    const ourUserId = this.client.getUserId();
    if (!ourUserId) return;

    await handleImageMessage({
      client: this.client,
      room,
      event,
      ourUserId,
      imageMaxSize: this.config.imageMaxSize,
      sendTyping: async (roomId, typing) => {
        await this.client!.sendTyping(roomId, typing, 30000);
      },
      sendMessage: async (roomId, text) => {
        await this.sendMessage({ chatId: roomId, text });
      },
      addReaction: async (roomId, eventId, emoji) => {
        const reactionContent = {
          "m.relates_to": {
            rel_type: sdk.RelationType.Annotation as string,
            event_id: eventId,
            key: emoji,
          },
        } as ReactionEventContent;
        await this.client!.sendEvent(roomId, sdk.EventType.Reaction, reactionContent);
      },
      storePendingImage: async (eventId, roomId, imageData, format) => {
        this.pendingImages.set(eventId, {
          eventId,
          roomId,
          imageData,
          format,
          timestamp: Date.now(),
        });
      },
    });
  }

  /**
   * Upload and send audio message to room
   */
  async uploadAndSendAudio(roomId: string, audioData: Buffer): Promise<string | null> {
    if (!this.client) return null;

    try {
      // Convert Buffer to Uint8Array for upload
      const uint8Array = new Uint8Array(audioData.buffer, audioData.byteOffset, audioData.byteLength);
      const blob = new Blob([uint8Array as unknown as BlobPart], { type: "audio/mpeg" });

      const uploadResponse = await this.client.uploadContent(blob, {
        name: "response.mp3",
        type: "audio/mpeg",
      });
      const mxcUrl = uploadResponse.content_uri;

      // Extract bot name from userId (@username:server -> username)
      const botName = this.config.userId.split(":")[0].slice(1) || "Bot";
      const voiceLabel = `${botName}'s voice`;

      const content = {
        msgtype: MsgType.Audio,
        body: voiceLabel,
        url: mxcUrl,
        info: {
          mimetype: "audio/mpeg",
          size: audioData.length,
        },
      } as RoomMessageEventContent;

      const response = await this.client.sendMessage(roomId, content);
      const eventId = response.event_id;

      this.ourAudioEvents.add(eventId);
      log.info(`Audio sent: ${eventId}...`);

      // Add 🎤 reaction for TTS regeneration
      const reactionContent = {
        "m.relates_to": {
          rel_type: sdk.RelationType.Annotation as string,
          event_id: eventId,
          key: "🎤",
        },
      } as ReactionEventContent;
      await this.client.sendEvent(roomId, sdk.EventType.Reaction, reactionContent);

      return eventId;
    } catch (err) {
      log.error("Failed to send audio:", err);
      return null;
    }
  }

  /**
   * Send a file/image/audio to a Matrix room.
   * Called by bot core when processing <send-file> and <voice> directives.
   * For audio: adds 🎤 reaction and stores original text (if caption provided) for regeneration.
   */
  async sendFile(file: OutboundFile): Promise<{ messageId: string }> {
    if (!this.client) throw new Error('Matrix client not initialized');

    const { chatId, filePath, kind, caption } = file;
    const filename = basename(filePath);
    const ext = extname(filePath).toLowerCase();

    // Determine mimetype
    const mimeType = inferMatrixMimeType(ext, kind);

    // Read file from disk
    const data = await readFile(filePath);
    const blob = new Blob([new Uint8Array(data.buffer, data.byteOffset, data.byteLength)], { type: mimeType });

    const uploadResponse = await this.client.uploadContent(blob, { name: filename, type: mimeType });
    const mxcUrl = uploadResponse.content_uri;

    // Build room message content
    let msgtype: string;
    if (kind === 'image') msgtype = MsgType.Image;
    else if (kind === 'audio') msgtype = MsgType.Audio;
    else msgtype = MsgType.File;

    const content: RoomMessageEventContent = {
      msgtype,
      body: caption || filename,
      url: mxcUrl,
      info: { mimetype: mimeType, size: data.length },
    };

    const response = await this.client.sendMessage(chatId, content);
    const eventId = response.event_id;

    // For audio: add 🎤 reaction + store text if available (enables regeneration button)
    if (kind === 'audio') {
      this.ourAudioEvents.add(eventId);
      if (caption) {
        this.storage.storeAudioMessage(eventId, 'default', chatId, caption);
      }
      const reactionContent: ReactionEventContent = {
        "m.relates_to": {
          rel_type: sdk.RelationType.Annotation as string,
          event_id: eventId,
          key: "🎤",
        },
      };
      await this.client.sendEvent(chatId, sdk.EventType.Reaction, reactionContent);
    }

    log.info(`sendFile: sent ${kind ?? 'file'} ${filename} → ${eventId} in ${chatId}`);
    return { messageId: eventId };
  }

  /**
   * Regenerate TTS for a text message
   */
  async regenerateTTS(text: string, roomId: string): Promise<string | null> {
    if (!this.client || !this.config.ttsUrl) return null;

    try {
      const audioData = await synthesizeSpeech(text, {
        url: this.config.ttsUrl,
        voice: this.config.ttsVoice,
      });

      const audioEventId = await this.uploadAndSendAudio(roomId, audioData);
      if (audioEventId) {
        // Store mapping so 🎤 on the regenerated audio works too
        this.storage.storeAudioMessage(audioEventId, "default", roomId, text);
      }
      return audioEventId;
    } catch (err) {
      log.error("Failed to regenerate TTS:", err);
      return null;
    }
  }

  /**
   * Store audio message text for 🎤 reaction regeneration
   */
  storeAudioMessage(messageId: string, conversationId: string, roomId: string, text: string): void {
    this.storage.storeAudioMessage(messageId, conversationId, roomId, text);
  }

  /**
   * Send TTS audio for a text response
   */
  async sendAudio(chatId: string, text: string): Promise<void> {
    if (!this.config.ttsUrl) return;

    try {
      const audioData = await synthesizeSpeech(text, {
        url: this.config.ttsUrl,
        voice: this.config.ttsVoice,
      });

      const audioEventId = await this.uploadAndSendAudio(chatId, audioData);
      if (audioEventId) {
        // Store for 🎤 regeneration
        this.storage.storeAudioMessage(audioEventId, "default", chatId, text);
      }
    } catch (err) {
      log.error("TTS failed (non-fatal):", err);
    }
  }

  /**
   * Get and consume a pending image for a room
   */
  getPendingImage(chatId: string): { imageData: Buffer; format: string } | null {
    for (const [key, img] of this.pendingImages.entries()) {
      if (img.roomId === chatId) {
        this.pendingImages.delete(key);
        return { imageData: img.imageData, format: img.format };
      }
    }
    return null;
  }

  /**
   * Track a sent message for reaction feedback
   */
  onMessageSent(chatId: string, messageId: string, stepId?: string): void {
    this.storage.storeMessageMapping(messageId, "default", stepId, "@ani:wiuf.net", chatId);
  }

  /**
   * Add an emoji reaction to a message
   */
  async addReaction(chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.client) return;
    const resolvedEmoji = resolveEmoji(emoji);
    const reactionContent = {
      "m.relates_to": {
        rel_type: sdk.RelationType.Annotation as string,
        event_id: messageId,
        key: resolvedEmoji,
      },
    } as ReactionEventContent;
    try {
      await this.client.sendEvent(chatId, sdk.EventType.Reaction, reactionContent);
    } catch (err: any) {
      // Ignore duplicate reaction errors (reaction already exists)
      if (err?.errcode === 'M_DUPLICATE_ANNOTATION' || err?.message?.includes('same reaction twice')) {
        // Already reacted with this emoji - that's fine
        return;
      }
      throw err;
    }
  }

  /**
   * Remove an emoji reaction from a message
   *
   * Finds our reaction event by scanning the room timeline for m.reaction
   * events from our userId matching the target event_id + key, then redacts it.
   */
  async removeReaction(chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.client) return;

    const resolvedEmoji = resolveEmoji(emoji);
    const room = this.client.getRoom(chatId);
    if (!room) return;

    const ourUserId = this.client.getUserId();
    if (!ourUserId) return;

    // Scan timeline for our reaction event matching the target message and emoji
    const timeline = room.getLiveTimeline();
    const events = timeline.getEvents();

    for (const event of events) {
      if (event.getType() !== sdk.EventType.Reaction) continue;
      if (event.getSender() !== ourUserId) continue;

      const content = event.getContent();
      const relatesTo = content?.["m.relates_to"];

      if (
        relatesTo?.rel_type === sdk.RelationType.Annotation &&
        relatesTo?.event_id === messageId &&
        relatesTo?.key === resolvedEmoji
      ) {
        // Found our reaction - redact it
        const eventId = event.getId();
        if (eventId) {
          try {
            await this.client.redactEvent(chatId, eventId);
            log.info(`Removed reaction ${resolvedEmoji} from ${messageId}`);
          } catch (err) {
            log.warn(`Failed to remove reaction: ${err}`);
          }
        }
        return;
      }
    }
  }

  /**
   * Get the storage instance (for reaction handler)
   */
  getStorage(): MatrixStorage {
    return this.storage;
  }

  private async startSync(): Promise<void> {
    if (!this.client) return;

    log.info("Starting sync...");

    // CRITICAL: Set up verification handlers BEFORE startClient()
    // Verification events arrive during initial sync, so we must be ready
    this.setupVerificationHandler();

    this.client.startClient({ initialSyncLimit: 10 });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Initial sync timeout")), 120000);
      const checkSync = () => {
        if (this.initialSyncDone) {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(checkSync, 100);
        }
      };
      checkSync();
    });
  }
}

export function createMatrixAdapter(config: MatrixAdapterConfig): MatrixAdapter {
  return new MatrixAdapter(config);
}

/**
 * Infer Matrix mimetype from file extension and/or kind hint.
 */
function inferMatrixMimeType(ext: string, kind?: string): string {
  if (kind === 'image') {
    const imageTypes: Record<string, string> = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
      '.tiff': 'image/tiff', '.tif': 'image/tiff',
    };
    return imageTypes[ext] ?? 'image/png';
  }
  if (kind === 'audio') {
    const audioTypes: Record<string, string> = {
      '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/ogg; codecs=opus',
      '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
      '.flac': 'audio/flac',
    };
    return audioTypes[ext] ?? 'audio/mpeg';
  }
  // Generic file — map common types, fall back to octet-stream
  const fileTypes: Record<string, string> = {
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv',
    '.json': 'application/json', '.zip': 'application/zip',
  };
  return fileTypes[ext] ?? 'application/octet-stream';
}

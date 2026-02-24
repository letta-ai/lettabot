/**
 * Telegram MTProto Channel Adapter
 *
 * Uses TDLib/MTProto for Telegram user account messaging.
 * Allows Letta agents to operate as Telegram users (not bots).
 *
 * Key differences from Bot API:
 * - Full user capabilities (DM anyone first, larger files, no privacy mode)
 * - Phone number authentication (not bot token)
 * - Session persistence via TDLib database
 * - UTF-16 entity offsets for text formatting
 *
 * Requirements:
 * - npm install tdl prebuilt-tdlib
 * - Telegram API credentials from https://my.telegram.org
 */

import type { ChannelAdapter } from './types.js';
import type { InboundMessage, OutboundMessage } from '../core/types.js';
import type { DmPolicy } from '../pairing/types.js';
import { isUserAllowed, upsertPairingRequest, approvePairingCode } from '../pairing/store.js';
import { markdownToTdlib } from './telegram-mtproto-format.js';
import * as readline from 'node:readline';

import { createLogger } from '../logger.js';

const log = createLogger('Telegram-mtproto');
// TDLib imports - configured at runtime
let tdlModule: typeof import('tdl');
let getTdjson: () => string;

export type GroupPolicy = 'mention' | 'reply' | 'both' | 'off';

export interface TelegramMTProtoConfig {
  phoneNumber: string;           // E.164 format: +1234567890
  apiId: number;                 // From my.telegram.org
  apiHash: string;               // From my.telegram.org
  databaseDirectory?: string;    // Default: ./data/telegram-mtproto
  // Security
  dmPolicy?: DmPolicy;           // 'pairing' (default), 'allowlist', or 'open'
  allowedUsers?: number[];       // Telegram user IDs (config allowlist)
  // Group behavior
  groupPolicy?: GroupPolicy;     // 'mention', 'reply', 'both' (default), or 'off'
  // Admin notifications
  adminChatId?: number;          // Chat ID for pairing request notifications
}

// TDLib client type (simplified for our needs)
interface TdlibClient {
  invoke(method: object): Promise<any>;
  iterUpdates(): AsyncIterable<any>;
  close(): Promise<void>;
  on(event: 'error', handler: (err: Error) => void): void;
}

export class TelegramMTProtoAdapter implements ChannelAdapter {
  readonly id = 'telegram-mtproto' as const;
  readonly name = 'Telegram (MTProto)';

  private config: TelegramMTProtoConfig;
  private running = false;
  private client: TdlibClient | null = null;
  private updateLoopPromise: Promise<void> | null = null;
  private stopRequested = false;

  // Auth state machine (single update loop handles both auth and runtime)
  private authState: 'initializing' | 'waiting_phone' | 'waiting_code' | 'waiting_password' | 'ready' = 'initializing';
  private authResolve: ((value: void) => void) | null = null;
  private authReject: ((error: Error) => void) | null = null;

  // For group policy - track our identity and sent messages
  private myUserId: number | null = null;
  private myUsername: string | null = null;
  private sentMessageIds = new Set<number>();  // Track our messages for reply detection

  // For pairing approval via reply - track admin notification messages
  // Maps admin notification messageId -> { code, userId, username }
  private pendingPairingApprovals = new Map<number, { code: string; userId: string; username: string }>();

  onMessage?: (msg: InboundMessage) => Promise<void>;
  onCommand?: (command: string) => Promise<string | null>;

  constructor(config: TelegramMTProtoConfig) {
    this.config = {
      ...config,
      dmPolicy: config.dmPolicy || 'pairing',
      databaseDirectory: config.databaseDirectory || './data/telegram-mtproto',
      groupPolicy: config.groupPolicy || 'both',
    };
  }

  /**
   * Check if a user is authorized based on dmPolicy
   */
  private async checkAccess(userId: number): Promise<'allowed' | 'blocked' | 'pairing'> {
    const policy = this.config.dmPolicy || 'pairing';

    if (policy === 'open') {
      return 'allowed';
    }

    const allowed = await isUserAllowed(
      'telegram-mtproto',
      String(userId),
      this.config.allowedUsers?.map(String)
    );
    if (allowed) {
      return 'allowed';
    }

    if (policy === 'allowlist') {
      return 'blocked';
    }

    return 'pairing';
  }

  /**
   * Format user-facing pairing message (simple, no implementation details)
   */
  private formatUserPairingMessage(): string {
    return `Your request has been passed on to the admin.`;
  }

  /**
   * Format admin notification for pairing request
   */
  private formatAdminPairingNotification(username: string, userId: string, code: string, messageText?: string): string {
    const userDisplay = username ? `@${username}` : `User`;
    const messagePreview = messageText
      ? `\n\n💬 Message:\n${messageText.slice(0, 500)}${messageText.length > 500 ? '...' : ''}`
      : '';
    return `🔔 **New pairing request**

${userDisplay} (ID: ${userId}) wants to chat.${messagePreview}

Reply **approve** or **deny** to this message.`;
  }

  /**
   * Get user info (username, first name) from Telegram
   */
  private async getUserInfo(userId: number): Promise<{ username: string | null; firstName: string | null }> {
    if (!this.client) return { username: null, firstName: null };

    try {
      const user = await this.client.invoke({ _: 'getUser', user_id: userId });
      return {
        username: user.usernames?.editable_username || user.username || null,
        firstName: user.first_name || null,
      };
    } catch (err) {
      log.warn(`Could not get user info for ${userId}:`, err);
      return { username: null, firstName: null };
    }
  }

  /**
   * Get the private chat ID for a user (TDLib chat_id != user_id)
   */
  private async getPrivateChatId(userId: number): Promise<number | null> {
    if (!this.client) return null;

    try {
      const chat = await this.client.invoke({ _: 'createPrivateChat', user_id: userId, force: false });
      return chat.id;
    } catch (err) {
      log.warn(`Could not get private chat for user ${userId}:`, err);
      return null;
    }
  }

  /**
   * Prompt user for input (verification code or 2FA password)
   */
  private async promptForInput(type: 'code' | 'password'): Promise<string> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const prompt = type === 'code'
      ? '[Telegram MTProto] Enter verification code: '
      : '[Telegram MTProto] Enter 2FA password: ';

    return new Promise((resolve) => {
      rl.question(prompt, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  /**
   * Initialize TDLib client
   */
  private async initializeClient(): Promise<void> {
    // Dynamic import to avoid issues if packages aren't installed
    try {
      tdlModule = await import('tdl');
      const prebuiltModule = await import('prebuilt-tdlib');
      getTdjson = prebuiltModule.getTdjson;
    } catch (err: any) {
      if (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND') {
        throw new Error(
          'Telegram MTProto adapter requires tdl and prebuilt-tdlib packages.\n' +
          'Install them with: npm install tdl prebuilt-tdlib\n' +
          'See: https://github.com/Bannerets/tdl#installation'
        );
      }
      throw err;
    }

    // CRITICAL: Configure tdl BEFORE creating client
    tdlModule.configure({ tdjson: getTdjson() });

    this.client = tdlModule.createClient({
      apiId: this.config.apiId,
      apiHash: this.config.apiHash,
      databaseDirectory: this.config.databaseDirectory,
      filesDirectory: `${this.config.databaseDirectory}/files`,
    }) as TdlibClient;

    // CRITICAL: Always attach error handler
    this.client.on('error', (err) => {
      log.error('Client error:', err);
    });
  }

  /**
   * Single update loop - handles both auth and runtime updates
   * This ensures we only consume iterUpdates() once
   */
  private async runUpdateLoop(): Promise<void> {
    if (!this.client) {
      throw new Error('Client not initialized');
    }

    log.info('Starting update loop...');

    for await (const update of this.client.iterUpdates()) {
      if (this.stopRequested) {
        log.info('Stop requested, exiting update loop');
        if (this.authReject) {
          this.authReject(new Error('Stop requested'));
        }
        break;
      }

      try {
        // Handle auth updates until ready
        if (this.authState !== 'ready' && update._ === 'updateAuthorizationState') {
          await this.handleAuthUpdate(update);
        } else if (this.authState === 'ready') {
          // Normal runtime updates
          await this.handleUpdate(update);
        }
        // Ignore non-auth updates before we're ready
      } catch (err) {
        log.error('Error handling update:', err);
        // If auth fails, reject the auth promise
        if (this.authState !== 'ready' && this.authReject) {
          this.authReject(err as Error);
          break;
        }
      }
    }
  }

  /**
   * Handle authorization state updates
   */
  private async handleAuthUpdate(update: any): Promise<void> {
    const state = update.authorization_state;

    switch (state._) {
      case 'authorizationStateWaitTdlibParameters':
        this.authState = 'initializing';
        // TDLib handles this automatically with createClient options
        break;

      case 'authorizationStateWaitPhoneNumber':
        this.authState = 'waiting_phone';
        log.info('Sending phone number...');
        await this.client!.invoke({
          _: 'setAuthenticationPhoneNumber',
          phone_number: this.config.phoneNumber,
        });
        break;

      case 'authorizationStateWaitCode':
        this.authState = 'waiting_code';
        log.info('Verification code sent to your Telegram app');
        const code = await this.promptForInput('code');
        if (this.stopRequested) throw new Error('Stop requested');
        await this.client!.invoke({
          _: 'checkAuthenticationCode',
          code,
        });
        break;

      case 'authorizationStateWaitPassword':
        this.authState = 'waiting_password';
        log.info('2FA password required');
        const password = await this.promptForInput('password');
        if (this.stopRequested) throw new Error('Stop requested');
        await this.client!.invoke({
          _: 'checkAuthenticationPassword',
          password,
        });
        break;

      case 'authorizationStateReady':
        this.authState = 'ready';
        log.info('Authenticated successfully!');
        log.info(`Session saved to ${this.config.databaseDirectory}/`);
        // Get our own user info for mention/reply detection
        try {
          const me = await this.client!.invoke({ _: 'getMe' });
          this.myUserId = me.id;
          this.myUsername = me.usernames?.editable_username || me.username || null;
          log.info(`Logged in as: ${this.myUsername || this.myUserId}`);
        } catch (err) {
          log.warn('Could not fetch user info:', err);
        }
        // Signal that auth is complete
        if (this.authResolve) {
          this.authResolve();
          this.authResolve = null;
          this.authReject = null;
        }
        break;

      case 'authorizationStateClosed':
      case 'authorizationStateClosing':
        throw new Error('Client is closing');

      case 'authorizationStateLoggingOut':
        throw new Error('Client is logging out');
    }
  }

  /**
   * Handle a single TDLib update
   */
  private async handleUpdate(update: any): Promise<void> {
    switch (update._) {
      case 'updateNewMessage':
        await this.handleNewMessage(update.message);
        break;

      case 'updateMessageSendSucceeded':
        // Track the real message ID for reply detection
        // old_message_id is the temp ID, message.id is the real server ID
        if (update.old_message_id && update.message?.id) {
          this.sentMessageIds.add(update.message.id);

          // Also update pending pairing approvals if this was an admin notification
          const pending = this.pendingPairingApprovals.get(update.old_message_id);
          if (pending) {
            this.pendingPairingApprovals.delete(update.old_message_id);
            this.pendingPairingApprovals.set(update.message.id, pending);
          }
        }
        break;

      case 'updateConnectionState':
        this.handleConnectionState(update.state);
        break;

      // Add other update types as needed
    }
  }

  /**
   * Handle incoming message
   */
  private async handleNewMessage(message: any): Promise<void> {
    // Skip outgoing messages (messages we sent)
    if (message.is_outgoing) return;

    // Check for pairing approval reply from admin
    const replyToId = message.reply_to?.message_id;
    if (replyToId && this.pendingPairingApprovals.has(replyToId)) {
      await this.handlePairingApprovalReply(message, replyToId);
      return;
    }

    // Skip ALL messages from admin chat (don't trigger agent)
    const msgChatId = message.chat_id;
    if (this.config.adminChatId && msgChatId === this.config.adminChatId) {
      // Only process replies to pairing notifications (handled above)
      // All other messages in admin chat are ignored
      return;
    }

    // Skip if no handler (for normal messages)
    if (!this.onMessage) return;

    // Skip non-text messages for now
    if (message.content?._ !== 'messageText') return;

    // Get sender ID - must be a user
    const senderId = message.sender_id;
    if (!senderId || senderId._ !== 'messageSenderUser') return;

    const userId = senderId.user_id;
    const chatId = message.chat_id;
    const text = message.content?.text?.text || '';
    const messageId = String(message.id);

    // Check if this is a group chat and apply group policy
    const isGroup = await this.isGroupChat(chatId);
    if (isGroup) {
      const shouldRespond = await this.shouldRespondInGroup(message, chatId);
      if (!shouldRespond) {
        return;
      }
    }

    // Check access (DM policy)
    const access = await this.checkAccess(userId);

    if (access === 'blocked') {
      log.info(`Blocked message from user ${userId}`);
      return;
    }

    if (access === 'pairing') {
      // Create pairing request
      const { code, created } = await upsertPairingRequest('telegram-mtproto', String(userId));

      // Pairing queue is full: notify user and stop
      if (!code) {
        await this.sendMessage({
          chatId: String(chatId),
          text: 'Too many pending pairing requests. Please try again later.',
        });
        return;
      }

      // Existing pending request: don't send duplicate notifications
      if (!created) {
        return;
      }

      // Send simple acknowledgment to user (no implementation details)
      await this.sendMessage({ chatId: String(chatId), text: this.formatUserPairingMessage() });

      // Send admin notification if admin chat is configured
      if (this.config.adminChatId) {
        const userInfo = await this.getUserInfo(userId);
        const adminMsg = this.formatAdminPairingNotification(
          userInfo.username || userInfo.firstName || '',
          String(userId),
          code,
          text
        );
        try {
          const result = await this.sendMessage({ chatId: String(this.config.adminChatId), text: adminMsg });

          // Track this notification for reply-based approval
          this.pendingPairingApprovals.set(Number(result.messageId), {
            code,
            userId: String(userId),
            username: userInfo.username || userInfo.firstName || String(userId),
          });

          // Clean up old entries (keep last 100)
          if (this.pendingPairingApprovals.size > 100) {
            const oldest = this.pendingPairingApprovals.keys().next().value;
            if (oldest !== undefined) {
              this.pendingPairingApprovals.delete(oldest);
            }
          }
        } catch (err) {
          log.error(`Failed to send admin notification:`, err);
          // Fall back to console
          log.info(`Pairing request from ${userInfo.username || userId}: ${code}`);
          log.info(`To approve: lettabot pairing approve telegram-mtproto ${code}`);
        }
      } else {
        // No admin chat configured, log to console
        const userInfo = await this.getUserInfo(userId);
        log.info(`Pairing request from ${userInfo.username || userId}: ${code}`);
        log.info(`To approve: lettabot pairing approve telegram-mtproto ${code}`);
      }
      return;
    }

    // Build inbound message
    const inboundMsg: InboundMessage = {
      channel: 'telegram-mtproto',
      chatId: String(chatId),
      userId: String(userId),
      text,
      messageId,
      timestamp: new Date(message.date * 1000),
    };

    // Call handler
    await this.onMessage(inboundMsg);
  }

  /**
   * Handle pairing approval/denial via reply to admin notification
   */
  private async handlePairingApprovalReply(message: any, replyToId: number): Promise<void> {
    const pending = this.pendingPairingApprovals.get(replyToId);
    if (!pending) return;

    const text = (message.content?.text?.text || '').toLowerCase().trim();
    const chatId = message.chat_id;

    if (text === 'approve' || text === 'yes' || text === 'y') {
      // Approve the pairing
      const result = await approvePairingCode('telegram-mtproto', pending.code);

      if (result) {
        // Notify admin
        await this.sendMessage({
          chatId: String(chatId),
          text: `✅ Approved! ${pending.username} can now chat.`,
        });

        // Notify user (need to get their chat ID, not user ID)
        const userChatId = await this.getPrivateChatId(Number(pending.userId));
        if (userChatId) {
          await this.sendMessage({
            chatId: String(userChatId),
            text: `You've been approved! You can now chat.`,
          });
        }

        log.info(`Approved pairing for ${pending.username} (${pending.userId})`);
      } else {
        await this.sendMessage({
          chatId: String(chatId),
          text: `❌ Could not approve: Code not found or expired.`,
        });
      }

      // Remove from pending
      this.pendingPairingApprovals.delete(replyToId);

    } else if (text === 'deny' || text === 'no' || text === 'n' || text === 'reject') {
      // Deny the pairing (just remove from pending, don't add to allowlist)
      // Silent denial - don't notify the user (security/privacy)
      await this.sendMessage({
        chatId: String(chatId),
        text: `❌ Denied. ${pending.username} will not be able to chat.`,
      });

      log.info(`Denied pairing for ${pending.username} (${pending.userId})`);

      // Remove from pending
      this.pendingPairingApprovals.delete(replyToId);
    }
    // If text is something else, just ignore (don't process as regular message)
  }

  /**
   * Handle connection state changes
   */
  private handleConnectionState(state: any): void {
    switch (state._) {
      case 'connectionStateReady':
        log.info('Connected');
        break;
      case 'connectionStateConnecting':
        log.info('Connecting...');
        break;
      case 'connectionStateUpdating':
        log.info('Updating...');
        break;
      case 'connectionStateWaitingForNetwork':
        log.info('Waiting for network...');
        break;
    }
  }

  // ==================== Group Policy Helpers ====================

  /**
   * Check if a chat is a group (basic group or supergroup)
   */
  private async isGroupChat(chatId: number): Promise<boolean> {
    if (!this.client) return false;

    try {
      const chat = await this.client.invoke({ _: 'getChat', chat_id: chatId });
      const chatType = chat.type?._;
      return chatType === 'chatTypeBasicGroup' || chatType === 'chatTypeSupergroup';
    } catch (err) {
      log.warn('Could not determine chat type:', err);
      return false;
    }
  }

  /**
   * Check if we are mentioned in the message
   * Checks for @username mentions and user ID mentions
   */
  private isMentioned(message: any): boolean {
    if (!this.myUserId) return false;

    const text = message.content?.text?.text || '';
    const entities = message.content?.text?.entities || [];

    for (const entity of entities) {
      const entityType = entity.type?._;

      // Check for @username mention
      if (entityType === 'textEntityTypeMention') {
        const mentionText = text.substring(entity.offset, entity.offset + entity.length);
        // Compare without @ prefix, case-insensitive
        if (this.myUsername && mentionText.toLowerCase() === `@${this.myUsername.toLowerCase()}`) {
          return true;
        }
      }

      // Check for mention by user ID (textEntityTypeMentionName)
      if (entityType === 'textEntityTypeMentionName' && entity.type.user_id === this.myUserId) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if message is a reply to one of our messages
   */
  private isReplyToUs(message: any): boolean {
    const replyTo = message.reply_to?.message_id || message.reply_to_message_id;
    if (!replyTo) return false;
    return this.sentMessageIds.has(replyTo);
  }

  /**
   * Apply group policy to determine if we should respond
   * Returns true if we should process the message, false to ignore
   */
  private async shouldRespondInGroup(message: any, chatId: number): Promise<boolean> {
    const policy = this.config.groupPolicy || 'both';

    // 'off' means never respond in groups
    if (policy === 'off') {
      log.info('Group policy is off, ignoring group message');
      return false;
    }

    const mentioned = this.isMentioned(message);
    const isReply = this.isReplyToUs(message);

    switch (policy) {
      case 'mention':
        if (!mentioned) {
          log.info('Not mentioned in group, ignoring');
          return false;
        }
        return true;

      case 'reply':
        if (!isReply) {
          log.info('Not a reply to us in group, ignoring');
          return false;
        }
        return true;

      case 'both':
      default:
        if (!mentioned && !isReply) {
          // Silent ignore - don't log every message in busy groups
          return false;
        }
        return true;
    }
  }

  // ==================== ChannelAdapter Interface ====================

  async start(): Promise<void> {
    if (this.running) return;

    log.info('Starting adapter...');
    this.stopRequested = false;
    this.authState = 'initializing';

    try {
      // Initialize TDLib client
      await this.initializeClient();

      // Create auth promise - will be resolved when authorizationStateReady is received
      const authPromise = new Promise<void>((resolve, reject) => {
        this.authResolve = resolve;
        this.authReject = reject;
      });

      // Start single update loop in background (handles both auth and runtime)
      this.updateLoopPromise = this.runUpdateLoop().catch((err) => {
        if (this.running && !this.stopRequested) {
          log.error('Update loop error:', err);
          this.running = false;
        }
      });

      // Wait for auth to complete
      await authPromise;

      this.running = true;
      log.info('Adapter started');
    } catch (err) {
      log.error('Failed to start:', err);
      throw err;
    }
  }

  async stop(): Promise<void> {
    // Always allow stop, even during auth (handles ctrl+c during code/password prompt)
    log.info('Stopping adapter...');
    this.stopRequested = true;
    this.running = false;

    if (this.client) {
      try {
        await this.client.close();
      } catch (err) {
        // Ignore errors during shutdown (client may already be closing)
        if (!String(err).includes('closed')) {
          log.error('Error closing client:', err);
        }
      }
      this.client = null;
    }

    log.info('Adapter stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  supportsEditing(): boolean {
    // Disabled for now: TDLib sendMessage returns temporary IDs,
    // and editMessage fails with "Message not found" until
    // updateMessageSendSucceeded provides the real ID.
    // TODO: Implement message ID tracking to enable streaming edits
    return false;
  }

  async sendMessage(msg: OutboundMessage): Promise<{ messageId: string }> {
    if (!this.client) {
      throw new Error('Client not initialized');
    }

    const formatted = markdownToTdlib(msg.text);

    const result = await this.client.invoke({
      _: 'sendMessage',
      chat_id: this.safeChatId(msg.chatId),
      input_message_content: {
        _: 'inputMessageText',
        text: formatted,
        link_preview_options: null,
        clear_draft: false,
      },
    });

    // Track this message ID for reply detection in groups
    // Note: This is the temp ID; the real ID comes via updateMessageSendSucceeded
    // For reply detection, we track both temp and real IDs
    this.sentMessageIds.add(result.id);

    // Limit set size to prevent memory leak (keep last 1000 messages)
    // Delete 100 oldest entries at once to avoid constant single deletions
    if (this.sentMessageIds.size > 1000) {
      const iterator = this.sentMessageIds.values();
      for (let i = 0; i < 100; i++) {
        const oldest = iterator.next().value;
        if (oldest !== undefined) {
          this.sentMessageIds.delete(oldest);
        }
      }
    }

    return { messageId: String(result.id) };
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    if (!this.client) {
      throw new Error('Client not initialized');
    }

    const formatted = markdownToTdlib(text);

    await this.client.invoke({
      _: 'editMessageText',
      chat_id: this.safeChatId(chatId),
      message_id: this.safeMessageId(messageId),
      input_message_content: {
        _: 'inputMessageText',
        text: formatted,
      },
    });
  }

  async sendTypingIndicator(chatId: string): Promise<void> {
    if (!this.client) return;

    try {
      await this.client.invoke({
        _: 'sendChatAction',
        chat_id: this.safeChatId(chatId),
        action: { _: 'chatActionTyping' },
      });
    } catch (err) {
      // Typing indicators are best-effort, don't throw
      log.warn('Failed to send typing indicator:', err);
    }
  }

  // ==================== Helpers ====================

  /**
   * Safely convert chatId to number, checking for safe integer bounds
   * @throws Error if chatId exceeds JavaScript safe integer bounds
   */
  private safeChatId(chatId: string): number {
    const num = Number(chatId);
    if (!Number.isSafeInteger(num)) {
      throw new Error(`Chat ID ${chatId} exceeds safe integer bounds (max: ${Number.MAX_SAFE_INTEGER}). This chat cannot be used with TDLib's number-based API.`);
    }
    return num;
  }

  /**
   * Safely convert messageId to number
   * @throws Error if messageId exceeds JavaScript safe integer bounds
   */
  private safeMessageId(messageId: string): number {
    const num = Number(messageId);
    if (!Number.isSafeInteger(num)) {
      throw new Error(`Message ID ${messageId} exceeds safe integer bounds (max: ${Number.MAX_SAFE_INTEGER}).`);
    }
    return num;
  }

  // ==================== Public API for Letta Tools ====================

  /**
   * Get public user info (for Letta telegram_get_user_info tool)
   */
  async getPublicUserInfo(userId: number): Promise<{ username: string | null; firstName: string | null; lastName: string | null }> {
    if (!this.client) throw new Error('Client not initialized');

    try {
      const user = await this.client.invoke({ _: 'getUser', user_id: userId });
      return {
        username: user.usernames?.editable_username || user.username || null,
        firstName: user.first_name || null,
        lastName: user.last_name || null,
      };
    } catch (err) {
      log.warn(`Could not get user info for ${userId}:`, err);
      throw err;
    }
  }

  /**
   * Initiate a direct message to a user (for Letta telegram_send_dm tool)
   * Creates a private chat if needed, then sends the message.
   */
  async initiateDirectMessage(userId: number, text: string): Promise<{ chatId: string; messageId: string }> {
    if (!this.client) throw new Error('Client not initialized');

    // Create private chat (or get existing)
    const chat = await this.client.invoke({ _: 'createPrivateChat', user_id: userId, force: false });
    const chatId = chat.id;

    // Send the message
    const formatted = markdownToTdlib(text);
    const result = await this.client.invoke({
      _: 'sendMessage',
      chat_id: chatId,
      input_message_content: {
        _: 'inputMessageText',
        text: formatted,
        link_preview_options: null,
        clear_draft: false,
      },
    });

    // Track message for reply detection
    this.sentMessageIds.add(result.id);
    if (this.sentMessageIds.size > 1000) {
      const oldest = this.sentMessageIds.values().next().value;
      if (oldest !== undefined) {
        this.sentMessageIds.delete(oldest);
      }
    }

    return { chatId: String(chatId), messageId: String(result.id) };
  }

  /**
   * Search for a user by username (for Letta telegram_find_user tool)
   */
  async searchUser(username: string): Promise<{ userId: number; username: string | null; firstName: string | null } | null> {
    if (!this.client) throw new Error('Client not initialized');

    try {
      // Remove @ prefix if present
      const cleanUsername = username.replace(/^@/, '');
      const result = await this.client.invoke({ _: 'searchPublicChat', username: cleanUsername });

      if (result.type?._ === 'chatTypePrivate') {
        const userId = result.type.user_id;
        const userInfo = await this.getPublicUserInfo(userId);
        return {
          userId,
          username: userInfo.username,
          firstName: userInfo.firstName,
        };
      }
      return null;
    } catch (err) {
      log.warn(`Could not find user @${username}:`, err);
      return null;
    }
  }
}

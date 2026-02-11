/**
 * WhatsApp Channel Types
 *
 * TypeScript interfaces for WhatsApp integration.
 * Shields consumers from Baileys proto types.
 */

import type { DmPolicy } from "../../pairing/types.js";
import type { GroupModeConfig } from "../group-mode.js";
import type {
  WASocket,
  WAMessage,
  proto,
  DisconnectReason as BaileysDisconnectReason,
} from "@whiskeysockets/baileys";

// Re-export Baileys types for use in modules
export type BaileysSocket = WASocket;
export type BaileysMessage = WAMessage;
export type BaileysProtoMessage = proto.IMessage;
export type BaileysDisconnectReasonType = typeof BaileysDisconnectReason;

/**
 * Configuration for WhatsApp channel adapter
 */
export interface WhatsAppConfig {
  /** Directory to store auth state (default: "./data/whatsapp-session") */
  sessionPath?: string;

  /** Access control policy (default: "pairing") */
  dmPolicy?: DmPolicy;

  /** Allowed phone numbers in E.164 format (e.g., +15551234567) */
  allowedUsers?: string[];

  /** Self-chat mode - only respond to "Message Yourself" chat (default: false) */
  selfChatMode?: boolean;

  /** Directory to save downloaded attachments */
  attachmentsDir?: string;

  /** Max attachment size in bytes (0 = metadata only, no download) */
  attachmentsMaxBytes?: number;

  /** Group policy - how to handle group messages (default: "open") */
  groupPolicy?: 'open' | 'disabled' | 'allowlist';

  /** Allowed senders in groups (E.164, supports "*" wildcard) */
  groupAllowFrom?: string[];

  /** Mention patterns for detection (regex, e.g., ["@?bot"]) */
  mentionPatterns?: string[];

  /** Per-group settings (JID or "*" for defaults) */
  groups?: Record<string, GroupModeConfig>;
}

/**
 * Baileys error structure (Boom-like errors)
 */
export interface BaileysError {
  output?: {
    statusCode?: number;
    payload?: {
      error?: string;
      message?: string;
      statusCode?: number;
    };
  };
  status?: number;
  message?: string;
  code?: string;
}

/**
 * Baileys connection update event
 * Re-exported from Baileys for convenience
 */
export type ConnectionUpdate = Partial<import("@whiskeysockets/baileys").ConnectionState>;

/**
 * Reconnection state tracking
 */
export interface ReconnectState {
  attempts: number;
  lastDisconnect: Date | null;
  abortController: AbortController | null;
  monitorTask: Promise<void> | null;
}

/**
 * Event listener references for cleanup
 */
export interface ListenerRefs {
  credsUpdate?: () => void;
  connectionUpdate?: (update: Partial<import("@whiskeysockets/baileys").ConnectionState>) => void;
  messagesUpsert?: (data: MessagesUpsertData) => void;
}

/**
 * Messages upsert event data
 */
export interface MessagesUpsertData {
  type?: "notify" | "append";
  messages: BaileysMessage[];
}

/**
 * LID to JID mapping for replies
 */
export interface LidMapping {
  lidToJid: Map<string, string>;
  selfChatLid: string;
}

/**
 * Message filtering result
 */
export interface MessageFilterResult {
  process: boolean;
  reason?: "invalid-type" | "status-broadcast" | "self-sent" | "duplicate" | "history";
}

/**
 * Access control check result
 */
export interface AccessControlResult {
  allowed: boolean;
  sendPairingMsg?: boolean;
  pairingCode?: string;
  reason?: "pairing" | "blocked" | "self-chat-mode" | "allowed";
}

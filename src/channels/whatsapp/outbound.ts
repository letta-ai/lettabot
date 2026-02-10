/**
 * WhatsApp Outbound Messaging
 *
 * Handles sending messages with LID resolution and presence indicators.
 * Based on OpenClaw's outbound.ts pattern.
 */

import type { OutboundMessage, OutboundFile } from "../../core/types.js";
import type { WAMessage } from '@whiskeysockets/baileys';
import { isLid } from "./utils.js";
import { basename } from "node:path";

/**
 * LID (Linked Identifier) mapping for message sending.
 * Maps LID addresses to real JIDs.
 */
export interface LidMapper {
  /** Self-chat LID */
  selfChatLid: string;

  /** Bot's phone number */
  myNumber: string;

  /** Map of LID -> real JID */
  lidToJid: Map<string, string>;

  /** Message store for getMessage callback (stores full WAMessage with key) */
  messageStore?: Map<string, WAMessage>;
}

/**
 * Resolve LID to real JID for sending messages.
 *
 * LIDs (Linked Identifiers) are privacy-focused WhatsApp identifiers that
 * need to be resolved to real JIDs before sending.
 *
 * Resolution order:
 * 1. Check if it's self-chat LID -> use bot's own JID
 * 2. Check signalRepository.lidMapping (Baileys built-in)
 * 3. Check manual lidToJid mapping (from senderPn in received messages)
 * 4. Fail safe: throw error (prevents sending to wrong person)
 *
 * @param chatId - Target chat ID (may be LID)
 * @param sock - Baileys socket instance
 * @param lidMapper - LID mapping data
 * @returns Resolved JID
 * @throws Error if LID cannot be resolved
 */
export function resolveSendJid(
  chatId: string,
  sock: import("@whiskeysockets/baileys").WASocket,
  lidMapper: LidMapper
): string {
  // Not an LID - return as-is
  if (!isLid(chatId)) {
    return chatId;
  }

  // Self-chat LID -> convert to bot's own JID
  if (chatId === lidMapper.selfChatLid && lidMapper.myNumber) {
    return `${lidMapper.myNumber}@s.whatsapp.net`;
  }

  // Try signalRepository mapping (Baileys built-in)
  // Note: lidMapping may not exist on all Baileys versions - use safe access
  const signalRepo = sock.signalRepository as unknown as { lidMapping?: Map<string, string> } | undefined;
  const signalMapping = signalRepo?.lidMapping?.get(chatId);
  if (signalMapping) {
    return signalMapping;
  }

  // Try manual mapping (from senderPn field in received messages)
  const manualMapping = lidMapper.lidToJid.get(chatId);
  if (manualMapping) {
    return manualMapping;
  }

  // FAIL SAFE: Cannot resolve LID - don't send to unknown address
  console.error(`[WhatsApp] Cannot resolve LID: ${chatId}`);
  throw new Error("Cannot send to unknown LID - no mapping found");
}

/**
 * Send a WhatsApp message with proper LID resolution and tracking.
 *
 * @param sock - Baileys socket instance
 * @param msg - Message to send
 * @param lidMapper - LID mapping data
 * @param sentMessageIds - Set to track sent messages (prevents self-echo)
 * @returns Message ID
 *
 * @example
 * const { messageId } = await sendWhatsAppMessage(
 *   sock,
 *   { chatId: '1234567890@s.whatsapp.net', text: 'Hello!' },
 *   lidMapper,
 *   sentMessageIds
 * );
 */
export async function sendWhatsAppMessage(
  sock: import("@whiskeysockets/baileys").WASocket,
  msg: OutboundMessage,
  lidMapper: LidMapper,
  sentMessageIds: Set<string>
): Promise<{ messageId: string }> {
  if (!sock) {
    throw new Error("WhatsApp not connected");
  }

  // Resolve LID to real JID
  const targetJid = resolveSendJid(msg.chatId, sock, lidMapper);

  try {
    // Send composing indicator (typing...)
    try {
      await sock.sendPresenceUpdate("composing", targetJid);
    } catch {
      // Ignore presence errors
    }

    // Send message
    const result = await sock.sendMessage(targetJid, { text: msg.text });
    const messageId = result?.key?.id || "";
    const message = result?.message;

    // Track sent message to prevent processing it as incoming (self-echo prevention)
    if (messageId) {
      sentMessageIds.add(messageId);

      // CRITICAL: Store sent message for getMessage callback (enables retry on delivery failure)
      if (result && lidMapper.messageStore) {
        lidMapper.messageStore.set(messageId, result);
        // Auto-cleanup after 24 hours
        setTimeout(() => {
          lidMapper.messageStore?.delete(messageId);
        }, 24 * 60 * 60 * 1000);
      }

      // Auto-cleanup sent ID after 60 seconds
      setTimeout(() => {
        sentMessageIds.delete(messageId);
      }, 60000);
    }

    return { messageId };
  } catch (error) {
    console.error("[WhatsApp] sendMessage error:", error);
    throw error;
  }
}

/**
 * Send typing indicator to a chat.
 *
 * @param sock - Baileys socket instance
 * @param chatId - Target chat ID
 */
export async function sendTypingIndicator(
  sock: import("@whiskeysockets/baileys").WASocket,
  chatId: string
): Promise<void> {
  if (!sock) return;

  try {
    await sock.sendPresenceUpdate("composing", chatId);
  } catch {
    // Ignore presence errors
  }
}

/**
 * Stop typing indicator for a chat.
 * Sends "paused" presence to immediately clear the "typing..." indicator
 * instead of waiting for WhatsApp's built-in timeout (~15-25s).
 */
export async function stopTypingIndicator(
  sock: import("@whiskeysockets/baileys").WASocket,
  chatId: string
): Promise<void> {
  if (!sock) return;

  try {
    await sock.sendPresenceUpdate("paused", chatId);
  } catch {
    // Ignore presence errors
  }
}

/**
 * Send read receipt for a message.
 *
 * @param sock - Baileys socket instance
 * @param remoteJid - Chat JID
 * @param messageId - Message ID to mark as read
 * @param participant - Optional participant JID (for group messages)
 */
export async function sendReadReceipt(
  sock: import("@whiskeysockets/baileys").WASocket,
  remoteJid: string,
  messageId: string,
  participant?: string | null
): Promise<void> {
  try {
    await sock.readMessages([
      {
        remoteJid,
        id: messageId,
        participant,
        fromMe: false,
      },
    ]);
  } catch (err) {
    // Ignore read receipt errors - not critical
    console.warn(`[WhatsApp] Failed to send read receipt for ${messageId}:`, err);
  }
}

/**
 * Send a file (image or document) to WhatsApp.
 *
 * @param sock - Baileys socket instance
 * @param file - File to send
 * @param lidMapper - LID mapping data
 * @param sentMessageIds - Set to track sent messages
 * @returns Message ID
 */
export async function sendWhatsAppFile(
  sock: import("@whiskeysockets/baileys").WASocket,
  file: OutboundFile,
  lidMapper: LidMapper,
  sentMessageIds: Set<string>
): Promise<{ messageId: string }> {
  if (!sock) {
    throw new Error("WhatsApp not connected");
  }

  // Resolve LID to real JID
  const targetJid = resolveSendJid(file.chatId, sock, lidMapper);

  // Build payload based on file kind
  const caption = file.caption || undefined;
  const fileName = basename(file.filePath);

  const payload =
    file.kind === "image"
      ? { image: { url: file.filePath }, caption }
      : { document: { url: file.filePath }, mimetype: "application/octet-stream", caption, fileName };

  try {
    // Send file
    const result = await sock.sendMessage(targetJid, payload);
    const messageId = result?.key?.id || "";
    const message = result?.message;

    // Track sent message to prevent self-echo
    if (messageId) {
      sentMessageIds.add(messageId);

      // Store in getMessage cache for retry capability
      if (result && lidMapper.messageStore) {
        lidMapper.messageStore.set(messageId, result);
        setTimeout(() => {
          lidMapper.messageStore?.delete(messageId);
        }, 24 * 60 * 60 * 1000);
      }

      // Cleanup sent ID after 60 seconds
      setTimeout(() => {
        sentMessageIds.delete(messageId);
      }, 60000);
    }

    return { messageId };
  } catch (error) {
    console.error("[WhatsApp] sendFile error:", error);
    throw error;
  }
}

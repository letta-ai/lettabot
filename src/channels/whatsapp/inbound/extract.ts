/**
 * WhatsApp Message Extraction
 *
 * Parses Baileys proto messages into clean TypeScript interfaces.
 * Based on OpenClaw's extract.ts pattern.
 */

import { jidToE164, isGroupJid, isLid } from "../utils.js";
import type { WebInboundMessage, AttachmentExtractionConfig } from "./types.js";
import type { GroupMetaCache } from "../utils.js";
import { unwrapMessageContent, extractMediaPreview, collectAttachments } from "./media.js";
import type { InboundAttachment } from "../../../core/types.js";

/**
 * Extract text content from a Baileys message.
 *
 * Checks multiple message types in order:
 * 1. conversation (simple text)
 * 2. extendedTextMessage.text (formatted text, links, etc.)
 * 3. imageMessage.caption
 * 4. videoMessage.caption
 *
 * @param message - Baileys proto message
 * @returns Extracted text or null
 */
export function extractText(message: import("@whiskeysockets/baileys").proto.IMessage | undefined): string | null {
  if (!message) return null;

  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    null
  );
}

/**
 * Extract reply context from a message.
 * Returns info about the message being replied to.
 *
 * @param message - Baileys proto message
 * @returns Reply context or undefined
 */
export function extractReplyContext(message: import("@whiskeysockets/baileys").proto.IMessage | undefined) {
  // Robust contextInfo extraction - check all message types (OpenClaw pattern)
  const contextInfo =
    message?.extendedTextMessage?.contextInfo ||
    message?.imageMessage?.contextInfo ||
    message?.videoMessage?.contextInfo ||
    message?.documentMessage?.contextInfo ||
    message?.audioMessage?.contextInfo ||
    message?.stickerMessage?.contextInfo ||
    message?.contactMessage?.contextInfo ||
    message?.locationMessage?.contextInfo ||
    message?.liveLocationMessage?.contextInfo ||
    message?.groupInviteMessage?.contextInfo ||
    message?.pollCreationMessage?.contextInfo;

  if (!contextInfo?.quotedMessage) {
    return undefined;
  }

  const body = extractText(contextInfo.quotedMessage);

  return {
    id: contextInfo.stanzaId ?? undefined,
    body: body ?? undefined,
    senderJid: contextInfo.participant ?? undefined,
    senderE164: contextInfo.participant ? jidToE164(contextInfo.participant) : undefined,
  };
}

/**
 * Extract mentioned JIDs (@mentions) from a message.
 *
 * @param message - Baileys proto message
 * @returns Array of mentioned JIDs or undefined
 */
export function extractMentionedJids(message: import("@whiskeysockets/baileys").proto.IMessage | undefined): string[] | undefined {
  // Robust contextInfo extraction - check all message types
  const contextInfo =
    message?.extendedTextMessage?.contextInfo ||
    message?.imageMessage?.contextInfo ||
    message?.videoMessage?.contextInfo ||
    message?.documentMessage?.contextInfo ||
    message?.audioMessage?.contextInfo ||
    message?.stickerMessage?.contextInfo ||
    message?.contactMessage?.contextInfo ||
    message?.locationMessage?.contextInfo ||
    message?.liveLocationMessage?.contextInfo ||
    message?.groupInviteMessage?.contextInfo ||
    message?.pollCreationMessage?.contextInfo;

  const mentions = contextInfo?.mentionedJid;

  if (!mentions || !Array.isArray(mentions)) {
    return undefined;
  }

  return mentions.filter(Boolean);
}

/**
 * Extract full inbound message data from Baileys message.
 *
 * This is the main extraction function that:
 * 1. Extracts text, reply context, mentions
 * 2. Resolves group metadata if needed
 * 3. Identifies sender info
 * 4. Returns normalized WebInboundMessage
 *
 * @param msg - Baileys WAMessage
 * @param sock - Baileys socket instance
 * @param groupMetaCache - Group metadata cache
 * @returns Normalized message or null if invalid
 */
/**
 * Resolve an LID (Linked ID) to a real phone number JID for inbound messages.
 *
 * LIDs are privacy-focused identifiers used by WhatsApp Web. The same user
 * has different JIDs depending on their device:
 * - Phone app: 34600...@s.whatsapp.net (real phone number)
 * - WhatsApp Web: xxxxx@lid (opaque linked ID)
 *
 * Without resolution, the same user gets different userIds, breaking
 * debouncing, daily limits, and conversation routing.
 *
 * Resolution order:
 * 1. msg.key.senderPn - provided by Baileys when available
 * 2. sock.signalRepository.lidMapping - Baileys built-in mapping
 * 3. Fall back to LID-stripped number (current behavior)
 *
 * @param lidJid - The LID JID to resolve (e.g., "12345@lid")
 * @param msg - Baileys message (may contain senderPn)
 * @param sock - Baileys socket (has signalRepository)
 * @returns Resolved phone number JID or null if not resolvable
 */
function resolveLidToPhoneJid(
  lidJid: string,
  msg: import("@whiskeysockets/baileys").WAMessage,
  sock: import("@whiskeysockets/baileys").WASocket
): string | null {
  const normalizePhoneJid = (value: string | undefined): string | null => {
    if (!value) return null;

    const trimmed = value.trim();
    if (!trimmed || isLid(trimmed)) {
      return null;
    }

    if (trimmed.includes('@')) {
      return trimmed;
    }

    // Defensive fallback: handle plain phone numbers by converting to a PN JID.
    const digits = trimmed.replace(/[^\d]/g, '');
    if (!digits) {
      return null;
    }
    return `${digits}@s.whatsapp.net`;
  };

  // Try senderPn from message key (most reliable)
  const senderPn = normalizePhoneJid(msg.key?.senderPn);
  if (senderPn) {
    return senderPn;
  }

  // Try signalRepository.lidMapping (Baileys built-in)
  const signalRepo = sock.signalRepository as unknown as { lidMapping?: Map<string, string> } | undefined;
  const signalMapping = normalizePhoneJid(signalRepo?.lidMapping?.get(lidJid));
  if (signalMapping) {
    return signalMapping;
  }

  // Could not resolve
  return null;
}

export async function extractInboundMessage(
  msg: import("@whiskeysockets/baileys").WAMessage,
  sock: import("@whiskeysockets/baileys").WASocket,
  groupMetaCache: GroupMetaCache,
  attachmentConfig?: AttachmentExtractionConfig
): Promise<WebInboundMessage | null> {
  const remoteJid = msg.key?.remoteJid;
  if (!remoteJid) return null;

  const messageId = msg.key?.id;
  const isGroup = isGroupJid(remoteJid);
  const participantJid = msg.key?.participant;

  // Extract bot's own info
  const selfJid = sock.user?.id || "";
  const selfE164 = selfJid ? jidToE164(selfJid) : undefined;

  // Unwrap message content (handles ephemeral/viewOnce)
  const messageContent = unwrapMessageContent(msg.message);

  // Extract text from unwrapped content
  const body = extractText(messageContent ?? undefined);

  // Detect media
  const preview = extractMediaPreview(messageContent);

  // Collect attachments if media present and config provided
  let attachments: InboundAttachment[] = [];
  let voiceTranscription: string | undefined;
  if (preview.hasMedia && attachmentConfig) {
    const result = await collectAttachments({
      messageContent,
      chatId: remoteJid,
      messageId: messageId || 'unknown',
      sock,
      ...attachmentConfig,
    });
    attachments = result.attachments;
    voiceTranscription = result.voiceTranscription;
  }

  // Use caption as fallback text (for media-only messages)
  // For voice messages, use transcription if available
  const finalBody = voiceTranscription || body || preview.caption || '';
  if (!finalBody && attachments.length === 0) {
    return null; // Skip messages with no text and no media
  }

  // Determine sender and chatId
  // For LID-based DMs, we need to resolve to the real phone number
  // so the same user gets consistent userIds regardless of device
  let from: string;
  let senderE164: string | undefined;
  let senderJid: string | undefined;
  let resolvedChatId = remoteJid; // Normalized chat ID (phone JID for LID DMs)

  if (isGroup) {
    // Group message - sender is the participant
    from = remoteJid; // Conversation ID is the group JID
    senderJid = participantJid ? participantJid : undefined;
    senderE164 = participantJid ? jidToE164(participantJid) : undefined;
  } else {
    // DM - check if this is an LID that needs resolution
    if (isLid(remoteJid)) {
      // Try to resolve LID to real phone number JID
      const resolvedJid = resolveLidToPhoneJid(remoteJid, msg, sock);
      if (resolvedJid) {
        // Successfully resolved - use real phone number
        from = jidToE164(resolvedJid);
        senderE164 = from;
        resolvedChatId = resolvedJid; // Normalize chatId to phone JID
      } else {
        // Could not resolve - fall back to LID-stripped number
        // This maintains backward compatibility but may cause user ID fragmentation
        from = jidToE164(remoteJid);
        senderE164 = from;
      }
    } else {
      // Regular phone JID - use as-is
      from = jidToE164(remoteJid);
      senderE164 = from;
    }
  }

  // Fetch group metadata if needed
  let groupSubject: string | undefined;
  let groupParticipants: string[] | undefined;

  if (isGroup) {
    const meta = await groupMetaCache.get(remoteJid, () =>
      sock.groupMetadata(remoteJid)
    );
    groupSubject = meta.subject;
    groupParticipants = meta.participants;
  }

  // Extract reply context (convert null to undefined)
  const replyContext = extractReplyContext(msg.message ?? undefined);

  // Extract mentions (convert null to undefined)
  const mentionedJids = extractMentionedJids(msg.message ?? undefined);

  // Check if sender mentioned the bot
  const wasMentioned = mentionedJids?.includes(selfJid) ?? false;

  // Detect self-chat (including LID-based self-chat on newer WhatsApp versions)
  const isLidChat = remoteJid.includes('@lid');
  const isSelfChat = !isGroup && (from === selfE164 || isLidChat);

  // Build normalized message (convert all nulls to undefined for type safety)
  const inboundMessage: WebInboundMessage = {
    id: messageId ?? undefined,
    from,
    to: selfE164 ?? "me",
    chatId: resolvedChatId, // Use resolved chatId (phone JID for LID DMs)
    body: finalBody,
    pushName: msg.pushName ?? undefined,
    timestamp: new Date(Number(msg.messageTimestamp) * 1000),
    chatType: isGroup ? "group" : "direct",
    senderJid: senderJid ?? undefined,
    senderE164: senderE164 ?? undefined,
    senderName: msg.pushName ?? undefined,
    replyContext,
    groupSubject,
    groupParticipants,
    mentionedJids,
    selfJid,
    selfE164,
    isSelfChat,
    wasMentioned,
    attachments: attachments.length > 0 ? attachments : undefined,
  };

  return inboundMessage;
}

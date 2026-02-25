/**
 * WhatsApp Media & Attachment Handling
 *
 * Handles detection, download, and extraction of media attachments.
 * Ported from PR #64 attachment support.
 */

import type { InboundAttachment } from "../../../core/types.js";
import { buildAttachmentPath, writeStreamToFile } from "../../attachments.js";

import { createLogger } from '../../../logger.js';

const log = createLogger('WhatsApp');
/**
 * Unwrap ephemeral and viewOnce message containers.
 * WhatsApp wraps certain messages in these containers which need to be unwrapped
 * before accessing the actual message content.
 *
 * @param message - Baileys proto message
 * @returns Unwrapped message content or null
 */
export function unwrapMessageContent(message: any): any {
  if (!message) return null;
  if (message.ephemeralMessage?.message) return message.ephemeralMessage.message;
  if (message.viewOnceMessage?.message) return message.viewOnceMessage.message;
  if (message.viewOnceMessageV2?.message) return message.viewOnceMessageV2.message;
  return message;
}

/**
 * Quick check for media presence in message content.
 * Detects images, videos, audio, documents, and stickers.
 *
 * @param messageContent - Unwrapped Baileys message content
 * @returns Object with hasMedia flag and optional caption
 */
export function extractMediaPreview(messageContent: any): { hasMedia: boolean; caption?: string } {
  if (!messageContent) return { hasMedia: false };

  const mediaMessage =
    messageContent.imageMessage ||
    messageContent.videoMessage ||
    messageContent.audioMessage ||
    messageContent.documentMessage ||
    messageContent.stickerMessage;

  if (!mediaMessage) return { hasMedia: false };

  return {
    hasMedia: true,
    caption: mediaMessage.caption as string | undefined,
  };
}

/**
 * Download and collect media attachments from a message.
 *
 * Handles 5 media types: image, video, audio, document, sticker.
 * Downloads using Baileys' downloadContentFromMessage and saves to disk.
 * Enforces size limits and supports metadata-only mode.
 * Transcribes voice messages (ptt: true) using configured transcription provider.
 *
 * @param params - Attachment collection parameters
 * @returns Attachments array, optional caption, and optional transcribed text for voice messages
 */
export async function collectAttachments(params: {
  messageContent: any;
  chatId: string;
  messageId: string;
  downloadContentFromMessage: (message: any, type: string) => Promise<AsyncIterable<Uint8Array>>;
  sock: import("@whiskeysockets/baileys").WASocket;
  attachmentsDir?: string;
  attachmentsMaxBytes?: number;
}): Promise<{ attachments: InboundAttachment[]; caption?: string; voiceTranscription?: string }> {
  const { messageContent, chatId, messageId, downloadContentFromMessage, sock, attachmentsDir, attachmentsMaxBytes } = params;
  const attachments: InboundAttachment[] = [];

  if (!messageContent) return { attachments };

  // Determine media type and extract media message
  let mediaMessage: any;
  let mediaType: 'image' | 'video' | 'audio' | 'document' | 'sticker' | null = null;
  let kind: InboundAttachment['kind'] = 'file';

  if (messageContent.imageMessage) {
    mediaMessage = messageContent.imageMessage;
    mediaType = 'image';
    kind = 'image';
  } else if (messageContent.videoMessage) {
    mediaMessage = messageContent.videoMessage;
    mediaType = 'video';
    kind = 'video';
  } else if (messageContent.audioMessage) {
    mediaMessage = messageContent.audioMessage;
    mediaType = 'audio';
    kind = 'audio';
  } else if (messageContent.documentMessage) {
    mediaMessage = messageContent.documentMessage;
    mediaType = 'document';
    kind = 'file';
  } else if (messageContent.stickerMessage) {
    mediaMessage = messageContent.stickerMessage;
    mediaType = 'sticker';
    kind = 'image';
  }

  if (!mediaMessage || !mediaType) return { attachments };

  // Extract metadata
  const mimeType = mediaMessage.mimetype as string | undefined;
  const fileLength = mediaMessage.fileLength;
  const size =
    typeof fileLength === 'number'
      ? fileLength
      : typeof fileLength?.toNumber === 'function'
        ? fileLength.toNumber()
        : undefined;

  const ext = extensionFromMime(mimeType);
  const defaultName = `whatsapp-${messageId}.${ext}`;
  const name = mediaMessage.fileName || defaultName;

  const attachment: InboundAttachment = {
    name,
    mimeType,
    size,
    kind,
  };

  // Check if this is a voice message (ptt = push-to-talk)
  const isPttVoiceMessage = mediaType === 'audio' && mediaMessage.ptt === true;
  let voiceTranscription: string | undefined;

  // Download if attachmentsDir is configured
  if (attachmentsDir) {
    // Metadata-only mode (attachmentsMaxBytes = 0)
    if (attachmentsMaxBytes === 0) {
      attachments.push(attachment);
      const caption = mediaMessage.caption as string | undefined;
      return { attachments, caption };
    }

    // Size limit enforcement
    if (attachmentsMaxBytes && size && size > attachmentsMaxBytes) {
      log.warn(`Attachment ${name} (${size} bytes) exceeds size limit, skipping download.`);
      attachments.push(attachment);
      const caption = mediaMessage.caption as string | undefined;
      return { attachments, caption };
    }

    // Download and save
    const target = buildAttachmentPath(attachmentsDir, 'whatsapp', chatId, name);
    try {
      const stream = await downloadContentFromMessage(mediaMessage, mediaType);
      await writeStreamToFile(stream, target);
      attachment.localPath = target;
      log.info(`Attachment saved to ${target}`);
    } catch (err) {
      log.warn('Failed to download attachment:', err);
    }
  }

  // Transcribe voice messages
  if (isPttVoiceMessage) {
    try {
      const { isTranscriptionConfigured } = await import('../../../transcription/index.js');
      if (!isTranscriptionConfigured()) {
        // Send error message directly to user (matches Telegram/Slack/Discord/Signal behavior)
        try {
          await sock.sendMessage(chatId, {
            text: 'Voice messages require a transcription API key. See: https://github.com/letta-ai/lettabot#voice-messages'
          });
        } catch (sendError) {
          log.error('Failed to send transcription error message:', sendError);
        }
        // Don't forward error to agent - return early
        const caption = mediaMessage.caption as string | undefined;
        return { attachments, caption };
      }

      // Download audio buffer for transcription
      const stream = await downloadContentFromMessage(mediaMessage, mediaType);
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      // Transcribe audio
      const { transcribeAudio } = await import('../../../transcription/index.js');
      const result = await transcribeAudio(buffer, name);

      if (result.success && result.text) {
        log.info(`Transcribed voice message: "${result.text.slice(0, 50)}..."`);
        voiceTranscription = `[Voice message]: ${result.text}`;
      } else {
        log.error(`Transcription failed: ${result.error}`);
        voiceTranscription = `[Voice message - transcription failed: ${result.error}]`;
      }
    } catch (error) {
      log.error('Error transcribing voice message:', error);
      voiceTranscription = `[Voice message - error: ${error instanceof Error ? error.message : 'unknown error'}]`;
    }
  }

  attachments.push(attachment);
  const caption = mediaMessage.caption as string | undefined;
  return { attachments, caption, voiceTranscription };
}

/**
 * Extract file extension from MIME type.
 *
 * @param mimeType - MIME type string (e.g., "image/jpeg")
 * @returns File extension (e.g., "jpeg") or "bin" if unknown
 */
export function extensionFromMime(mimeType?: string): string {
  if (!mimeType) return 'bin';
  const clean = mimeType.split(';')[0] || '';
  const parts = clean.split('/');
  if (parts.length < 2) return 'bin';
  const ext = parts[1].trim();
  return ext || 'bin';
}

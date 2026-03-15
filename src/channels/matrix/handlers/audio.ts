import { createLogger } from '../../../logger.js';
const log = createLogger('MatrixAudio');
/**
 * Audio Handler for Matrix Adapter
 *
 * Handles incoming audio messages, transcription via STT,
 * and coordinates TTS audio response generation.
 */

import type * as sdk from "matrix-js-sdk";
import type { InboundMessage } from "../../../core/types.js";
import { transcribeAudio } from "../stt.js";
import { downloadAndDecryptMedia, type EncryptionInfo } from "../media.js";

export interface AudioHandlerContext {
  client: sdk.MatrixClient;
  room: sdk.Room;
  event: sdk.MatrixEvent;
  ourUserId: string;

  // Configuration
  transcriptionEnabled: boolean;
  sttUrl?: string;

  // Callbacks
  sendTyping: (roomId: string, typing: boolean) => Promise<void>;
  sendMessage: (roomId: string, text: string) => Promise<void>;
}

interface AudioInfo {
  mxcUrl?: string;
  encryptionInfo?: EncryptionInfo;
}

/**
 * Handle audio messages
 */
export async function handleAudioMessage(
  ctx: AudioHandlerContext,
): Promise<InboundMessage | null> {
  const { client, room, event, ourUserId } = ctx;

  const sender = event.getSender();
  const roomId = room.roomId;

  if (!sender || !roomId) return null;

  log.info(`Audio from ${sender} in ${roomId}`);

  // Send typing indicator (STT takes time)
  await ctx.sendTyping(roomId, true);

  try {
    const content = event.getContent();
    const audioInfo = extractAudioInfo(content);

    if (!audioInfo.mxcUrl) {
      throw new Error("No audio URL found");
    }

    // Download and decrypt audio (handles auth + E2EE)
    const audioData = await downloadAndDecryptMedia(client, audioInfo.mxcUrl, audioInfo.encryptionInfo);
    log.info(`Downloaded ${audioData.length} bytes`);

    // Transcribe if enabled
    if (!ctx.transcriptionEnabled) {
      await ctx.sendTyping(roomId, false);
      await ctx.sendMessage(roomId, "Audio received (transcription disabled)");
      return null;
    }

    const transcription = await transcribeAudio(audioData, {
      url: ctx.sttUrl,
      model: "small",
    });

    if (!transcription || isTranscriptionFailed(transcription)) {
      await ctx.sendTyping(roomId, false);
      await ctx.sendMessage(roomId, "No speech detected in audio");
      return null;
    }

    log.info(`Transcribed: "${transcription.slice(0, 50)}..."`);

    // Voice context prefix
    const voiceMessage = `[VOICE] "${transcription}"`;

    const isDm = isDirectMessage(room);
    const roomName = room.name || room.getCanonicalAlias() || roomId;

    await ctx.sendTyping(roomId, false);

    return {
      channel: "matrix",
      chatId: roomId,
      userId: sender,
      userName: room.getMember(sender)?.name || sender,
      userHandle: sender,
      messageId: event.getId() || undefined,
      text: voiceMessage,
      timestamp: new Date(event.getTs()),
      isGroup: !isDm,
      groupName: isDm ? undefined : roomName,
      isVoiceInput: true, // Mark as voice so bot.ts knows to generate audio response
    };
  } catch (err) {
    log.error("Failed to process audio:", err);
    await ctx.sendTyping(roomId, false);
    await ctx.sendMessage(roomId, `Failed to process audio: ${err instanceof Error ? err.message : "Unknown error"}`);
    return null;
  }
}

function extractAudioInfo(content: Record<string, unknown>): AudioInfo {
  const file = content.file as Record<string, unknown> | undefined;
  const url = content.url as string | undefined;

  if (file?.url) {
    return {
      mxcUrl: file.url as string,
      encryptionInfo: {
        key: file.key as { k: string },
        iv: file.iv as string,
        hashes: file.hashes as { sha256: string },
      },
    };
  }

  if (url) {
    return { mxcUrl: url };
  }

  return {};
}


function isDirectMessage(room: sdk.Room): boolean {
  return room.getJoinedMembers().length === 2;
}

function isTranscriptionFailed(text: string): boolean {
  return text.startsWith("[") && text.includes("Error");
}

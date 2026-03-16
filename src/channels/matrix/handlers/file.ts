import { createLogger } from '../../../logger.js';
const log = createLogger('MatrixFile');
/**
 * File Handler for Matrix Adapter
 *
 * Handles incoming file messages (PDFs, docs, etc.) by downloading,
 * decrypting, and saving to disk so the agent can process them via
 * shell tools (pdftotext, cat, etc.)
 *
 * Files are saved to: {uploadDir}/uploads/YYYY-MM/{filename}
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type * as sdk from "matrix-js-sdk";
import type { InboundMessage } from "../../../core/types.js";
import { downloadAndDecryptMedia, type EncryptionInfo } from "../media.js";

export interface FileHandlerContext {
  client: sdk.MatrixClient;
  room: sdk.Room;
  event: sdk.MatrixEvent;
  ourUserId: string;

  // Base directory for uploads (e.g. process.cwd())
  uploadDir: string;

  // Callbacks
  sendTyping: (roomId: string, typing: boolean) => Promise<void>;
}

interface FileInfo {
  mxcUrl?: string;
  encryptionInfo?: EncryptionInfo;
  filename: string;
  mimetype: string;
  size?: number;
}

/**
 * Handle generic file messages (m.file)
 */
export async function handleFileMessage(
  ctx: FileHandlerContext,
): Promise<InboundMessage | null> {
  const { client, room, event, ourUserId } = ctx;

  const sender = event.getSender();
  const roomId = room.roomId;

  if (!sender || sender === ourUserId) return null;
  if (!roomId) return null;

  const content = event.getContent();
  if (!content) return null;

  const fileInfo = extractFileInfo(content, event.getId() || "unknown");

  log.info(`File from ${sender} in ${roomId}: ${fileInfo.filename} (${fileInfo.mimetype})`);

  if (!fileInfo.mxcUrl) {
    log.warn("No URL found in file event");
    return null;
  }

  await ctx.sendTyping(roomId, true);

  try {
    // Download and decrypt (handles auth + E2EE)
    const fileData = await downloadAndDecryptMedia(client, fileInfo.mxcUrl, fileInfo.encryptionInfo);
    log.info(`Downloaded ${fileData.length} bytes`);

    // Build upload path: uploads/YYYY-MM/filename
    const now = new Date();
    const monthDir = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const uploadPath = join(ctx.uploadDir, "uploads", monthDir);
    mkdirSync(uploadPath, { recursive: true });

    const savePath = join(uploadPath, fileInfo.filename);
    writeFileSync(savePath, fileData);

    // Relative path for agent (relative to uploadDir / process.cwd())
    const relativePath = join("uploads", monthDir, fileInfo.filename);
    const sizeKB = fileInfo.size ? `${Math.round(fileInfo.size / 1024)} KB` : `${Math.round(fileData.length / 1024)} KB`;

    log.info(`Saved to ${savePath}`);

    await ctx.sendTyping(roomId, false);

    const isDm = room.getJoinedMembers().length === 2;
    const roomName = room.name || room.getCanonicalAlias() || roomId;

    const text = [
      `[File received: ${fileInfo.filename} (${fileInfo.mimetype}, ${sizeKB})`,
      `Saved to: ${relativePath}`,
      `Use shell tools to read it (pdftotext, cat, head, strings, etc.)]`,
    ].join("\n");

    return {
      channel: "matrix",
      chatId: roomId,
      userId: sender,
      userName: room.getMember(sender)?.name || sender,
      userHandle: sender,
      messageId: event.getId() || undefined,
      text,
      timestamp: new Date(event.getTs()),
      isGroup: !isDm,
      groupName: isDm ? undefined : roomName,
    };
  } catch (err) {
    log.error("Failed to process file:", err);
    await ctx.sendTyping(roomId, false);
    return null;
  }
}

function extractFileInfo(content: Record<string, unknown>, eventId: string): FileInfo {
  const file = content.file as Record<string, unknown> | undefined;
  const url = content.url as string | undefined;
  const info = content.info as Record<string, unknown> | undefined;

  // Sanitize filename: strip path separators, collapse spaces
  const rawName = (content.body as string | undefined) || eventId;
  const filename = rawName
    .replace(/[/\\]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9._\-]/g, "_")
    .slice(0, 200) || "file";

  const mimetype = (info?.mimetype as string | undefined) || "application/octet-stream";
  const size = info?.size as number | undefined;

  if (file?.url) {
    return {
      mxcUrl: file.url as string,
      encryptionInfo: {
        key: file.key as { k: string },
        iv: file.iv as string,
        hashes: file.hashes as { sha256: string },
      },
      filename,
      mimetype,
      size,
    };
  }

  if (url) {
    return { mxcUrl: url, filename, mimetype, size };
  }

  return { filename, mimetype, size };
}

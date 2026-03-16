import { createLogger } from '../../logger.js';
const log = createLogger('MatrixMedia');
/**
 * Matrix Media Download Utilities
 *
 * Handles authenticated media downloads and E2EE attachment decryption.
 *
 * Matrix spec v1.11 moved media to authenticated endpoints:
 *   /_matrix/client/v1/media/download/{serverName}/{mediaId}
 *
 * E2EE attachments use AES-256-CTR encryption with:
 *   - Key: base64url-encoded 256-bit AES key (file.key.k)
 *   - IV: base64-encoded 128-bit counter block (file.iv)
 *   - Hash: SHA-256 of encrypted data (file.hashes.sha256)
 */

import type * as sdk from "matrix-js-sdk";
import { webcrypto } from "crypto";

export interface EncryptionInfo {
  key: { k: string };
  iv: string;
  hashes: { sha256: string };
}

/**
 * Download a Matrix media file with authentication.
 * Tries the authenticated v1 endpoint first, falls back to v3.
 */
export async function downloadMatrixMedia(
  client: sdk.MatrixClient,
  mxcUrl: string,
): Promise<Buffer> {
  if (!mxcUrl.startsWith("mxc://")) {
    throw new Error(`Invalid MXC URL: ${mxcUrl}`);
  }

  // Parse mxc://serverName/mediaId
  const withoutScheme = mxcUrl.slice("mxc://".length);
  const slashIndex = withoutScheme.indexOf("/");
  if (slashIndex === -1) throw new Error(`Malformed MXC URL: ${mxcUrl}`);

  const serverName = withoutScheme.slice(0, slashIndex);
  const mediaId = withoutScheme.slice(slashIndex + 1);
  const homeserver = (client as any).baseUrl || (client as any).getHomeserverUrl?.();
  const accessToken = client.getAccessToken();

  // Prefer authenticated endpoint (Matrix spec v1.11+)
  const authUrl = `${homeserver}/_matrix/client/v1/media/download/${serverName}/${mediaId}`;
  const fallbackUrl = `${homeserver}/_matrix/media/v3/download/${serverName}/${mediaId}`;

  const headers: Record<string, string> = {};
  if (accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }

  for (const url of [authUrl, fallbackUrl]) {
    try {
      log.info(`Downloading from ${url.substring(0, 80)}...`);
      const response = await fetch(url, { headers });
      if (response.ok) {
        const data = Buffer.from(await response.arrayBuffer());
        log.info(`Downloaded ${data.length} bytes`);
        return data;
      }
      log.info(`${url.includes("v1") ? "v1" : "v3"} returned ${response.status}, ${url.includes("v1") ? "trying v3..." : "giving up"}`);
    } catch (err) {
      log.info(`Request failed: ${err}`);
      if (url === fallbackUrl) throw err;
    }
  }

  throw new Error("Failed to download media from both endpoints");
}

/**
 * Decrypt an AES-256-CTR encrypted Matrix attachment.
 * Used for files in E2EE rooms.
 */
export async function decryptAttachment(
  encryptedData: Buffer,
  encInfo: EncryptionInfo,
): Promise<Buffer> {
  const subtle = webcrypto.subtle;

  // Decode base64url key (32 bytes for AES-256)
  const keyBytes = Buffer.from(encInfo.key.k, "base64url");

  // Decode base64 IV (16 bytes)
  const iv = Buffer.from(encInfo.iv, "base64");
  if (iv.length !== 16) {
    throw new Error(`Invalid IV length: ${iv.length} (expected 16)`);
  }

  // Convert Buffer to plain ArrayBuffer for WebCrypto compatibility
  // Buffer.buffer is ArrayBufferLike (may be SharedArrayBuffer), but .slice() always returns ArrayBuffer
  const encryptedAB = encryptedData.buffer.slice(encryptedData.byteOffset, encryptedData.byteOffset + encryptedData.byteLength) as ArrayBuffer;
  const ivAB = iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer;
  const keyAB = keyBytes.buffer.slice(keyBytes.byteOffset, keyBytes.byteOffset + keyBytes.byteLength) as ArrayBuffer;

  // Verify SHA-256 hash of encrypted data before decrypting
  const hashBuffer = await subtle.digest("SHA-256", encryptedAB);
  const hashB64 = Buffer.from(hashBuffer).toString("base64").replace(/=/g, "");
  const expectedHash = encInfo.hashes.sha256.replace(/=/g, "");
  if (hashB64 !== expectedHash) {
    throw new Error(`SHA-256 hash mismatch: file may be corrupted`);
  }

  // Import AES-256-CTR key
  const cryptoKey = await subtle.importKey(
    "raw",
    keyAB,
    { name: "AES-CTR", length: 256 },
    false,
    ["decrypt"],
  );

  // Decrypt (AES-256-CTR, 64-bit counter = last 8 bytes of the 16-byte block)
  const decrypted = await subtle.decrypt(
    { name: "AES-CTR", counter: new Uint8Array(ivAB), length: 64 },
    cryptoKey,
    encryptedAB,
  );

  return Buffer.from(decrypted);
}

/**
 * Download and optionally decrypt a Matrix media attachment.
 */
export async function downloadAndDecryptMedia(
  client: sdk.MatrixClient,
  mxcUrl: string,
  encryptionInfo?: EncryptionInfo,
): Promise<Buffer> {
  const data = await downloadMatrixMedia(client, mxcUrl);

  if (encryptionInfo) {
    log.info(`Decrypting E2EE attachment...`);
    const decrypted = await decryptAttachment(data, encryptionInfo);
    log.info(`Decrypted: ${data.length} → ${decrypted.length} bytes`);
    return decrypted;
  }

  return data;
}

import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const SAFE_NAME_RE = /[^A-Za-z0-9._-]/g;

export function sanitizeFilename(input: string): string {
  const cleaned = input.replace(SAFE_NAME_RE, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'attachment';
}

export function buildAttachmentPath(
  baseDir: string,
  channel: string,
  chatId: string,
  filename?: string
): string {
  const safeChannel = sanitizeFilename(channel);
  const safeChatId = sanitizeFilename(chatId);
  const safeName = sanitizeFilename(filename || 'attachment');
  const dir = join(baseDir, safeChannel, safeChatId);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const token = randomUUID().slice(0, 8);
  return join(dir, `${stamp}-${token}-${safeName}`);
}

export async function downloadToFile(
  url: string,
  filePath: string,
  headers?: Record<string, string>
): Promise<void> {
  ensureParentDir(filePath);
  const res = await fetch(url, { headers });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (${res.status})`);
  }
  const stream = Readable.from(res.body as unknown as AsyncIterable<Uint8Array>);
  await pipeline(stream, createWriteStream(filePath));
}

export async function writeStreamToFile(
  stream: AsyncIterable<Uint8Array> | NodeJS.ReadableStream,
  filePath: string
): Promise<void> {
  ensureParentDir(filePath);
  const readable = isReadableStream(stream) ? stream : Readable.from(stream);
  await pipeline(readable, createWriteStream(filePath));
}

function ensureParentDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

function isReadableStream(
  stream: AsyncIterable<Uint8Array> | NodeJS.ReadableStream
): stream is NodeJS.ReadableStream {
  return typeof (stream as NodeJS.ReadableStream).pipe === 'function';
}

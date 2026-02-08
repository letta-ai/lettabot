/**
 * Pairing Store
 * 
 * Manages pending pairing requests and approved allowlists.
 * Based on moltbot's pairing system.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { PairingRequest, PairingStore, AllowFromStore } from './types.js';
import { normalizePhoneForStorage } from '../utils/phone.js';

// Configuration
const CODE_LENGTH = 8;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No ambiguous chars (0O1I)
const CODE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_PENDING = 3;

// Storage paths
function getCredentialsDir(): string {
  const home = os.homedir();
  return path.join(home, '.lettabot', 'credentials');
}

function getPairingPath(channel: string): string {
  return path.join(getCredentialsDir(), `${channel}-pairing.json`);
}

function getAllowFromPath(channel: string): string {
  return path.join(getCredentialsDir(), `${channel}-allowFrom.json`);
}

// Helpers
function generateCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    const idx = crypto.randomInt(0, CODE_ALPHABET.length);
    code += CODE_ALPHABET[idx];
  }
  return code;
}

function generateUniqueCode(existing: Set<string>): string {
  for (let attempt = 0; attempt < 500; attempt++) {
    const code = generateCode();
    if (!existing.has(code)) return code;
  }
  throw new Error('Failed to generate unique pairing code');
}

function isExpired(request: PairingRequest): boolean {
  const createdAt = Date.parse(request.createdAt);
  if (!Number.isFinite(createdAt)) return true;
  return Date.now() - createdAt > CODE_TTL_MS;
}

function pruneExpired(requests: PairingRequest[]): PairingRequest[] {
  return requests.filter(r => !isExpired(r));
}

function pruneExcess(requests: PairingRequest[]): PairingRequest[] {
  if (requests.length <= MAX_PENDING) return requests;
  // Keep the most recent ones
  return requests
    .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))
    .slice(0, MAX_PENDING);
}

// File I/O
async function ensureDir(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf-8' });
  await fs.promises.chmod(tmp, 0o600);
  await fs.promises.rename(tmp, filePath);
}

// Public API

/**
 * Read the allowFrom list for a channel
 */
export async function readAllowFrom(channel: string): Promise<string[]> {
  const filePath = getAllowFromPath(channel);
  const store = await readJson<AllowFromStore>(filePath, { version: 1, allowFrom: [] });
  return store.allowFrom || [];
}

/**
 * Add a user ID to the allowFrom list
 */
export async function addToAllowFrom(channel: string, userId: string): Promise<void> {
  const filePath = getAllowFromPath(channel);
  const store = await readJson<AllowFromStore>(filePath, { version: 1, allowFrom: [] });
  const allowFrom = store.allowFrom || [];

  const normalized = normalizePhoneForStorage(userId);
  if (!normalized || allowFrom.includes(normalized)) return;

  allowFrom.push(normalized);
  await writeJson(filePath, { version: 1, allowFrom });
}

/**
 * Check if a user is allowed (in config or store)
 */
export async function isUserAllowed(
  channel: string,
  userId: string,
  configAllowlist?: string[]
): Promise<boolean> {
  const normalized = normalizePhoneForStorage(userId);

  // Check config allowlist first (normalize each entry for comparison)
  if (configAllowlist) {
    const normalizedConfig = configAllowlist.map(id => normalizePhoneForStorage(id));
    if (normalizedConfig.includes(normalized)) {
      return true;
    }
  }

  // Check stored allowFrom
  const storeAllowFrom = await readAllowFrom(channel);
  return storeAllowFrom.includes(normalized);
}

/**
 * List pending pairing requests for a channel
 */
export async function listPairingRequests(channel: string): Promise<PairingRequest[]> {
  const filePath = getPairingPath(channel);
  const store = await readJson<PairingStore>(filePath, { version: 1, requests: [] });
  
  let requests = store.requests || [];
  const beforeCount = requests.length;
  
  // Prune expired and excess
  requests = pruneExpired(requests);
  requests = pruneExcess(requests);
  
  // Save if we pruned anything
  if (requests.length !== beforeCount) {
    await writeJson(filePath, { version: 1, requests });
  }
  
  return requests.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Create or update a pairing request
 * Returns { code, created } where created is true if this is a new request
 */
export async function upsertPairingRequest(
  channel: string,
  userId: string,
  meta?: PairingRequest['meta']
): Promise<{ code: string; created: boolean }> {
  const filePath = getPairingPath(channel);
  const store = await readJson<PairingStore>(filePath, { version: 1, requests: [] });
  
  const now = new Date().toISOString();
  const id = String(userId).trim();
  
  let requests = store.requests || [];
  requests = pruneExpired(requests);
  
  // Check for existing request
  const existingIdx = requests.findIndex(r => r.id === id);
  const existingCodes = new Set(requests.map(r => r.code.toUpperCase()));
  
  if (existingIdx >= 0) {
    // Update existing request
    const existing = requests[existingIdx];
    const code = existing.code || generateUniqueCode(existingCodes);
    requests[existingIdx] = {
      ...existing,
      code,
      lastSeenAt: now,
      meta: meta || existing.meta,
    };
    await writeJson(filePath, { version: 1, requests: pruneExcess(requests) });
    return { code, created: false };
  }
  
  // Check if we're at max pending
  requests = pruneExcess(requests);
  if (requests.length >= MAX_PENDING) {
    // Return empty code to indicate we can't create more
    return { code: '', created: false };
  }
  
  // Create new request
  const code = generateUniqueCode(existingCodes);
  requests.push({
    id,
    code,
    createdAt: now,
    lastSeenAt: now,
    meta,
  });
  
  await writeJson(filePath, { version: 1, requests });
  return { code, created: true };
}

/**
 * Approve a pairing code
 * Returns the user ID if successful, null if code not found
 */
export async function approvePairingCode(
  channel: string,
  code: string
): Promise<{ userId: string; meta?: PairingRequest['meta'] } | null> {
  const filePath = getPairingPath(channel);
  const store = await readJson<PairingStore>(filePath, { version: 1, requests: [] });
  
  let requests = store.requests || [];
  requests = pruneExpired(requests);
  
  const normalizedCode = code.trim().toUpperCase();
  const idx = requests.findIndex(r => r.code.toUpperCase() === normalizedCode);
  
  if (idx < 0) {
    // Save pruned list even if code not found
    await writeJson(filePath, { version: 1, requests });
    return null;
  }
  
  const request = requests[idx];
  requests.splice(idx, 1);
  
  // Save updated requests and add to allowFrom
  await writeJson(filePath, { version: 1, requests });
  await addToAllowFrom(channel, request.id);
  
  return { userId: request.id, meta: request.meta };
}

/**
 * Format the pairing message to send to users
 */
export function formatPairingMessage(code: string): string {
  return `Hi! This bot requires pairing.

Your code: **${code}**

Ask the owner to run:
\`lettabot pairing approve telegram ${code}\`

This code expires in 1 hour.`;
}

/**
 * Approved Groups Store
 *
 * Tracks which groups have been approved (activated by a paired user).
 * Only relevant when dmPolicy === 'pairing'.
 *
 * Storage: ~/.lettabot/credentials/{channel}-approvedGroups.json
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

interface ApprovedGroupsStore {
  version: 1;
  groups: string[];
}

function getCredentialsDir(): string {
  return path.join(os.homedir(), '.lettabot', 'credentials');
}

function getStorePath(channel: string): string {
  return path.join(getCredentialsDir(), `${channel}-approvedGroups.json`);
}

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

/**
 * Check if a group has been approved for a given channel.
 */
export async function isGroupApproved(channel: string, chatId: string): Promise<boolean> {
  const filePath = getStorePath(channel);
  const store = await readJson<ApprovedGroupsStore>(filePath, { version: 1, groups: [] });
  return (store.groups || []).includes(chatId);
}

/**
 * Approve a group for a given channel.
 */
export async function approveGroup(channel: string, chatId: string): Promise<void> {
  const filePath = getStorePath(channel);
  const store = await readJson<ApprovedGroupsStore>(filePath, { version: 1, groups: [] });
  const groups = store.groups || [];
  if (groups.includes(chatId)) return;
  groups.push(chatId);
  await writeJson(filePath, { version: 1, groups });
}

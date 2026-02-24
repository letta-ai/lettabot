/**
 * API key management for LettaBot HTTP API
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { IncomingHttpHeaders } from 'http';

import { createLogger } from '../logger.js';

const log = createLogger('API');
const API_KEY_FILE = 'lettabot-api.json';

interface ApiKeyStore {
  apiKey: string;
}

/**
 * Generate a secure random API key (64 hex chars)
 */
export function generateApiKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Load API key from environment or file. Throws if not found.
 * Use this in CLI tools where generating a new key would be incorrect.
 */
export function loadApiKey(): string {
  // 1. Check environment variable first
  if (process.env.LETTABOT_API_KEY) {
    return process.env.LETTABOT_API_KEY;
  }

  // 2. Try to load from file
  const filePath = path.resolve(process.cwd(), API_KEY_FILE);
  if (fs.existsSync(filePath)) {
    try {
      const data = fs.readFileSync(filePath, 'utf-8');
      const store: ApiKeyStore = JSON.parse(data);
      if (store.apiKey && typeof store.apiKey === 'string') {
        return store.apiKey;
      }
    } catch {
      // Fall through to error
    }
  }

  throw new Error(
    'API key not found. Start the lettabot server first (it generates lettabot-api.json), ' +
    'or set LETTABOT_API_KEY environment variable.'
  );
}

/**
 * Load API key from file or environment, or generate new one.
 * Use this on the server side where generating a key on first run is expected.
 */
export function loadOrGenerateApiKey(): string {
  // 1. Check environment variable first
  if (process.env.LETTABOT_API_KEY) {
    return process.env.LETTABOT_API_KEY;
  }

  // 2. Try to load from file
  const filePath = path.resolve(process.cwd(), API_KEY_FILE);
  if (fs.existsSync(filePath)) {
    try {
      const data = fs.readFileSync(filePath, 'utf-8');
      const store: ApiKeyStore = JSON.parse(data);
      if (store.apiKey && typeof store.apiKey === 'string') {
        return store.apiKey;
      }
    } catch (error) {
      log.warn(`Failed to load API key from ${API_KEY_FILE}:`, error);
    }
  }

  // 3. Generate new key and save
  const newKey = generateApiKey();
  saveApiKey(newKey);
  return newKey;
}

/**
 * Save API key to file
 */
export function saveApiKey(key: string): void {
  const filePath = path.resolve(process.cwd(), API_KEY_FILE);
  const store: ApiKeyStore = { apiKey: key };

  try {
    fs.writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf-8');
    log.info(`Key saved to ${API_KEY_FILE}`);
  } catch (error) {
    log.error(`Failed to save API key to ${API_KEY_FILE}:`, error);
  }
}

/**
 * Validate API key from request headers
 */
export function validateApiKey(headers: IncomingHttpHeaders, expectedKey: string): boolean {
  const providedKey = headers['x-api-key'];

  if (!providedKey || typeof providedKey !== 'string') {
    return false;
  }

  // Use constant-time comparison to prevent timing attacks
  const a = Buffer.from(providedKey);
  const b = Buffer.from(expectedKey);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

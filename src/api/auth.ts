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
 * Extract API key from request headers.
 * Checks X-Api-Key first (lettabot convention), then Authorization: Bearer <key> (OpenAI convention).
 * 
 * Note: When using Authorization header, ensure CORS includes 'Authorization' in Access-Control-Allow-Headers.
 * 
 * @param headers - HTTP request headers
 * @returns The extracted API key, or null if not found
 */
export function extractApiKey(headers: IncomingHttpHeaders): string | null {
  // 1. X-Api-Key header (lettabot convention)
  const xApiKey = headers['x-api-key'];
  if (xApiKey && typeof xApiKey === 'string') {
    return xApiKey;
  }

  // 2. Authorization: Bearer <key> (OpenAI convention)
  const auth = headers['authorization'];
  if (auth && typeof auth === 'string') {
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (match) {
      return match[1];
    }
  }

  return null;
}

/**
 * Validate API key from request headers.
 * Supports both X-Api-Key and Authorization: Bearer <key> formats.
 * 
 * @param headers - HTTP request headers
 * @param expectedKey - The expected API key to validate against
 * @returns true if the provided key matches the expected key, false otherwise
 */
export function validateApiKey(headers: IncomingHttpHeaders, expectedKey: string): boolean {
  const providedKey = extractApiKey(headers);

  if (!providedKey) {
    return false;
  }

  // Use constant-time comparison to prevent timing attacks
  const a = Buffer.from(providedKey);
  const b = Buffer.from(expectedKey);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

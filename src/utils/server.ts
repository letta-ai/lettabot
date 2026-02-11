/**
 * Letta server URL utilities
 *
 * The heuristic is simple: Letta API lives at a known URL.
 * Everything else is a Docker/custom server.
 */

import { LETTA_API_URL } from '../auth/oauth.js';

/**
 * Check if a URL points at Letta API (api.letta.com)
 *
 * @param url - The base URL to check. When absent, assumes Letta API (the default).
 */
export function isLettaApiUrl(url?: string): boolean {
  if (!url) return true; // no URL means the default (Letta API)
  try {
    const given = new URL(url);
    const api = new URL(LETTA_API_URL);
    return given.hostname === api.hostname;
  } catch {
    return false;
  }
}

// Backward-compatible alias.
export const isLettaCloudUrl = isLettaApiUrl;

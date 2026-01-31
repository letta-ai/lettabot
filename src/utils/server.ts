/**
 * Letta server URL utilities
 *
 * The heuristic is simple: Letta Cloud lives at a known URL.
 * Everything else is self-hosted.
 */

import { LETTA_CLOUD_API_URL } from '../auth/oauth.js';

/**
 * Check if a URL points at Letta Cloud (api.letta.com)
 *
 * @param url - The base URL to check. When absent, assumes cloud (the default).
 */
export function isLettaCloudUrl(url?: string): boolean {
  if (!url) return true; // no URL means the default (cloud)
  try {
    const given = new URL(url);
    const cloud = new URL(LETTA_CLOUD_API_URL);
    return given.hostname === cloud.hostname;
  } catch {
    return false;
  }
}

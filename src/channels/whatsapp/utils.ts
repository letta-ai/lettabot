/**
 * WhatsApp Utility Functions
 *
 * Helper functions for JID parsing, self-chat detection, and group metadata caching.
 */

/**
 * Convert WhatsApp JID to E.164 phone number format.
 *
 * @param jid - WhatsApp JID (e.g., "1234567890@s.whatsapp.net")
 * @returns E.164 number (e.g., "1234567890")
 *
 * @example
 * jidToE164("1234567890@s.whatsapp.net") // "1234567890"
 * jidToE164("1234567890:50@s.whatsapp.net") // "1234567890"
 */
import { createLogger } from '../../logger.js';

const log = createLogger('WhatsApp');
export function jidToE164(jid: string): string {
  return jid.replace(/@.*/, "").replace(/:\d+$/, "");
}

/**
 * Normalize WhatsApp JID to consistent format.
 *
 * @param jid - WhatsApp JID
 * @returns Normalized JID
 */
export function normalizeJid(jid: string): string {
  return jid.trim();
}

/**
 * Check if a message is a self-chat message (user messaging themselves).
 *
 * Self-chat detection rules:
 * 1. Message must be fromMe (sent by the bot's phone)
 * 2. AND one of:
 *    - Remote JID matches bot's own JID
 *    - Remote JID number matches bot's number
 *    - In selfChatMode AND remote JID is an LID
 *
 * @param message - Baileys message
 * @param myJid - Bot's own JID
 * @param myNumber - Bot's phone number
 * @param selfChatMode - Whether self-chat mode is enabled
 * @returns true if this is a self-chat message
 */
export function isSelfChatMessage(
  message: import("@whiskeysockets/baileys").WAMessage,
  myJid: string,
  myNumber: string,
  selfChatMode: boolean
): boolean {
  if (!message.key?.fromMe) {
    return false;
  }

  const remoteJid = message.key.remoteJid ?? "";

  // Check if remote JID is our own number
  const isOwnJid =
    remoteJid === myJid || remoteJid.replace(/@.*/, "") === myNumber;

  // Check if it's an LID self-chat (only in selfChatMode)
  const isLidSelfChat = selfChatMode && remoteJid.includes("@lid");

  return isOwnJid || isLidSelfChat;
}

/**
 * Group metadata cache entry
 */
export interface GroupMetaEntry {
  subject?: string;
  participants?: string[];
  expires: number;
}

/**
 * Group metadata cache interface
 */
export interface GroupMetaCache {
  get: (jid: string, fetch: () => Promise<any>) => Promise<GroupMetaEntry>;
  clear: () => void;
}

/**
 * Create a TTL-based cache for group metadata.
 * Reduces API calls by caching group info for 5 minutes.
 *
 * @returns Group metadata cache
 *
 * @example
 * const cache = createGroupMetaCache();
 *
 * // Fetch and cache
 * const meta = await cache.get(groupJid, () => sock.groupMetadata(groupJid));
 * console.log(meta.subject); // "My Group Name"
 *
 * // Subsequent calls within 5 minutes return cached data
 * const cached = await cache.get(groupJid, () => sock.groupMetadata(groupJid));
 * // No API call made
 */
export function createGroupMetaCache(): GroupMetaCache {
  const cache = new Map<string, GroupMetaEntry>();
  const TTL_MS = 5 * 60 * 1000; // 5 minutes

  return {
    get: async (jid: string, fetch: () => Promise<any>): Promise<GroupMetaEntry> => {
      // Check cache
      const cached = cache.get(jid);
      if (cached && cached.expires > Date.now()) {
        return cached;
      }

      // Fetch fresh data
      try {
        const meta = await fetch();
        const entry: GroupMetaEntry = {
          subject: meta.subject,
          participants: meta.participants?.map((p: { id: string }) => p.id) ?? [],
          expires: Date.now() + TTL_MS,
        };
        cache.set(jid, entry);
        return entry;
      } catch (err) {
        log.warn(`Failed to fetch group metadata for ${jid}:`, err);
        // Return empty entry with TTL (prevents repeated failed fetches)
        return { expires: Date.now() + TTL_MS };
      }
    },

    clear: (): void => {
      cache.clear();
    },
  };
}

/**
 * Check if a remote JID is a status or broadcast channel.
 * These should not trigger bot responses.
 *
 * @param remoteJid - WhatsApp JID
 * @returns true if status/broadcast
 */
export function isStatusOrBroadcast(remoteJid: string | null | undefined): boolean {
  if (!remoteJid) return false;
  return remoteJid.endsWith("@status") || remoteJid.endsWith("@broadcast");
}

/**
 * Check if a remote JID is a group.
 *
 * @param remoteJid - WhatsApp JID
 * @returns true if group
 */
export function isGroupJid(remoteJid: string | null | undefined): boolean {
  if (!remoteJid) return false;
  return remoteJid.endsWith("@g.us");
}

/**
 * Check if a remote JID is an LID (Linked Identifier).
 * LIDs are used for contact privacy and need special handling.
 *
 * @param remoteJid - WhatsApp JID
 * @returns true if LID
 */
export function isLid(remoteJid: string | null | undefined): boolean {
  if (!remoteJid) return false;
  return remoteJid.includes("@lid");
}

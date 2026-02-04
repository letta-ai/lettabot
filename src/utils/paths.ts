/**
 * Path utilities for persistent data storage
 * 
 * On Railway with a volume attached, RAILWAY_VOLUME_MOUNT_PATH is automatically set.
 * We use this to store all persistent data in the volume.
 * 
 * Priority:
 * 1. RAILWAY_VOLUME_MOUNT_PATH (Railway with volume)
 * 2. DATA_DIR env var (custom path)
 * 3. process.cwd() (default - local development)
 */

import { resolve } from 'node:path';

/**
 * Get the base directory for persistent data storage.
 * 
 * On Railway with a volume, this returns the volume mount path.
 * Locally, this returns the current working directory.
 */
export function getDataDir(): string {
  // Railway volume takes precedence
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    return process.env.RAILWAY_VOLUME_MOUNT_PATH;
  }
  
  // Custom data directory
  if (process.env.DATA_DIR) {
    return process.env.DATA_DIR;
  }
  
  // Default to current working directory
  return process.cwd();
}

/**
 * Get the working directory for runtime data (attachments, skills, etc.)
 * 
 * On Railway with a volume, this returns {volume}/data
 * Otherwise uses WORKING_DIR env var or /tmp/lettabot
 */
export function getWorkingDir(): string {
  // Explicit WORKING_DIR always wins
  if (process.env.WORKING_DIR) {
    return process.env.WORKING_DIR;
  }
  
  // On Railway with volume, use volume/data subdirectory
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    return resolve(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'data');
  }
  
  // Default for local development
  return '/tmp/lettabot';
}

/**
 * Check if running on Railway
 */
export function isRailway(): boolean {
  return !!process.env.RAILWAY_ENVIRONMENT;
}

/**
 * Check if a Railway volume is mounted
 */
export function hasRailwayVolume(): boolean {
  return !!process.env.RAILWAY_VOLUME_MOUNT_PATH;
}

// =============================================================================
// Multi-Agent Path Utilities
// =============================================================================

import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Get the data directory for a specific agent.
 * Channel state (WhatsApp sessions, Signal data) is stored here.
 *
 * Format: {dataDir}/agents/{agentId}/
 */
export function getAgentDataDir(agentId: string): string {
  return join(getDataDir(), 'agents', agentId);
}

/**
 * Get the channel state directory for a specific agent and channel type.
 *
 * Format: {dataDir}/agents/{agentId}/{channelType}-session/
 */
export function getAgentChannelStateDir(agentId: string, channelType: string): string {
  return join(getAgentDataDir(agentId), `${channelType}-session`);
}

/**
 * Migrate legacy channel state to agent-scoped directory.
 *
 * This is called on agent startup to move legacy channel state
 * (e.g., ./data/whatsapp-session) to the new agent-scoped location
 * (e.g., ./data/agents/{agentId}/whatsapp-session).
 *
 * Only runs once per agent - skips if destination already exists.
 */
export function migrateChannelState(agentId: string): void {
  const dataDir = getDataDir();
  const agentDataDir = getAgentDataDir(agentId);

  // Channels with persistent state that may need migration
  const channelTypes = ['whatsapp', 'signal'];

  for (const channelType of channelTypes) {
    const oldPath = join(dataDir, `${channelType}-session`);
    const newPath = join(agentDataDir, `${channelType}-session`);

    // Skip if old path doesn't exist or new path already exists
    if (!existsSync(oldPath) || existsSync(newPath)) {
      continue;
    }

    try {
      // Ensure agent data directory exists
      mkdirSync(agentDataDir, { recursive: true });

      // Move the session directory
      renameSync(oldPath, newPath);
      console.log(`[Migration] Moved ${channelType} session to ${newPath}`);
    } catch (e) {
      console.error(`[Migration] Failed to migrate ${channelType} session:`, e);
    }
  }
}

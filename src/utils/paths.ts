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
 * Get the canonical directory for cron state (cron-jobs.json / cron-log.jsonl).
 *
 * This is intentionally deterministic across server and CLI contexts, and does
 * not depend on process.cwd().
 *
 * Priority:
 * 1. RAILWAY_VOLUME_MOUNT_PATH (Railway persistent volume)
 * 2. DATA_DIR (explicit persistent data override)
 * 3. WORKING_DIR (runtime workspace)
 * 4. /tmp/lettabot (deterministic local fallback)
 */
export function getCronDataDir(): string {
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    return process.env.RAILWAY_VOLUME_MOUNT_PATH;
  }

  if (process.env.DATA_DIR) {
    return process.env.DATA_DIR;
  }

  if (process.env.WORKING_DIR) {
    return process.env.WORKING_DIR;
  }

  return '/tmp/lettabot';
}

/**
 * Canonical cron store path.
 */
export function getCronStorePath(): string {
  return resolve(getCronDataDir(), 'cron-jobs.json');
}

/**
 * Canonical cron log path.
 */
export function getCronLogPath(): string {
  return resolve(getCronDataDir(), 'cron-log.jsonl');
}

/**
 * Legacy cron store path (used before deterministic cron path resolution).
 * Kept for migration of existing local files.
 */
export function getLegacyCronStorePath(): string {
  return resolve(getDataDir(), 'cron-jobs.json');
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

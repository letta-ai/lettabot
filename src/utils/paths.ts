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

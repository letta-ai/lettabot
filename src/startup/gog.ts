/**
 * Restore gogcli (gog) credentials from environment for headless deployments.
 *
 * On Railway / Docker there is no browser to complete the OAuth flow.
 * Instead, the user authenticates locally, exports their ~/.config/gogcli
 * directory as a base64-encoded tarball, and sets GOG_CONFIG_BASE64 in the
 * deployment environment.
 *
 * At startup this module unpacks that tarball into the container's config
 * directory so that all gog services (Gmail, Calendar, Drive, Contacts,
 * Sheets, Docs) work without interactive auth.
 *
 * Export locally:
 *   tar -czf - -C ~/.config gogcli | base64 | tr -d '\n'
 *
 * Set as GOG_CONFIG_BASE64 in Railway / Docker env vars.
 *
 * For headless keyring access set GOG_KEYRING_PASSWORD as well (gogcli uses
 * an encrypted on-disk keyring when no OS keychain is available).
 */

import { existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createLogger } from '../logger.js';

const log = createLogger('GOG');

/**
 * Restore gogcli config from GOG_CONFIG_BASE64 environment variable.
 * Should be called early in startup, before the polling service starts.
 */
export function restoreGogConfig(): void {
  const encoded = process.env.GOG_CONFIG_BASE64;
  if (!encoded) return;

  const configDir = process.env.XDG_CONFIG_HOME || `${process.env.HOME}/.config`;
  const gogDir = `${configDir}/gogcli`;

  // Skip if credentials already exist (e.g. from a persistent volume)
  if (existsSync(`${gogDir}/credentials.json`)) {
    log.info('gogcli credentials already present, skipping restore');
    return;
  }

  log.info('Restoring gogcli config from GOG_CONFIG_BASE64...');

  // Ensure parent config directory exists
  mkdirSync(configDir, { recursive: true });

  // Decode and untar into config directory
  const result = spawnSync('sh', [
    '-c',
    `echo "${encoded}" | base64 -d | tar -xzf - -C "${configDir}"`,
  ], {
    encoding: 'utf-8',
    timeout: 10000,
  });

  if (result.status !== 0) {
    log.error(`Failed to restore gogcli config: ${result.stderr || 'unknown error'}`);
    log.error('Ensure GOG_CONFIG_BASE64 is a valid base64-encoded tarball of ~/.config/gogcli');
    return;
  }

  if (existsSync(`${gogDir}/credentials.json`)) {
    log.info('gogcli config restored successfully');
  } else {
    log.warn('GOG_CONFIG_BASE64 unpacked but credentials.json not found — check tarball contents');
  }
}

/**
 * Check if gogcli is available on PATH.
 * Returns true if `gog --version` succeeds.
 */
export function isGogAvailable(): boolean {
  const result = spawnSync('gog', ['--version'], {
    stdio: 'pipe',
    timeout: 5000,
  });
  return result.status === 0;
}

import type { LettaBotConfig } from './types.js';
import { loadConfigStrict, resolveConfigPath } from './io.js';

import { createLogger } from '../logger.js';

const log = createLogger('Config');
export type ExitFn = (code: number) => never;

/**
 * Load config for app/CLI entrypoints. On invalid config, print one
 * consistent error and terminate.
 */
export function loadAppConfigOrExit(exitFn: ExitFn = process.exit): LettaBotConfig {
  try {
    return loadConfigStrict();
  } catch (err) {
    const configPath = resolveConfigPath();
    log.error(`Failed to load ${configPath}:`, err);
    log.error(`Fix the errors above in ${configPath} and restart.`);
    return exitFn(1);
  }
}

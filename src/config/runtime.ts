import type { LettaBotConfig } from './types.js';
import { configSourceLabel, loadConfigStrict } from './io.js';

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
    const source = configSourceLabel();
    log.error(`Failed to load ${source}:`, err);
    log.error(`Fix the errors above in ${source} and restart.`);
    return exitFn(1);
  }
}

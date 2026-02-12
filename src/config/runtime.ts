import type { LettaBotConfig } from './types.js';
import { loadConfigStrict, resolveConfigPath } from './io.js';

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
    console.error(`[Config] Failed to load ${configPath}:`, err);
    console.error(`[Config] Fix the errors above in ${configPath} and restart.`);
    return exitFn(1);
  }
}

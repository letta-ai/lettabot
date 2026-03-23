import { isDockerServerMode, type ServerMode } from './types.js';

export type ResolvedMemfsSource = 'config' | 'env' | 'default-docker' | 'unset';

export interface ResolveSessionMemfsInput {
  configuredMemfs?: boolean;
  envMemfs?: string;
  serverMode?: ServerMode;
}

export interface ResolveSessionMemfsResult {
  value: boolean | undefined;
  source: ResolvedMemfsSource;
}

function parseBooleanEnv(value?: string): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

/**
 * Resolve the memfs value forwarded to SDK session options.
 *
 * Precedence:
 * 1) Per-agent config (`features.memfs`)
 * 2) `LETTABOT_MEMFS` env var (`true`/`false`)
 * 3) Default `false` in docker/self-hosted mode (safety)
 * 4) `undefined` in API mode (leave agent memfs unchanged)
 */
export function resolveSessionMemfs(input: ResolveSessionMemfsInput): ResolveSessionMemfsResult {
  // Runtime config parsing can surface non-boolean values (e.g. YAML `memfs:` -> null).
  // Only treat explicit booleans as configured; everything else falls through.
  if (typeof input.configuredMemfs === 'boolean') {
    return { value: input.configuredMemfs, source: 'config' };
  }

  const envMemfs = parseBooleanEnv(input.envMemfs);
  if (envMemfs !== undefined) {
    return { value: envMemfs, source: 'env' };
  }

  if (isDockerServerMode(input.serverMode)) {
    return { value: false, source: 'default-docker' };
  }

  return { value: undefined, source: 'unset' };
}

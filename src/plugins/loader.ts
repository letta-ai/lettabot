/**
 * Plugin Loader
 *
 * Discovers and loads channel adapter plugins from plugin directories.
 * Plugins are loaded dynamically at runtime using import().
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type {
  PluginManifest,
  PluginModule,
  ChannelPluginFactory,
  UIPluginFactory,
  ChannelPluginModule,
  UIPluginModule,
  DiscoveredPlugin,
  LoadedPlugin,
  LoadedChannelPlugin,
  LoadedUIPlugin,
  PluginLoaderConfig,
  PluginLoadResult,
  ResolvedPluginConfig,
  PluginConfigSchema,
  UIPluginContext,
  PluginType,
} from './types.js';

// Default plugin directories
const HOME = process.env.HOME || process.env.USERPROFILE || '';
// Use dist/plugins for compiled code, fallback to plugins/ for dev mode (tsx/vitest)
export const PROJECT_PLUGINS_DIR = existsSync(resolve(process.cwd(), 'dist/plugins'))
  ? resolve(process.cwd(), 'dist/plugins')
  : resolve(process.cwd(), 'plugins');
export const USER_PLUGINS_DIR = join(HOME, '.lettabot', 'plugins');

/**
 * Discover all plugins in a directory
 */
export function discoverPluginsInDir(dir: string): DiscoveredPlugin[] {
  const plugins: DiscoveredPlugin[] = [];

  if (!existsSync(dir)) {
    return plugins;
  }

  try {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;

      const pluginDir = join(dir, entry.name);
      const manifestPath = join(pluginDir, 'plugin.json');

      if (!existsSync(manifestPath)) {
        continue;
      }

      try {
        const manifestContent = readFileSync(manifestPath, 'utf-8');
        const manifest = JSON.parse(manifestContent) as PluginManifest;

        // Validate required fields
        if (!manifest.name || !manifest.id || !manifest.version || !manifest.main) {
          console.warn(`[Plugins] Invalid manifest in ${entry.name}: missing required fields`);
          continue;
        }

        const declaredEntryPath = join(pluginDir, manifest.main);
        const entryPathCandidates: string[] = [declaredEntryPath];

        // Extension flexibility: allow both .ts and .js entry points.
        // - Dev mode (tsx): manifest says .ts, use .ts directly
        // - Dev mode (tsx): manifest says .js but only .ts exists, use .ts
        // - Prod mode (node): manifest says .ts but only .js exists (compiled), use .js
        // - Prod mode (node): manifest says .js, use .js directly
        if (!existsSync(declaredEntryPath)) {
          if (declaredEntryPath.endsWith('.js')) {
            entryPathCandidates.push(declaredEntryPath.slice(0, -3) + '.ts');
            entryPathCandidates.push(declaredEntryPath.slice(0, -3) + '.mts');
          } else if (declaredEntryPath.endsWith('.mjs')) {
            entryPathCandidates.push(declaredEntryPath.slice(0, -4) + '.ts');
            entryPathCandidates.push(declaredEntryPath.slice(0, -4) + '.mts');
          } else if (declaredEntryPath.endsWith('.ts')) {
            // Production: manifest says .ts but compiled .js exists
            entryPathCandidates.push(declaredEntryPath.slice(0, -3) + '.js');
          } else if (declaredEntryPath.endsWith('.mts')) {
            entryPathCandidates.push(declaredEntryPath.slice(0, -4) + '.mjs');
          }
        }

        const resolvedEntryPath = entryPathCandidates.find(candidate => existsSync(candidate));
        if (!resolvedEntryPath) {
          console.warn(`[Plugins] Entry file not found: ${declaredEntryPath}`);
          continue;
        }

        plugins.push({
          manifest,
          pluginDir,
          entryPath: resolvedEntryPath,
        });
      } catch (err) {
        console.warn(`[Plugins] Failed to parse manifest in ${entry.name}:`, err);
      }
    }
  } catch (err) {
    console.error(`[Plugins] Failed to read plugin directory ${dir}:`, err);
  }

  return plugins;
}

/**
 * Discover all plugins from multiple directories
 * Later directories take priority (can override earlier plugins with same ID)
 */
export function discoverPlugins(dirs: string[] = [USER_PLUGINS_DIR, PROJECT_PLUGINS_DIR]): DiscoveredPlugin[] {
  const byId = new Map<string, DiscoveredPlugin>();

  for (const dir of dirs) {
    const plugins = discoverPluginsInDir(dir);
    for (const plugin of plugins) {
      byId.set(plugin.manifest.id, plugin);
    }
  }

  return Array.from(byId.values());
}

/**
 * Resolve plugin configuration from environment variables
 */
export function resolvePluginConfig(
  manifest: PluginManifest,
  overrides: Record<string, unknown> = {}
): ResolvedPluginConfig {
  const config: ResolvedPluginConfig = {};
  const schema = manifest.configSchema;

  if (!schema?.properties) {
    return overrides;
  }

  for (const [key, prop] of Object.entries(schema.properties)) {
    // Check override first
    if (key in overrides) {
      config[key] = overrides[key];
      continue;
    }

    // Check environment variable
    if (prop.env && process.env[prop.env] !== undefined) {
      const rawValue = process.env[prop.env];
      config[key] = coerceValue(rawValue, prop.type);
      continue;
    }

    // Use default
    if (prop.default !== undefined) {
      config[key] = prop.default;
    }
  }

  return config;
}

/**
 * Coerce string value to the expected type
 */
function coerceValue(value: string | undefined, type: string): unknown {
  if (value === undefined) return undefined;

  switch (type) {
    case 'number':
      return parseFloat(value);
    case 'boolean':
      return value.toLowerCase() === 'true' || value === '1';
    case 'array':
      return value.split(',').filter(Boolean);
    default:
      return value;
  }
}

/**
 * Check if a plugin's requirements are met
 */
export function checkPluginRequirements(manifest: PluginManifest): { met: boolean; missing: string[] } {
  const missing: string[] = [];

  if (!manifest.requires) {
    return { met: true, missing };
  }

  // Check required environment variables
  if (manifest.requires.env) {
    for (const envVar of manifest.requires.env) {
      if (!process.env[envVar]) {
        missing.push(`env:${envVar}`);
      }
    }
  }

  // Check Node.js version
  if (manifest.requires.node) {
    const required = manifest.requires.node.replace(/[^\d.]/g, '');
    const current = process.version.replace(/[^\d.]/g, '');
    if (compareVersions(current, required) < 0) {
      missing.push(`node:${manifest.requires.node}`);
    }
  }

  return { met: missing.length === 0, missing };
}

/**
 * Simple version comparison (a < b returns -1, a = b returns 0, a > b returns 1)
 */
function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  const len = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < len; i++) {
    const numA = partsA[i] ?? 0;
    const numB = partsB[i] ?? 0;
    if (numA < numB) return -1;
    if (numA > numB) return 1;
  }
  return 0;
}

/**
 * Check if a plugin should be auto-enabled based on its config
 */
export function shouldAutoEnable(manifest: PluginManifest): boolean {
  // Check for explicit enabled flag
  if (manifest.enabled === true) {
    return true;
  }

  const schema = manifest.configSchema;
  const required = schema?.required || [];

  if (required.length === 0) {
    return false; // No required config = don't auto-enable
  }

  // Check if at least one required config has its env var set
  for (const key of required) {
    const prop = schema?.properties[key];
    if (prop?.env && process.env[prop.env]) {
      return true;
    }
  }

  return false;
}

/**
 * Load a single plugin module
 */
async function loadPluginModule(plugin: DiscoveredPlugin): Promise<PluginModule> {
  // Convert file path to URL for dynamic import
  const moduleUrl = pathToFileURL(plugin.entryPath).href;

  try {
    const module = await import(moduleUrl);
    return module as PluginModule;
  } catch (err) {
    throw new Error(`Failed to import plugin module: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Get the factory function from a channel plugin module
 */
function getChannelPluginFactory(module: PluginModule): ChannelPluginFactory | null {
  const channelModule = module as ChannelPluginModule;

  // Check for createAdapter export
  if (typeof channelModule.createAdapter === 'function') {
    return channelModule.createAdapter;
  }

  // Check for default export
  if (typeof channelModule.default === 'function') {
    return channelModule.default;
  }

  return null;
}

/**
 * Get the factory function from a UI plugin module
 */
function getUIPluginFactory(module: PluginModule): UIPluginFactory | null {
  const uiModule = module as UIPluginModule;

  // Check for createServer export
  if (typeof uiModule.createServer === 'function') {
    return uiModule.createServer;
  }

  // Check for default export
  if (typeof uiModule.default === 'function') {
    return uiModule.default;
  }

  return null;
}

/**
 * Load all plugins and create their adapters/servers
 */
export async function loadPlugins(loaderConfig: PluginLoaderConfig = {}): Promise<PluginLoadResult> {
  const result: PluginLoadResult = {
    loaded: [],
    channels: [],
    ui: [],
    failed: [],
    skipped: [],
  };

  // Get plugin directories
  const pluginDirs = loaderConfig.pluginDirs || [USER_PLUGINS_DIR, PROJECT_PLUGINS_DIR];

  // Discover plugins
  const discovered = discoverPlugins(pluginDirs);

  if (discovered.length === 0) {
    return result;
  }

  console.log(`[Plugins] Discovered ${discovered.length} plugin(s)`);

  for (const plugin of discovered) {
    const pluginId = plugin.manifest.id;
    const pluginType: PluginType = plugin.manifest.type || 'channel';

    // Check if explicitly disabled
    if (loaderConfig.disabledPlugins?.includes(pluginId)) {
      result.skipped.push({
        pluginId,
        reason: 'Explicitly disabled',
      });
      continue;
    }

    // Check requirements
    const { met, missing } = checkPluginRequirements(plugin.manifest);
    if (!met) {
      result.skipped.push({
        pluginId,
        reason: `Missing requirements: ${missing.join(', ')}`,
      });
      continue;
    }

    // Check if should be enabled
    const explicitlyEnabled = loaderConfig.enabledPlugins?.includes(pluginId);
    const autoEnabled = loaderConfig.autoEnable !== false && shouldAutoEnable(plugin.manifest);

    if (!explicitlyEnabled && !autoEnabled) {
      result.skipped.push({
        pluginId,
        reason: 'Not enabled (set required env vars or add to enabledPlugins)',
      });
      continue;
    }

    // UI plugins require context
    if (pluginType === 'ui' && !loaderConfig.uiContext) {
      result.skipped.push({
        pluginId,
        reason: 'UI plugin requires uiContext in loader config',
      });
      continue;
    }

    // Load the plugin
    try {
      const module = await loadPluginModule(plugin);
      const config = resolvePluginConfig(plugin.manifest);

      if (pluginType === 'channel') {
        const factory = getChannelPluginFactory(module);
        if (!factory) {
          result.failed.push({
            pluginId,
            error: 'Channel plugin does not export createAdapter or default function',
            pluginDir: plugin.pluginDir,
          });
          continue;
        }

        const adapter = await Promise.resolve(factory(config));
        const loadedPlugin: LoadedChannelPlugin = {
          ...plugin,
          type: 'channel',
          adapter,
          enabled: true,
        };
        result.loaded.push(loadedPlugin);
        result.channels.push(loadedPlugin);
      } else if (pluginType === 'ui') {
        const factory = getUIPluginFactory(module);
        if (!factory) {
          result.failed.push({
            pluginId,
            error: 'UI plugin does not export createServer or default function',
            pluginDir: plugin.pluginDir,
          });
          continue;
        }

        const server = await Promise.resolve(factory(config, loaderConfig.uiContext!));
        const loadedPlugin: LoadedUIPlugin = {
          ...plugin,
          type: 'ui',
          server,
          enabled: true,
        };
        result.loaded.push(loadedPlugin);
        result.ui.push(loadedPlugin);
      } else {
        result.skipped.push({
          pluginId,
          reason: `Unknown plugin type: ${pluginType}`,
        });
        continue;
      }

      console.log(`[Plugins] Loaded: ${plugin.manifest.name} v${plugin.manifest.version} (${pluginType})`);
    } catch (err) {
      result.failed.push({
        pluginId,
        error: err instanceof Error ? err.message : String(err),
        pluginDir: plugin.pluginDir,
      });
    }
  }

  return result;
}

/**
 * Get plugin info for display/debugging
 */
export function getPluginInfo(plugin: DiscoveredPlugin): string {
  const { manifest } = plugin;
  const features = manifest.features || {};
  const featureList = Object.entries(features)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(', ');

  return [
    `${manifest.name} v${manifest.version}`,
    manifest.description ? `  ${manifest.description}` : null,
    featureList ? `  Features: ${featureList}` : null,
    `  Path: ${plugin.pluginDir}`,
  ]
    .filter(Boolean)
    .join('\n');
}

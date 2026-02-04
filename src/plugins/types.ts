/**
 * Plugin System Types
 *
 * Plugins are dynamically loaded extensions that add capabilities to Lettabot:
 * - channel: Messaging adapters (Telegram, Discord, etc.)
 * - ui: Web interfaces for management
 * - service: Background services (future)
 */

import type { ChannelAdapter } from '../channels/types.js';
import type { ChannelId } from '../core/types.js';
import type { Server } from 'node:http';

/** Plugin types */
export type PluginType = 'channel' | 'ui' | 'service';

/**
 * Plugin manifest schema (plugin.json)
 */
export interface PluginManifest {
  // Required fields
  name: string;                     // Plugin display name (e.g., "Telegram MTProto")
  id: string;                       // Unique plugin ID (e.g., "telegram-mtproto")
  version: string;                  // SemVer version (e.g., "1.0.0")
  main: string;                     // Entry point (e.g., "index.js")
  type?: PluginType;                // Plugin type (default: 'channel')

  // Plugin metadata
  description?: string;
  author?: string;
  homepage?: string;
  enabled?: boolean;                // Explicitly enable plugin (bypasses auto-enable logic)

  // Configuration schema
  configSchema?: PluginConfigSchema;

  // Requirements
  requires?: {
    lettabot?: string;              // Minimum lettabot version
    node?: string;                  // Minimum Node.js version
    env?: string[];                 // Required environment variables
    optionalEnv?: string[];         // Optional environment variables
  };

  // Feature flags (for channel plugins)
  features?: {
    pairing?: boolean;              // Supports DM policy/pairing
    groups?: boolean;               // Supports group chats
    editing?: boolean;              // Supports message editing
    typing?: boolean;               // Supports typing indicators
    media?: boolean;                // Supports media messages
  };
}

/**
 * Configuration schema for plugin config
 */
export interface PluginConfigSchema {
  type: 'object';
  properties: Record<string, PluginConfigProperty>;
  required?: string[];
}

/**
 * Individual config property schema
 */
export interface PluginConfigProperty {
  type: 'string' | 'number' | 'boolean' | 'array';
  description?: string;
  default?: unknown;
  env?: string;                     // Environment variable to read from
  items?: { type: string };         // For array types
  enum?: (string | number)[];       // Allowed values
}

/**
 * Plugin factory function type for channel plugins
 */
export type ChannelPluginFactory = (config: Record<string, unknown>) => ChannelAdapter | Promise<ChannelAdapter>;

/**
 * UI plugin context - passed to UI plugins for integration
 */
export interface UIPluginContext {
  getStatus: () => {
    agentId: string | null;
    agentName: string;
    channels: string[];
    uptime: number;
    startedAt: string;
  };
  activeChannels: string[];
}

/**
 * Plugin factory function type for UI plugins
 */
export type UIPluginFactory = (config: Record<string, unknown>, context: UIPluginContext) => Server | Promise<Server>;

/**
 * Legacy type alias for backwards compatibility
 */
export type PluginFactory = ChannelPluginFactory;

/**
 * Loaded plugin module for channel plugins
 */
export interface ChannelPluginModule {
  default?: ChannelPluginFactory;
  createAdapter?: ChannelPluginFactory;
}

/**
 * Loaded plugin module for UI plugins
 */
export interface UIPluginModule {
  default?: UIPluginFactory;
  createServer?: UIPluginFactory;
}

/**
 * Union of all plugin module types
 */
export type PluginModule = ChannelPluginModule | UIPluginModule;

/**
 * Discovered plugin (manifest + path info)
 */
export interface DiscoveredPlugin {
  manifest: PluginManifest;
  pluginDir: string;                // Directory containing the plugin
  entryPath: string;                // Full path to entry file
}

/**
 * Loaded channel plugin
 */
export interface LoadedChannelPlugin extends DiscoveredPlugin {
  type: 'channel';
  adapter: ChannelAdapter;
  enabled: boolean;
}

/**
 * Loaded UI plugin
 */
export interface LoadedUIPlugin extends DiscoveredPlugin {
  type: 'ui';
  server: Server;
  enabled: boolean;
}

/**
 * Loaded and ready plugin (union type)
 */
export type LoadedPlugin = LoadedChannelPlugin | LoadedUIPlugin;

/**
 * Legacy type alias - channel plugin specifically
 * @deprecated Use LoadedChannelPlugin instead
 */
export type LoadedPluginLegacy = LoadedChannelPlugin;

/**
 * Plugin loader configuration
 */
export interface PluginLoaderConfig {
  // Plugin directories to search (in priority order)
  pluginDirs?: string[];

  // Plugins to explicitly enable (by ID)
  enabledPlugins?: string[];

  // Plugins to explicitly disable (by ID)
  disabledPlugins?: string[];

  // Auto-enable plugins based on env vars being set
  autoEnable?: boolean;

  // Context for UI plugins (required to load UI plugins)
  uiContext?: UIPluginContext;
}

/**
 * Result of loading plugins
 */
export interface PluginLoadResult {
  loaded: LoadedPlugin[];
  channels: LoadedChannelPlugin[];   // Convenience accessor for channel plugins
  ui: LoadedUIPlugin[];              // Convenience accessor for UI plugins
  failed: Array<{
    pluginId: string;
    error: string;
    pluginDir?: string;
  }>;
  skipped: Array<{
    pluginId: string;
    reason: string;
  }>;
}

/**
 * Plugin configuration resolved from env vars
 */
export type ResolvedPluginConfig = Record<string, unknown>;

/**
 * Check if a ChannelId is a plugin-provided channel
 */
export function isPluginChannelId(id: string): boolean {
  // Built-in channels
  const builtIn = ['telegram', 'slack', 'whatsapp', 'signal', 'discord'];
  return !builtIn.includes(id);
}

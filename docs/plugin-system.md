# Lettabot Plugin System

The plugin system allows you to add channel adapters without modifying Lettabot's core code.

## Plugin Directories

Plugins are discovered from:
1. `~/.lettabot/plugins/` - User plugins (higher priority)
2. `./plugins/` - Project plugins (highest priority)

## Creating a Plugin

### Directory Structure

```
plugins/
  my-channel/
    plugin.json     # Plugin manifest
    index.ts        # Entry point
    adapter.ts      # Adapter implementation
```

### Plugin Manifest (plugin.json)

```json
{
  "name": "My Channel",
  "id": "my-channel",
  "version": "1.0.0",
  "description": "Description of the channel adapter",
  "main": "index.js",

  "requires": {
    "node": ">=18.0.0",
    "env": ["MY_CHANNEL_TOKEN"]
  },

  "configSchema": {
    "type": "object",
    "properties": {
      "token": {
        "type": "string",
        "description": "API token",
        "env": "MY_CHANNEL_TOKEN"
      },
      "debug": {
        "type": "boolean",
        "default": false,
        "env": "MY_CHANNEL_DEBUG"
      }
    },
    "required": ["token"]
  },

  "features": {
    "pairing": true,
    "groups": false,
    "editing": true,
    "typing": true
  }
}
```

### Entry Point (index.ts)

```typescript
import { MyChannelAdapter } from './adapter.js';
import type { ChannelAdapter } from '../../src/channels/types.js';

export function createAdapter(config: Record<string, unknown>): ChannelAdapter {
  return new MyChannelAdapter({
    token: config.token as string,
    debug: config.debug as boolean || false,
  });
}

export default createAdapter;
```

### Adapter Implementation

Your adapter must implement the `ChannelAdapter` interface:

```typescript
interface ChannelAdapter {
  readonly id: string;      // Unique channel ID
  readonly name: string;    // Display name

  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;

  sendMessage(msg: OutboundMessage): Promise<{ messageId: string }>;
  editMessage(chatId: string, messageId: string, text: string): Promise<void>;
  sendTypingIndicator(chatId: string): Promise<void>;

  supportsEditing?(): boolean;

  onMessage?: (msg: InboundMessage) => Promise<void>;
  onCommand?: (command: string) => Promise<string | null>;
}
```

## Configuration

Plugins are auto-enabled when their required environment variables are set. You can also explicitly control which plugins are loaded via the loader config.

### Auto-Enable (Default)

If your plugin requires `MY_CHANNEL_TOKEN` and it's set, the plugin will automatically load.

### Required Environment Variables

Define required env vars in `requires.env`:
```json
{
  "requires": {
    "env": ["MY_CHANNEL_TOKEN", "MY_CHANNEL_SECRET"]
  }
}
```

### Config Schema

Define how config is resolved from environment:
```json
{
  "configSchema": {
    "properties": {
      "token": {
        "type": "string",
        "env": "MY_CHANNEL_TOKEN"
      }
    }
  }
}
```

## Example: Telegram MTProto Plugin

The MTProto adapter is bundled as a plugin in `plugins/telegram-mtproto/`.

Enable it by setting:
```bash
TELEGRAM_PHONE_NUMBER=+1234567890
TELEGRAM_API_ID=12345678
TELEGRAM_API_HASH=abcdef...
```

## Plugin Priority

When multiple plugins have the same ID:
1. `./plugins/` overrides `~/.lettabot/plugins/`

This allows project-specific overrides of global plugins.

## Mutual Exclusion

Some channels are mutually exclusive (e.g., Telegram Bot and Telegram MTProto). The loader validates this after loading plugins.

## Debugging

Set `DEBUG=true` to see which plugins are skipped and why:
```bash
DEBUG=true lettabot
```

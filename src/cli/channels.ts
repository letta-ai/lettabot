#!/usr/bin/env node
/**
 * lettabot-channels - Discover channels across platforms
 *
 * Usage:
 *   lettabot-channels list [--channel discord|slack] [--agent name]
 *
 * The agent can use this CLI via Bash to discover channel IDs
 * for sending messages with lettabot-message.
 */

// Config loaded from lettabot.yaml (sets env vars for token fallback)
import { loadAppConfigOrExit, applyConfigToEnv } from '../config/index.js';
const config = loadAppConfigOrExit();
applyConfigToEnv(config);

import { listGroupsFromArgs } from './group-listing.js';

function showHelp(): void {
  console.log(`
lettabot-channels - Discover channels across platforms

Commands:
  list [options]          List channels with their IDs

List options:
  --channel, -c <name>    Platform to list: discord, slack (default: all configured)
  --agent <name>          Agent name from lettabot.yaml (reads tokens from that agent's config)

Examples:
  # List channels for all configured platforms
  lettabot-channels list

  # List Discord channels only
  lettabot-channels list --channel discord

  # List Slack channels only
  lettabot-channels list --channel slack

  # List channels for a specific agent (multi-agent setup)
  lettabot-channels list --agent MyAgent

Environment variables (used as fallback when --agent is not specified):
  DISCORD_BOT_TOKEN       Required for Discord channel listing
  SLACK_BOT_TOKEN         Required for Slack channel listing

Note: Telegram, WhatsApp, and Signal do not support channel listing.
`);
}

// Main
const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'list':
    listGroupsFromArgs(args.slice(1));
    break;

  case 'help':
  case '--help':
  case '-h':
    showHelp();
    break;

  default:
    if (command) {
      // Allow `lettabot-channels --channel discord` without 'list'
      if (command.startsWith('-')) {
        listGroupsFromArgs(args);
        break;
      }
      console.error(`Unknown command: ${command}`);
    }
    showHelp();
    break;
}

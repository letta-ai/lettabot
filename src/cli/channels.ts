#!/usr/bin/env node
/**
 * lettabot-channels - Discover channels across platforms
 *
 * Usage:
 *   lettabot-channels list [--channel discord|slack]
 *
 * The agent can use this CLI via Bash to discover channel IDs
 * for sending messages with lettabot-message.
 */

// Config loaded from lettabot.yaml
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

Examples:
  # List channels for all configured platforms
  lettabot-channels list

  # List Discord channels only
  lettabot-channels list --channel discord

  # List Slack channels only
  lettabot-channels list --channel slack

Environment variables:
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

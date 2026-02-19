/**
 * Channel Setup Prompts
 * 
 * Shared setup functions used by both onboard.ts and channel-management.ts.
 * Each function takes existing config and returns the new config to save.
 */

import { spawnSync } from 'node:child_process';
import * as p from '@clack/prompts';

// ============================================================================
// Channel Metadata
// ============================================================================

export const CHANNELS = [
  { id: 'telegram', displayName: 'Telegram', hint: 'Easiest to set up' },
  { id: 'slack', displayName: 'Slack', hint: 'Socket Mode app' },
  { id: 'discord', displayName: 'Discord', hint: 'Bot token + Message Content intent' },
  { id: 'whatsapp', displayName: 'WhatsApp', hint: 'QR code pairing' },
  { id: 'signal', displayName: 'Signal', hint: 'signal-cli daemon' },
] as const;

export type ChannelId = typeof CHANNELS[number]['id'];

export function getChannelMeta(id: ChannelId) {
  return CHANNELS.find(c => c.id === id)!;
}

export function isSignalCliInstalled(): boolean {
  return spawnSync('which', ['signal-cli'], { stdio: 'pipe' }).status === 0;
}

export function getChannelHint(id: ChannelId): string {
  if (id === 'signal' && !isSignalCliInstalled()) {
    return '⚠️ signal-cli not installed';
  }
  return getChannelMeta(id).hint;
}

// ============================================================================
// Group ID hints per channel
// ============================================================================

const GROUP_ID_HINTS: Record<ChannelId, string> = {
  telegram:
    'Group IDs are negative numbers (e.g., -1001234567890).\n' +
    'Forward a group message to @userinfobot, or check bot logs.',
  discord:
    'Enable Developer Mode in Settings > Advanced,\n' +
    'then right-click a channel/server > Copy ID.',
  slack:
    'Right-click channel > Copy link > extract ID,\n' +
    'or Channel Details > Copy Channel ID (e.g., C0123456789).',
  whatsapp:
    'Group JIDs appear in bot logs on first message\n' +
    '(e.g., 120363123456@g.us).',
  signal:
    'Group IDs appear in bot logs on first group message.',
};

// ============================================================================
// Setup Functions
// ============================================================================

type GroupMode = 'open' | 'listen' | 'mention-only' | 'disabled';

/**
 * Derive the initial group mode from existing config.
 * Reads modern groups config first, falls back to deprecated fields.
 */
function deriveExistingMode(existing?: any): GroupMode | undefined {
  // Modern: groups.*.mode
  const wildcardMode = existing?.groups?.['*']?.mode;
  if (wildcardMode) return wildcardMode as GroupMode;

  // Deprecated: listeningGroups implies "listen" was the intent
  if (existing?.listeningGroups?.length > 0) return 'listen';

  return undefined;
}

async function promptGroupSettings(
  channelId: ChannelId,
  existing?: any,
): Promise<{
  groups?: Record<string, { mode: GroupMode }>;
  groupDebounceSec?: number;
}> {
  const existingMode = deriveExistingMode(existing);
  const hasExisting = existingMode !== undefined
    || existing?.groupDebounceSec !== undefined
    || (existing?.groups && Object.keys(existing.groups).length > 0);

  const configure = await p.confirm({
    message: 'Configure group chat settings?',
    initialValue: hasExisting,
  });
  if (p.isCancel(configure)) {
    p.cancel('Cancelled');
    process.exit(0);
  }

  if (!configure) {
    // Preserve existing config as-is
    return {
      groups: existing?.groups,
      groupDebounceSec: existing?.groupDebounceSec,
    };
  }

  // Step 1: Default group mode
  const mode = await p.select({
    message: 'Default group behavior',
    options: [
      { value: 'mention-only', label: 'Mention-only (recommended)', hint: 'Only respond when @mentioned' },
      { value: 'listen', label: 'Listen', hint: 'Read all messages, only respond when mentioned' },
      { value: 'open', label: 'Open', hint: 'Respond to all group messages' },
      { value: 'disabled', label: 'Disabled', hint: 'Ignore all group messages' },
    ],
    initialValue: existingMode || 'mention-only',
  });
  if (p.isCancel(mode)) {
    p.cancel('Cancelled');
    process.exit(0);
  }

  // Step 2: Debounce (skip for disabled)
  let groupDebounceSec: number | undefined = existing?.groupDebounceSec;
  if (mode !== 'disabled') {
    const debounceRaw = await p.text({
      message: 'Group debounce seconds (blank = 5s default)',
      placeholder: '5',
      initialValue: existing?.groupDebounceSec !== undefined ? String(existing.groupDebounceSec) : '',
      validate: (value) => {
        const trimmed = value.trim();
        if (!trimmed) return undefined;
        const num = Number(trimmed);
        if (!Number.isFinite(num) || num < 0) return 'Enter a non-negative number or leave blank';
        return undefined;
      },
    });
    if (p.isCancel(debounceRaw)) {
      p.cancel('Cancelled');
      process.exit(0);
    }
    const debounceValue = typeof debounceRaw === 'string' ? debounceRaw.trim() : '';
    groupDebounceSec = debounceValue ? Number(debounceValue) : undefined;
  }

  // Step 3: Channel-specific hint for finding group IDs
  const hint = GROUP_ID_HINTS[channelId];
  if (hint && mode !== 'disabled') {
    p.note(
      hint + '\n\n' +
      'Tip: Start with this default and check logs for IDs.\n' +
      'Add per-group overrides in lettabot.yaml later.',
      'Finding Group IDs'
    );
  }

  // Build groups config: set wildcard default, preserve any existing per-group overrides
  const groups: Record<string, any> = {};

  // Carry over existing per-group entries (non-wildcard)
  if (existing?.groups) {
    for (const [key, value] of Object.entries(existing.groups)) {
      if (key !== '*') {
        groups[key] = value;
      }
    }
  }

  // Set the wildcard default
  groups['*'] = { mode: mode as GroupMode };

  return {
    groups,
    groupDebounceSec,
  };
}

export async function setupTelegram(existing?: any): Promise<any> {
  p.note(
    '1. Message @BotFather on Telegram\n' +
    '2. Send /newbot and follow prompts\n' +
    '3. Copy the bot token',
    'Telegram Setup'
  );
  
  const token = await p.text({
    message: 'Telegram Bot Token',
    placeholder: '123456:ABC-DEF...',
    initialValue: existing?.token || '',
  });
  
  if (p.isCancel(token)) {
    p.cancel('Cancelled');
    process.exit(0);
  }
  
  const dmPolicy = await p.select({
    message: 'Who can message the bot?',
    options: [
      { value: 'pairing', label: 'Pairing (recommended)', hint: 'Requires CLI approval' },
      { value: 'allowlist', label: 'Allowlist only', hint: 'Specific user IDs' },
      { value: 'open', label: 'Open', hint: 'Anyone (not recommended)' },
    ],
    initialValue: existing?.dmPolicy || 'pairing',
  });
  
  if (p.isCancel(dmPolicy)) {
    p.cancel('Cancelled');
    process.exit(0);
  }
  
  let allowedUsers: string[] | undefined;
  
  if (dmPolicy === 'pairing') {
    p.log.info('Users will get a code. Approve with: lettabot pairing approve telegram CODE');
  } else if (dmPolicy === 'allowlist') {
    const users = await p.text({
      message: 'Allowed Telegram user IDs (comma-separated)',
      placeholder: '123456789,987654321',
      initialValue: existing?.allowedUsers?.join(',') || '',
    });
    if (!p.isCancel(users) && users) {
      allowedUsers = users.split(',').map(s => s.trim()).filter(Boolean);
    }
  }
  
  const groupSettings = await promptGroupSettings('telegram', existing);

  return {
    enabled: true,
    token: token || undefined,
    dmPolicy: dmPolicy as 'pairing' | 'allowlist' | 'open',
    allowedUsers,
    ...groupSettings,
  };
}

export async function setupSlack(existing?: any): Promise<any> {
  const hasExistingTokens = existing?.appToken || existing?.botToken;
  
  p.note(
    'Requires two tokens from api.slack.com/apps:\n' +
    '  • App Token (xapp-...) - Socket Mode\n' +
    '  • Bot Token (xoxb-...) - Bot permissions',
    'Slack Requirements'
  );
  
  const wizardChoice = await p.select({
    message: 'Slack setup',
    options: [
      { value: 'wizard', label: 'Guided setup', hint: 'Step-by-step instructions with validation' },
      { value: 'manual', label: 'Manual entry', hint: 'I already have tokens' },
    ],
    initialValue: hasExistingTokens ? 'manual' : 'wizard',
  });
  
  if (p.isCancel(wizardChoice)) {
    p.cancel('Cancelled');
    process.exit(0);
  }
  
  if (wizardChoice === 'wizard') {
    const { runSlackWizard } = await import('../setup/slack-wizard.js');
    const result = await runSlackWizard({
      appToken: existing?.appToken,
      botToken: existing?.botToken,
      allowedUsers: existing?.allowedUsers,
    });
    
    if (result) {
      const groupSettings = await promptGroupSettings('slack', existing);
      return {
        enabled: true,
        appToken: result.appToken,
        botToken: result.botToken,
        allowedUsers: result.allowedUsers,
        ...groupSettings,
      };
    }
    return { enabled: false }; // Wizard cancelled
  }
  
  // Manual entry
  const { validateSlackTokens, stepAccessControl, validateAppToken, validateBotToken } = await import('../setup/slack-wizard.js');
  
  p.note(
    'Get tokens from api.slack.com/apps:\n' +
    '• Enable Socket Mode → App-Level Token (xapp-...)\n' +
    '• Install App → Bot User OAuth Token (xoxb-...)\n\n' +
    'See docs/slack-setup.md for detailed instructions',
    'Slack Setup'
  );
  
  const appToken = await p.text({
    message: 'Slack App Token (xapp-...)',
    initialValue: existing?.appToken || '',
    validate: validateAppToken,
  });
  
  if (p.isCancel(appToken)) {
    p.cancel('Cancelled');
    process.exit(0);
  }
  
  const botToken = await p.text({
    message: 'Slack Bot Token (xoxb-...)',
    initialValue: existing?.botToken || '',
    validate: validateBotToken,
  });
  
  if (p.isCancel(botToken)) {
    p.cancel('Cancelled');
    process.exit(0);
  }
  
  if (appToken && botToken) {
    await validateSlackTokens(appToken, botToken);
  }
  
  const allowedUsers = await stepAccessControl(existing?.allowedUsers);
  const groupSettings = await promptGroupSettings('slack', existing);
  
  return {
    enabled: true,
    appToken: appToken || undefined,
    botToken: botToken || undefined,
    allowedUsers,
    ...groupSettings,
  };
}

export async function setupDiscord(existing?: any): Promise<any> {
  p.note(
    '1. Go to discord.com/developers/applications\n' +
    '2. Click "New Application" (or select existing)\n' +
    '3. Go to "Bot" → Copy the Bot Token\n' +
    '4. Enable "Message Content Intent" (under Privileged Gateway Intents)\n' +
    '5. Go to "OAuth2" → "URL Generator"\n' +
    '   • Scopes: bot\n' +
    '   • Permissions: Send Messages, Read Message History, View Channels\n' +
    '6. Copy the generated URL and open it to invite the bot to your server',
    'Discord Setup'
  );
  
  const token = await p.text({
    message: 'Discord Bot Token',
    placeholder: 'Bot → Reset Token → Copy',
    initialValue: existing?.token || '',
  });
  
  if (p.isCancel(token)) {
    p.cancel('Cancelled');
    process.exit(0);
  }
  
  // Try to show invite URL
  if (token) {
    try {
      const appId = Buffer.from(token.split('.')[0], 'base64').toString();
      if (/^\d+$/.test(appId)) {
        const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${appId}&permissions=68608&scope=bot`;
        p.log.info(`Invite URL: ${inviteUrl}`);
        p.log.message('Open this URL in your browser to add the bot to your server.');
      }
    } catch {
      // Token parsing failed
    }
  }
  
  const dmPolicy = await p.select({
    message: 'Who can message the bot?',
    options: [
      { value: 'pairing', label: 'Pairing (recommended)', hint: 'Requires CLI approval' },
      { value: 'allowlist', label: 'Allowlist only', hint: 'Specific user IDs' },
      { value: 'open', label: 'Open', hint: 'Anyone (not recommended)' },
    ],
    initialValue: existing?.dmPolicy || 'pairing',
  });
  
  if (p.isCancel(dmPolicy)) {
    p.cancel('Cancelled');
    process.exit(0);
  }
  
  let allowedUsers: string[] | undefined;
  
  if (dmPolicy === 'pairing') {
    p.log.info('Users will get a code. Approve with: lettabot pairing approve discord CODE');
  } else if (dmPolicy === 'allowlist') {
    const users = await p.text({
      message: 'Allowed Discord user IDs (comma-separated)',
      placeholder: '123456789012345678,987654321098765432',
      initialValue: existing?.allowedUsers?.join(',') || '',
    });
    if (!p.isCancel(users) && users) {
      allowedUsers = users.split(',').map(s => s.trim()).filter(Boolean);
    }
  }
  
  const groupSettings = await promptGroupSettings('discord', existing);

  return {
    enabled: true,
    token: token || undefined,
    dmPolicy: dmPolicy as 'pairing' | 'allowlist' | 'open',
    allowedUsers,
    ...groupSettings,
  };
}

export async function setupWhatsApp(existing?: any): Promise<any> {
  p.note(
    'QR code will appear on first run - scan with your phone.\n' +
    'Phone: Settings → Linked Devices → Link a Device\n\n' +
    '⚠️  Security: Links as a full device to your WhatsApp account.\n' +
    'Can see ALL messages, not just ones sent to the bot.\n' +
    'Consider using a dedicated number for better isolation.',
    'WhatsApp'
  );
  
  const selfChat = await p.select({
    message: 'Whose number is this?',
    options: [
      { value: 'personal', label: 'My personal number (recommended)', hint: 'SAFE: Only "Message Yourself" chat' },
      { value: 'dedicated', label: 'Dedicated bot number', hint: 'Bot responds to anyone who messages' },
    ],
    initialValue: existing?.selfChat !== false ? 'personal' : 'dedicated',
  });
  
  if (p.isCancel(selfChat)) {
    p.cancel('Cancelled');
    process.exit(0);
  }
  
  const isSelfChat = selfChat === 'personal';
  
  if (!isSelfChat) {
    p.log.warn('Dedicated number mode: Bot will respond to ALL incoming messages.');
    p.log.warn('Only use this if this number is EXCLUSIVELY for the bot.');
  }
  
  let dmPolicy: 'pairing' | 'allowlist' | 'open' = 'pairing';
  let allowedUsers: string[] | undefined;
  
  if (!isSelfChat) {
    dmPolicy = 'allowlist';
    const users = await p.text({
      message: 'Allowed phone numbers (comma-separated, with +)',
      placeholder: '+15551234567,+15559876543',
      initialValue: existing?.allowedUsers?.join(',') || '',
    });
    if (!p.isCancel(users) && users) {
      allowedUsers = users.split(',').map(s => s.trim()).filter(Boolean);
    }
    if (!allowedUsers?.length) {
      p.log.warn('No allowed numbers set. Bot will reject all messages until you add numbers to lettabot.yaml');
    }
  }
  
  const groupSettings = await promptGroupSettings('whatsapp', existing);

  p.log.info('Run "lettabot server" to see the QR code and complete pairing.');
  
  return {
    enabled: true,
    selfChat: isSelfChat,
    dmPolicy,
    allowedUsers,
    ...groupSettings,
  };
}

export async function setupSignal(existing?: any): Promise<any> {
  const signalInstalled = isSignalCliInstalled();
  
  if (!signalInstalled) {
    p.log.warn('signal-cli is not installed.');
    p.log.info('Install with: brew install signal-cli');
    
    const continueAnyway = await p.confirm({
      message: 'Continue setup anyway?',
      initialValue: false,
    });
    
    if (p.isCancel(continueAnyway) || !continueAnyway) {
      p.cancel('Cancelled');
      process.exit(0);
    }
  }
  
  p.note(
    'See docs/signal-setup.md for detailed instructions.\n' +
    'Requires signal-cli registered with your phone number.\n\n' +
    '⚠️  Security: Has full access to your Signal account.\n' +
    'Can see all messages and send as you.',
    'Signal Setup'
  );
  
  const phone = await p.text({
    message: 'Signal phone number',
    placeholder: '+1XXXXXXXXXX',
    initialValue: existing?.phone || '',
  });
  
  if (p.isCancel(phone)) {
    p.cancel('Cancelled');
    process.exit(0);
  }
  
  const selfChat = await p.select({
    message: 'Whose number is this?',
    options: [
      { value: 'personal', label: 'My personal number (recommended)', hint: 'SAFE: Only "Note to Self" chat' },
      { value: 'dedicated', label: 'Dedicated bot number', hint: 'Bot responds to anyone who messages' },
    ],
    initialValue: existing?.selfChat !== false ? 'personal' : 'dedicated',
  });
  
  if (p.isCancel(selfChat)) {
    p.cancel('Cancelled');
    process.exit(0);
  }
  
  const isSelfChat = selfChat === 'personal';
  
  if (!isSelfChat) {
    p.log.warn('Dedicated number mode: Bot will respond to ALL incoming messages.');
    p.log.warn('Only use this if this number is EXCLUSIVELY for the bot.');
  }
  
  let dmPolicy: 'pairing' | 'allowlist' | 'open' = 'pairing';
  let allowedUsers: string[] | undefined;
  
  if (!isSelfChat) {
    dmPolicy = 'allowlist';
    const users = await p.text({
      message: 'Allowed phone numbers (comma-separated, with +)',
      placeholder: '+15551234567,+15559876543',
      initialValue: existing?.allowedUsers?.join(',') || '',
    });
    if (!p.isCancel(users) && users) {
      allowedUsers = users.split(',').map(s => s.trim()).filter(Boolean);
    }
    if (!allowedUsers?.length) {
      p.log.warn('No allowed numbers set. Bot will reject all messages until you add numbers to lettabot.yaml');
    }
  }
  
  const groupSettings = await promptGroupSettings('signal', existing);

  return {
    enabled: true,
    phone: phone || undefined,
    selfChat: isSelfChat,
    dmPolicy,
    allowedUsers,
    ...groupSettings,
  };
}

/** Get the setup function for a channel */
export function getSetupFunction(id: ChannelId): (existing?: any) => Promise<any> {
  const setupFunctions: Record<ChannelId, (existing?: any) => Promise<any>> = {
    telegram: setupTelegram,
    slack: setupSlack,
    discord: setupDiscord,
    whatsapp: setupWhatsApp,
    signal: setupSignal,
  };
  return setupFunctions[id];
}

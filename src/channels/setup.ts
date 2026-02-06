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
// Setup Functions
// ============================================================================

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
  
  return {
    enabled: true,
    token: token || undefined,
    dmPolicy: dmPolicy as 'pairing' | 'allowlist' | 'open',
    allowedUsers,
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
      return {
        enabled: true,
        appToken: result.appToken,
        botToken: result.botToken,
        allowedUsers: result.allowedUsers,
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
  
  return {
    enabled: true,
    appToken: appToken || undefined,
    botToken: botToken || undefined,
    allowedUsers,
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
  
  return {
    enabled: true,
    token: token || undefined,
    dmPolicy: dmPolicy as 'pairing' | 'allowlist' | 'open',
    allowedUsers,
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
  
  p.log.info('Run "lettabot server" to see the QR code and complete pairing.');
  
  return {
    enabled: true,
    selfChat: isSelfChat,
    dmPolicy,
    allowedUsers,
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
  
  return {
    enabled: true,
    phone: phone || undefined,
    selfChat: isSelfChat,
    dmPolicy,
    allowedUsers,
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

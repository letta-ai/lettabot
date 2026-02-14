/**
 * Interactive Slack Setup Wizard
 * 
 * Guides users through the full Slack app configuration process
 * with browser automation and validation at each step.
 */

import * as p from '@clack/prompts';

interface SlackWizardResult {
  appToken: string;
  botToken: string;
  allowedUsers?: string[];
}

// Shared validators (exported for use in onboard.ts manual flow)
export function validateAppToken(val: string): string | undefined {
  if (!val) return 'App Token is required';
  if (!val.startsWith('xapp-')) return 'App Token should start with "xapp-"';
  if (val.length < 20) return 'Token appears too short';
}

export function validateBotToken(val: string): string | undefined {
  if (!val) return 'Bot Token is required';
  if (!val.startsWith('xoxb-')) return 'Bot Token should start with "xoxb-"';
  if (val.length < 20) return 'Token appears too short';
}

function validateSlackUserId(val: string): string | undefined {
  if (!val) return undefined; // Optional
  const ids = val.split(',').map(s => s.trim());
  for (const id of ids) {
    if (!/^U[A-Z0-9]{8,}$/i.test(id)) {
      return `Invalid Slack user ID: ${id} (should start with U)`;
    }
  }
}

/**
 * Run the interactive Slack setup wizard
 */
export async function runSlackWizard(existingConfig?: {
  appToken?: string;
  botToken?: string;
  allowedUsers?: string[];
}): Promise<SlackWizardResult | null> {
  p.intro('🔧 Slack Setup Wizard');
  
  p.note(
    'This wizard creates a Slack app using a pre-configured manifest.\n' +
    'All permissions and settings are configured automatically!\n\n' +
    'Total time: ~2 minutes\n' +
    'Press Ctrl+C to cancel anytime',
    'Overview'
  );
  
  // Step 1: Create Slack App from Manifest (scopes, events, Socket Mode all pre-configured)
  const createdApp = await stepCreateApp();
  if (!createdApp) return null;

  // Step 2: Configure App Home (enable DM messaging)
  await stepConfigureAppHome();

  // Step 3: Install to Workspace + Get Bot Token
  const botToken = await stepInstallApp(existingConfig?.botToken);
  if (!botToken) return null;
  
  // Step 4: Enable Socket Mode + Get App Token
  const appToken = await stepEnableSocketMode(existingConfig?.appToken);
  if (!appToken) return null;
  
  // Validate tokens
  await validateSlackTokens(appToken, botToken);
  
  // Access control
  const allowedUsers = await stepAccessControl(existingConfig?.allowedUsers);
  
  p.outro('✅ Slack setup complete!');
  
  return {
    appToken,
    botToken,
    allowedUsers,
  };
}

async function stepCreateApp(): Promise<boolean> {
  p.log.step('Step 1/4: Create Slack App from Manifest');
  
  // Inline manifest for Socket Mode configuration
  const appName = process.env.SLACK_APP_NAME || process.env.LETTA_AGENT_NAME || 'LettaBot';
  const manifest = `display_information:
  name: ${appName}
  description: AI assistant with Socket Mode for real-time conversations
  background_color: "#2c2d30"
features:
  bot_user:
    display_name: ${appName}
    always_online: false
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - chat:write
      - files:read
      - im:history
      - im:read
      - im:write
settings:
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
  event_subscriptions:
    bot_events:
      - app_mention
      - message.im`;
  
  const manifestEncoded = encodeURIComponent(manifest);
  const url = `https://api.slack.com/apps?new_app=1&manifest_yaml=${manifestEncoded}`;
  
  p.note(
    'Creates app with everything pre-configured:\n' +
    '  • Socket Mode enabled\n' +
    '  • 6 bot scopes (app_mentions:read, chat:write, files:read, im:*)\n' +
    '  • 2 event subscriptions (app_mention, message.im)\n\n' +
    'Just review and click "Create"!',
    'One-Click Setup'
  );
  
  const openBrowser = await p.confirm({
    message: 'Open pre-configured app creation page?',
    initialValue: true,
  });
  
  if (p.isCancel(openBrowser)) {
    p.cancel('Setup cancelled');
    return false;
  }
  
  if (openBrowser) {
    try {
      const open = (await import('open')).default;
      await open(url, { wait: false });
      p.log.success('Browser opened');
    } catch {
      p.log.warn('Could not open browser');
      p.log.info('Copy this URL:');
      console.log(url);
    }
  } else {
    p.log.info('Copy this URL:');
    console.log(url);
  }
  
  const completed = await p.confirm({
    message: 'Clicked "Create"?',
    initialValue: true,
  });
  
  if (p.isCancel(completed) || !completed) {
    p.cancel('Slack setup skipped');
    return false;
  }
  
  return true;
}

async function stepEnableSocketMode(existingToken?: string): Promise<string | null> {
  p.log.step('Step 4/4: Get App-Level Token');
  
  p.note(
    '1. In the left sidebar, click "Socket Mode"\n' +
    '2. Click "Generate Token"\n' +
    '   • Token Name: "socket-token"\n' +
    '   • Scopes: connections:write (pre-selected)\n' +
    '3. Copy the token (xapp-...)',
    'Instructions'
  );
  
  const appToken = await p.text({
    message: 'Slack App Token (xapp-...)',
    placeholder: 'xapp-1-A0ABKA5451U-...',
    initialValue: existingToken || '',
    validate: validateAppToken,
  });
  
  if (p.isCancel(appToken)) {
    p.cancel('Setup cancelled');
    return null;
  }
  
  return appToken;
}

async function stepConfigureScopes(): Promise<boolean> {
  p.log.step('Step 3/6: Configure Bot Permissions');
  
  p.note(
    '1. In the left sidebar, go to "OAuth & Permissions"\n' +
    '2. Scroll to "Scopes" → "Bot Token Scopes"\n' +
    '3. Click "Add an OAuth Scope" for each:\n' +
    '   • app_mentions:read\n' +
    '   • chat:write\n' +
    '   • files:read\n' +
    '   • im:history\n' +
    '   • im:read\n' +
    '   • im:write',
    'Instructions'
  );
  
  const completed = await p.confirm({
    message: 'Enabled permissions?',
    initialValue: true,
  });
  
  if (p.isCancel(completed) || !completed) {
    p.cancel('Slack setup skipped');
    return false;
  }
  
  return true;
}

async function stepConfigureEvents(): Promise<boolean> {
  p.log.step('Step 4/6: Enable Event Subscriptions');
  
  p.note(
    '1. In the left sidebar, go to "Event Subscriptions"\n' +
    '2. Toggle "Enable Events" → ON\n' +
    '3. Scroll to "Subscribe to bot events"\n' +
    '4. Click "Add Bot User Event" for each:\n' +
    '   • app_mention\n' +
    '   • message.im\n' +
    '5. Click "Save Changes" at the bottom',
    'Instructions'
  );
  
  const completed = await p.confirm({
    message: 'Enabled subscriptions?',
    initialValue: true,
  });
  
  if (p.isCancel(completed) || !completed) {
    p.cancel('Slack setup skipped');
    return false;
  }
  
  return true;
}

async function stepConfigureAppHome(): Promise<boolean> {
  p.log.step('Step 2/4: Configure App Home');
  
  p.note(
    '1. Go to "App Home" in left sidebar\n' +
    '2. Under "Show Tabs", toggle "Messages Tab" → ON\n' +
    '3. Check "Allow users to send messages from the messages tab"',
    'Instructions'
  );
  
  const completed = await p.confirm({
    message: 'Enabled messaging?',
    initialValue: true,
  });
  
  if (p.isCancel(completed) || !completed) {
    p.log.warn('Skipping - DMs may not work without Messages Tab enabled');
    // Continue anyway, just warn
  }
  
  return true;
}

async function stepInstallApp(existingToken?: string): Promise<string | null> {
  p.log.step('Step 3/4: Install to Workspace');
  
  p.note(
    '1. Go to "Install App" in left sidebar\n' +
    '2. Click "Install to Workspace"\n' +
    '3. Click "Allow"\n' +
    '4. Copy "Bot User OAuth Token" (xoxb-...)',
    'Instructions'
  );
  
  const botToken = await p.text({
    message: 'Slack Bot Token (xoxb-...)',
    placeholder: 'xoxb-7365707142320-...',
    initialValue: existingToken || '',
    validate: validateBotToken,
  });
  
  if (p.isCancel(botToken)) {
    p.cancel('Setup cancelled');
    return null;
  }
  
  return botToken;
}

/**
 * Validate Slack tokens via API
 * Exported for use in both wizard and manual flows
 */
export async function validateSlackTokens(appToken: string, botToken: string): Promise<void> {
  p.log.step('Validating Configuration');
  
  const spinner = p.spinner();
  spinner.start('Testing App Token...');
  
  let appTokenValid = false;
  let botTokenValid = false;
  let botUsername = '';
  let workspaceName = '';
  
  // Test App Token with auth.test
  try {
    const response = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${appToken}`,
        'Content-Type': 'application/json',
      },
    });
    
    const data = await response.json() as { ok: boolean; error?: string };
    
    if (data.ok) {
      spinner.stop('✓ App Token valid');
      appTokenValid = true;
    } else {
      spinner.stop('✗ App Token validation failed');
      p.log.error(`Error: ${data.error || 'Unknown error'}`);
      p.log.warn('The token might not work. Double-check it in your Slack app settings.');
    }
  } catch (e) {
    spinner.stop('Could not validate App Token (network error)');
    p.log.warn('Skipping validation - will test when server starts');
  }
  
  spinner.start('Testing Bot Token...');
  
  // Test Bot Token with auth.test
  try {
    const response = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${botToken}`,
        'Content-Type': 'application/json',
      },
    });
    
    const data = await response.json() as { ok: boolean; error?: string; user?: string; team?: string };
    
    if (data.ok) {
      spinner.stop('✓ Bot Token valid');
      botTokenValid = true;
      botUsername = data.user || '';
      workspaceName = data.team || '';
    } else {
      spinner.stop('✗ Bot Token validation failed');
      p.log.error(`Error: ${data.error || 'Unknown error'}`);
      p.log.warn('The token might not work. Double-check it in your Slack app settings.');
    }
  } catch (e) {
    spinner.stop('Could not validate Bot Token (network error)');
    p.log.warn('Skipping validation - will test when server starts');
  }
  
  // Show success summary if both tokens valid
  if (appTokenValid && botTokenValid) {
    p.note(
      `Bot: @${botUsername}\n` +
      `Workspace: ${workspaceName}\n` +
      `Socket Mode: Enabled\n\n` +
      `Your Slack bot is ready to receive messages!`,
      '✓ Validation Successful'
    );
  }
}

/**
 * Access control step - shared by wizard and manual flows
 * Exported for reuse in onboard.ts
 */
export async function stepAccessControl(existingUsers?: string[]): Promise<string[] | undefined> {
  const restrictSlack = await p.confirm({
    message: 'Restrict to specific Slack users?',
    initialValue: (existingUsers?.length || 0) > 0,
  });
  
  if (p.isCancel(restrictSlack)) return undefined;
  
  if (restrictSlack) {
    p.note(
      'To find user IDs:\n' +
      '1. Click on a user\'s profile in Slack\n' +
      '2. Click ⋮ menu → "Copy member ID"\n' +
      '3. IDs look like U01ABCD2EFG',
      'Finding User IDs'
    );
    
    const users = await p.text({
      message: 'Allowed Slack user IDs (comma-separated)',
      placeholder: 'U01234567,U98765432',
      initialValue: existingUsers?.join(',') || '',
      validate: validateSlackUserId,
    });
    
    if (p.isCancel(users)) return undefined;
    
    if (users) {
      return users.split(',').map(s => s.trim()).filter(Boolean);
    }
  }
  
  return undefined;
}

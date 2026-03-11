import { describe, expect, it } from 'vitest';
import {
  applyOnboardEnvProjection,
  buildProjectedAgentConfig,
  toProjectionInputFromNonInteractiveConfig,
  toProjectionInputFromOnboardConfig,
} from './onboard.js';

describe('onboarding projection helpers', () => {
  it('produces equivalent agent projection for non-interactive and interactive paths', () => {
    const nonInteractive = {
      agentName: 'LettaBot',
      agentId: 'agent-123',
      telegram: {
        enabled: true,
        botToken: 'tg-token',
        dmPolicy: 'allowlist' as const,
        allowedUsers: ['111', '222'],
        groupDebounceSec: 8,
        groupPollIntervalMin: 2,
        instantGroups: ['-1001'],
        listeningGroups: ['-1002'],
      },
      slack: {
        enabled: true,
        appToken: 'xapp-1',
        botToken: 'xoxb-1',
        allowedUsers: ['U1'],
        groupDebounceSec: 6,
        groupPollIntervalMin: 3,
        instantGroups: ['C1'],
        listeningGroups: ['C2'],
      },
      discord: {
        enabled: true,
        botToken: 'discord-token',
        dmPolicy: 'pairing' as const,
        allowedUsers: ['user-a'],
        groupDebounceSec: 5,
        groupPollIntervalMin: 4,
        instantGroups: ['g1'],
        listeningGroups: ['g2'],
      },
      whatsapp: {
        enabled: true,
        selfChat: false,
        dmPolicy: 'open' as const,
        allowedUsers: ['+1555'],
        groupDebounceSec: 10,
        groupPollIntervalMin: 7,
        instantGroups: ['wa1'],
        listeningGroups: ['wa2'],
      },
      signal: {
        enabled: true,
        phoneNumber: '+15551234567',
        selfChat: true,
        dmPolicy: 'allowlist' as const,
        allowedUsers: ['+15559876543'],
        groupDebounceSec: 9,
        groupPollIntervalMin: 6,
        instantGroups: ['sg1'],
        listeningGroups: ['sg2'],
      },
    };

    const interactive: any = {
      agentName: 'LettaBot',
      agentId: 'agent-123',
      telegram: {
        enabled: true,
        token: 'tg-token',
        dmPolicy: 'allowlist',
        allowedUsers: ['111', '222'],
        groupDebounceSec: 8,
        groupPollIntervalMin: 2,
        instantGroups: ['-1001'],
        listeningGroups: ['-1002'],
      },
      slack: {
        enabled: true,
        appToken: 'xapp-1',
        botToken: 'xoxb-1',
        allowedUsers: ['U1'],
        groupDebounceSec: 6,
        groupPollIntervalMin: 3,
        instantGroups: ['C1'],
        listeningGroups: ['C2'],
      },
      discord: {
        enabled: true,
        token: 'discord-token',
        dmPolicy: 'pairing',
        allowedUsers: ['user-a'],
        groupDebounceSec: 5,
        groupPollIntervalMin: 4,
        instantGroups: ['g1'],
        listeningGroups: ['g2'],
      },
      whatsapp: {
        enabled: true,
        selfChat: false,
        dmPolicy: 'open',
        allowedUsers: ['+1555'],
        groupDebounceSec: 10,
        groupPollIntervalMin: 7,
        instantGroups: ['wa1'],
        listeningGroups: ['wa2'],
      },
      signal: {
        enabled: true,
        phone: '+15551234567',
        selfChat: true,
        dmPolicy: 'allowlist',
        allowedUsers: ['+15559876543'],
        groupDebounceSec: 9,
        groupPollIntervalMin: 6,
        instantGroups: ['sg1'],
        listeningGroups: ['sg2'],
      },
      cron: false,
      heartbeat: { enabled: false, interval: '60' },
      google: { enabled: false, accounts: [] },
    };

    const fromEnv = buildProjectedAgentConfig(
      toProjectionInputFromNonInteractiveConfig(nonInteractive),
    );
    const fromInteractive = buildProjectedAgentConfig(
      toProjectionInputFromOnboardConfig(interactive),
    );

    expect(fromInteractive).toEqual(fromEnv);
  });

  it('applies env projection and clears stale channel keys when disabled', () => {
    const env: Record<string, string> = {
      TELEGRAM_BOT_TOKEN: 'old-tg',
      TELEGRAM_ALLOWED_USERS: 'old',
      DISCORD_BOT_TOKEN: 'old-discord',
      WHATSAPP_ENABLED: 'true',
      WHATSAPP_SELF_CHAT_MODE: 'true',
      SIGNAL_PHONE_NUMBER: '+1-old',
      SIGNAL_SELF_CHAT_MODE: 'false',
      HEARTBEAT_INTERVAL_MIN: '30',
      CRON_ENABLED: 'true',
    };

    const config: any = {
      agentName: 'ProjectedBot',
      telegram: {
        enabled: true,
        token: 'new-tg',
        dmPolicy: 'pairing',
        allowedUsers: ['123', '456'],
      },
      slack: { enabled: false },
      discord: { enabled: false },
      whatsapp: {
        enabled: true,
        selfChat: false,
        dmPolicy: 'allowlist',
        allowedUsers: ['+1444'],
      },
      signal: {
        enabled: true,
        phone: '+1777',
        selfChat: false,
        dmPolicy: 'open',
        allowedUsers: ['+1888'],
      },
      heartbeat: { enabled: false },
      cron: false,
      transcription: {
        enabled: true,
        provider: 'mistral',
        apiKey: 'mistral-key',
      },
    };

    applyOnboardEnvProjection(config, env);

    expect(env.AGENT_NAME).toBe('ProjectedBot');
    expect(env.TELEGRAM_BOT_TOKEN).toBe('new-tg');
    expect(env.TELEGRAM_ALLOWED_USERS).toBe('123,456');
    expect(env.DISCORD_BOT_TOKEN).toBeUndefined();
    expect(env.WHATSAPP_ENABLED).toBe('true');
    expect(env.WHATSAPP_SELF_CHAT_MODE).toBeUndefined();
    expect(env.SIGNAL_PHONE_NUMBER).toBe('+1777');
    expect(env.SIGNAL_SELF_CHAT_MODE).toBe('false');
    expect(env.HEARTBEAT_INTERVAL_MIN).toBeUndefined();
    expect(env.CRON_ENABLED).toBeUndefined();
    expect(env.MISTRAL_API_KEY).toBe('mistral-key');
  });
});

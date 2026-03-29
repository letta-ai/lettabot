import { BlueskyAdapter } from './bluesky.js';
import { DiscordAdapter } from './discord.js';
import { MatrixAdapter } from './matrix.js';
import { SignalAdapter } from './signal.js';
import { SlackAdapter } from './slack.js';
import { TelegramMTProtoAdapter } from './telegram-mtproto.js';
import { TelegramAdapter } from './telegram.js';
import type { ChannelAdapter } from './types.js';
import { WhatsAppAdapter } from './whatsapp/index.js';
import type { AgentConfig } from '../config/types.js';
import { createLogger } from '../logger.js';

const log = createLogger('Config');

type SharedFactoryOptions = {
  attachmentsDir: string;
  attachmentsMaxBytes: number;
};

type SharedChannelBuilder = {
  isEnabled: (agentConfig: AgentConfig) => boolean;
  build: (agentConfig: AgentConfig, options: SharedFactoryOptions) => ChannelAdapter;
};

function nonEmpty<T>(values: T[] | undefined): T[] | undefined {
  return values && values.length > 0 ? values : undefined;
}

function parseUserIds(values: Array<string | number> | undefined): number[] | undefined {
  const normalized = nonEmpty(values);
  if (!normalized) return undefined;
  return normalized.map((value) => (typeof value === 'string' ? parseInt(value, 10) : value));
}

const SHARED_CHANNEL_BUILDERS: SharedChannelBuilder[] = [
  {
    isEnabled: (agentConfig) => !!(agentConfig.channels.slack?.botToken && agentConfig.channels.slack?.appToken),
    build: (agentConfig, options) => {
      const slack = agentConfig.channels.slack;
      if (!slack?.botToken || !slack.appToken) {
        throw new Error(`Slack is enabled for agent "${agentConfig.name}" but required tokens are missing`);
      }
      return new SlackAdapter({
        botToken: slack.botToken,
        appToken: slack.appToken,
        dmPolicy: slack.dmPolicy || 'pairing',
        allowedUsers: nonEmpty(slack.allowedUsers),
        streaming: slack.streaming,
        attachmentsDir: options.attachmentsDir,
        attachmentsMaxBytes: options.attachmentsMaxBytes,
        groups: slack.groups,
        agentName: agentConfig.name,
      });
    },
  },
  {
    isEnabled: (agentConfig) => !!agentConfig.channels.whatsapp?.enabled,
    build: (agentConfig, options) => {
      const whatsappRaw = agentConfig.channels.whatsapp! as unknown as Record<string, unknown>;
      if (whatsappRaw.streaming) {
        log.warn('WhatsApp does not support streaming (message edits not available). Streaming setting will be ignored for WhatsApp.');
      }
      const selfChatMode = agentConfig.channels.whatsapp!.selfChat ?? true;
      if (!selfChatMode) {
        log.warn('WARNING: selfChatMode is OFF - bot will respond to ALL incoming messages!');
        log.warn('Only use this if this is a dedicated bot number, not your personal WhatsApp.');
      }
      return new WhatsAppAdapter({
        sessionPath: agentConfig.channels.whatsapp!.sessionPath || process.env.WHATSAPP_SESSION_PATH || './data/whatsapp-session',
        dmPolicy: agentConfig.channels.whatsapp!.dmPolicy || 'pairing',
        allowedUsers: nonEmpty(agentConfig.channels.whatsapp!.allowedUsers),
        selfChatMode,
        attachmentsDir: options.attachmentsDir,
        attachmentsMaxBytes: options.attachmentsMaxBytes,
        groups: agentConfig.channels.whatsapp!.groups,
        mentionPatterns: agentConfig.channels.whatsapp!.mentionPatterns,
        agentName: agentConfig.name,
      });
    },
  },
  {
    isEnabled: (agentConfig) => !!agentConfig.channels.signal?.phone,
    build: (agentConfig, options) => {
      const signal = agentConfig.channels.signal;
      if (!signal?.phone) {
        throw new Error(`Signal is enabled for agent "${agentConfig.name}" but phone is missing`);
      }
      const selfChatMode = signal.selfChat ?? true;
      if (!selfChatMode) {
        log.warn('WARNING: selfChatMode is OFF - bot will respond to ALL incoming messages!');
        log.warn('Only use this if this is a dedicated bot number, not your personal Signal.');
      }
      return new SignalAdapter({
        phoneNumber: signal.phone,
        cliPath: signal.cliPath || process.env.SIGNAL_CLI_PATH || 'signal-cli',
        httpHost: signal.httpHost || process.env.SIGNAL_HTTP_HOST || '127.0.0.1',
        httpPort: signal.httpPort || parseInt(process.env.SIGNAL_HTTP_PORT || '8090', 10),
        readReceipts: signal.readReceipts ?? (process.env.SIGNAL_READ_RECEIPTS !== 'false'),
        dmPolicy: signal.dmPolicy || 'pairing',
        allowedUsers: nonEmpty(signal.allowedUsers),
        selfChatMode,
        attachmentsDir: options.attachmentsDir,
        attachmentsMaxBytes: options.attachmentsMaxBytes,
        groups: signal.groups,
        mentionPatterns: signal.mentionPatterns,
        agentName: agentConfig.name,
      });
    },
  },
  {
    isEnabled: (agentConfig) => !!agentConfig.channels.discord?.token,
    build: (agentConfig, options) => {
      const discord = agentConfig.channels.discord;
      if (!discord?.token) {
        throw new Error(`Discord is enabled for agent "${agentConfig.name}" but token is missing`);
      }
      return new DiscordAdapter({
        token: discord.token,
        dmPolicy: discord.dmPolicy || 'pairing',
        allowedUsers: nonEmpty(discord.allowedUsers),
        streaming: discord.streaming,
        attachmentsDir: options.attachmentsDir,
        attachmentsMaxBytes: options.attachmentsMaxBytes,
        groups: discord.groups,
        agentName: agentConfig.name,
        ignoreBotReactions: discord.ignoreBotReactions,
      });
    },
  },
  {
    isEnabled: (agentConfig) => !!agentConfig.channels.matrix?.accessToken,
    build: (agentConfig, options) => {
      const matrix = agentConfig.channels.matrix;
      if (!matrix?.homeserverUrl || !matrix.accessToken || !matrix.userId) {
        throw new Error(`Matrix is enabled for agent "${agentConfig.name}" but credentials are missing`);
      }
      return new MatrixAdapter({
        homeserverUrl: matrix.homeserverUrl,
        accessToken: matrix.accessToken,
        userId: matrix.userId,
        deviceId: matrix.deviceId,
        dmPolicy: matrix.dmPolicy || 'pairing',
        allowedUsers: nonEmpty(matrix.allowedUsers),
        streaming: matrix.streaming,
        attachmentsDir: options.attachmentsDir,
        attachmentsMaxBytes: options.attachmentsMaxBytes,
        mentionPatterns: matrix.mentionPatterns,
        groups: matrix.groups,
        agentName: agentConfig.name,
        e2ee: matrix.e2ee,
        storePath: matrix.storePath,
      });
    },
  },
];

/**
 * Create channel adapters for an agent from its config.
 * Uses a table-driven builder for shared channel setup while preserving
 * Telegram-specific mutual-exclusion checks.
 */
export function createChannelsForAgent(
  agentConfig: AgentConfig,
  attachmentsDir: string,
  attachmentsMaxBytes: number,
): ChannelAdapter[] {
  const adapters: ChannelAdapter[] = [];
  const sharedOptions = { attachmentsDir, attachmentsMaxBytes };

  const hasTelegramBot = !!agentConfig.channels.telegram?.token;
  const hasTelegramMtproto = !!agentConfig.channels['telegram-mtproto']?.apiId;
  if (hasTelegramBot && hasTelegramMtproto) {
    log.error(`Agent "${agentConfig.name}" has both telegram and telegram-mtproto configured.`);
    log.error('  The Bot API adapter and MTProto adapter cannot run together.');
    log.error('Choose one: telegram (bot token) or telegram-mtproto (user account).');
    process.exit(1);
  }

  if (hasTelegramBot) {
    adapters.push(new TelegramAdapter({
      token: agentConfig.channels.telegram!.token!,
      dmPolicy: agentConfig.channels.telegram!.dmPolicy || 'pairing',
      allowedUsers: parseUserIds(agentConfig.channels.telegram!.allowedUsers),
      streaming: agentConfig.channels.telegram!.streaming,
      attachmentsDir,
      attachmentsMaxBytes,
      groups: agentConfig.channels.telegram!.groups,
      mentionPatterns: agentConfig.channels.telegram!.mentionPatterns,
      agentName: agentConfig.name,
    }));
  }

  if (hasTelegramMtproto) {
    const mtprotoConfig = agentConfig.channels['telegram-mtproto']!;
    if (mtprotoConfig.apiId === undefined || !mtprotoConfig.apiHash || !mtprotoConfig.phoneNumber) {
      log.error(`Agent "${agentConfig.name}" has incomplete telegram-mtproto config (requires apiId, apiHash, phoneNumber).`);
      process.exit(1);
    }
    adapters.push(new TelegramMTProtoAdapter({
      apiId: mtprotoConfig.apiId,
      apiHash: mtprotoConfig.apiHash,
      phoneNumber: mtprotoConfig.phoneNumber,
      databaseDirectory: mtprotoConfig.databaseDirectory || './data/telegram-mtproto',
      dmPolicy: mtprotoConfig.dmPolicy || 'pairing',
      allowedUsers: parseUserIds(mtprotoConfig.allowedUsers),
      groupPolicy: mtprotoConfig.groupPolicy || 'both',
      adminChatId: mtprotoConfig.adminChatId,
    }));
  }

  for (const builder of SHARED_CHANNEL_BUILDERS) {
    if (builder.isEnabled(agentConfig)) {
      adapters.push(builder.build(agentConfig, sharedOptions));
    }
  }

  // Bluesky: only start if there's something to subscribe to
  if (agentConfig.channels.bluesky?.enabled) {
    const bsky = agentConfig.channels.bluesky;
    const hasWantedDids = !!bsky.wantedDids?.length;
    const hasLists = !!(bsky.lists && Object.keys(bsky.lists).length > 0);
    const hasAuth = !!bsky.handle;
    const wantsNotifications = !!bsky.notifications?.enabled;
    if (hasWantedDids || hasLists || hasAuth || wantsNotifications) {
      adapters.push(new BlueskyAdapter({
        agentName: agentConfig.name,
        jetstreamUrl: bsky.jetstreamUrl,
        wantedDids: bsky.wantedDids,
        wantedCollections: bsky.wantedCollections,
        cursor: bsky.cursor,
        handle: bsky.handle,
        appPassword: bsky.appPassword,
        serviceUrl: bsky.serviceUrl,
        appViewUrl: bsky.appViewUrl,
        groups: bsky.groups,
        lists: bsky.lists,
        notifications: bsky.notifications,
      }));
    }
  }

  return adapters;
}

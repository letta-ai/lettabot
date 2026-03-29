import * as p from '@clack/prompts';
import {
  isApiServerMode,
  loadAppConfigOrExit,
  resolveConfigPath,
  saveConfig,
  serverModeLabel,
} from '../config/index.js';
import type { AgentConfig, LettaBotConfig, ServerMode } from '../config/types.js';
import {
  CHANNELS,
  getChannelHint,
  getSetupFunction,
  type ChannelId,
} from '../channels/setup.js';

type CoreServerMode = 'api' | 'docker';

export interface CoreConfigDraft {
  server: {
    mode: CoreServerMode;
    baseUrl?: string;
    apiKey?: string;
  };
  agent: {
    name: string;
    id?: string;
  };
  channels: AgentConfig['channels'];
  features: NonNullable<AgentConfig['features']>;
  source: 'agents' | 'legacy';
}

class InterceptedExit extends Error {
  code: number;

  constructor(code = 0) {
    super(`process.exit(${code}) intercepted`);
    this.code = code;
  }
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeServerMode(mode?: ServerMode): CoreServerMode {
  return isApiServerMode(mode) ? 'api' : 'docker';
}

function getPrimaryAgent(config: LettaBotConfig): AgentConfig | null {
  if (Array.isArray(config.agents) && config.agents.length > 0) {
    return config.agents[0];
  }
  return null;
}

function normalizeFeatures(source?: AgentConfig['features']): NonNullable<AgentConfig['features']> {
  const features = deepClone(source ?? {});
  const skipRecentPolicy = features.heartbeat?.skipRecentPolicy
    ?? (features.heartbeat?.skipRecentUserMin !== undefined ? 'fixed' : 'fraction');
  return {
    ...features,
    cron: typeof features.cron === 'boolean' ? features.cron : false,
    heartbeat: {
      enabled: features.heartbeat?.enabled ?? false,
      intervalMin: features.heartbeat?.intervalMin ?? 60,
      skipRecentUserMin: features.heartbeat?.skipRecentUserMin,
      skipRecentPolicy,
      skipRecentFraction: features.heartbeat?.skipRecentFraction,
      interruptOnUserMessage: features.heartbeat?.interruptOnUserMessage ?? true,
      prompt: features.heartbeat?.prompt,
      promptFile: features.heartbeat?.promptFile,
      target: features.heartbeat?.target,
    },
  };
}

function normalizeChannels(source?: AgentConfig['channels']): AgentConfig['channels'] {
  return deepClone(source ?? {});
}

export function extractCoreDraft(config: LettaBotConfig): CoreConfigDraft {
  const primary = getPrimaryAgent(config);
  const source = primary ? 'agents' : 'legacy';

  return {
    server: {
      mode: normalizeServerMode(config.server.mode),
      baseUrl: config.server.baseUrl,
      apiKey: config.server.apiKey,
    },
    agent: {
      name: (primary?.name || config.agent.name || 'LettaBot').trim() || 'LettaBot',
      id: primary?.id ?? config.agent.id,
    },
    channels: normalizeChannels(primary?.channels ?? config.channels),
    features: normalizeFeatures(primary?.features ?? config.features),
    source,
  };
}

export function applyCoreDraft(baseConfig: LettaBotConfig, draft: CoreConfigDraft): LettaBotConfig {
  const next = deepClone(baseConfig);

  next.server = {
    ...next.server,
    mode: draft.server.mode,
    baseUrl: draft.server.baseUrl,
    apiKey: draft.server.apiKey,
  };

  if (Array.isArray(next.agents) && next.agents.length > 0) {
    const [primary, ...rest] = next.agents;
    const updatedPrimary: AgentConfig = {
      ...primary,
      name: draft.agent.name,
      channels: normalizeChannels(draft.channels),
      features: normalizeFeatures(draft.features),
    };

    if (draft.agent.id) {
      updatedPrimary.id = draft.agent.id;
    } else {
      delete updatedPrimary.id;
    }

    next.agents = [updatedPrimary, ...rest];
  } else {
    next.agent = {
      ...next.agent,
      name: draft.agent.name,
    };

    if (draft.agent.id) {
      next.agent.id = draft.agent.id;
    } else {
      delete next.agent.id;
    }

    next.channels = normalizeChannels(draft.channels);
    next.features = normalizeFeatures(draft.features);
  }

  return next;
}

function isChannelEnabled(config: unknown): boolean {
  return !!config && typeof config === 'object' && (config as { enabled?: boolean }).enabled === true;
}

function getEnabledChannelIds(channels: AgentConfig['channels']): ChannelId[] {
  return CHANNELS
    .map((channel) => channel.id)
    .filter((channelId) => isChannelEnabled(channels[channelId]));
}

export function getCoreDraftWarnings(draft: CoreConfigDraft): string[] {
  const warnings: string[] = [];

  if (draft.server.mode === 'api' && !draft.server.apiKey?.trim()) {
    warnings.push('Server mode is api, but API key is empty.');
  }

  if (getEnabledChannelIds(draft.channels).length === 0) {
    warnings.push('No channels are enabled.');
  }

  return warnings;
}

function formatChannelsSummary(draft: CoreConfigDraft): string {
  const enabled = getEnabledChannelIds(draft.channels);
  if (!enabled.length) return 'None';
  return enabled.map((id) => CHANNELS.find((channel) => channel.id === id)?.displayName ?? id).join(', ');
}

export function formatCoreDraftSummary(draft: CoreConfigDraft, configPath: string): string {
  const rows: Array<[string, string]> = [
    ['Config Path', configPath],
    ['Server Mode', serverModeLabel(draft.server.mode)],
    ['API Key', draft.server.apiKey ? '✓ Set' : '✗ Not set'],
    ['Docker Base URL', draft.server.baseUrl || '(unset)'],
    ['Agent Name', draft.agent.name],
    ['Agent ID', draft.agent.id || '(new/auto)'],
    ['Enabled Channels', formatChannelsSummary(draft)],
    ['Cron', draft.features.cron ? '✓ Enabled' : '✗ Disabled'],
    [
      'Heartbeat',
      draft.features.heartbeat?.enabled
        ? `✓ ${draft.features.heartbeat.intervalMin ?? 60}${draft.features.heartbeat.intervalMaxMin ? `-${draft.features.heartbeat.intervalMaxMin}` : ''}min • ${draft.features.heartbeat.skipRecentPolicy ?? 'fraction'} • preempt ${draft.features.heartbeat.interruptOnUserMessage === false ? 'off' : 'on'}`
        : '✗ Disabled',
    ],
  ];

  const max = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `${(label + ':').padEnd(max + 2)}${value}`).join('\n');
}

function hasDraftChanged(initial: CoreConfigDraft, current: CoreConfigDraft): boolean {
  return JSON.stringify(initial) !== JSON.stringify(current);
}

async function editServerAuth(draft: CoreConfigDraft): Promise<void> {
  const mode = await p.select({
    message: 'Select server mode',
    options: [
      { value: 'api', label: 'API', hint: 'Use Letta API key authentication' },
      { value: 'docker', label: 'Docker/Self-hosted', hint: 'Use local/self-hosted base URL' },
    ],
    initialValue: draft.server.mode,
  });

  if (p.isCancel(mode)) return;
  draft.server.mode = mode as CoreServerMode;

  if (draft.server.mode === 'api') {
    const apiKey = await p.text({
      message: 'API key (blank to unset)',
      placeholder: 'sk-...',
      initialValue: draft.server.apiKey ?? '',
    });
    if (p.isCancel(apiKey)) return;
    draft.server.apiKey = apiKey.trim() || undefined;
  } else {
    const baseUrl = await p.text({
      message: 'Base URL',
      placeholder: 'http://localhost:8283',
      initialValue: draft.server.baseUrl ?? 'http://localhost:8283',
      validate: (value) => {
        const trimmed = value.trim();
        if (!trimmed) return 'Base URL is required in docker mode';
        if (!/^https?:\/\//.test(trimmed)) return 'Base URL must start with http:// or https://';
        return undefined;
      },
    });
    if (p.isCancel(baseUrl)) return;
    draft.server.baseUrl = baseUrl.trim();
  }
}

async function editAgent(draft: CoreConfigDraft): Promise<void> {
  const name = await p.text({
    message: 'Agent name',
    initialValue: draft.agent.name,
    validate: (value) => {
      if (!value.trim()) return 'Agent name is required';
      return undefined;
    },
  });
  if (p.isCancel(name)) return;

  const id = await p.text({
    message: 'Agent ID (optional)',
    placeholder: 'agent-xxxx',
    initialValue: draft.agent.id ?? '',
  });
  if (p.isCancel(id)) return;

  draft.agent.name = name.trim();
  draft.agent.id = id.trim() || undefined;
}

async function runChannelSetupSafely(channelId: ChannelId, existing?: unknown): Promise<unknown | undefined> {
  const setup = getSetupFunction(channelId);
  const originalExit = process.exit;

  (process as unknown as { exit: (code?: number) => never }).exit = ((code?: number) => {
    throw new InterceptedExit(code ?? 0);
  }) as (code?: number) => never;

  try {
    return await setup(existing);
  } catch (error) {
    if (error instanceof InterceptedExit) {
      if (error.code === 0) return undefined;
      throw new Error(`Channel setup exited with code ${error.code}`);
    }
    throw error;
  } finally {
    (process as unknown as { exit: typeof process.exit }).exit = originalExit;
  }
}

async function configureChannel(draft: CoreConfigDraft, channelId: ChannelId): Promise<void> {
  const current = draft.channels[channelId];
  const enabled = isChannelEnabled(current);

  const action = await p.select({
    message: `${CHANNELS.find((channel) => channel.id === channelId)?.displayName || channelId} settings`,
    options: enabled
      ? [
          { value: 'edit', label: 'Edit settings', hint: getChannelHint(channelId) },
          { value: 'disable', label: 'Disable channel', hint: 'Set enabled=false' },
          { value: 'back', label: 'Back', hint: '' },
        ]
      : [
          { value: 'enable', label: 'Enable and configure', hint: getChannelHint(channelId) },
          { value: 'back', label: 'Back', hint: '' },
        ],
  });

  if (p.isCancel(action) || action === 'back') return;

  if (action === 'disable') {
    const confirmed = await p.confirm({
      message: `Disable ${channelId}?`,
      initialValue: false,
    });
    if (p.isCancel(confirmed) || !confirmed) return;
    draft.channels[channelId] = { enabled: false } as AgentConfig['channels'][ChannelId];
    return;
  }

  const result = await runChannelSetupSafely(channelId, current);
  if (!result) {
    p.log.info(`${channelId} setup cancelled.`);
    return;
  }
  draft.channels[channelId] = result as AgentConfig['channels'][ChannelId];
}

async function editChannels(draft: CoreConfigDraft): Promise<void> {
  while (true) {
    const selected = await p.select({
      message: 'Select a channel to edit',
      options: [
        ...CHANNELS.map((channel) => {
          const enabled = isChannelEnabled(draft.channels[channel.id]);
          return {
            value: channel.id,
            label: `${enabled ? '✓' : '✗'} ${channel.displayName}`,
            hint: enabled ? 'enabled' : getChannelHint(channel.id),
          };
        }),
        { value: 'back', label: 'Back', hint: '' },
      ],
    });

    if (p.isCancel(selected) || selected === 'back') return;
    await configureChannel(draft, selected as ChannelId);
  }
}

async function editFeatures(draft: CoreConfigDraft): Promise<void> {
  const cron = await p.confirm({
    message: 'Enable cron?',
    initialValue: !!draft.features.cron,
  });
  if (p.isCancel(cron)) return;
  draft.features.cron = cron;

  const heartbeatEnabled = await p.confirm({
    message: 'Enable heartbeat?',
    initialValue: !!draft.features.heartbeat?.enabled,
  });
  if (p.isCancel(heartbeatEnabled)) return;
  draft.features.heartbeat = {
    ...draft.features.heartbeat,
    enabled: heartbeatEnabled,
  };

  if (heartbeatEnabled) {
    const interval = await p.text({
      message: 'Heartbeat interval minutes',
      placeholder: '60',
      initialValue: String(draft.features.heartbeat.intervalMin ?? 60),
      validate: (value) => {
        const parsed = Number(value.trim());
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return 'Enter a positive number';
        }
        return undefined;
      },
    });
    if (p.isCancel(interval)) return;
    draft.features.heartbeat.intervalMin = Number(interval.trim());

    const skipPolicy = await p.select({
      message: 'Heartbeat skip policy after user activity',
      options: [
        { value: 'fraction', label: 'Fraction of interval', hint: 'default: 0.5 × interval' },
        { value: 'fixed', label: 'Fixed minutes', hint: 'manual skip window (legacy behavior)' },
        { value: 'off', label: 'Disabled', hint: 'never skip based on recent user message' },
      ],
      initialValue: draft.features.heartbeat.skipRecentPolicy ?? 'fraction',
    });
    if (p.isCancel(skipPolicy)) return;
    draft.features.heartbeat.skipRecentPolicy = skipPolicy as 'fixed' | 'fraction' | 'off';

    if (skipPolicy === 'fixed') {
      const skipMin = await p.text({
        message: 'Skip heartbeats for this many minutes after user messages',
        placeholder: '5',
        initialValue: String(draft.features.heartbeat.skipRecentUserMin ?? 5),
        validate: (value) => {
          const parsed = Number(value.trim());
          if (!Number.isFinite(parsed) || parsed < 0) {
            return 'Enter a non-negative number';
          }
          return undefined;
        },
      });
      if (p.isCancel(skipMin)) return;
      draft.features.heartbeat.skipRecentUserMin = Number(skipMin.trim());
      delete draft.features.heartbeat.skipRecentFraction;
    } else if (skipPolicy === 'fraction') {
      const skipFraction = await p.text({
        message: 'Skip window as fraction of interval (0-1)',
        placeholder: '0.5',
        initialValue: String(draft.features.heartbeat.skipRecentFraction ?? 0.5),
        validate: (value) => {
          const parsed = Number(value.trim());
          if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
            return 'Enter a number between 0 and 1';
          }
          return undefined;
        },
      });
      if (p.isCancel(skipFraction)) return;
      draft.features.heartbeat.skipRecentFraction = Number(skipFraction.trim());
      delete draft.features.heartbeat.skipRecentUserMin;
    } else {
      delete draft.features.heartbeat.skipRecentUserMin;
      delete draft.features.heartbeat.skipRecentFraction;
    }

    const interruptOnUserMessage = await p.confirm({
      message: 'Interrupt in-flight heartbeat when a user message arrives?',
      initialValue: draft.features.heartbeat.interruptOnUserMessage !== false,
    });
    if (p.isCancel(interruptOnUserMessage)) return;
    draft.features.heartbeat.interruptOnUserMessage = interruptOnUserMessage;
  }
}

async function reviewDraft(draft: CoreConfigDraft, configPath: string): Promise<void> {
  p.note(formatCoreDraftSummary(draft, configPath), 'Draft Configuration');
}

export async function configTui(): Promise<void> {
  const configPath = resolveConfigPath();
  const loaded = loadAppConfigOrExit();
  const draft = extractCoreDraft(loaded);
  const initial = deepClone(draft);

  p.intro('⚙️  LettaBot Config TUI (Core)');

  while (true) {
    const enabledChannels = getEnabledChannelIds(draft.channels).length;
    const changed = hasDraftChanged(initial, draft);

    const choice = await p.select({
      message: 'What would you like to edit?',
      options: [
        {
          value: 'server',
          label: 'Server/Auth',
          hint: `${serverModeLabel(draft.server.mode)}${draft.server.mode === 'api' ? '' : ` • ${draft.server.baseUrl || 'unset'}`}`,
        },
        {
          value: 'agent',
          label: 'Agent',
          hint: draft.agent.name,
        },
        {
          value: 'channels',
          label: 'Channels',
          hint: `${enabledChannels} enabled`,
        },
        {
          value: 'features',
          label: 'Features',
          hint: `cron ${draft.features.cron ? 'on' : 'off'} • heartbeat ${draft.features.heartbeat?.enabled ? 'on' : 'off'}`,
        },
        {
          value: 'review',
          label: 'Review Draft',
          hint: changed ? 'unsaved changes' : 'no changes',
        },
        {
          value: 'save',
          label: 'Save & Exit',
          hint: configPath,
        },
        {
          value: 'exit',
          label: 'Exit Without Saving',
          hint: '',
        },
      ],
    });

    if (p.isCancel(choice) || choice === 'exit') {
      if (hasDraftChanged(initial, draft)) {
        const discard = await p.confirm({
          message: 'Discard unsaved changes?',
          initialValue: false,
        });
        if (p.isCancel(discard) || !discard) continue;
      }
      p.outro('Exited without saving.');
      return;
    }

    if (choice === 'server') {
      await editServerAuth(draft);
      continue;
    }

    if (choice === 'agent') {
      await editAgent(draft);
      continue;
    }

    if (choice === 'channels') {
      await editChannels(draft);
      continue;
    }

    if (choice === 'features') {
      await editFeatures(draft);
      continue;
    }

    if (choice === 'review') {
      await reviewDraft(draft, configPath);
      continue;
    }

    if (choice === 'save') {
      const warnings = getCoreDraftWarnings(draft);
      if (warnings.length > 0) {
        p.note(warnings.map((warning) => `• ${warning}`).join('\n'), 'Pre-save Warnings');
      }

      const confirmSave = await p.confirm({
        message: `Save changes to ${configPath}?`,
        initialValue: true,
      });

      if (p.isCancel(confirmSave) || !confirmSave) continue;

      const updated = applyCoreDraft(loaded, draft);
      saveConfig(updated, configPath);
      p.log.success(`Saved configuration to ${configPath}`);
      p.outro('Run `lettabot server` to apply changes.');
      return;
    }
  }
}

import { describe, expect, it } from 'vitest';
import {
  applyCoreDraft,
  extractCoreDraft,
  formatCoreDraftSummary,
  getCoreDraftWarnings,
  type CoreConfigDraft,
} from './config-tui.js';
import type { LettaBotConfig } from '../config/types.js';

function makeBaseConfig(): LettaBotConfig {
  return {
    server: {
      mode: 'api',
      apiKey: 'sk-base',
    },
    agent: {
      name: 'Legacy Agent',
      id: 'legacy-id',
    },
    channels: {
      telegram: {
        enabled: true,
        token: 'telegram-token',
      },
    },
    features: {
      cron: false,
      heartbeat: {
        enabled: true,
        intervalMin: 30,
      },
    },
    providers: [
      {
        id: 'openai',
        name: 'OpenAI',
        type: 'openai',
        apiKey: 'provider-key',
      },
    ],
    attachments: {
      maxMB: 20,
      maxAgeDays: 14,
    },
  };
}

describe('config TUI helpers', () => {
  it('extractCoreDraft uses primary agent when agents[] exists', () => {
    const config: LettaBotConfig = {
      ...makeBaseConfig(),
      agents: [
        {
          name: 'Primary',
          id: 'agent-1',
          channels: {
            discord: { enabled: true, token: 'discord-token' },
          },
          features: {
            cron: true,
            heartbeat: { enabled: false, intervalMin: 10 },
          },
        },
        {
          name: 'Secondary',
          channels: {
            telegram: { enabled: true, token: 'secondary' },
          },
        },
      ],
    };

    const draft = extractCoreDraft(config);
    expect(draft.source).toBe('agents');
    expect(draft.agent.name).toBe('Primary');
    expect(draft.agent.id).toBe('agent-1');
    expect(draft.channels.discord?.enabled).toBe(true);
    expect(draft.features.cron).toBe(true);
    expect(draft.features.heartbeat?.enabled).toBe(false);
  });

  it('extractCoreDraft falls back to legacy top-level fields', () => {
    const draft = extractCoreDraft(makeBaseConfig());
    expect(draft.source).toBe('legacy');
    expect(draft.agent.name).toBe('Legacy Agent');
    expect(draft.channels.telegram?.enabled).toBe(true);
    expect(draft.features.heartbeat?.intervalMin).toBe(30);
  });

  it('applyCoreDraft updates only primary agent and preserves others', () => {
    const config: LettaBotConfig = {
      ...makeBaseConfig(),
      agents: [
        {
          name: 'Primary',
          id: 'agent-1',
          channels: { telegram: { enabled: true, token: 'primary-token' } },
          features: { cron: false, heartbeat: { enabled: true, intervalMin: 20 } },
        },
        {
          name: 'Secondary',
          id: 'agent-2',
          channels: { discord: { enabled: true, token: 'secondary-token' } },
          features: { cron: true, heartbeat: { enabled: false } },
        },
      ],
    };
    const draft = extractCoreDraft(config);
    draft.agent.name = 'Updated Primary';
    draft.agent.id = 'agent-1b';
    draft.channels.telegram = { enabled: false };
    draft.features.cron = true;
    draft.server.mode = 'docker';
    draft.server.baseUrl = 'http://localhost:8283';

    const updated = applyCoreDraft(config, draft);
    expect(updated.server.mode).toBe('docker');
    expect(updated.server.baseUrl).toBe('http://localhost:8283');
    expect(updated.agents?.[0].name).toBe('Updated Primary');
    expect(updated.agents?.[0].id).toBe('agent-1b');
    expect(updated.agents?.[0].channels.telegram?.enabled).toBe(false);
    expect(updated.agents?.[1].name).toBe('Secondary');
    expect(updated.agents?.[1].channels.discord?.token).toBe('secondary-token');
    expect(updated.providers?.[0].id).toBe('openai');
    expect(updated.attachments?.maxMB).toBe(20);
  });

  it('applyCoreDraft updates legacy top-level fields when agents[] absent', () => {
    const config = makeBaseConfig();
    const draft = extractCoreDraft(config);
    draft.agent.name = 'Updated Legacy';
    draft.agent.id = undefined;
    draft.features.cron = true;
    draft.channels.telegram = { enabled: false };

    const updated = applyCoreDraft(config, draft);
    expect(updated.agent.name).toBe('Updated Legacy');
    expect(updated.agent.id).toBeUndefined();
    expect(updated.features?.cron).toBe(true);
    expect(updated.channels.telegram?.enabled).toBe(false);
    expect(updated.providers?.[0].name).toBe('OpenAI');
  });

  it('getCoreDraftWarnings flags missing API key and no enabled channels', () => {
    const draft: CoreConfigDraft = {
      server: { mode: 'api', apiKey: undefined, baseUrl: undefined },
      agent: { name: 'A' },
      channels: {
        telegram: { enabled: false },
      },
      features: {
        cron: false,
        heartbeat: { enabled: false, intervalMin: 60 },
      },
      source: 'legacy',
    };

    const warnings = getCoreDraftWarnings(draft);
    expect(warnings).toContain('Server mode is api, but API key is empty.');
    expect(warnings).toContain('No channels are enabled.');
  });

  it('formatCoreDraftSummary includes key sections', () => {
    const draft = extractCoreDraft(makeBaseConfig());
    const summary = formatCoreDraftSummary(draft, '/tmp/lettabot.yaml');
    expect(summary).toContain('Config Path:');
    expect(summary).toContain('Server Mode:');
    expect(summary).toContain('Agent Name:');
    expect(summary).toContain('Enabled Channels:');
    expect(summary).toContain('/tmp/lettabot.yaml');
  });
});

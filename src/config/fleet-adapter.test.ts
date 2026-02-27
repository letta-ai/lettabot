import { describe, it, expect, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  createLogger: () => ({
    fatal: (...args: unknown[]) => console.error(...args),
    error: (...args: unknown[]) => console.error(...args),
    warn: (...args: unknown[]) => console.warn(...args),
    info: (...args: unknown[]) => console.log(...args),
    debug: (...args: unknown[]) => console.log(...args),
    trace: (...args: unknown[]) => console.log(...args),
    pino: {},
  }),
}));

import {
  isFleetConfig,
  fleetConfigToLettaBotConfig,
  wasLoadedFromFleetConfig,
  setLoadedFromFleetConfig,
} from './fleet-adapter.js';

// ---------------------------------------------------------------------------
// isFleetConfig
// ---------------------------------------------------------------------------

describe('isFleetConfig', () => {
  it('returns true for a fleet config with llm_config', () => {
    expect(
      isFleetConfig({
        agents: [
          { name: 'bot', llm_config: { model: 'gpt-4' }, system_prompt: { value: 'hi' } },
        ],
      }),
    ).toBe(true);
  });

  it('returns true for a fleet config with system_prompt only', () => {
    expect(
      isFleetConfig({
        agents: [{ name: 'bot', system_prompt: { value: 'hi' } }],
      }),
    ).toBe(true);
  });

  it('returns false for native LettaBot single-agent config', () => {
    expect(
      isFleetConfig({
        server: { mode: 'api' },
        agent: { name: 'Bot' },
        channels: { telegram: { enabled: true, token: 'abc' } },
      }),
    ).toBe(false);
  });

  it('returns false for native LettaBot multi-agent config', () => {
    expect(
      isFleetConfig({
        server: { mode: 'api' },
        agents: [
          { name: 'Bot1', channels: { telegram: { enabled: true } } },
        ],
      }),
    ).toBe(false);
  });

  it('returns false for null', () => {
    expect(isFleetConfig(null)).toBe(false);
  });

  it('returns false for empty object', () => {
    expect(isFleetConfig({})).toBe(false);
  });

  it('returns false for empty agents array', () => {
    expect(isFleetConfig({ agents: [] })).toBe(false);
  });

  it('returns false for an array', () => {
    expect(isFleetConfig([{ llm_config: {} }])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fleetConfigToLettaBotConfig — single agent
// ---------------------------------------------------------------------------

describe('fleetConfigToLettaBotConfig (single agent)', () => {
  it('converts a single qualifying agent to single-agent format', () => {
    const fleet = {
      agents: [
        {
          name: 'MyBot',
          description: 'Test bot',
          llm_config: { model: 'gpt-4', context_window: 128000 },
          system_prompt: { value: 'You are helpful' },
          tools: ['web_search'],
          lettabot: {
            server: { mode: 'docker', baseUrl: 'http://localhost:8283' },
            displayName: 'Bot',
            channels: {
              telegram: { enabled: true, token: 'tg-token', dmPolicy: 'open' },
            },
            features: { cron: true },
          },
        },
      ],
    };

    const result = fleetConfigToLettaBotConfig(fleet);

    expect(result.agent.name).toBe('MyBot');
    expect(result.agent.displayName).toBe('Bot');
    expect(result.server.mode).toBe('docker');
    expect(result.server.baseUrl).toBe('http://localhost:8283');
    expect(result.channels.telegram?.token).toBe('tg-token');
    expect(result.channels.telegram?.dmPolicy).toBe('open');
    expect(result.features?.cron).toBe(true);
    // lettactl-only fields should NOT be present
    expect((result as any).description).toBeUndefined();
    expect((result as any).llm_config).toBeUndefined();
    expect((result as any).system_prompt).toBeUndefined();
    expect((result as any).tools).toBeUndefined();
  });

  it('maps all lettabot fields correctly', () => {
    const fleet = {
      agents: [
        {
          name: 'FullBot',
          llm_config: { model: 'gpt-4' },
          lettabot: {
            server: { mode: 'api', apiKey: 'sk-test', logLevel: 'debug' },
            displayName: 'Full',
            conversations: { mode: 'per-channel', heartbeat: 'dedicated' },
            channels: {
              slack: { enabled: true, appToken: 'xapp-1', botToken: 'xoxb-1' },
            },
            features: {
              heartbeat: { enabled: true, intervalMin: 15 },
              maxToolCalls: 50,
              display: { showToolCalls: true },
            },
            providers: [{ id: 'anthropic', name: 'anthropic', type: 'anthropic', apiKey: 'sk-ant' }],
            polling: { gmail: { enabled: true, account: 'user@gmail.com' } },
            transcription: { provider: 'openai', apiKey: 'sk-oai' },
            attachments: { maxMB: 10, maxAgeDays: 7 },
          },
        },
      ],
    };

    const result = fleetConfigToLettaBotConfig(fleet);

    expect(result.server.apiKey).toBe('sk-test');
    expect(result.server.logLevel).toBe('debug');
    expect(result.conversations?.mode).toBe('per-channel');
    expect(result.conversations?.heartbeat).toBe('dedicated');
    expect(result.channels.slack?.appToken).toBe('xapp-1');
    expect(result.features?.heartbeat?.intervalMin).toBe(15);
    expect(result.features?.maxToolCalls).toBe(50);
    expect(result.features?.display?.showToolCalls).toBe(true);
    expect(result.providers).toHaveLength(1);
    expect(result.providers![0].apiKey).toBe('sk-ant');
    expect(result.polling?.gmail?.account).toBe('user@gmail.com');
    expect(result.transcription?.provider).toBe('openai');
    expect(result.attachments?.maxMB).toBe(10);
  });

  it('skips agents without lettabot section', () => {
    const fleet = {
      agents: [
        {
          name: 'ServerOnly',
          llm_config: { model: 'gpt-4' },
          system_prompt: { value: 'no lettabot' },
        },
        {
          name: 'WithBot',
          llm_config: { model: 'gpt-4' },
          system_prompt: { value: 'has lettabot' },
          lettabot: {
            channels: { telegram: { enabled: true, token: 'tg' } },
          },
        },
      ],
    };

    const result = fleetConfigToLettaBotConfig(fleet);
    expect(result.agent.name).toBe('WithBot');
    expect(result.channels.telegram?.token).toBe('tg');
    // Should be single-agent format (not multi-agent) since only one qualifies
    expect(result.agents).toBeUndefined();
  });

  it('throws when no agents have lettabot section', () => {
    const fleet = {
      agents: [
        { name: 'Bot1', llm_config: { model: 'gpt-4' } },
        { name: 'Bot2', llm_config: { model: 'gpt-4' } },
      ],
    };

    expect(() => fleetConfigToLettaBotConfig(fleet)).toThrow(
      /No agents in fleet config have a `lettabot:` section/,
    );
  });

  it('defaults to empty channels when lettabot has no channels', () => {
    const fleet = {
      agents: [
        {
          name: 'MinimalBot',
          llm_config: { model: 'gpt-4' },
          lettabot: {
            server: { mode: 'docker', baseUrl: 'http://localhost:8283' },
          },
        },
      ],
    };

    const result = fleetConfigToLettaBotConfig(fleet);
    expect(result.channels).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// fleetConfigToLettaBotConfig — multi-agent
// ---------------------------------------------------------------------------

describe('fleetConfigToLettaBotConfig (multi-agent)', () => {
  it('converts multiple qualifying agents to multi-agent format', () => {
    const fleet = {
      agents: [
        {
          name: 'Bot1',
          llm_config: { model: 'gpt-4' },
          lettabot: {
            server: { mode: 'docker', baseUrl: 'http://localhost:8283' },
            displayName: 'First',
            channels: { telegram: { enabled: true, token: 'tg1' } },
            providers: [{ id: 'oai', name: 'openai', type: 'openai', apiKey: 'sk-1' }],
            transcription: { provider: 'openai' },
            attachments: { maxMB: 5 },
          },
        },
        {
          name: 'Bot2',
          llm_config: { model: 'claude-3' },
          lettabot: {
            displayName: 'Second',
            channels: { slack: { enabled: true, appToken: 'xapp', botToken: 'xoxb' } },
            features: { cron: true },
          },
        },
      ],
    };

    const result = fleetConfigToLettaBotConfig(fleet);

    // Should be multi-agent format
    expect(result.agents).toHaveLength(2);
    expect(result.agents![0].name).toBe('Bot1');
    expect(result.agents![0].displayName).toBe('First');
    expect(result.agents![0].channels.telegram?.token).toBe('tg1');
    expect(result.agents![1].name).toBe('Bot2');
    expect(result.agents![1].displayName).toBe('Second');
    expect(result.agents![1].channels.slack?.appToken).toBe('xapp');
    expect(result.agents![1].features?.cron).toBe(true);

    // System-wide fields promoted from first agent
    expect(result.server.mode).toBe('docker');
    expect(result.server.baseUrl).toBe('http://localhost:8283');
    expect(result.providers).toHaveLength(1);
    expect(result.transcription?.provider).toBe('openai');
    expect(result.attachments?.maxMB).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// wasLoadedFromFleetConfig / setLoadedFromFleetConfig
// ---------------------------------------------------------------------------

describe('wasLoadedFromFleetConfig', () => {
  it('defaults to false', () => {
    setLoadedFromFleetConfig(false);
    expect(wasLoadedFromFleetConfig()).toBe(false);
  });

  it('can be set to true', () => {
    setLoadedFromFleetConfig(true);
    expect(wasLoadedFromFleetConfig()).toBe(true);
    // Clean up
    setLoadedFromFleetConfig(false);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import YAML from 'yaml';
import { saveConfig, loadConfig } from './io.js';
import { normalizeAgents } from './types.js';
import type { LettaBotConfig } from './types.js';

describe('saveConfig with agents[] format', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lettabot-config-test-'));
    configPath = join(tmpDir, 'lettabot.yaml');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should write agents[] config without legacy agent/channels at top level', () => {
    const config = {
      server: { mode: 'cloud' as const, apiKey: 'test-key' },
      agents: [{
        name: 'TestBot',
        id: 'agent-abc123',
        channels: {
          telegram: { enabled: true, token: 'tg-token', dmPolicy: 'pairing' as const },
        },
        features: {
          cron: true,
          heartbeat: { enabled: true, intervalMin: 30 },
        },
      }],
    };

    saveConfig(config, configPath);

    const raw = readFileSync(configPath, 'utf-8');
    const parsed = YAML.parse(raw);

    // Should have agents[] at top level
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.agents[0].name).toBe('TestBot');
    expect(parsed.agents[0].channels.telegram.token).toBe('tg-token');

    // Should NOT have legacy agent/channels at top level
    expect(parsed.agent).toBeUndefined();
    expect(parsed.channels).toBeUndefined();
    expect(parsed.features).toBeUndefined();
  });

  it('should roundtrip agents[] config through save and loadConfig+normalizeAgents', () => {
    const config = {
      server: { mode: 'cloud' as const, apiKey: 'test-key' },
      agents: [{
        name: 'MyBot',
        id: 'agent-xyz',
        channels: {
          telegram: { enabled: true, token: 'tg-123', dmPolicy: 'open' as const },
          whatsapp: { enabled: true, selfChat: true, dmPolicy: 'pairing' as const },
        },
        features: {
          cron: false,
          heartbeat: { enabled: true, intervalMin: 15 },
        },
      }],
      transcription: {
        provider: 'openai' as const,
        apiKey: 'whisper-key',
      },
    };

    saveConfig(config, configPath);

    // loadConfig reads from resolveConfigPath(), so we need to load manually
    // and merge with defaults the same way loadConfig does
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = YAML.parse(raw) as Partial<LettaBotConfig>;
    const loaded: LettaBotConfig = {
      server: { mode: 'cloud', ...parsed.server },
      agent: { name: 'LettaBot', ...parsed.agent },
      channels: { ...parsed.channels },
      ...parsed,
    };

    // normalizeAgents should pick up agents[] and ignore defaults
    const agents = normalizeAgents(loaded);

    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('MyBot');
    expect(agents[0].id).toBe('agent-xyz');
    expect(agents[0].channels.telegram?.token).toBe('tg-123');
    expect(agents[0].channels.whatsapp?.selfChat).toBe(true);
    expect(agents[0].features?.heartbeat?.intervalMin).toBe(15);

    // Global fields should survive
    expect(loaded.transcription?.apiKey).toBe('whisper-key');
  });

  it('should always include agent id in agents[] (onboarding contract)', () => {
    // After onboarding, agent ID should always be present in the config.
    // This test documents the contract: new configs have the ID eagerly set.
    const config = {
      server: { mode: 'cloud' as const, apiKey: 'test-key' },
      agents: [{
        name: 'LettaBot',
        id: 'agent-eagerly-created',
        channels: {
          telegram: { enabled: true, token: 'tg-token' },
        },
        features: { cron: false, heartbeat: { enabled: false } },
      }],
    };

    saveConfig(config, configPath);

    const raw = readFileSync(configPath, 'utf-8');
    const parsed = YAML.parse(raw);

    expect(parsed.agents[0].id).toBe('agent-eagerly-created');
  });

  it('should preserve providers at top level, not inside agents', () => {
    const config = {
      server: { mode: 'cloud' as const, apiKey: 'test-key' },
      agents: [{
        name: 'TestBot',
        channels: {},
        features: { cron: false, heartbeat: { enabled: false } },
      }],
      providers: [{
        id: 'anthropic',
        name: 'anthropic',
        type: 'anthropic',
        apiKey: 'sk-ant-test',
      }],
    };

    saveConfig(config, configPath);

    const raw = readFileSync(configPath, 'utf-8');
    const parsed = YAML.parse(raw);

    expect(parsed.providers).toHaveLength(1);
    expect(parsed.providers[0].name).toBe('anthropic');
    expect(parsed.agents[0].providers).toBeUndefined();
  });
});

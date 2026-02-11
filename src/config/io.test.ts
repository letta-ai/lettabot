import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import YAML from 'yaml';
import { saveConfig, loadConfig, configToEnv, didLoadFail } from './io.js';
import { normalizeAgents, DEFAULT_CONFIG } from './types.js';
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

describe('server.api config (canonical location)', () => {
  it('configToEnv should read port from server.api', () => {
    const config: LettaBotConfig = {
      ...DEFAULT_CONFIG,
      server: {
        mode: 'selfhosted',
        baseUrl: 'http://localhost:6701',
        api: { port: 6702, host: '0.0.0.0', corsOrigin: '*' },
      },
    };

    const env = configToEnv(config);

    expect(env.PORT).toBe('6702');
    expect(env.API_HOST).toBe('0.0.0.0');
    expect(env.API_CORS_ORIGIN).toBe('*');
  });

  it('configToEnv should fall back to top-level api (deprecated)', () => {
    const config: LettaBotConfig = {
      ...DEFAULT_CONFIG,
      server: { mode: 'selfhosted', baseUrl: 'http://localhost:6701' },
      api: { port: 8081 },
    };

    const env = configToEnv(config);

    expect(env.PORT).toBe('8081');
  });

  it('server.api should take precedence over top-level api', () => {
    const config: LettaBotConfig = {
      ...DEFAULT_CONFIG,
      server: {
        mode: 'selfhosted',
        baseUrl: 'http://localhost:6701',
        api: { port: 9090 },
      },
      api: { port: 8081 },
    };

    const env = configToEnv(config);

    expect(env.PORT).toBe('9090');
  });

  it('should not set PORT when no api config is present', () => {
    const config: LettaBotConfig = {
      ...DEFAULT_CONFIG,
      server: { mode: 'selfhosted', baseUrl: 'http://localhost:6701' },
    };

    const env = configToEnv(config);

    expect(env.PORT).toBeUndefined();
  });

  it('server.api should survive save/load roundtrip in YAML', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'lettabot-api-test-'));
    const configPath = join(tmpDir, 'lettabot.yaml');

    try {
      const config = {
        server: {
          mode: 'selfhosted' as const,
          baseUrl: 'http://localhost:6701',
          api: { port: 6702, host: '0.0.0.0' },
        },
        agents: [{
          name: 'TestBot',
          channels: {},
        }],
      };

      saveConfig(config, configPath);

      const raw = readFileSync(configPath, 'utf-8');
      const parsed = YAML.parse(raw);

      // server.api should be in the YAML under server
      expect(parsed.server.api).toBeDefined();
      expect(parsed.server.api.port).toBe(6702);
      expect(parsed.server.api.host).toBe('0.0.0.0');

      // Should NOT have top-level api
      expect(parsed.api).toBeUndefined();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('didLoadFail', () => {
  it('should return false initially', () => {
    // loadConfig hasn't been called with a bad file, so it should be false
    // (or whatever state it was left in from previous test)
    // Call loadConfig with a valid env to reset
    const originalEnv = process.env.LETTABOT_CONFIG;
    const tmpDir = mkdtempSync(join(tmpdir(), 'lettabot-fail-test-'));
    const configPath = join(tmpDir, 'lettabot.yaml');

    try {
      writeFileSync(configPath, 'server:\n  mode: cloud\n', 'utf-8');
      process.env.LETTABOT_CONFIG = configPath;
      loadConfig();
      expect(didLoadFail()).toBe(false);
    } finally {
      process.env.LETTABOT_CONFIG = originalEnv;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should return true after a parse error', () => {
    const originalEnv = process.env.LETTABOT_CONFIG;
    const tmpDir = mkdtempSync(join(tmpdir(), 'lettabot-fail-test-'));
    const configPath = join(tmpDir, 'lettabot.yaml');

    try {
      // Write invalid YAML
      writeFileSync(configPath, 'server:\n  api: port: 6702\n', 'utf-8');
      process.env.LETTABOT_CONFIG = configPath;

      // Suppress console output during test
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const config = loadConfig();

      expect(didLoadFail()).toBe(true);
      // Should return default config on failure
      expect(config.server.mode).toBe(DEFAULT_CONFIG.server.mode);

      errorSpy.mockRestore();
      warnSpy.mockRestore();
    } finally {
      process.env.LETTABOT_CONFIG = originalEnv;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should reset to false on successful load after a failure', () => {
    const originalEnv = process.env.LETTABOT_CONFIG;
    const tmpDir = mkdtempSync(join(tmpdir(), 'lettabot-fail-test-'));
    const badPath = join(tmpDir, 'bad.yaml');
    const goodPath = join(tmpDir, 'good.yaml');

    try {
      // First: load bad file
      writeFileSync(badPath, 'server:\n  api: port: 6702\n', 'utf-8');
      process.env.LETTABOT_CONFIG = badPath;
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      loadConfig();
      expect(didLoadFail()).toBe(true);
      errorSpy.mockRestore();
      warnSpy.mockRestore();

      // Then: load good file
      writeFileSync(goodPath, 'server:\n  mode: selfhosted\n  baseUrl: http://localhost:6701\n', 'utf-8');
      process.env.LETTABOT_CONFIG = goodPath;
      loadConfig();
      expect(didLoadFail()).toBe(false);
    } finally {
      process.env.LETTABOT_CONFIG = originalEnv;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('loadConfig deprecation warning for top-level api', () => {
  it('should warn when top-level api is present without server.api', () => {
    const originalEnv = process.env.LETTABOT_CONFIG;
    const tmpDir = mkdtempSync(join(tmpdir(), 'lettabot-deprecation-test-'));
    const configPath = join(tmpDir, 'lettabot.yaml');

    try {
      writeFileSync(configPath, 'server:\n  mode: cloud\napi:\n  port: 9090\n', 'utf-8');
      process.env.LETTABOT_CONFIG = configPath;

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const config = loadConfig();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Top-level `api:` is deprecated')
      );
      // The top-level api should still be loaded
      expect(config.api?.port).toBe(9090);

      warnSpy.mockRestore();
    } finally {
      process.env.LETTABOT_CONFIG = originalEnv;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should not warn when server.api is used (canonical location)', () => {
    const originalEnv = process.env.LETTABOT_CONFIG;
    const tmpDir = mkdtempSync(join(tmpdir(), 'lettabot-deprecation-test-'));
    const configPath = join(tmpDir, 'lettabot.yaml');

    try {
      writeFileSync(configPath, 'server:\n  mode: selfhosted\n  baseUrl: http://localhost:6701\n  api:\n    port: 6702\n', 'utf-8');
      process.env.LETTABOT_CONFIG = configPath;

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const config = loadConfig();

      // Should NOT have deprecated warning
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Top-level `api:` is deprecated')
      );
      // server.api should be loaded
      expect(config.server.api?.port).toBe(6702);
      // top-level api should be undefined
      expect(config.api).toBeUndefined();

      warnSpy.mockRestore();
    } finally {
      process.env.LETTABOT_CONFIG = originalEnv;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

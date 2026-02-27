import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock the logger so log.warn/error route through console (tests spy on console)
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

import { loadAppConfigOrExit } from './runtime.js';
import { didLoadFail } from './io.js';

describe('loadAppConfigOrExit', () => {
  it('should load valid config without exiting', () => {
    const originalEnv = process.env.LETTABOT_CONFIG;
    const tmpDir = mkdtempSync(join(tmpdir(), 'lettabot-runtime-test-'));
    const configPath = join(tmpDir, 'lettabot.yaml');

    try {
      writeFileSync(configPath, 'server:\n  mode: api\n', 'utf-8');
      process.env.LETTABOT_CONFIG = configPath;

      const config = loadAppConfigOrExit(((code: number): never => {
        throw new Error(`unexpected-exit:${code}`);
      }));

      expect(config.server.mode).toBe('api');
      expect(didLoadFail()).toBe(false);
    } finally {
      process.env.LETTABOT_CONFIG = originalEnv;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should log and exit on invalid config', () => {
    const originalEnv = process.env.LETTABOT_CONFIG;
    const tmpDir = mkdtempSync(join(tmpdir(), 'lettabot-runtime-test-'));
    const configPath = join(tmpDir, 'lettabot.yaml');

    try {
      writeFileSync(configPath, 'server:\n  api: port: 6702\n', 'utf-8');
      process.env.LETTABOT_CONFIG = configPath;

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exit = (code: number): never => {
        throw new Error(`exit:${code}`);
      };

      expect(() => loadAppConfigOrExit(exit)).toThrow('exit:1');
      expect(didLoadFail()).toBe(true);
      expect(errorSpy).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('Failed to load'),
        expect.anything()
      );
      expect(errorSpy).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('Fix the errors above')
      );

      errorSpy.mockRestore();
    } finally {
      process.env.LETTABOT_CONFIG = originalEnv;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should mention LETTABOT_CONFIG_YAML when inline config is invalid', () => {
    const originalInline = process.env.LETTABOT_CONFIG_YAML;
    const originalPath = process.env.LETTABOT_CONFIG;

    try {
      process.env.LETTABOT_CONFIG_YAML = 'server:\n  api: port: 6702\n';
      delete process.env.LETTABOT_CONFIG;

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exit = (code: number): never => {
        throw new Error(`exit:${code}`);
      };

      expect(() => loadAppConfigOrExit(exit)).toThrow('exit:1');
      expect(errorSpy).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('Failed to load LETTABOT_CONFIG_YAML'),
        expect.anything()
      );
      expect(errorSpy).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('Fix the errors above in LETTABOT_CONFIG_YAML')
      );

      errorSpy.mockRestore();
    } finally {
      process.env.LETTABOT_CONFIG_YAML = originalInline;
      process.env.LETTABOT_CONFIG = originalPath;
    }
  });
});

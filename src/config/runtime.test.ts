import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  getCronDataDir,
  getCronLogPath,
  getCronStorePath,
  getLegacyCronStorePath,
  getWorkingDir,
  resolveWorkingDirPath,
} from './paths.js';

const TEST_ENV_KEYS = [
  'RAILWAY_VOLUME_MOUNT_PATH',
  'DATA_DIR',
  'WORKING_DIR',
] as const;

const ORIGINAL_ENV: Record<(typeof TEST_ENV_KEYS)[number], string | undefined> = {
  RAILWAY_VOLUME_MOUNT_PATH: process.env.RAILWAY_VOLUME_MOUNT_PATH,
  DATA_DIR: process.env.DATA_DIR,
  WORKING_DIR: process.env.WORKING_DIR,
};

function clearPathEnv(): void {
  for (const key of TEST_ENV_KEYS) {
    delete process.env[key];
  }
}

describe('cron path resolution', () => {
  beforeEach(() => {
    clearPathEnv();
  });

  afterEach(() => {
    clearPathEnv();
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }
  });

  it('prioritizes Railway volume path', () => {
    process.env.RAILWAY_VOLUME_MOUNT_PATH = '/railway/volume';
    process.env.DATA_DIR = '/custom/data';
    process.env.WORKING_DIR = '/custom/work';

    expect(getCronDataDir()).toBe('/railway/volume');
  });

  it('uses DATA_DIR when Railway volume is not set', () => {
    process.env.DATA_DIR = '/custom/data';
    process.env.WORKING_DIR = '/custom/work';

    expect(getCronDataDir()).toBe('/custom/data');
  });

  it('uses WORKING_DIR when DATA_DIR is not set', () => {
    process.env.WORKING_DIR = '/custom/work';

    expect(getCronDataDir()).toBe('/custom/work');
  });

  it('falls back to /tmp/lettabot when no overrides are set', () => {
    expect(getCronDataDir()).toBe('/tmp/lettabot');
    expect(getCronStorePath()).toBe('/tmp/lettabot/cron-jobs.json');
    expect(getCronLogPath()).toBe('/tmp/lettabot/cron-log.jsonl');
  });

  it('keeps legacy cron path behavior for migration', () => {
    expect(getLegacyCronStorePath()).toBe(resolve(process.cwd(), 'cron-jobs.json'));
  });
});

describe('working directory path resolution', () => {
  beforeEach(() => {
    clearPathEnv();
  });

  afterEach(() => {
    clearPathEnv();
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }
  });

  it('expands ~ in configured WORKING_DIR', () => {
    process.env.WORKING_DIR = '~/lettabot-work';
    expect(getWorkingDir()).toBe(resolve(homedir(), 'lettabot-work'));
  });

  it('resolves relative WORKING_DIR to absolute path', () => {
    process.env.WORKING_DIR = 'tmp/lettabot';
    expect(getWorkingDir()).toBe(resolve('tmp/lettabot'));
  });

  it('expands ~ for per-agent workingDir values', () => {
    expect(resolveWorkingDirPath('~/agent-work')).toBe(resolve(homedir(), 'agent-work'));
  });
});

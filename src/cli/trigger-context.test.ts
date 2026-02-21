import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveTriggerContext } from './trigger-context.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
  vi.restoreAllMocks();
});

describe('resolveTriggerContext', () => {
  it('returns undefined when no trigger inputs are provided', () => {
    const result = resolveTriggerContext({});
    expect(result).toBeUndefined();
  });

  it('builds trigger context from explicit inputs', () => {
    const result = resolveTriggerContext({
      channel: 'slack',
      chatId: 'C123',
      triggerType: 'cron',
      outputMode: 'silent',
      jobId: 'job-1',
      jobName: 'Daily Digest',
    });

    expect(result).toEqual({
      type: 'cron',
      outputMode: 'silent',
      sourceChannel: 'slack',
      sourceChatId: 'C123',
      jobId: 'job-1',
      jobName: 'Daily Digest',
      notifyTarget: { channel: 'slack', chatId: 'C123' },
    });
  });

  it('defaults to webhook when output mode is provided without trigger type', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = resolveTriggerContext({
      channel: 'telegram',
      chatId: '123',
      outputMode: 'responsive',
    });

    expect(result).toEqual({
      type: 'webhook',
      outputMode: 'responsive',
      sourceChannel: 'telegram',
      sourceChatId: '123',
      notifyTarget: { channel: 'telegram', chatId: '123' },
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('uses environment variables when provided', () => {
    process.env.LETTABOT_TRIGGER_TYPE = 'feed';
    process.env.LETTABOT_TRIGGER_OUTPUT_MODE = 'silent';
    process.env.LETTABOT_TRIGGER_JOB_ID = 'env-job';
    process.env.LETTABOT_TRIGGER_JOB_NAME = 'Env Job';

    const result = resolveTriggerContext({ channel: 'discord', chatId: '456' });

    expect(result).toEqual({
      type: 'feed',
      outputMode: 'silent',
      sourceChannel: 'discord',
      sourceChatId: '456',
      jobId: 'env-job',
      jobName: 'Env Job',
      notifyTarget: { channel: 'discord', chatId: '456' },
    });
  });

  it('throws on invalid trigger type', () => {
    expect(() => resolveTriggerContext({ triggerType: 'bad' }))
      .toThrow('Invalid --trigger value');
  });
});

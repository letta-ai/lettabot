import { describe, expect, it } from 'vitest';

import { resolveSessionMemfs } from './memfs.js';

describe('resolveSessionMemfs', () => {
  it('uses explicit agent config first', () => {
    const result = resolveSessionMemfs({
      configuredMemfs: true,
      envMemfs: 'false',
      serverMode: 'api',
    });

    expect(result).toEqual({ value: true, source: 'config' });
  });

  it('uses LETTABOT_MEMFS env override when config is unset', () => {
    const result = resolveSessionMemfs({
      envMemfs: 'false',
      serverMode: 'api',
    });

    expect(result).toEqual({ value: false, source: 'env' });
  });

  it('defaults to memfs false in docker/selfhosted mode when unset', () => {
    const result = resolveSessionMemfs({
      serverMode: 'selfhosted',
    });

    expect(result).toEqual({ value: false, source: 'default-docker' });
  });

  it('leaves memfs unchanged in api/cloud mode when unset', () => {
    const result = resolveSessionMemfs({
      serverMode: 'cloud',
    });

    expect(result).toEqual({ value: undefined, source: 'unset' });
  });

  it('ignores invalid LETTABOT_MEMFS values', () => {
    const result = resolveSessionMemfs({
      envMemfs: 'yes',
      serverMode: 'api',
    });

    expect(result).toEqual({ value: undefined, source: 'unset' });
  });

  it('treats null configured memfs as unset and applies docker default', () => {
    const result = resolveSessionMemfs({
      configuredMemfs: null as unknown as boolean,
      serverMode: 'selfhosted',
    });

    expect(result).toEqual({ value: false, source: 'default-docker' });
  });
});

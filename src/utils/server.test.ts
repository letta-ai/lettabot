import { describe, it, expect } from 'vitest';
import { isLettaCloudUrl } from './server.js';

describe('isLettaCloudUrl', () => {
  it('returns true for undefined (default is cloud)', () => {
    expect(isLettaCloudUrl(undefined)).toBe(true);
  });

  it('returns true for Letta Cloud URL', () => {
    expect(isLettaCloudUrl('https://api.letta.com')).toBe(true);
  });

  it('returns true for Letta Cloud URL with trailing slash', () => {
    expect(isLettaCloudUrl('https://api.letta.com/')).toBe(true);
  });

  it('returns true for Letta Cloud URL with path', () => {
    expect(isLettaCloudUrl('https://api.letta.com/v1/agents')).toBe(true);
  });

  it('returns false for localhost', () => {
    expect(isLettaCloudUrl('http://localhost:8283')).toBe(false);
  });

  it('returns false for 127.0.0.1', () => {
    expect(isLettaCloudUrl('http://127.0.0.1:8283')).toBe(false);
  });

  it('returns false for custom server', () => {
    expect(isLettaCloudUrl('https://custom.server.com')).toBe(false);
  });

  it('returns false for docker network URL', () => {
    expect(isLettaCloudUrl('http://letta:8283')).toBe(false);
  });

  it('returns false for invalid URL', () => {
    expect(isLettaCloudUrl('not-a-url')).toBe(false);
  });

  it('returns true for empty string (treated as default)', () => {
    // Empty string is falsy, so it's treated like undefined (default to cloud)
    expect(isLettaCloudUrl('')).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import { isLettaApiUrl, isLettaCloudUrl } from './server.js';

describe('isLettaApiUrl', () => {
  it('returns true for undefined (default is Letta API)', () => {
    expect(isLettaApiUrl(undefined)).toBe(true);
  });

  it('returns true for Letta API URL', () => {
    expect(isLettaApiUrl('https://api.letta.com')).toBe(true);
  });

  it('returns true for Letta API URL with trailing slash', () => {
    expect(isLettaApiUrl('https://api.letta.com/')).toBe(true);
  });

  it('returns true for Letta API URL with path', () => {
    expect(isLettaApiUrl('https://api.letta.com/v1/agents')).toBe(true);
  });

  it('returns false for localhost', () => {
    expect(isLettaApiUrl('http://localhost:8283')).toBe(false);
  });

  it('returns false for 127.0.0.1', () => {
    expect(isLettaApiUrl('http://127.0.0.1:8283')).toBe(false);
  });

  it('returns false for custom server', () => {
    expect(isLettaApiUrl('https://custom.server.com')).toBe(false);
  });

  it('returns false for docker network URL', () => {
    expect(isLettaApiUrl('http://letta:8283')).toBe(false);
  });

  it('returns false for invalid URL', () => {
    expect(isLettaApiUrl('not-a-url')).toBe(false);
  });

  it('returns true for empty string (treated as default)', () => {
    // Empty string is falsy, so it's treated like undefined (default to Letta API)
    expect(isLettaApiUrl('')).toBe(true);
  });

  it('keeps backward-compatible alias behavior', () => {
    expect(isLettaCloudUrl('https://api.letta.com')).toBe(true);
    expect(isLettaCloudUrl('http://localhost:8283')).toBe(false);
  });
});

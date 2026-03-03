import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseGmailAccounts, resolveEmailPrompt } from './service.js';

describe('parseGmailAccounts', () => {
  it('returns empty array for undefined', () => {
    expect(parseGmailAccounts(undefined)).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parseGmailAccounts('')).toEqual([]);
  });

  it('parses single account string', () => {
    expect(parseGmailAccounts('user@gmail.com')).toEqual([{ account: 'user@gmail.com' }]);
  });

  it('parses comma-separated string', () => {
    expect(parseGmailAccounts('a@gmail.com,b@gmail.com')).toEqual([
      { account: 'a@gmail.com' },
      { account: 'b@gmail.com' },
    ]);
  });

  it('trims whitespace', () => {
    expect(parseGmailAccounts('  a@gmail.com , b@gmail.com  ')).toEqual([
      { account: 'a@gmail.com' },
      { account: 'b@gmail.com' },
    ]);
  });

  it('deduplicates accounts', () => {
    expect(parseGmailAccounts('a@gmail.com,a@gmail.com,b@gmail.com')).toEqual([
      { account: 'a@gmail.com' },
      { account: 'b@gmail.com' },
    ]);
  });

  it('skips empty segments', () => {
    expect(parseGmailAccounts('a@gmail.com,,b@gmail.com,')).toEqual([
      { account: 'a@gmail.com' },
      { account: 'b@gmail.com' },
    ]);
  });

  it('accepts string array', () => {
    expect(parseGmailAccounts(['a@gmail.com', 'b@gmail.com'])).toEqual([
      { account: 'a@gmail.com' },
      { account: 'b@gmail.com' },
    ]);
  });

  it('deduplicates string array', () => {
    expect(parseGmailAccounts(['a@gmail.com', 'a@gmail.com'])).toEqual([{ account: 'a@gmail.com' }]);
  });

  it('trims string array values', () => {
    expect(parseGmailAccounts([' a@gmail.com ', ' b@gmail.com '])).toEqual([
      { account: 'a@gmail.com' },
      { account: 'b@gmail.com' },
    ]);
  });

  it('accepts GmailAccountConfig array', () => {
    expect(parseGmailAccounts([
      { account: 'a@gmail.com', prompt: 'Check urgent emails' },
      { account: 'b@gmail.com' },
    ])).toEqual([
      { account: 'a@gmail.com', prompt: 'Check urgent emails' },
      { account: 'b@gmail.com' },
    ]);
  });

  it('accepts mixed array of strings and config objects', () => {
    expect(parseGmailAccounts([
      'a@gmail.com',
      { account: 'b@gmail.com', prompt: 'Only important' },
    ])).toEqual([
      { account: 'a@gmail.com' },
      { account: 'b@gmail.com', prompt: 'Only important' },
    ]);
  });

  it('deduplicates mixed array by account', () => {
    expect(parseGmailAccounts([
      'a@gmail.com',
      { account: 'a@gmail.com', prompt: 'Override' },
    ])).toEqual([
      { account: 'a@gmail.com' },  // First one wins
    ]);
  });
});

describe('resolveEmailPrompt', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined when no prompts configured', () => {
    expect(resolveEmailPrompt({ account: 'a@gmail.com' })).toBeUndefined();
  });

  it('returns account-specific inline prompt', () => {
    expect(resolveEmailPrompt(
      { account: 'a@gmail.com', prompt: 'Check urgent' },
      'global prompt',
    )).toBe('Check urgent');
  });

  it('reads account-specific promptFile', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'poll-test-'));
    writeFileSync(join(tmpDir, 'acct.txt'), '  File prompt content  ');
    expect(resolveEmailPrompt(
      { account: 'a@gmail.com', promptFile: 'acct.txt' },
      undefined, undefined, tmpDir,
    )).toBe('File prompt content');
  });

  it('account inline prompt wins over account promptFile', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'poll-test-'));
    writeFileSync(join(tmpDir, 'acct.txt'), 'from file');
    expect(resolveEmailPrompt(
      { account: 'a@gmail.com', prompt: 'inline wins', promptFile: 'acct.txt' },
      undefined, undefined, tmpDir,
    )).toBe('inline wins');
  });

  it('falls back to global prompt when account has none', () => {
    expect(resolveEmailPrompt(
      { account: 'a@gmail.com' },
      'global prompt',
    )).toBe('global prompt');
  });

  it('falls back to global promptFile', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'poll-test-'));
    writeFileSync(join(tmpDir, 'global.txt'), 'global file content');
    expect(resolveEmailPrompt(
      { account: 'a@gmail.com' },
      undefined, 'global.txt', tmpDir,
    )).toBe('global file content');
  });

  it('global inline prompt wins over global promptFile', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'poll-test-'));
    writeFileSync(join(tmpDir, 'global.txt'), 'from file');
    expect(resolveEmailPrompt(
      { account: 'a@gmail.com' },
      'global inline', 'global.txt', tmpDir,
    )).toBe('global inline');
  });

  it('falls through gracefully when account promptFile is missing', () => {
    expect(resolveEmailPrompt(
      { account: 'a@gmail.com', promptFile: 'nonexistent.txt' },
      'fallback global',
      undefined, '/tmp',
    )).toBe('fallback global');
  });

  it('falls through gracefully when global promptFile is missing', () => {
    expect(resolveEmailPrompt(
      { account: 'a@gmail.com' },
      undefined, 'nonexistent.txt', '/tmp',
    )).toBeUndefined();
  });
});

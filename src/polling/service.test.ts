import { describe, it, expect } from 'vitest';
import { parseGmailAccounts } from './service.js';

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

import { describe, it, expect } from 'vitest';
import { normalizePhoneForStorage, isSameContact } from './phone.js';

describe('normalizePhoneForStorage', () => {
  it('strips WhatsApp DM suffix', () => {
    expect(normalizePhoneForStorage('12345678901@s.whatsapp.net')).toBe('+12345678901');
  });

  it('strips WhatsApp group suffix', () => {
    expect(normalizePhoneForStorage('12345678901@g.us')).toBe('+12345678901');
  });

  it('strips LID suffix', () => {
    expect(normalizePhoneForStorage('12345678901@lid')).toBe('+12345678901');
  });

  it('strips port suffix', () => {
    expect(normalizePhoneForStorage('12345678901:2')).toBe('+12345678901');
  });

  it('adds + prefix to raw numbers', () => {
    expect(normalizePhoneForStorage('12345678901')).toBe('+12345678901');
  });

  it('preserves existing + prefix', () => {
    expect(normalizePhoneForStorage('+12345678901')).toBe('+12345678901');
  });

  it('handles combined suffixes', () => {
    expect(normalizePhoneForStorage('12345678901@lid:2')).toBe('+12345678901');
  });

  it('trims whitespace', () => {
    expect(normalizePhoneForStorage('  12345678901  ')).toBe('+12345678901');
  });
});

describe('isSameContact', () => {
  it('returns true for same number with different formats', () => {
    expect(isSameContact('123@lid', '+123')).toBe(true);
    expect(isSameContact('123@s.whatsapp.net', '123')).toBe(true);
  });

  it('returns false for different numbers', () => {
    expect(isSameContact('123', '456')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { parseCsvList, parseNonNegativeNumber, parseOptionalInt } from './parse.js';

describe('parseCsvList', () => {
  it('splits and trims comma-separated values', () => {
    expect(parseCsvList('one, two,three')).toEqual(['one', 'two', 'three']);
  });

  it('drops empty entries', () => {
    expect(parseCsvList('one,, ,two,')).toEqual(['one', 'two']);
  });
});

describe('parseOptionalInt', () => {
  it('returns undefined for missing values', () => {
    expect(parseOptionalInt()).toBeUndefined();
    expect(parseOptionalInt('')).toBeUndefined();
  });

  it('parses valid integer prefixes', () => {
    expect(parseOptionalInt('42')).toBe(42);
    expect(parseOptionalInt('42px')).toBe(42);
  });

  it('returns undefined for invalid values', () => {
    expect(parseOptionalInt('nope')).toBeUndefined();
  });
});

describe('parseNonNegativeNumber', () => {
  it('returns undefined for missing, invalid, or negative values', () => {
    expect(parseNonNegativeNumber()).toBeUndefined();
    expect(parseNonNegativeNumber('nope')).toBeUndefined();
    expect(parseNonNegativeNumber('-1')).toBeUndefined();
  });

  it('parses zero and positive numbers', () => {
    expect(parseNonNegativeNumber('0')).toBe(0);
    expect(parseNonNegativeNumber('1.5')).toBe(1.5);
  });
});

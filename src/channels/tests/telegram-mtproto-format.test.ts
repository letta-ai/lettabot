/**
 * Tests for telegram-mtproto-format.ts
 *
 * CRITICAL: These tests verify UTF-16 offset calculations.
 * TDLib uses UTF-16 code units, and emoji/surrogate pairs take 2 units.
 */

import { describe, it, expect } from 'vitest';
import {
  markdownToTdlib,
  plainToTdlib,
  utf16Length,
  TdlibFormattedText
} from '../telegram-mtproto-format.js';

describe('utf16Length', () => {
  it('returns correct length for ASCII text', () => {
    expect(utf16Length('hello')).toBe(5);
    expect(utf16Length('')).toBe(0);
    expect(utf16Length('a')).toBe(1);
  });

  it('returns correct length for basic emoji (BMP)', () => {
    // Most common emoji are actually outside BMP
    expect(utf16Length('☺')).toBe(1); // U+263A is in BMP
  });

  it('returns correct length for emoji with surrogate pairs', () => {
    // 👋 U+1F44B is outside BMP, takes 2 UTF-16 code units
    expect(utf16Length('👋')).toBe(2);
    expect(utf16Length('Hello 👋')).toBe(8); // 6 + 2
    expect(utf16Length('👋👋')).toBe(4);     // 2 + 2
  });

  it('returns correct length for complex emoji sequences', () => {
    // 👨‍👩‍👧 family emoji (multiple code points joined with ZWJ)
    const family = '👨‍👩‍👧';
    expect(utf16Length(family)).toBe(8); // Each person is 2, ZWJ is 1 each
  });

  it('returns correct length for mixed content', () => {
    expect(utf16Length('Hi 👋 there!')).toBe(12); // 3 + 2 + 7
  });
});

describe('plainToTdlib', () => {
  it('creates formattedText with no entities', () => {
    const result = plainToTdlib('Hello world');
    expect(result._).toBe('formattedText');
    expect(result.text).toBe('Hello world');
    expect(result.entities).toEqual([]);
  });

  it('handles empty string', () => {
    const result = plainToTdlib('');
    expect(result.text).toBe('');
    expect(result.entities).toEqual([]);
  });
});

describe('markdownToTdlib', () => {
  describe('plain text', () => {
    it('passes through plain text unchanged', () => {
      const result = markdownToTdlib('Hello world');
      expect(result.text).toBe('Hello world');
      expect(result.entities).toEqual([]);
    });

    it('handles empty string', () => {
      const result = markdownToTdlib('');
      expect(result.text).toBe('');
      expect(result.entities).toEqual([]);
    });
  });

  describe('bold formatting', () => {
    it('handles **bold** syntax', () => {
      const result = markdownToTdlib('Hello **world**');
      expect(result.text).toBe('Hello world');
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0]).toEqual({
        _: 'textEntity',
        offset: 6,
        length: 5,
        type: { _: 'textEntityTypeBold' }
      });
    });

    it('handles __bold__ syntax', () => {
      const result = markdownToTdlib('Hello __world__');
      expect(result.text).toBe('Hello world');
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].type._).toBe('textEntityTypeBold');
    });

    it('handles bold with emoji', () => {
      const result = markdownToTdlib('Hello **👋 wave**');
      expect(result.text).toBe('Hello 👋 wave');
      expect(result.entities[0].offset).toBe(6);
      expect(result.entities[0].length).toBe(7); // 2 (emoji) + 5 (space + wave)
    });
  });

  describe('italic formatting', () => {
    it('handles *italic* syntax', () => {
      const result = markdownToTdlib('Hello *world*');
      expect(result.text).toBe('Hello world');
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0]).toEqual({
        _: 'textEntity',
        offset: 6,
        length: 5,
        type: { _: 'textEntityTypeItalic' }
      });
    });

    it('handles _italic_ syntax', () => {
      const result = markdownToTdlib('Hello _world_');
      expect(result.text).toBe('Hello world');
      expect(result.entities[0].type._).toBe('textEntityTypeItalic');
    });
  });

  describe('code formatting', () => {
    it('handles `inline code`', () => {
      const result = markdownToTdlib('Use `npm install`');
      expect(result.text).toBe('Use npm install');
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0]).toEqual({
        _: 'textEntity',
        offset: 4,
        length: 11,
        type: { _: 'textEntityTypeCode' }
      });
    });

    it('handles code blocks without language', () => {
      const result = markdownToTdlib('```\nconst x = 1;\n```');
      expect(result.text).toBe('const x = 1;\n');
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].type).toEqual({ _: 'textEntityTypePre' });
    });

    it('handles code blocks with language', () => {
      const result = markdownToTdlib('```typescript\nconst x: number = 1;\n```');
      expect(result.text).toBe('const x: number = 1;\n');
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].type).toEqual({
        _: 'textEntityTypePre',
        language: 'typescript'
      });
    });
  });

  describe('strikethrough formatting', () => {
    it('handles ~~strikethrough~~', () => {
      const result = markdownToTdlib('This is ~~deleted~~ text');
      expect(result.text).toBe('This is deleted text');
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0]).toEqual({
        _: 'textEntity',
        offset: 8,
        length: 7,
        type: { _: 'textEntityTypeStrikethrough' }
      });
    });
  });

  describe('multiple entities', () => {
    it('handles multiple formatting types', () => {
      const result = markdownToTdlib('**bold** and *italic*');
      expect(result.text).toBe('bold and italic');
      expect(result.entities).toHaveLength(2);
      expect(result.entities[0].type._).toBe('textEntityTypeBold');
      expect(result.entities[1].type._).toBe('textEntityTypeItalic');
    });

    it('calculates correct offsets for sequential entities', () => {
      const result = markdownToTdlib('**A** **B** **C**');
      expect(result.text).toBe('A B C');
      expect(result.entities).toHaveLength(3);
      expect(result.entities[0].offset).toBe(0); // A
      expect(result.entities[1].offset).toBe(2); // B
      expect(result.entities[2].offset).toBe(4); // C
    });
  });

  describe('UTF-16 offset edge cases', () => {
    it('calculates correct offset after emoji', () => {
      // "👋 **bold**" - emoji takes 2 units, space is 1
      const result = markdownToTdlib('👋 **bold**');
      expect(result.text).toBe('👋 bold');
      expect(result.entities[0].offset).toBe(3); // 2 (emoji) + 1 (space)
      expect(result.entities[0].length).toBe(4);
    });

    it('handles emoji inside formatted text', () => {
      const result = markdownToTdlib('**Hello 👋 World**');
      expect(result.text).toBe('Hello 👋 World');
      expect(result.entities[0].offset).toBe(0);
      expect(result.entities[0].length).toBe(14); // 6 + 2 + 6
    });

    it('handles multiple emoji', () => {
      const result = markdownToTdlib('👋👋 **test** 👋');
      expect(result.text).toBe('👋👋 test 👋');
      // Offset: 4 (two emoji) + 1 (space) = 5
      expect(result.entities[0].offset).toBe(5);
      expect(result.entities[0].length).toBe(4);
    });

    it('handles flag emoji (multi-codepoint)', () => {
      // 🇺🇸 is two regional indicator symbols
      const flag = '🇺🇸';
      expect(utf16Length(flag)).toBe(4); // Each regional indicator is 2 units

      const result = markdownToTdlib(`${flag} **USA**`);
      expect(result.text).toBe('🇺🇸 USA');
      expect(result.entities[0].offset).toBe(5); // 4 (flag) + 1 (space)
    });
  });

  describe('unclosed formatting', () => {
    it('treats unclosed ** as literal', () => {
      const result = markdownToTdlib('Hello **world');
      expect(result.text).toBe('Hello **world');
      expect(result.entities).toEqual([]);
    });

    it('treats unclosed ` as literal', () => {
      const result = markdownToTdlib('Hello `world');
      expect(result.text).toBe('Hello `world');
      expect(result.entities).toEqual([]);
    });

    it('treats unclosed ``` as literal', () => {
      const result = markdownToTdlib('```code without close');
      expect(result.text).toBe('```code without close');
      expect(result.entities).toEqual([]);
    });
  });
});

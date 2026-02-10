import { describe, it, expect } from 'vitest';
import { parseDirectives, stripActionsBlock } from './directives.js';

describe('parseDirectives', () => {
  it('returns text unchanged when no actions block present', () => {
    const result = parseDirectives('Hello world');
    expect(result.cleanText).toBe('Hello world');
    expect(result.directives).toEqual([]);
  });

  it('parses a single react directive in actions block', () => {
    const result = parseDirectives('<actions>\n  <react emoji="eyes" />\n</actions>');
    expect(result.cleanText).toBe('');
    expect(result.directives).toEqual([{ type: 'react', emoji: 'eyes' }]);
  });

  it('parses react directive with escaped quotes', () => {
    const result = parseDirectives('<actions><react emoji=\\"thumbsup\\" /></actions>');
    expect(result.cleanText).toBe('');
    expect(result.directives).toEqual([{ type: 'react', emoji: 'thumbsup' }]);
  });

  it('parses react directive with single-quoted attributes', () => {
    const result = parseDirectives("<actions><react emoji='thumbsup' /></actions>");
    expect(result.cleanText).toBe('');
    expect(result.directives).toEqual([{ type: 'react', emoji: 'thumbsup' }]);
  });

  it('parses react directive with unicode emoji', () => {
    const result = parseDirectives('<actions><react emoji="👀" /></actions>');
    expect(result.cleanText).toBe('');
    expect(result.directives).toEqual([{ type: 'react', emoji: '👀' }]);
  });

  it('extracts text after actions block', () => {
    const result = parseDirectives('<actions>\n  <react emoji="thumbsup" />\n</actions>\nGreat idea!');
    expect(result.cleanText).toBe('Great idea!');
    expect(result.directives).toEqual([{ type: 'react', emoji: 'thumbsup' }]);
  });

  it('handles multiline text after actions block', () => {
    const result = parseDirectives('<actions><react emoji="fire" /></actions>\nLine 1\nLine 2');
    expect(result.cleanText).toBe('Line 1\nLine 2');
    expect(result.directives).toEqual([{ type: 'react', emoji: 'fire' }]);
  });

  it('parses multiple directives in one actions block', () => {
    const input = '<actions>\n  <react emoji="fire" />\n  <react emoji="thumbsup" />\n</actions>\nNice!';
    const result = parseDirectives(input);
    expect(result.cleanText).toBe('Nice!');
    expect(result.directives).toHaveLength(2);
    expect(result.directives[0]).toEqual({ type: 'react', emoji: 'fire' });
    expect(result.directives[1]).toEqual({ type: 'react', emoji: 'thumbsup' });
  });

  it('parses react directive with message attribute', () => {
    const result = parseDirectives('<actions><react emoji="eyes" message="456" /></actions>');
    expect(result.cleanText).toBe('');
    expect(result.directives).toEqual([
      { type: 'react', emoji: 'eyes', messageId: '456' },
    ]);
  });

  it('ignores react directive without emoji attribute', () => {
    const result = parseDirectives('<actions><react message="123" /></actions>');
    expect(result.cleanText).toBe('');
    expect(result.directives).toEqual([]);
  });

  it('ignores actions block NOT at start of response', () => {
    const input = 'Some text first <actions><react emoji="eyes" /></actions>';
    const result = parseDirectives(input);
    expect(result.cleanText).toBe(input);
    expect(result.directives).toEqual([]);
  });

  it('handles leading whitespace before actions block', () => {
    const result = parseDirectives('  \n<actions><react emoji="heart" /></actions>\nHello');
    expect(result.cleanText).toBe('Hello');
    expect(result.directives).toEqual([{ type: 'react', emoji: 'heart' }]);
  });

  it('ignores incomplete/malformed actions block', () => {
    const input = '<actions><react emoji="eyes" />';
    const result = parseDirectives(input);
    expect(result.cleanText).toBe(input);
    expect(result.directives).toEqual([]);
  });

  it('handles actions-only response (no text after)', () => {
    const result = parseDirectives('<actions><react emoji="thumbsup" /></actions>');
    expect(result.cleanText).toBe('');
    expect(result.directives).toHaveLength(1);
  });

  it('preserves non-directive XML-like content in text', () => {
    const input = 'Use <code> tags for formatting';
    const result = parseDirectives(input);
    expect(result.cleanText).toBe(input);
    expect(result.directives).toEqual([]);
  });

  it('handles no-space before self-closing slash in child directives', () => {
    const result = parseDirectives('<actions><react emoji="eyes"/></actions>');
    expect(result.cleanText).toBe('');
    expect(result.directives).toEqual([{ type: 'react', emoji: 'eyes' }]);
  });

  it('ignores unknown child tag names inside actions block', () => {
    const result = parseDirectives('<actions><unknown emoji="test" /></actions>');
    expect(result.cleanText).toBe('');
    expect(result.directives).toEqual([]);
  });
});

describe('stripActionsBlock', () => {
  it('strips a complete actions block', () => {
    expect(stripActionsBlock('<actions><react emoji="eyes" /></actions>\nHello')).toBe('Hello');
  });

  it('returns text unchanged if no actions block', () => {
    expect(stripActionsBlock('Hello world')).toBe('Hello world');
  });

  it('returns empty string for actions-only text', () => {
    expect(stripActionsBlock('<actions><react emoji="eyes" /></actions>')).toBe('');
  });

  it('does not strip actions block in middle of text', () => {
    const input = 'Before <actions><react emoji="eyes" /></actions> After';
    expect(stripActionsBlock(input)).toBe(input);
  });
});

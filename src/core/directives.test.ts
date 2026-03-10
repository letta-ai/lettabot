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

  it('parses send-file directive with path and caption', () => {
    const result = parseDirectives('<actions><send-file path="/tmp/report.pdf" caption="Report" /></actions>');
    expect(result.cleanText).toBe('');
    expect(result.directives).toEqual([
      { type: 'send-file', path: '/tmp/report.pdf', caption: 'Report' },
    ]);
  });

  it('parses send-file directive with file alias and kind', () => {
    const result = parseDirectives('<actions><send-file file="photo.png" kind="image" /></actions>');
    expect(result.cleanText).toBe('');
    expect(result.directives).toEqual([
      { type: 'send-file', path: 'photo.png', kind: 'image' },
    ]);
  });

  it('parses send-file directive with audio kind', () => {
    const result = parseDirectives('<actions><send-file path="voice.ogg" kind="audio" /></actions>');
    expect(result.cleanText).toBe('');
    expect(result.directives).toEqual([
      { type: 'send-file', path: 'voice.ogg', kind: 'audio' },
    ]);
  });

  it('parses send-file directive with cleanup attribute', () => {
    const result = parseDirectives('<actions><send-file path="/tmp/report.pdf" cleanup="true" /></actions>');
    expect(result.cleanText).toBe('');
    expect(result.directives).toEqual([
      { type: 'send-file', path: '/tmp/report.pdf', cleanup: true },
    ]);
  });

  it('omits cleanup when not set to true', () => {
    const result = parseDirectives('<actions><send-file path="/tmp/report.pdf" cleanup="false" /></actions>');
    expect(result.cleanText).toBe('');
    expect(result.directives).toEqual([
      { type: 'send-file', path: '/tmp/report.pdf' },
    ]);
  });

  it('ignores send-file directive without path or file attribute', () => {
    const result = parseDirectives('<actions><send-file caption="Missing" /></actions>');
    expect(result.cleanText).toBe('');
    expect(result.directives).toEqual([]);
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

  it('parses voice directive with text content', () => {
    const result = parseDirectives('<actions><voice>Hello from a voice memo</voice></actions>');
    expect(result.cleanText).toBe('');
    expect(result.directives).toEqual([{ type: 'voice', text: 'Hello from a voice memo' }]);
  });

  it('parses voice directive with text after actions block', () => {
    const result = parseDirectives('<actions><voice>Here is a voice note</voice></actions>\nHere\'s the audio!');
    expect(result.cleanText).toBe("Here's the audio!");
    expect(result.directives).toEqual([{ type: 'voice', text: 'Here is a voice note' }]);
  });

  it('parses voice directive with multiline text', () => {
    const result = parseDirectives('<actions><voice>Line one.\nLine two.</voice></actions>');
    expect(result.cleanText).toBe('');
    expect(result.directives).toEqual([{ type: 'voice', text: 'Line one.\nLine two.' }]);
  });

  it('ignores empty voice directive', () => {
    const result = parseDirectives('<actions><voice>  </voice></actions>');
    expect(result.cleanText).toBe('');
    expect(result.directives).toEqual([]);
  });

  it('parses voice and react directives together', () => {
    const result = parseDirectives('<actions><react emoji="🎤" /><voice>Check this out</voice></actions>');
    expect(result.directives).toHaveLength(2);
    expect(result.directives[0]).toEqual({ type: 'react', emoji: '🎤' });
    expect(result.directives[1]).toEqual({ type: 'voice', text: 'Check this out' });
  });

  it('preserves order when voice appears before react', () => {
    const result = parseDirectives('<actions><voice>First</voice><react emoji="🎤" /></actions>');
    expect(result.directives).toEqual([
      { type: 'voice', text: 'First' },
      { type: 'react', emoji: '🎤' },
    ]);
  });

  it('preserves mixed directive order across voice and self-closing tags', () => {
    const result = parseDirectives(
      '<actions><send-file path="a.pdf" /><voice>One</voice><react emoji="👍" /><voice>Two</voice></actions>',
    );
    expect(result.directives).toEqual([
      { type: 'send-file', path: 'a.pdf' },
      { type: 'voice', text: 'One' },
      { type: 'react', emoji: '👍' },
      { type: 'voice', text: 'Two' },
    ]);
  });

  // --- send-message directive ---

  it('parses send-message directive with channel and chat', () => {
    const result = parseDirectives(
      '<actions><send-message channel="whatsapp" chat="5511999999999">Your transcription is ready</send-message></actions>',
    );
    expect(result.cleanText).toBe('');
    expect(result.directives).toEqual([
      { type: 'send-message', text: 'Your transcription is ready', channel: 'whatsapp', chat: '5511999999999' },
    ]);
  });

  it('parses send-message with text after actions block', () => {
    const result = parseDirectives(
      '<actions><send-message channel="telegram" chat="123">Done!</send-message></actions>\nHere is the summary.',
    );
    expect(result.cleanText).toBe('Here is the summary.');
    expect(result.directives).toEqual([
      { type: 'send-message', text: 'Done!', channel: 'telegram', chat: '123' },
    ]);
  });

  it('parses send-message with multiline text', () => {
    const result = parseDirectives(
      '<actions><send-message channel="slack" chat="C123">Line one.\nLine two.</send-message></actions>',
    );
    expect(result.directives).toEqual([
      { type: 'send-message', text: 'Line one.\nLine two.', channel: 'slack', chat: 'C123' },
    ]);
  });

  it('ignores send-message without channel attribute', () => {
    const result = parseDirectives(
      '<actions><send-message chat="123">Hello</send-message></actions>',
    );
    expect(result.directives).toEqual([]);
  });

  it('ignores send-message without chat attribute', () => {
    const result = parseDirectives(
      '<actions><send-message channel="telegram">Hello</send-message></actions>',
    );
    expect(result.directives).toEqual([]);
  });

  it('ignores send-message with empty text', () => {
    const result = parseDirectives(
      '<actions><send-message channel="telegram" chat="123">   </send-message></actions>',
    );
    expect(result.directives).toEqual([]);
  });

  it('parses multiple send-message directives', () => {
    const result = parseDirectives(
      '<actions>' +
      '<send-message channel="whatsapp" chat="111">Hello user 1</send-message>' +
      '<send-message channel="telegram" chat="222">Hello user 2</send-message>' +
      '</actions>',
    );
    expect(result.directives).toHaveLength(2);
    expect(result.directives[0]).toEqual({ type: 'send-message', text: 'Hello user 1', channel: 'whatsapp', chat: '111' });
    expect(result.directives[1]).toEqual({ type: 'send-message', text: 'Hello user 2', channel: 'telegram', chat: '222' });
  });

  it('parses send-message mixed with other directives', () => {
    const result = parseDirectives(
      '<actions>' +
      '<react emoji="thumbsup" />' +
      '<send-message channel="whatsapp" chat="555">Result ready</send-message>' +
      '<send-file path="report.pdf" />' +
      '</actions>',
    );
    expect(result.directives).toHaveLength(3);
    expect(result.directives[0]).toEqual({ type: 'react', emoji: 'thumbsup' });
    expect(result.directives[1]).toEqual({ type: 'send-message', text: 'Result ready', channel: 'whatsapp', chat: '555' });
    expect(result.directives[2]).toEqual({ type: 'send-file', path: 'report.pdf' });
  });

  // --- send-file with channel/chat targeting ---

  it('parses send-file with channel and chat targeting', () => {
    const result = parseDirectives(
      '<actions><send-file path="result.txt" channel="whatsapp" chat="5511999999999" caption="Here you go" /></actions>',
    );
    expect(result.directives).toEqual([
      { type: 'send-file', path: 'result.txt', channel: 'whatsapp', chat: '5511999999999', caption: 'Here you go' },
    ]);
  });

  it('parses send-file without channel/chat (default behavior unchanged)', () => {
    const result = parseDirectives(
      '<actions><send-file path="report.pdf" caption="Report" /></actions>',
    );
    expect(result.directives).toEqual([
      { type: 'send-file', path: 'report.pdf', caption: 'Report' },
    ]);
  });

  it('parses send-file with only channel (no chat) -- stores partial targeting', () => {
    const result = parseDirectives(
      '<actions><send-file path="report.pdf" channel="whatsapp" /></actions>',
    );
    expect(result.directives).toEqual([
      { type: 'send-file', path: 'report.pdf', channel: 'whatsapp' },
    ]);
  });

  it('parses send-file with only chat (no channel) -- stores partial targeting', () => {
    const result = parseDirectives(
      '<actions><send-file path="report.pdf" chat="123" /></actions>',
    );
    expect(result.directives).toEqual([
      { type: 'send-file', path: 'report.pdf', chat: '123' },
    ]);
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

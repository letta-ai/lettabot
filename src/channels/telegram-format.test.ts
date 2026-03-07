import { describe, expect, it } from 'vitest';
import { markdownToTelegramV2 } from './telegram-format.js';

describe('markdownToTelegramV2', () => {
  it('converts bold text', async () => {
    const result = await markdownToTelegramV2('**hello**');
    expect(result).toContain('*hello*');
  });

  it('converts inline code', async () => {
    const result = await markdownToTelegramV2('use `npm install`');
    expect(result).toContain('`npm install`');
  });

  it('escapes special characters outside formatting', async () => {
    const result = await markdownToTelegramV2('Hello! How are you?');
    expect(result).toContain('\\!');
  });

  it('handles code blocks', async () => {
    const result = await markdownToTelegramV2('```js\nconsole.log("hi")\n```');
    expect(result).toContain('```');
  });

  it('returns something for any input (never throws)', async () => {
    // Even weird inputs should return without throwing
    const weirdInputs = ['', '\\', '[](){}', '****', '```'];
    for (const input of weirdInputs) {
      const result = await markdownToTelegramV2(input);
      expect(typeof result).toBe('string');
    }
  });

  it('handles links', async () => {
    const result = await markdownToTelegramV2('Check out [Google](https://google.com)');
    expect(result).toContain('https://google.com');
  });

  it('preserves plain text', async () => {
    const result = await markdownToTelegramV2('Just some plain text');
    expect(result).toContain('Just some plain text');
  });

  it('preserves intentional markdown blockquotes', async () => {
    const result = await markdownToTelegramV2('> got annexed by the relationship problem.');
    expect(result).toContain('> got annexed by the relationship problem');
  });

  it('does not alter greater-than signs in the middle of a line', async () => {
    const result = await markdownToTelegramV2('2 > 1');
    expect(result).toContain('2 \\> 1');
  });

  it('preserves greater-than signs inside fenced code blocks', async () => {
    const result = await markdownToTelegramV2('```\n> code\n```');
    expect(result).toContain('```\n> code\n```');
  });
});

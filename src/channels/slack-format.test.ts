import { describe, expect, it } from 'vitest';
import { fallbackMarkdownToSlackMrkdwn, markdownToSlackMrkdwn } from './slack-format.js';

describe('markdownToSlackMrkdwn', () => {
  it('converts bold', async () => {
    const result = await markdownToSlackMrkdwn('**hello**');
    expect(result).toContain('*hello*');
  });

  it('converts italics', async () => {
    const result = await markdownToSlackMrkdwn('*hello*');
    expect(result).toContain('_hello_');
  });

  it('converts strikethrough', async () => {
    const result = await markdownToSlackMrkdwn('~~bye~~');
    expect(result).toContain('~bye~');
  });

  it('converts links', async () => {
    const result = await markdownToSlackMrkdwn('Check out [Google](https://google.com)');
    expect(result).toContain('<https://google.com|Google>');
  });

  it('strips code fence language identifiers', async () => {
    const result = await markdownToSlackMrkdwn('```js\nconsole.log(1)\n```');
    expect(result).toContain('```');
    expect(result).not.toContain('```js');
  });

  it('returns something for any input (never throws)', async () => {
    const weirdInputs = ['', '\\', '[](){}', '****', '```'];
    for (const input of weirdInputs) {
      const result = await markdownToSlackMrkdwn(input);
      expect(typeof result).toBe('string');
    }
  });
});

describe('fallbackMarkdownToSlackMrkdwn', () => {
  it('converts the common Slack mrkdwn differences', () => {
    const result = fallbackMarkdownToSlackMrkdwn(
      '**bold** *italic* ~~strike~~ [link](https://example.com)\n```js\ncode\n```'
    );

    expect(result).toContain('*bold*');
    expect(result).toContain('_italic_');
    expect(result).toContain('~strike~');
    expect(result).toContain('<https://example.com|link>');
    expect(result).toContain('```\ncode\n```');
    expect(result).not.toContain('```js');
  });
});


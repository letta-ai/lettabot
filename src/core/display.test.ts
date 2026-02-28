import { describe, expect, it } from 'vitest';
import { formatQuestionsForChannel, formatReasoningDisplay, formatToolCallDisplay } from './display.js';
import type { StreamMsg } from './types.js';

describe('formatToolCallDisplay', () => {
  it('formats known tools using configured header and detail from toolInput', () => {
    const streamMsg: StreamMsg = {
      type: 'tool_call',
      toolName: 'web_search',
      toolInput: { query: 'weather in SF' },
    };

    expect(formatToolCallDisplay(streamMsg)).toBe('**Searching**\nweather in SF');
  });

  it('formats Bash tool with inline code for short commands', () => {
    const streamMsg: StreamMsg = {
      type: 'tool_call',
      toolName: 'Bash',
      toolInput: { command: 'ls -la' },
    };

    expect(formatToolCallDisplay(streamMsg)).toBe('**Running**\n`ls -la`');
  });

  it('falls back to description for long Bash commands', () => {
    const streamMsg: StreamMsg = {
      type: 'tool_call',
      toolName: 'Bash',
      toolInput: {
        command: 'x'.repeat(121),
        description: 'Install project dependencies',
      },
    };

    expect(formatToolCallDisplay(streamMsg)).toBe('**Running**\nInstall project dependencies');
  });

  it('uses dynamic headers for Skill tool actions', () => {
    const unloadMsg: StreamMsg = {
      type: 'tool_call',
      toolName: 'Skill',
      toolInput: { command: 'unload', skill: 'web-design-guidelines' },
    };
    const refreshMsg: StreamMsg = {
      type: 'tool_call',
      toolName: 'Skill',
      toolInput: { command: 'refresh' },
    };

    expect(formatToolCallDisplay(unloadMsg)).toBe('**Unloading web-design-guidelines**');
    expect(formatToolCallDisplay(refreshMsg)).toBe('**Refreshing skills**');
  });

  it('uses tool_result content when toolInput is unavailable', () => {
    const streamMsg: StreamMsg = {
      type: 'tool_call',
      toolName: 'web_search',
    };
    const toolResult: StreamMsg = {
      type: 'tool_result',
      content: JSON.stringify({ query: 'latest ts features' }),
    };

    expect(formatToolCallDisplay(streamMsg, toolResult)).toBe('**Searching**\nlatest ts features');
  });

  it('uses generic fallback formatting for unknown tools', () => {
    const streamMsg: StreamMsg = {
      type: 'tool_call',
      toolName: 'my_custom_tool',
      toolInput: { foo: 'bar' },
    };

    expect(formatToolCallDisplay(streamMsg)).toBe('**Tool**\nmy_custom_tool (foo: bar)');
  });
});

describe('formatReasoningDisplay', () => {
  it('formats signal output as italic text', () => {
    const result = formatReasoningDisplay('  think\n deeply', 'signal');
    expect(result).toEqual({ text: '**Thinking**\n_think\ndeeply_' });
  });

  it('formats telegram output as escaped HTML blockquote', () => {
    const result = formatReasoningDisplay('a < b & c > d', 'telegram');
    expect(result.parseMode).toBe('HTML');
    expect(result.text).toBe('<blockquote expandable><b>Thinking</b>\na &lt; b &amp; c &gt; d</blockquote>');
  });

  it('formats non-signal/telegram channels as markdown blockquote', () => {
    const result = formatReasoningDisplay('line 1\n line 2', 'discord');
    expect(result).toEqual({ text: '> **Thinking**\n> line 1\n> line 2' });
  });

  it('truncates when reasoningMaxChars is set', () => {
    const result = formatReasoningDisplay('   1234567890', undefined, 5);
    expect(result.text).toBe('> **Thinking**\n> 12345...');
  });
});

describe('formatQuestionsForChannel', () => {
  it('formats a single question with numbered options and reply hint', () => {
    const output = formatQuestionsForChannel([{
      question: 'Choose a stack?',
      header: 'Stack',
      options: [
        { label: 'TypeScript', description: 'Preferred default' },
        { label: 'Python', description: 'Fast prototyping' },
      ],
      multiSelect: false,
    }]);

    expect(output).toContain('**Choose a stack?**');
    expect(output).toContain('1. **TypeScript**');
    expect(output).toContain('2. **Python**');
    expect(output).toContain('_Reply with your choice');
  });
});

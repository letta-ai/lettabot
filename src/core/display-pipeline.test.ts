import { describe, it, expect } from 'vitest';
import { createDisplayPipeline, type DisplayEvent } from './display-pipeline.js';
import type { StreamMsg } from './types.js';

/** Helper: collect all DisplayEvents from a pipeline fed with the given messages. */
async function collect(
  messages: StreamMsg[],
  convKey = 'test',
): Promise<DisplayEvent[]> {
  async function* feed(): AsyncIterable<StreamMsg> {
    for (const msg of messages) yield msg;
  }
  const events: DisplayEvent[] = [];
  for await (const evt of createDisplayPipeline(feed(), {
    convKey,
    resultFingerprints: new Map(),
  })) {
    events.push(evt);
  }
  return events;
}

describe('createDisplayPipeline', () => {
  it('locks foreground on first reasoning event and yields immediately', async () => {
    const events = await collect([
      { type: 'reasoning', content: 'thinking...', runId: 'run-1' },
      { type: 'assistant', content: 'reply', runId: 'run-1' },
      { type: 'result', success: true, result: 'reply', runIds: ['run-1'] },
    ]);

    const types = events.map(e => e.type);
    // Reasoning should appear BEFORE text -- no buffering
    expect(types[0]).toBe('reasoning');
    expect(types[1]).toBe('text');
    expect(types[2]).toBe('complete');
  });

  it('locks foreground on first tool_call event', async () => {
    const events = await collect([
      { type: 'tool_call', toolCallId: 'tc-1', toolName: 'Bash', toolInput: { command: 'echo hi' }, runId: 'run-1' },
      { type: 'assistant', content: 'done', runId: 'run-1' },
      { type: 'result', success: true, result: 'done', runIds: ['run-1'] },
    ]);

    expect(events[0].type).toBe('tool_call');
    expect(events[1].type).toBe('text');
    expect(events[2].type).toBe('complete');
  });

  it('filters pre-foreground error events to prevent false retry triggers', async () => {
    const events = await collect([
      { type: 'error', runId: 'run-bg', message: 'conflict waiting for approval', stopReason: 'error' },
      { type: 'result', success: false, error: 'error', runIds: ['run-main'] },
    ]);

    // Pre-foreground error is filtered (not yielded). Only the result passes through.
    const errorEvt = events.find(e => e.type === 'error');
    const completeEvt = events.find(e => e.type === 'complete');
    expect(errorEvt).toBeUndefined();
    expect(completeEvt).toBeDefined();
    if (completeEvt?.type === 'complete') {
      expect(completeEvt.runIds).toContain('run-main');
    }
  });

  it('rebinds foreground on assistant event with new run ID', async () => {
    const events = await collect([
      { type: 'assistant', content: 'before tool ', runId: 'run-1' },
      { type: 'tool_call', toolCallId: 'tc-1', toolName: 'Bash', toolInput: {}, runId: 'run-1' },
      { type: 'assistant', content: 'after tool', runId: 'run-2' },
      { type: 'result', success: true, result: 'before tool after tool', runIds: ['run-2'] },
    ]);

    const textEvents = events.filter(e => e.type === 'text');
    // Both assistant events should pass through (rebind on run-2)
    expect(textEvents.length).toBe(2);
    expect(events.find(e => e.type === 'complete')).toBeDefined();
  });

  it('filters non-foreground events after lock', async () => {
    const events = await collect([
      { type: 'reasoning', content: 'foreground thinking', runId: 'run-1' },
      { type: 'reasoning', content: 'background noise', runId: 'run-2' },
      { type: 'assistant', content: 'reply', runId: 'run-1' },
      { type: 'result', success: true, result: 'reply', runIds: ['run-1'] },
    ]);

    const reasoningEvents = events.filter(e => e.type === 'reasoning');
    // Only foreground reasoning should appear (run-2 filtered after lock to run-1)
    expect(reasoningEvents.length).toBe(1);
    if (reasoningEvents[0].type === 'reasoning') {
      expect(reasoningEvents[0].content).toBe('foreground thinking');
    }
  });

  it('accumulates reasoning chunks and flushes on type change', async () => {
    const events = await collect([
      { type: 'reasoning', content: 'part 1 ', runId: 'run-1' },
      { type: 'reasoning', content: 'part 2', runId: 'run-1' },
      { type: 'assistant', content: 'reply', runId: 'run-1' },
      { type: 'result', success: true, result: 'reply', runIds: ['run-1'] },
    ]);

    const reasoningEvents = events.filter(e => e.type === 'reasoning');
    // Multiple reasoning chunks should be accumulated into one event
    expect(reasoningEvents.length).toBe(1);
    if (reasoningEvents[0].type === 'reasoning') {
      expect(reasoningEvents[0].content).toBe('part 1 part 2');
    }
  });

  it('inserts newline before reasoning chunk starting with bold header', async () => {
    const events = await collect([
      { type: 'reasoning', content: 'First section ends here.', runId: 'run-1' },
      { type: 'reasoning', content: '**Second Section**\nMore text.', runId: 'run-1' },
      { type: 'assistant', content: 'reply', runId: 'run-1' },
      { type: 'result', success: true, result: 'reply', runIds: ['run-1'] },
    ]);

    const reasoning = events.find(e => e.type === 'reasoning');
    expect(reasoning).toBeDefined();
    if (reasoning?.type === 'reasoning') {
      expect(reasoning.content).toBe('First section ends here.\n**Second Section**\nMore text.');
    }
  });

  it('inserts newline before reasoning chunk starting with markdown heading', async () => {
    const events = await collect([
      { type: 'reasoning', content: 'End of thought.', runId: 'run-1' },
      { type: 'reasoning', content: '## Next Topic\nDetails here.', runId: 'run-1' },
      { type: 'assistant', content: 'reply', runId: 'run-1' },
      { type: 'result', success: true, result: 'reply', runIds: ['run-1'] },
    ]);

    const reasoning = events.find(e => e.type === 'reasoning');
    expect(reasoning).toBeDefined();
    if (reasoning?.type === 'reasoning') {
      expect(reasoning.content).toBe('End of thought.\n## Next Topic\nDetails here.');
    }
  });

  it('does not insert separator for token-level streaming chunks', async () => {
    const events = await collect([
      { type: 'reasoning', content: "I'm", runId: 'run-1' },
      { type: 'reasoning', content: ' thinking', runId: 'run-1' },
      { type: 'reasoning', content: ' about this', runId: 'run-1' },
      { type: 'assistant', content: 'reply', runId: 'run-1' },
      { type: 'result', success: true, result: 'reply', runIds: ['run-1'] },
    ]);

    const reasoning = events.find(e => e.type === 'reasoning');
    expect(reasoning).toBeDefined();
    if (reasoning?.type === 'reasoning') {
      expect(reasoning.content).toBe("I'm thinking about this");
    }
  });

  it('skips separator when buffer already ends with newline', async () => {
    const events = await collect([
      { type: 'reasoning', content: 'First block.\n', runId: 'run-1' },
      { type: 'reasoning', content: '**Second block**', runId: 'run-1' },
      { type: 'assistant', content: 'reply', runId: 'run-1' },
      { type: 'result', success: true, result: 'reply', runIds: ['run-1'] },
    ]);

    const reasoning = events.find(e => e.type === 'reasoning');
    expect(reasoning).toBeDefined();
    if (reasoning?.type === 'reasoning') {
      // No double newline -- buffer already ended with \n
      expect(reasoning.content).toBe('First block.\n**Second block**');
    }
  });

  it('prefers streamed text over result field on divergence', async () => {
    const events = await collect([
      { type: 'assistant', content: 'streamed reply', runId: 'run-1' },
      { type: 'result', success: true, result: 'result field reply', runIds: ['run-1'] },
    ]);

    const complete = events.find(e => e.type === 'complete');
    expect(complete).toBeDefined();
    if (complete?.type === 'complete') {
      expect(complete.text).toBe('streamed reply');
    }
  });

  it('falls back to result field when no streamed text', async () => {
    const events = await collect([
      { type: 'result', success: true, result: 'result only', runIds: ['run-1'] },
    ]);

    const complete = events.find(e => e.type === 'complete');
    expect(complete).toBeDefined();
    if (complete?.type === 'complete') {
      expect(complete.text).toBe('result only');
    }
  });

  it('detects stale duplicate results by run fingerprint', async () => {
    const fingerprints = new Map<string, string>();

    // First call -- fresh
    const events1 = await (async () => {
      async function* feed(): AsyncIterable<StreamMsg> {
        yield { type: 'result', success: true, result: 'first', runIds: ['run-1'] };
      }
      const events: DisplayEvent[] = [];
      for await (const evt of createDisplayPipeline(feed(), { convKey: 'test', resultFingerprints: fingerprints })) {
        events.push(evt);
      }
      return events;
    })();

    // Second call with same runIds -- stale
    const events2 = await (async () => {
      async function* feed(): AsyncIterable<StreamMsg> {
        yield { type: 'result', success: true, result: 'second', runIds: ['run-1'] };
      }
      const events: DisplayEvent[] = [];
      for await (const evt of createDisplayPipeline(feed(), { convKey: 'test', resultFingerprints: fingerprints })) {
        events.push(evt);
      }
      return events;
    })();

    const c1 = events1.find(e => e.type === 'complete');
    const c2 = events2.find(e => e.type === 'complete');
    expect(c1?.type === 'complete' && c1.stale).toBe(false);
    expect(c2?.type === 'complete' && c2.stale).toBe(true);
  });

  it('marks cancelled results', async () => {
    const events = await collect([
      { type: 'result', success: true, result: '', stopReason: 'cancelled', runIds: ['run-1'] },
    ]);

    const complete = events.find(e => e.type === 'complete');
    expect(complete).toBeDefined();
    if (complete?.type === 'complete') {
      expect(complete.cancelled).toBe(true);
    }
  });

  it('skips stream_event types', async () => {
    const events = await collect([
      { type: 'stream_event', content: 'partial delta' },
      { type: 'assistant', content: 'reply', runId: 'run-1' },
      { type: 'result', success: true, result: 'reply', runIds: ['run-1'] },
    ]);

    // stream_event never reaches the output -- only text + complete
    expect(events.length).toBe(2);
    expect(events[0].type).toBe('text');
    expect(events[1].type).toBe('complete');
  });

  it('yields tool_result events', async () => {
    const events = await collect([
      { type: 'tool_call', toolCallId: 'tc-1', toolName: 'Bash', toolInput: {}, runId: 'run-1' },
      { type: 'tool_result', toolCallId: 'tc-1', content: 'ok', isError: false, runId: 'run-1' },
      { type: 'assistant', content: 'done', runId: 'run-1' },
      { type: 'result', success: true, result: 'done', runIds: ['run-1'] },
    ]);

    const toolResult = events.find(e => e.type === 'tool_result');
    expect(toolResult).toBeDefined();
    if (toolResult?.type === 'tool_result') {
      expect(toolResult.toolCallId).toBe('tc-1');
      expect(toolResult.content).toBe('ok');
      expect(toolResult.isError).toBe(false);
    }
  });
});

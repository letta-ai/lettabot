import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createManageTodoTool } from './todo.js';

function parseToolResult(result: { content: Array<{ text?: string }> }): any {
  const text = result.content[0]?.text || '{}';
  return JSON.parse(text);
}

describe('manage_todo tool', () => {
  let tmpDataDir: string;
  let originalDataDir: string | undefined;

  beforeEach(() => {
    tmpDataDir = resolve(tmpdir(), `todo-tool-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tmpDataDir, { recursive: true });
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = tmpDataDir;
  });

  afterEach(() => {
    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDir;
    }
    rmSync(tmpDataDir, { recursive: true, force: true });
  });

  it('adds and lists todos', async () => {
    const tool = createManageTodoTool('agent-tool');

    const addResult = await tool.execute('1', {
      action: 'add',
      text: 'Check AI news feeds',
      recurring: 'daily',
    });
    const addPayload = parseToolResult(addResult);

    expect(addPayload.ok).toBe(true);
    expect(addPayload.todo.text).toBe('Check AI news feeds');

    const listResult = await tool.execute('2', {
      action: 'list',
      view: 'open',
    });
    const listPayload = parseToolResult(listResult);

    expect(listPayload.ok).toBe(true);
    expect(listPayload.count).toBe(1);
    expect(listPayload.todos[0].text).toBe('Check AI news feeds');
  });

  it('completes and reopens todos', async () => {
    const tool = createManageTodoTool('agent-tool-2');

    const addResult = await tool.execute('1', {
      action: 'add',
      text: 'Morning report',
    });
    const addPayload = parseToolResult(addResult);
    const id = addPayload.todo.id;

    const completeResult = await tool.execute('2', {
      action: 'complete',
      id,
    });
    const completePayload = parseToolResult(completeResult);
    expect(completePayload.todo.completed).toBe(true);

    const reopenResult = await tool.execute('3', {
      action: 'reopen',
      id,
    });
    const reopenPayload = parseToolResult(reopenResult);
    expect(reopenPayload.todo.completed).toBe(false);
  });
});

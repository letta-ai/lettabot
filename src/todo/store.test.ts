import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  addTodo,
  completeTodo,
  listActionableTodos,
  listTodos,
  removeTodo,
  snoozeTodo,
  syncTodosFromTool,
} from './store.js';

describe('todo store', () => {
  let tmpDataDir: string;
  let originalDataDir: string | undefined;

  beforeEach(() => {
    tmpDataDir = resolve(tmpdir(), `todo-store-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
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

  it('adds, lists, and completes todos', () => {
    const created = addTodo('agent-a', {
      text: 'Summarize unread emails',
      due: '2026-02-13T08:00:00.000Z',
      recurring: 'daily 8am',
    });

    expect(created.id).toContain('todo-');

    const open = listTodos('agent-a');
    expect(open).toHaveLength(1);
    expect(open[0].text).toBe('Summarize unread emails');
    expect(open[0].recurring).toBe('daily 8am');

    completeTodo('agent-a', created.id);

    const stillOpen = listTodos('agent-a');
    expect(stillOpen).toHaveLength(0);

    const all = listTodos('agent-a', { includeCompleted: true });
    expect(all).toHaveLength(1);
    expect(all[0].completed).toBe(true);
  });

  it('filters out future-snoozed todos from actionable list', () => {
    addTodo('agent-b', { text: 'Morning report', snoozed_until: '2099-01-01T00:00:00.000Z' });
    addTodo('agent-b', { text: 'Check urgent email' });

    const actionable = listActionableTodos('agent-b', new Date('2026-02-12T12:00:00.000Z'));

    expect(actionable).toHaveLength(1);
    expect(actionable[0].text).toBe('Check urgent email');
  });

  it('supports ID prefixes for remove', () => {
    const a = addTodo('agent-c', { text: 'Task A' });
    addTodo('agent-c', { text: 'Task B' });

    removeTodo('agent-c', a.id.slice(0, 12));

    const remaining = listTodos('agent-c');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].text).toBe('Task B');
  });

  it('validates date fields', () => {
    expect(() => addTodo('agent-d', { text: 'Bad due', due: 'not-a-date' })).toThrow('Invalid due value');
    const created = addTodo('agent-d', { text: 'Valid todo' });
    expect(() => snoozeTodo('agent-d', created.id, 'not-a-date')).toThrow('Invalid snoozed_until value');
  });

  it('syncs TodoWrite payloads into persistent todos', () => {
    const first = syncTodosFromTool('agent-e', [
      { content: 'Buy milk', status: 'pending' },
      { content: 'File taxes', status: 'in_progress' },
    ]);
    expect(first.added).toBe(2);
    expect(first.updated).toBe(0);

    const second = syncTodosFromTool('agent-e', [
      { content: 'Buy milk', status: 'completed' },
      { description: 'Call dentist', status: 'pending' },
    ]);
    expect(second.added).toBe(1);
    expect(second.updated).toBe(1);

    const open = listTodos('agent-e');
    expect(open.some((todo) => todo.text === 'Buy milk')).toBe(false);
    expect(open.some((todo) => todo.text === 'Call dentist')).toBe(true);

    const all = listTodos('agent-e', { includeCompleted: true });
    const milk = all.find((todo) => todo.text === 'Buy milk');
    expect(milk?.completed).toBe(true);
  });
});

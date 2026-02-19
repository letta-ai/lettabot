import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getDataDir } from '../utils/paths.js';

const TODO_STORE_VERSION = 1;

export interface TodoItem {
  id: string;
  text: string;
  created: string;
  due: string | null;
  snoozed_until: string | null;
  recurring: string | null;
  completed: boolean;
  completed_at?: string | null;
}

interface TodoStoreFile {
  version: number;
  todos: TodoItem[];
}

export interface AddTodoInput {
  text: string;
  due?: string | null;
  snoozed_until?: string | null;
  recurring?: string | null;
}

export interface TodoWriteSyncItem {
  content?: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

export interface ListTodoOptions {
  includeCompleted?: boolean;
}

function parseDateOrThrow(value: string, field: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${field} value: ${value}`);
  }
  return parsed.toISOString();
}

function normalizeDate(value: unknown, field: string): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return parseDateOrThrow(trimmed, field);
  } catch {
    return null;
  }
}

function normalizeOptionalDate(value: string | null | undefined, field: string): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return parseDateOrThrow(trimmed, field);
}

function normalizeRecurring(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function toSafeAgentKey(agentKey: string): string {
  const base = agentKey.trim() || 'lettabot';
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'lettabot';
  const hash = createHash('sha1').update(base).digest('hex').slice(0, 8);
  return `${slug}-${hash}`;
}

export function getTodoStorePath(agentKey: string): string {
  const fileName = `${toSafeAgentKey(agentKey)}.json`;
  return resolve(getDataDir(), 'todos', fileName);
}

function normalizeTodo(raw: unknown): TodoItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const text = typeof item.text === 'string' ? item.text.trim() : '';
  if (!text) return null;

  const created = normalizeDate(item.created, 'created') || new Date().toISOString();
  const completed = item.completed === true;

  return {
    id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `todo-${randomUUID()}`,
    text,
    created,
    due: normalizeDate(item.due, 'due'),
    snoozed_until: normalizeDate(item.snoozed_until, 'snoozed_until'),
    recurring: normalizeRecurring(item.recurring),
    completed,
    completed_at: completed ? normalizeDate(item.completed_at, 'completed_at') || new Date().toISOString() : null,
  };
}

function normalizeStore(raw: unknown): TodoStoreFile {
  if (Array.isArray(raw)) {
    return {
      version: TODO_STORE_VERSION,
      todos: raw.map(normalizeTodo).filter((t): t is TodoItem => !!t),
    };
  }

  if (raw && typeof raw === 'object') {
    const store = raw as Partial<TodoStoreFile>;
    const todos = Array.isArray(store.todos) ? store.todos : [];
    return {
      version: TODO_STORE_VERSION,
      todos: todos.map(normalizeTodo).filter((t): t is TodoItem => !!t),
    };
  }

  return {
    version: TODO_STORE_VERSION,
    todos: [],
  };
}

function loadStore(path: string): TodoStoreFile {
  if (!existsSync(path)) {
    return {
      version: TODO_STORE_VERSION,
      todos: [],
    };
  }

  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    return normalizeStore(raw);
  } catch {
    return {
      version: TODO_STORE_VERSION,
      todos: [],
    };
  }
}

function saveStore(path: string, store: TodoStoreFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2));
}

function compareTodoOrder(a: TodoItem, b: TodoItem): number {
  if (a.completed !== b.completed) {
    return a.completed ? 1 : -1;
  }

  const aDue = a.due ? new Date(a.due).getTime() : Number.POSITIVE_INFINITY;
  const bDue = b.due ? new Date(b.due).getTime() : Number.POSITIVE_INFINITY;
  if (aDue !== bDue) {
    return aDue - bDue;
  }

  return new Date(a.created).getTime() - new Date(b.created).getTime();
}

function findTodoIndex(todos: TodoItem[], id: string): number {
  const needle = id.trim();
  if (!needle) {
    throw new Error('Todo ID is required');
  }

  const exactIndex = todos.findIndex((todo) => todo.id === needle);
  if (exactIndex >= 0) return exactIndex;

  const partialMatches = todos
    .map((todo, index) => ({ todo, index }))
    .filter((entry) => entry.todo.id.startsWith(needle));

  if (partialMatches.length === 1) {
    return partialMatches[0].index;
  }

  if (partialMatches.length > 1) {
    const matches = partialMatches.map((entry) => entry.todo.id).join(', ');
    throw new Error(`Todo ID prefix "${needle}" is ambiguous: ${matches}`);
  }

  throw new Error(`Todo not found: ${needle}`);
}

export function addTodo(agentKey: string, input: AddTodoInput): TodoItem {
  const text = input.text.trim();
  if (!text) {
    throw new Error('Todo text is required');
  }

  const path = getTodoStorePath(agentKey);
  const store = loadStore(path);

  const todo: TodoItem = {
    id: `todo-${randomUUID()}`,
    text,
    created: new Date().toISOString(),
    due: normalizeOptionalDate(input.due, 'due'),
    snoozed_until: normalizeOptionalDate(input.snoozed_until, 'snoozed_until'),
    recurring: normalizeRecurring(input.recurring),
    completed: false,
    completed_at: null,
  };

  store.todos.push(todo);
  store.todos.sort(compareTodoOrder);
  saveStore(path, store);
  return { ...todo };
}

export function listTodos(agentKey: string, options: ListTodoOptions = {}): TodoItem[] {
  const path = getTodoStorePath(agentKey);
  const store = loadStore(path);

  return store.todos
    .filter((todo) => options.includeCompleted || !todo.completed)
    .sort(compareTodoOrder)
    .map((todo) => ({ ...todo }));
}

export function listActionableTodos(agentKey: string, now: Date = new Date()): TodoItem[] {
  const nowMs = now.getTime();
  return listTodos(agentKey)
    .filter((todo) => {
      if (!todo.snoozed_until) return true;
      return new Date(todo.snoozed_until).getTime() <= nowMs;
    })
    .sort(compareTodoOrder);
}

export function completeTodo(agentKey: string, id: string): TodoItem {
  const path = getTodoStorePath(agentKey);
  const store = loadStore(path);
  const idx = findTodoIndex(store.todos, id);

  const updated: TodoItem = {
    ...store.todos[idx],
    completed: true,
    completed_at: new Date().toISOString(),
  };
  store.todos[idx] = updated;

  store.todos.sort(compareTodoOrder);
  saveStore(path, store);
  return { ...updated };
}

export function reopenTodo(agentKey: string, id: string): TodoItem {
  const path = getTodoStorePath(agentKey);
  const store = loadStore(path);
  const idx = findTodoIndex(store.todos, id);

  const updated: TodoItem = {
    ...store.todos[idx],
    completed: false,
    completed_at: null,
  };
  store.todos[idx] = updated;

  store.todos.sort(compareTodoOrder);
  saveStore(path, store);
  return { ...updated };
}

export function removeTodo(agentKey: string, id: string): TodoItem {
  const path = getTodoStorePath(agentKey);
  const store = loadStore(path);
  const idx = findTodoIndex(store.todos, id);

  const [removed] = store.todos.splice(idx, 1);
  saveStore(path, store);
  return { ...removed };
}

export function snoozeTodo(agentKey: string, id: string, until: string | null): TodoItem {
  const path = getTodoStorePath(agentKey);
  const store = loadStore(path);
  const idx = findTodoIndex(store.todos, id);

  const updated: TodoItem = {
    ...store.todos[idx],
    snoozed_until: until ? parseDateOrThrow(until, 'snoozed_until') : null,
  };
  store.todos[idx] = updated;
  store.todos.sort(compareTodoOrder);
  saveStore(path, store);

  return { ...updated };
}

/**
 * Merge todos from Letta Code's built-in TodoWrite/WriteTodos tools into the
 * persistent heartbeat todo store.
 *
 * This is additive/upsert behavior (not full replacement) so existing manual
 * todos are preserved even if not included in the tool payload.
 */
export function syncTodosFromTool(agentKey: string, incoming: TodoWriteSyncItem[]): {
  added: number;
  updated: number;
  totalIncoming: number;
  totalStored: number;
} {
  const path = getTodoStorePath(agentKey);
  const store = loadStore(path);
  const nowIso = new Date().toISOString();

  const incomingNormalized = incoming
    .map((item) => {
      const text = (item.content || item.description || '').trim();
      const status = item.status;
      if (!text) return null;
      if (!['pending', 'in_progress', 'completed', 'cancelled'].includes(status)) return null;
      return { text, status };
    })
    .filter((item): item is { text: string; status: 'pending' | 'in_progress' | 'completed' | 'cancelled' } => !!item);

  if (incomingNormalized.length === 0) {
    return {
      added: 0,
      updated: 0,
      totalIncoming: 0,
      totalStored: store.todos.length,
    };
  }

  const existingByText = new Map<string, number[]>();
  for (let i = 0; i < store.todos.length; i++) {
    const key = store.todos[i].text.toLowerCase();
    const bucket = existingByText.get(key) || [];
    bucket.push(i);
    existingByText.set(key, bucket);
  }

  let added = 0;
  let updated = 0;

  for (const todo of incomingNormalized) {
    const key = todo.text.toLowerCase();
    const bucket = existingByText.get(key);
    const idx = bucket && bucket.length > 0 ? bucket.shift()! : -1;
    const completed = todo.status === 'completed' || todo.status === 'cancelled';

    if (idx >= 0) {
      const prev = store.todos[idx];
      const next: TodoItem = {
        ...prev,
        text: todo.text,
        completed,
        completed_at: completed ? (prev.completed_at || nowIso) : null,
      };
      store.todos[idx] = next;
      updated += 1;
      continue;
    }

    const created: TodoItem = {
      id: `todo-${randomUUID()}`,
      text: todo.text,
      created: nowIso,
      due: null,
      snoozed_until: null,
      recurring: null,
      completed,
      completed_at: completed ? nowIso : null,
    };
    store.todos.push(created);
    added += 1;
  }

  store.todos.sort(compareTodoOrder);
  saveStore(path, store);

  return {
    added,
    updated,
    totalIncoming: incomingNormalized.length,
    totalStored: store.todos.length,
  };
}

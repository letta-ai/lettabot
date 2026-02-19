import type { AnyAgentTool } from '@letta-ai/letta-code-sdk';
import {
  jsonResult,
  readStringParam,
} from '@letta-ai/letta-code-sdk';
import {
  addTodo,
  completeTodo,
  listActionableTodos,
  listTodos,
  reopenTodo,
  removeTodo,
  snoozeTodo,
} from '../todo/store.js';

function readOptionalString(params: Record<string, unknown>, key: string): string | null {
  const value = readStringParam(params, key);
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function createManageTodoTool(agentKey: string): AnyAgentTool {
  return {
    label: 'Manage To-Do List',
    name: 'manage_todo',
    description: 'Add, list, complete, reopen, remove, and snooze to-dos for this agent.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'list', 'complete', 'reopen', 'remove', 'snooze'],
          description: 'Action to perform.',
        },
        text: {
          type: 'string',
          description: 'Todo text for add action.',
        },
        id: {
          type: 'string',
          description: 'Todo ID (full or unique prefix) for complete/reopen/remove/snooze.',
        },
        due: {
          type: 'string',
          description: 'Optional due date/time (ISO string or date phrase parsable by JavaScript Date).',
        },
        recurring: {
          type: 'string',
          description: 'Optional recurring note (e.g. daily at 8am).',
        },
        snoozed_until: {
          type: 'string',
          description: 'Optional snooze-until date/time for add or snooze actions.',
        },
        view: {
          type: 'string',
          enum: ['open', 'all', 'actionable'],
          description: 'List scope for list action. Default: open.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async execute(_toolCallId: string, args: unknown) {
      const params = (args && typeof args === 'object') ? args as Record<string, unknown> : {};
      const action = readStringParam(params, 'action', { required: true })?.toLowerCase();

      switch (action) {
        case 'add': {
          const text = readStringParam(params, 'text', { required: true });
          const due = readOptionalString(params, 'due');
          const recurring = readOptionalString(params, 'recurring');
          const snoozedUntil = readOptionalString(params, 'snoozed_until');
          const todo = addTodo(agentKey, {
            text,
            due,
            recurring,
            snoozed_until: snoozedUntil,
          });
          return jsonResult({
            ok: true,
            action,
            message: `Added todo ${todo.id}`,
            todo,
          });
        }

        case 'list': {
          const view = (readStringParam(params, 'view') || 'open').toLowerCase();
          const todos = view === 'all'
            ? listTodos(agentKey, { includeCompleted: true })
            : view === 'actionable'
              ? listActionableTodos(agentKey)
              : listTodos(agentKey);

          return jsonResult({
            ok: true,
            action,
            view,
            count: todos.length,
            todos,
          });
        }

        case 'complete': {
          const id = readStringParam(params, 'id', { required: true });
          const todo = completeTodo(agentKey, id);
          return jsonResult({
            ok: true,
            action,
            message: `Completed todo ${todo.id}`,
            todo,
          });
        }

        case 'reopen': {
          const id = readStringParam(params, 'id', { required: true });
          const todo = reopenTodo(agentKey, id);
          return jsonResult({
            ok: true,
            action,
            message: `Reopened todo ${todo.id}`,
            todo,
          });
        }

        case 'remove': {
          const id = readStringParam(params, 'id', { required: true });
          const todo = removeTodo(agentKey, id);
          return jsonResult({
            ok: true,
            action,
            message: `Removed todo ${todo.id}`,
            todo,
          });
        }

        case 'snooze': {
          const id = readStringParam(params, 'id', { required: true });
          const until = readOptionalString(params, 'snoozed_until');
          const todo = snoozeTodo(agentKey, id, until);
          return jsonResult({
            ok: true,
            action,
            message: until ? `Snoozed todo ${todo.id}` : `Cleared snooze for ${todo.id}`,
            todo,
          });
        }

        default:
          throw new Error(`Unsupported action: ${action}`);
      }
    },
  };
}

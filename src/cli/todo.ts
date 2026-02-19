import {
  addTodo,
  completeTodo,
  getTodoStorePath,
  listActionableTodos,
  listTodos,
  reopenTodo,
  removeTodo,
  snoozeTodo,
  type TodoItem,
} from '../todo/store.js';

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const current = argv[i];

    if (!current.startsWith('--')) {
      positional.push(current);
      continue;
    }

    const equalIndex = current.indexOf('=');
    if (equalIndex > -1) {
      const key = current.slice(2, equalIndex);
      const value = current.slice(equalIndex + 1);
      flags[key] = value;
      continue;
    }

    const key = current.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }

    flags[key] = next;
    i += 1;
  }

  return { positional, flags };
}

function parseDateFlag(value: string, field: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${field}: ${value}`);
  }
  return parsed.toISOString();
}

function formatTodo(todo: TodoItem): string {
  const status = todo.completed ? 'x' : ' ';
  const shortId = todo.id.slice(0, 16);
  const details: string[] = [];

  if (todo.due) details.push(`due ${new Date(todo.due).toLocaleString()}`);
  if (todo.snoozed_until) details.push(`snoozed until ${new Date(todo.snoozed_until).toLocaleString()}`);
  if (todo.recurring) details.push(`recurring ${todo.recurring}`);

  return `[${status}] ${shortId} ${todo.text}${details.length > 0 ? ` (${details.join('; ')})` : ''}`;
}

function showUsage(): void {
  console.log(`
Usage: lettabot todo <command> [options]

Commands:
  add <text>            Add a todo
  list                  List todos
  complete <id>         Mark a todo complete
  reopen <id>           Mark a completed todo as open
  remove <id>           Delete a todo
  snooze <id>           Snooze a todo until a date

Options:
  --due <date>          Due date/time for add (ISO or Date-parsable)
  --recurring <text>    Recurring note for add (e.g. "daily 8am")
  --snooze-until <date> Initial snooze-until for add
  --until <date>        Snooze-until date for snooze command
  --clear               Clear snooze on snooze command
  --all                 Include completed todos in list
  --actionable          List only actionable todos (not future-snoozed)
  --agent <name>        Agent key/name (default: current config agent)

Examples:
  lettabot todo add "Deliver morning report" --recurring "daily 8am"
  lettabot todo add "Remind about dentist" --due "2026-02-13 09:00"
  lettabot todo list --actionable
  lettabot todo complete todo-abc123
  lettabot todo snooze todo-abc123 --until "2026-02-20"
`);
}

function asString(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function resolveAgentKey(flags: Record<string, string | boolean>, defaultAgentKey: string): string {
  const fromFlag = asString(flags.agent);
  return (fromFlag && fromFlag.trim()) || defaultAgentKey;
}

export async function todoCommand(subCommand: string | undefined, argv: string[], defaultAgentKey: string): Promise<void> {
  const parsed = parseArgs(argv);
  const agentKey = resolveAgentKey(parsed.flags, defaultAgentKey);

  try {
    switch (subCommand) {
      case 'add': {
        const text = parsed.positional.join(' ').trim();
        if (!text) {
          throw new Error('Usage: lettabot todo add <text> [--due <date>] [--recurring <text>] [--snooze-until <date>]');
        }

        const dueInput = asString(parsed.flags.due);
        const recurring = asString(parsed.flags.recurring);
        const snoozeUntilInput = asString(parsed.flags['snooze-until']) || asString(parsed.flags.snoozed_until);

        const todo = addTodo(agentKey, {
          text,
          due: dueInput ? parseDateFlag(dueInput, 'due') : null,
          recurring: recurring || null,
          snoozed_until: snoozeUntilInput ? parseDateFlag(snoozeUntilInput, 'snooze-until') : null,
        });

        console.log(`Added todo ${todo.id.slice(0, 16)} for agent "${agentKey}"`);
        console.log(formatTodo(todo));
        console.log(`Store: ${getTodoStorePath(agentKey)}`);
        return;
      }

      case 'list': {
        const actionableOnly = parsed.flags.actionable === true;
        const includeCompleted = parsed.flags.all === true;

        const todos = actionableOnly
          ? listActionableTodos(agentKey)
          : listTodos(agentKey, { includeCompleted });

        if (todos.length === 0) {
          console.log(`No todos for agent "${agentKey}".`);
          console.log(`Store: ${getTodoStorePath(agentKey)}`);
          return;
        }

        console.log(`Todos for agent "${agentKey}" (${todos.length}):`);
        todos.forEach((todo) => console.log(`  ${formatTodo(todo)}`));
        console.log(`Store: ${getTodoStorePath(agentKey)}`);
        return;
      }

      case 'complete': {
        const id = parsed.positional[0];
        if (!id) throw new Error('Usage: lettabot todo complete <id>');
        const todo = completeTodo(agentKey, id);
        console.log(`Completed: ${formatTodo(todo)}`);
        return;
      }

      case 'reopen': {
        const id = parsed.positional[0];
        if (!id) throw new Error('Usage: lettabot todo reopen <id>');
        const todo = reopenTodo(agentKey, id);
        console.log(`Reopened: ${formatTodo(todo)}`);
        return;
      }

      case 'remove': {
        const id = parsed.positional[0];
        if (!id) throw new Error('Usage: lettabot todo remove <id>');
        const todo = removeTodo(agentKey, id);
        console.log(`Removed: ${formatTodo(todo)}`);
        return;
      }

      case 'snooze': {
        const id = parsed.positional[0];
        if (!id) throw new Error('Usage: lettabot todo snooze <id> --until <date> | --clear');

        const clear = parsed.flags.clear === true;
        const untilInput = asString(parsed.flags.until);

        if (!clear && !untilInput) {
          throw new Error('Usage: lettabot todo snooze <id> --until <date> | --clear');
        }

        const todo = snoozeTodo(agentKey, id, clear ? null : parseDateFlag(untilInput!, 'snooze-until'));
        if (clear) {
          console.log(`Cleared snooze: ${formatTodo(todo)}`);
        } else {
          console.log(`Snoozed: ${formatTodo(todo)}`);
        }
        return;
      }

      case undefined:
      case 'help':
      case '--help':
      case '-h':
        showUsage();
        return;

      default:
        throw new Error(`Unknown todo subcommand: ${subCommand}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(1);
  }
}

---
name: subagents
description: Delegate tasks to specialized subagents using the Task tool. Use for parallel work, complex exploration, background processing, and tasks that need different tool access levels.
---

# Working with Subagents

The `Task` tool launches specialized subagents (subprocesses) that work autonomously on your behalf. Think of them as delegating to teammates with specific skills.

## Available Subagent Types

| Type | Access | Best For |
|------|--------|----------|
| `explore` | Read-only | Codebase exploration, finding files, understanding structure |
| `general-purpose` | Full read-write | Implementation, edits, complex multi-step tasks |
| `history-analyzer` | Read-only | Analyze conversation history, update agent memory |
| `recall` | Read-only | Search past conversations for specific topics |
| `memory` | Full access | Reorganize memory files into focused blocks |

## Available Agent IDs

- `agent-9f62eb6a` - general-purpose (full read-write access)
- `agent-44c566ac` - explore (read-only codebase exploration)

## When to Use Subagents

**Use subagents when:**
- Tasks can run in parallel (e.g., exploring multiple files simultaneously)
- You need read-only exploration without risking accidental edits
- The task is self-contained and can work independently
- You want to background a long-running task
- The task needs a different tool access level than you have

**Don't use subagents when:**
- It's a single, straightforward task (just do it directly)
- You need tight coordination/interaction (becomes overhead)
- The task is trivial and tracking it provides no benefit
- You need immediate results for the current flow

## Basic Usage

```typescript
// Simple task with explore agent
Task({
  subagent_type: "explore",
  description: "Find auth code",
  prompt: "Find all authentication-related code in src/. List file paths and the main auth approach used."
})

// Task with general-purpose agent
Task({
  subagent_type: "general-purpose",
  description: "Add input validation",
  prompt: "Add email and password validation to the user registration form. Check existing validation patterns first, then implement consistent validation."
})
```

## Running in Parallel

Launch multiple agents at once for concurrent work:

```typescript
Task({ subagent_type: "explore", description: "Find frontend components", prompt: "..." })
Task({ subagent_type: "explore", description: "Find backend APIs", prompt: "..." })
```

## Background Tasks

For long-running tasks, use `run_in_background: true`:

```typescript
Task({
  subagent_type: "general-purpose",
  description: "Refactor auth module",
  prompt: "Refactor the authentication module to use the new JWT pattern...",
  run_in_background: true
})
```

The tool result includes an `output_file` path. Check progress with:

```typescript
Read({ file_path: "/path/to/output.json" })  // or Bash with tail
```

## Continuing Conversations

Subagents can be resumed using their `conversation_id`:

```typescript
// First run returns a conversation_id
const result = Task({...})

// Later, continue the same conversation
Task({
  conversation_id: "conv-xyz789",
  description: "Continue implementation",
  prompt: "Now implement the fix we discussed"
})
```

## Model Selection

Subagents inherit your model by default, but you can specify a different one for cost/performance reasons:

```typescript
Task({
  subagent_type: "general-purpose",
  model: "letta/letta-free",  // Lighter model for quick tasks
  ...
})
```

**To see available models:**

```bash
lettabot model list
```

**Recommendations:**
- Use lighter models (e.g., `letta/letta-free`) for quick exploration tasks
- Use more capable models for complex implementation work
- Match the model to the task complexity to save tokens/latency
- Model handles shown in `lettabot model list` can be used directly

## Access Levels

Control what tools the subagent can use:

| subagent_type | Tools Available |
|---------------|-----------------|
| `explore` | Read, Glob, Grep (read-only, safer for exploration) |
| `general-purpose` | Full access including Bash, Edit, Write |
| `history-analyzer` | Read-only, conversation access |
| `recall` | Read-only, conversation search |
| `memory` | Full access to memory system |

**Safety note:** Multiple agents editing the same file risks conflicts. Partition work by file/directory boundaries when running in parallel.

## Example Patterns

### Explore + Implement Pattern

```typescript
// First, explore read-only
const exploration = Task({
  subagent_type: "explore",
  description: "Find validation code",
  prompt: "Find existing validation patterns in the codebase. Look for email, password, and form validation."
})

// Then implement based on findings
Task({
  subagent_type: "general-purpose",
  description: "Add validation",
  prompt: `Add validation to the registration form. Based on the patterns found: ${exploration}`
})
```

### Parallel File Analysis

```typescript
// Analyze multiple files concurrently
Task({ subagent_type: "explore", description: "Analyze auth.ts", prompt: "..." })
Task({ subagent_type: "explore", description: "Analyze middleware.ts", prompt: "..." })
Task({ subagent_type: "explore", description: "Analyze routes.ts", prompt: "..." })
```

### Background Research

```typescript
// Start a background investigation
Task({
  subagent_type: "explore",
  description: "Research error handling",
  prompt: "Find all error handling patterns in the codebase. Group by category and summarize approaches.",
  run_in_background: true
})

// Continue with other work...
```

## Tips

- **Be specific** in prompts - subagents work autonomously, so clear instructions matter
- **Trust the output** - subagents are generally reliable
- **Use descriptions** - keep them short (3-5 words) for readability
- **Partition parallel work** - avoid having multiple agents edit the same file
- **Check background results** - use the output_file path to monitor progress

---
name: linear
description: Manage Linear issues via GraphQL API. List, filter, update, prioritize, comment, and search issues. Use when the user asks about Linear, issues, project management, or backlog.
---

# Linear

Interact with Linear's GraphQL API to manage issues.

## When to Use

- User asks about Linear issues, tickets, or project management
- Need to triage, prioritize, or update issue status
- Want to search or comment on issues
- Managing a backlog or sprint

## Setup

Requires `LINEAR_API_KEY` environment variable. Get one from Linear Settings > API > Personal API keys.

## Quick Operations

### List issues by status
```bash
npx tsx scripts/linear.ts list --state "Triage"
npx tsx scripts/linear.ts list --state "In Progress"
npx tsx scripts/linear.ts list --state "Backlog"
```

### List issues assigned to someone
```bash
npx tsx scripts/linear.ts list --assignee "cameron"
```

### Get issue details
```bash
npx tsx scripts/linear.ts get <issue-id>
```

### Update issue priority (0=none, 1=urgent, 2=high, 3=medium, 4=low)
```bash
npx tsx scripts/linear.ts update <issue-id> --priority 2
```

### Update issue state
```bash
npx tsx scripts/linear.ts update <issue-id> --state "In Progress"
```

### Add comment
```bash
npx tsx scripts/linear.ts comment <issue-id> "Your comment here"
```

### Search issues
```bash
npx tsx scripts/linear.ts search "search query"
```

## Triage Workflow

1. List triage issues: `list --state "Triage"`
2. Review each issue, decide priority
3. Update priority and move to appropriate state
4. Add comments for context if needed

## Output Format

All commands output JSON for easy parsing. Use `jq` for filtering if needed.

## Battle-Tested Insights

### GraphQL Query Patterns
- Linear uses GraphQL with nested filtering. State filters need the exact format: `state: { name: { eq: "State Name" } }`
- Assignee filters are case-insensitive with `containsIgnoreCase`
- When updating state, you need to fetch the state ID first - state names alone won't work in mutations

### Common Pitfalls
- Issue IDs vs Identifiers: The API accepts both UUID-style IDs and human-readable identifiers (e.g., "ENG-123"), but some endpoints prefer one over the other
- Priority is numeric (0-4), not a string
- Rate limits are generous but exist - batch operations if doing bulk updates

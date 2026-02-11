# Testing Guide

LettaBot uses [Vitest](https://vitest.dev/) for testing with two test suites: unit tests and end-to-end (E2E) tests.

## Quick Start

```bash
# Run unit tests (watch mode)
npm test

# Run unit tests once (CI mode)
npm run test:run

# Run E2E tests (requires env vars)
npm run test:e2e
```

## Unit Tests

Unit tests are co-located with source files using the `.test.ts` suffix.

### Structure

```
src/
  core/
    commands.ts
    commands.test.ts      # Tests for commands.ts
    formatter.ts
    formatter.test.ts     # Tests for formatter.ts
  utils/
    phone.ts
    phone.test.ts
```

### Writing Unit Tests

```typescript
import { describe, it, expect } from 'vitest';
import { myFunction } from './my-module.js';

describe('myFunction', () => {
  it('does something expected', () => {
    expect(myFunction('input')).toBe('output');
  });

  it('handles edge cases', () => {
    expect(myFunction(null)).toBeNull();
  });
});
```

### What to Test

- **Utility functions** - Pure functions are easy to test
- **Parsing logic** - Config parsing, message formatting
- **Business rules** - Access control, rate limiting, etc.

## E2E Tests

E2E tests verify the full message flow against a real Letta API agent.

### Setup

E2E tests require two environment variables:

```bash
export LETTA_API_KEY=your-api-key
export LETTA_E2E_AGENT_ID=agent-xxx
```

Without these, E2E tests are automatically skipped.

### Test Agent

We use a dedicated test agent named "greg" on Letta API. This agent:
- Has minimal configuration
- Is only used for automated testing
- Should not have any sensitive data

### E2E Test Structure

```
e2e/
  bot.e2e.test.ts    # Main E2E test file
```

### MockChannelAdapter

The `MockChannelAdapter` (in `src/test/mock-channel.ts`) simulates a messaging channel:

```typescript
import { MockChannelAdapter } from '../src/test/mock-channel.js';

const adapter = new MockChannelAdapter();
bot.registerChannel(adapter);

// Simulate a message and wait for response
const response = await adapter.simulateMessage('Hello!');
expect(response).toBeTruthy();

// Check sent messages
const sent = adapter.getSentMessages();
expect(sent).toHaveLength(1);
```

### E2E Test Example

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { LettaBot } from '../src/core/bot.js';
import { MockChannelAdapter } from '../src/test/mock-channel.js';

const SKIP_E2E = !process.env.LETTA_API_KEY;

describe.skipIf(SKIP_E2E)('e2e: LettaBot', () => {
  let bot: LettaBot;
  let adapter: MockChannelAdapter;

  beforeAll(async () => {
    bot = new LettaBot({ /* config */ });
    adapter = new MockChannelAdapter();
    bot.registerChannel(adapter);
  });

  it('responds to messages', async () => {
    const response = await adapter.simulateMessage('Hi!');
    expect(response.length).toBeGreaterThan(0);
  }, 60000); // 60s timeout for API calls
});
```

## CI/CD

Tests run automatically via GitHub Actions (`.github/workflows/test.yml`):

| Job | Trigger | What it tests |
|-----|---------|---------------|
| `unit` | All PRs and pushes | Unit tests only |
| `e2e` | Pushes to main | Full E2E with Letta API |

E2E tests only run on `main` because they require secrets that aren't available to fork PRs.

## Best Practices

1. **Co-locate tests** - Put `foo.test.ts` next to `foo.ts`
2. **Test new code** - Add tests for bug fixes and new features
3. **Use descriptive names** - `it('returns null for invalid input')` not `it('works')`
4. **Set timeouts** - E2E tests need longer timeouts (30-120s)
5. **Mock external deps** - Don't call real APIs in unit tests

## Coverage

To see test coverage:

```bash
npm run test:run -- --coverage
```

Current test coverage focuses on:
- Core utilities (phone, backoff, server)
- Message formatting
- Command parsing
- Channel-specific logic (WhatsApp mentions, group gating)

---
name: swarm-module-patterns
description: Patterns and anti-patterns discovered during swarm module development and review. Use when building multi-agent systems, MCP clients, or event-driven Node.js services in LettaBot.
tags: [swarm, performance, security, architecture, mcp, node]
created: 2026-02-13
source: Three-reviewer compound engineering analysis of src/swarm/
---

# Swarm Module Patterns

Lessons learned from building and reviewing the TEAM-Elites swarm system. These patterns apply broadly to multi-agent orchestration, MCP client development, and high-throughput Node.js services.

## Critical: Never Use Sync I/O on Hot Paths

**Problem discovered:** `writeFileSync()` and `appendFileSync()` were called on every state mutation and telemetry event. In a message routing pipeline, this means every incoming message blocks the event loop for 1-10ms of disk I/O.

**Rule:** Any code in the message processing path must be fully async.

**Pattern: Debounced async writes**
```typescript
private dirty = false;
private saveTimeout: NodeJS.Timeout | null = null;

private scheduleSave(): void {
  this.dirty = true;
  if (this.saveTimeout) return; // Already scheduled
  this.saveTimeout = setTimeout(() => {
    this.saveTimeout = null;
    if (this.dirty) {
      this.dirty = false;
      fs.promises.writeFile(this.path, JSON.stringify(this.data, null, 2))
        .catch(err => console.error('[Store] Save failed:', err));
    }
  }, 100); // 100ms debounce
}
```

**Pattern: Batched async log writes**
```typescript
const pendingWrites: string[] = [];
let flushScheduled = false;

export function logEvent(event: string, data: unknown): void {
  pendingWrites.push(JSON.stringify({ event, data, ts: Date.now() }) + '\n');
  if (!flushScheduled) {
    flushScheduled = true;
    setImmediate(async () => {
      const batch = pendingWrites.splice(0);
      await fs.promises.appendFile(LOG_PATH, batch.join(''));
      flushScheduled = false;
    });
  }
}
```

**Where this applies:** SwarmStore, telemetry, any persistent state in message pipeline.

## Critical: Always Escape Content in XML/HTML Context

**Problem discovered:** User-controlled content (agent thoughts, messages) was inserted into `<swarm-context>` XML blocks without escaping, enabling XML injection.

**Rule:** Any user content injected into structured markup must be escaped.

**Pattern: XML escape utility**
```typescript
function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
```

**Where this applies:** ReasoningBridge context injection, any prompt assembly with external content.

## Critical: Never Swallow Errors Silently

**Problem discovered:** Empty catch blocks in message processing, context gathering, and provisioning. When these fail silently, production debugging becomes impossible.

**Rule:** Every catch block must either log or re-throw. "Never block message processing" is fine, but log the failure.

**Pattern: Log-and-continue for non-critical paths**
```typescript
try {
  const ctx = await bridge.gatherContext(agentId, nicheKey);
  prepend = ctx;
} catch (err) {
  logSwarmEvent('context_gather_failed', {
    agentId, nicheKey,
    error: err instanceof Error ? err.message : String(err),
  });
  // Continue without context - degraded but functional
}
```

**Pattern: Structured error telemetry**
```typescript
// In catch blocks, always emit structured telemetry
logSwarmEvent('operation_failed', {
  operation: 'provision_agent',
  nicheKey: blueprint.niche.key,
  error: err instanceof Error ? err.message : String(err),
  stack: err instanceof Error ? err.stack : undefined,
});
```

**Where this applies:** All swarm code, especially message routing, evolution, and bridge operations.

## Important: Extract MCP Client Base Class

**Problem discovered:** GatewayClient and HubClient share ~90% identical code (initialize handshake, JSON-RPC wrapping, session ID persistence, error handling).

**Rule:** When two classes share >50% implementation, extract a base class.

**Pattern: Abstract MCP client**
```typescript
abstract class MCPClient {
  protected url: string;
  protected fetchFn: typeof fetch;
  protected sessionId: string | null = null;
  protected requestId = 0;
  protected initialized = false;

  constructor(url: string, fetchFn?: typeof fetch) {
    // Validate URL (see security pattern below)
    this.url = url;
    this.fetchFn = fetchFn || globalThis.fetch;
  }

  protected abstract getToolName(): string;

  protected async call(operation: string, args: Record<string, unknown> = {}): Promise<any> {
    // Shared JSON-RPC logic, session management, error handling
  }
}

export class GatewayClient extends MCPClient {
  protected getToolName() { return 'thoughtbox_gateway'; }
  // Gateway-specific methods only
}

export class HubClient extends MCPClient {
  protected getToolName() { return 'thoughtbox_hub'; }
  // Hub-specific methods only
}
```

**Bonus:** Tests for the base class cover both clients automatically. The `calls[1]` bug (checking initialize handshake instead of actual call) would have been caught once, not twice.

## Important: Validate URLs in Client Constructors

**Problem discovered:** GatewayClient and HubClient accept arbitrary URLs without validation, risking SSRF or credential theft via redirect.

**Pattern: URL validation**
```typescript
constructor(url: string, fetchFn?: typeof fetch) {
  const parsed = new URL(url); // Throws on invalid
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('URL must use HTTP or HTTPS');
  }
  this.url = url;
  this.fetchFn = fetchFn || globalThis.fetch;
}
```

## Important: Use Index Maps for Hot-Path Lookups

**Problem discovered:** `Array.find()` on agents and blueprints arrays during message routing. O(n) per message, degrades linearly with agent count.

**Pattern: Maintain index maps alongside arrays**
```typescript
private agentsByNiche = new Map<string, SwarmAgentEntry>();

addAgent(entry: SwarmAgentEntry): void {
  this.data.agents.push(entry);
  this.agentsByNiche.set(entry.nicheKey, entry);
  this.scheduleSave();
}

getAgentForNiche(niche: NicheDescriptor): SwarmAgentEntry | null {
  return this.agentsByNiche.get(niche.key) ?? null; // O(1)
}
```

**When to apply:** Any lookup that happens per-message in the routing pipeline.

## Important: Separate Queries from Commands

**Problem discovered:** `routeMessage()` both returns routing info AND mutates metrics counters. Can't call it without side effects, making testing harder.

**Pattern: Command-Query Separation**
```typescript
// Pure query - no side effects
routeMessage(msg: InboundMessage): RouteResult | null { ... }

// Separate command for recording
recordRouteOutcome(niche: NicheDescriptor, success: boolean): void { ... }
```

## Important: Avoid Temporal Coupling

**Problem discovered:** SwarmManager requires `setProcessor()` to be called after construction, but silently does nothing if forgotten.

**Rule:** Objects should be fully initialized at construction time, or throw if used before ready.

**Pattern: Constructor injection over setter injection**
```typescript
// Bad: temporal coupling
const mgr = new SwarmManager(store, matcher);
mgr.setProcessor(fn); // Easy to forget!

// Good: required at construction
const mgr = new SwarmManager(store, matcher, fn);
```

## Nice to Have: Break Up God Methods

**Problem discovered:** `runGeneration()` (80 lines) handles selection, variation, evaluation, submission, review, approval, merging, provisioning, and telemetry.

**Pattern: Compose from focused methods**
```typescript
async runGeneration(niches: NicheDescriptor[]): Promise<void> {
  for (const niche of niches) {
    const candidate = await this.createCandidate(niche);
    const approved = await this.reviewCandidate(candidate);
    if (approved) await this.mergeAndProvision(candidate);
  }
}
```

Each sub-method is independently testable and replaceable.

## Testing Pattern: Account for MCP Initialize Handshake

**Problem discovered:** Tests checking `fetchMock.mock.calls[0]` were actually checking the MCP `initialize` handshake, not the operation call. The actual operation is at `calls[1]`.

**Rule:** When testing MCP clients with mock fetch, the first call is always `initialize`. Check `calls[1]` for your actual operation.

```typescript
// Wrong - this is the initialize handshake
const body = JSON.parse(fetchMock.mock.calls[0][1].body);
expect(body.method).toBe('tools/call'); // Fails! It's 'initialize'

// Right - skip past initialize
const body = JSON.parse(fetchMock.mock.calls[1][1].body);
expect(body.method).toBe('tools/call'); // Passes
```

**Exception:** The session-ID persistence test replaces `fetchFn` after the first call, so the second mock only has `calls[0]`.

## Testing Pattern: Clear Environment Variables

**Problem discovered:** `LETTA_AGENT_ID` environment variable leaks into tests via `process.env`, causing SwarmStore to return a real agent ID when tests expect null.

**Rule:** If your code has `process.env` fallbacks, tests must save/clear/restore those variables.

```typescript
it('agentId is null in fresh store', () => {
  const saved = process.env.LETTA_AGENT_ID;
  delete process.env.LETTA_AGENT_ID;
  
  const store = new SwarmStore(tmpDir);
  expect(store.agentId).toBeNull();
  
  if (saved) process.env.LETTA_AGENT_ID = saved;
});
```

## Summary: The Swarm Development Checklist

Before merging swarm code, verify:

- [ ] No `writeFileSync` or `appendFileSync` in message pipeline
- [ ] All user content escaped before insertion into XML/prompts
- [ ] Every catch block logs or re-throws (no empty catches)
- [ ] MCP client URLs validated in constructors
- [ ] Hot-path lookups use Maps, not Array.find()
- [ ] Tests account for MCP initialize handshake (`calls[1]`)
- [ ] Tests clear relevant environment variables
- [ ] No temporal coupling (objects valid at construction)
- [ ] Queries don't mutate state (CQS principle)
- [ ] Methods under 50 lines (extract if longer)

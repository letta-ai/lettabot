# TEAM-Elites Expected Behavior

This document defines the expected behavior for LettaBot's TEAM-Elites swarm mode.
It is intended to be reviewed alongside implementation files in `src/swarm/` and startup wiring in `src/main.ts`.

## Purpose

TEAM-Elites extends LettaBot from a single-agent runtime to a niche-based multi-agent runtime:

- Route incoming messages to niche-specialized agents.
- Preserve backward compatibility with single-agent operation.
- Evolve per-niche team blueprints over time.
- Share reasoning context across agents to improve coordination.

## Scope and Non-goals

In scope:

- Runtime wiring from YAML config to swarm startup.
- Message routing and per-agent queue semantics.
- Evolution scheduling and archive updates.
- Reasoning context bridge behavior.
- Persistence and restart behavior.

Current non-goals:

- Full production-grade online fitness evaluation (current implementation simulates evaluation).
- Automatic agent provisioning lifecycle from blueprints (partial/in-progress).
- Dynamic niche-space optimization beyond channel x domain.

## Configuration Contract

Expected config shape under `features.swarm`:

- `enabled: boolean`
- `hubUrl?: string` (default `http://localhost:1731/mcp`)
- `schedule?: string` (default `0 */6 * * *`)
- `populationSize?: number` (default `5`)
- `maxAgents?: number` (default `25`)
- `swarmChannels?: ChannelId[]` (recommended rollout guardrail; defaults to all enabled channels)
- `maxGenerations?: number` (recommended rollout guardrail for early testing)

Expected wiring path:

1. YAML parses to typed config (`src/config/types.ts`).
2. Config converts to env variables (`src/config/io.ts`):
   - `SWARM_ENABLED`
   - `SWARM_HUB_URL`
   - `SWARM_SCHEDULE`
   - `SWARM_POPULATION_SIZE`
   - `SWARM_MAX_AGENTS`
3. `src/main.ts` derives runtime `config.swarm` from env plus defaults.

Notes:

- The default channel x domain lattice is 25 niches (5 channels x 5 domains), which aligns with `maxAgents=25`.
- This alignment is intentional for full one-agent-per-niche coverage, but does not imply all niches must be populated immediately.

## Startup Lifecycle (Swarm Enabled)

When swarm is enabled, expected startup behavior is:

1. Create `SwarmStore` in data dir and set mode to `swarm`.
2. Create `SwarmManager` and inject into `LettaBot`.
3. Build niche set from enabled channels x domains:
   - channels: `telegram | slack | whatsapp | signal | discord`
   - domains: `coding | research | scheduling | communication | general`
4. Create `HubClient` + `EvolutionEngine`.
5. Initialize archive:
   - Register coordinator agent in Hub (if missing).
   - Create archive workspace (if missing).
   - Create one Hub problem per niche.
6. Schedule evolution loop via `CronService.addEvolutionJob(schedule, callback)`.
7. Optionally initialize `ReasoningBridge` unless `SWARM_REASONING=false`.

Expected degradation behavior:

- If archive initialization fails (Hub unavailable), bot startup continues.
- Swarm routing remains available and independent of evolution readiness.
- Evolution should skip gracefully while archive is unready (recommended: persisted `archiveReady` health flag in `SwarmStore`).

## Routing and Queue Semantics

Expected routing contract:

- In `single` mode, all messages route to the legacy `agentId`.
- In `swarm` mode:
  - Classify niche by:
    - channel = inbound message channel
    - domain = keyword heuristic (`matchNiche` / `classifyDomain`)
  - Tie-break behavior must be deterministic when multiple domains match:
    - primary rule: highest keyword hit count wins
    - tie rule: fixed priority order (recommended: `coding > research > scheduling > communication > general`)
  - Look up agent for `niche.key` in `SwarmStore`.
  - If found, route to that agent.
  - If not found, fallback to legacy single-agent path and emit a structured "niche-unserved" metric/event.
  - No-route fallback is preferred over immediate auto-provisioning for v1 stability.

Recommended `general`-domain guardrail:

- Track `general` share of routed messages.
- If `general` exceeds a threshold for a sustained window, split/refine domain heuristics before expanding provisioning.

Expected queue behavior:

- One queue per agent (not a single global mutex).
- `processQueues()` handles one message per non-empty agent queue per cycle.
- Different agents process concurrently.
- Empty per-agent queues are cleaned up.

## Agent Provisioning Semantics

The `DefaultSwarmProvisioner` implements eager, single-agent-per-niche provisioning:

**Naming Convention:**
- Deterministic agent naming: `lettabot-swarm-<nicheKey>`
- Example: `lettabot-swarm-telegram-coding`
- Enables agent reuse across restarts and identification by niche

**Provisioning Behavior:**
- Provision on elite merge: When evolution merges a new elite blueprint, automatically provision agent
- Reuse existing agents: Check for agent by name before creating new
- Persist mapping: Store `niche → agentId` mapping in `SwarmStore`
- Telemetry events: Emit `provision_merge_success` / `provision_merge_failed` for observability

**Integration Points:**
- `EvolutionEngine` accepts optional provisioner during construction
- On successful elite merge, engine calls `provisioner.provisionNicheAgent(niche, blueprint)`
- Provisioner creates/reuses agent and updates `SwarmStore.setAgentForNiche(nicheKey, agentId)`
- Per-agent conversation IDs stored separately via `SwarmStore.setConversationForAgent(agentId, conversationId)`

**Degradation:**
- If provisioning fails, evolution continues (logs failure telemetry)
- Routing fallback remains available for unprovisioned niches
- No blocking dependencies on provisioning success

## Reasoning Bridge Semantics

When enabled, expected reasoning behavior is:

- Initialize or resume a shared Thoughtbox session.
- Advance gateway stage via `cipher`.
- Ensure shared Hub workspace/problem for reasoning decisions.
- Register hub identities for swarm agents as needed.
- Post an initialization thought on main chain.

Pre-processing behavior:

- For each routed message, gather recent thoughts from other agents' branches.
- Gather recent shared decisions from Hub channel.
- Inject context as `<swarm-context>...</swarm-context>` XML into message text.
- Never block main processing on bridge errors.

Post-processing behavior:

- Log summarized reasoning to agent's branch (fire-and-forget).
- First thought on a branch forks from main chain (`branchFromThought`).
- Optional decisions may be posted to shared Hub channel.

## Evolution Loop Semantics

Per generation, expected loop is:

1. Select niche and parent:
   - existing elite for niche, or random bootstrap blueprint if none.
2. Apply variation operators to produce child blueprint.
3. Evaluate fitness.
4. Submit proposal to Hub.
5. Review proposal (automated policy).
6. Merge if better than current elite.
7. Persist merged elite in `SwarmStore`.

Policy expectations:

- Iterations per run = `min(populationSize, nicheCount)`.
- Elite replacement only when candidate fitness exceeds current elite.
- Store generation/blueprint records update only on successful merge.
- Niche provisioning priority should be informed by accumulated fallback/unserved counts.

## Persistence and Backward Compatibility

`SwarmStore` expectations:

- Persist to `swarm-registry.json`.
- Auto-migrate from legacy `lettabot-agent.json` if present.
- Preserve single-agent fields (`agentId`, `conversationId`, `baseUrl`) for compatibility.
- Persist swarm metadata:
  - `mode`, `agents`, `blueprints`, `generation`
  - `hubAgentId`, `hubWorkspaceId`
  - reasoning session/workspace/problem IDs and per-agent hub IDs
  - recommended metadata additions:
    - `schemaVersion` (migration guardrail)
    - `archiveReady` (evolution health/readiness)
    - unserved niche counters / last-seen timestamps

Compatibility requirement:

- `mode=single` must behave identically to historical single-agent bot operation.

## Operational Invariants

Expected invariants:

- Swarm mode must not break non-swarm bot startup.
- Evolution scheduling must not break existing cron features.
- Reasoning bridge failures must not fail message processing.
- Missing niche routes must fail safely (null route or fallback).
- Store reads/writes must survive process restarts.
- Evolution is enhancement-only and never blocks core message handling.

## Fitness Signals (LangSmith-Oriented)

The current implementation simulates fitness. Target production fitness should be observable from live runtime and traced in LangSmith.

Recommended initial signals:

- `responseLatency`: queue entry to response sent.
- `routingAccuracy`: proxy signal from follow-up behavior (rephrase/escalation/redirect patterns).
- `continuationRate`: whether the conversation continues within a time window.
- `reasoningBridgeUtility`: presence and downstream usefulness of shared context (non-empty context and reduced retries/escalations).

Recommended scoring approach:

- Weighted composite with conservative replacement policy.
- Keep elite replacement strict (`candidate > elite`) and optionally add a minimum delta threshold to reduce churn.
- Start simple, tune weights using observed disagreement between evaluator scores and manual review.

## LangSmith Evaluation Plan

Use LangSmith for both tracing and evaluation of swarm behavior.

Environment:

- Required:
  - `LANGSMITH_TRACING=true`
  - `LANGSMITH_API_KEY=<key>`
- Optional but recommended:
  - `LANGSMITH_PROJECT=lettabot-swarm` (or your chosen project name)

Notes on API keys:

- `LETTA_API_KEY` is required for Letta Cloud usage.
- `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are only required if your runtime/evaluators actually call those providers.
- LangSmith tracing itself does not require OpenAI/Anthropic unless those SDKs/models are used in your eval path.

Instrumentation goals:

1. Trace per-message routing decisions (`niche`, `route_found`, `fallback_used`).
2. Trace per-agent queue metrics (`queue_depth`, `wait_ms`, `process_ms`).
3. Trace evolution runs (`generation`, `niche`, `candidate_fitness`, `elite_fitness`, `merged`).
4. Trace reasoning bridge usage (`context_thought_count`, `context_decision_count`, `context_injected`).

Evaluation loop in LangSmith:

1. Collect traces for swarm traffic and evolution events.
2. Build dataset slices per niche and per channel.
3. Run evaluator experiments on routing quality + response outcomes.
4. Compare evaluator outputs to sampled human labels.
5. Tune fitness weights and tie-break/fallback thresholds.

## Current Implementation Status (As of this branch)

Implemented:

- Config type + env wiring for swarm.
- Main startup wiring for swarm, archive init, and evolution scheduling.
- Swarm store, niche matcher, swarm manager, evolution engine, hub client.
- Reasoning bridge and gateway client with tests (in branch working tree).
- Unit/integration coverage for store/manager/evolution and bridge/client behavior.
- ✅ **Provisioner service** (`DefaultSwarmProvisioner`) with deterministic agent naming (`lettabot-swarm-<nicheKey>`).
- ✅ **Eager provisioning on elite merge** integrated into `EvolutionEngine`.
- ✅ **Real swarm processor wiring** complete in `main.ts` with explicit `agentId` routing.
- ✅ **Swarm queue contract** upgraded to include adapter for proper message routing.
- ✅ **Per-agent execution path** (`processMessageForAgent`) that preserves global state isolation.
- ✅ **Per-agent conversation persistence** with niche upsert helpers in `SwarmStore`.
- ✅ **Comprehensive test coverage** for provisioner, evolution integration, queue adapter, and conversation persistence.

Known gaps to review:

- Fitness evaluation currently uses simulated scores, not real benchmark runs.
- Implement and persist deterministic tie-break, fallback metrics, and archive readiness state.
- Add schema versioning before further registry growth.
- Complete reasoning bridge production integration (implementation exists, needs production wiring verification).

## Review Checklist

Use this checklist while reviewing:

- Are tie-break rules and `general`-domain thresholds explicit enough?
- Is fallback-first behavior acceptable for all channels in v1?
- Do we want `archiveReady` and `schemaVersion` in the next implementation pass?
- Are these fitness signals sufficient for first LangSmith experiments?
- Which canary rollout should we use first (`swarmChannels`, `maxGenerations`, both)?

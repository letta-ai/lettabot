#!/usr/bin/env tsx

import { createHash } from 'node:crypto';

import { Letta } from '@letta-ai/letta-client';
import { createAgent, resumeSession } from '@letta-ai/letta-code-sdk';

type ParsedArgs = {
  agentId?: string;
  model?: string;
  targetWindow: number;
  iterations: number;
  preSessionIdleMs: number;
  keepAgent: boolean;
  skipControl: boolean;
  baseUrl?: string;
  apiKey?: string;
  includeDirectSystemPatch: boolean;
};

type AgentSnapshot = {
  at: string;
  contextWindowLimit: number | null;
  llmContextWindow: number | null;
  effectiveContextWindow: number | null;
  systemHash: string;
  systemLength: number;
  compactionSettings: unknown;
};

type StepResult = {
  step: string;
  snapshot: AgentSnapshot;
  changedFromTarget: boolean;
};

function printUsage(): void {
  console.log(`
Repro: context_window_limit drift after SDK memfs toggle updates.

Usage:
  npm run repro:context-window-reset -- [options]

Options:
  --agent-id <id>              Use an existing agent instead of creating one.
  --model <handle>             Model handle for created agent.
  --target-window <number>     Context window limit to pin before triggers (default: 38000).
  --iterations <number>        Number of memfs-false init cycles (default: 3).
  --pre-idle-ms <number>       Idle wait after pin and before SDK steps (default: 2000).
  --keep-agent                 Keep auto-created agent (default: delete it).
  --skip-control               Skip control init with memfs omitted.
  --direct-system-patch        Also run direct {system:<same>} patch via API client.
  --base-url <url>             Override LETTA_BASE_URL.
  --api-key <key>              Override LETTA_API_KEY.
  --help                       Show this message.

Required env (unless passed via flags):
  LETTA_API_KEY
Optional env:
  LETTA_BASE_URL (default: https://api.letta.com)
`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    targetWindow: 38000,
    iterations: 3,
    preSessionIdleMs: 2000,
    keepAgent: false,
    skipControl: false,
    includeDirectSystemPatch: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
    if (arg === '--agent-id') {
      out.agentId = argv[++i];
      continue;
    }
    if (arg === '--model') {
      out.model = argv[++i];
      continue;
    }
    if (arg === '--target-window') {
      out.targetWindow = Number(argv[++i]);
      continue;
    }
    if (arg === '--iterations') {
      out.iterations = Number(argv[++i]);
      continue;
    }
    if (arg === '--pre-idle-ms') {
      out.preSessionIdleMs = Number(argv[++i]);
      continue;
    }
    if (arg === '--keep-agent') {
      out.keepAgent = true;
      continue;
    }
    if (arg === '--skip-control') {
      out.skipControl = true;
      continue;
    }
    if (arg === '--direct-system-patch') {
      out.includeDirectSystemPatch = true;
      continue;
    }
    if (arg === '--base-url') {
      out.baseUrl = argv[++i];
      continue;
    }
    if (arg === '--api-key') {
      out.apiKey = argv[++i];
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isFinite(out.targetWindow) || out.targetWindow <= 0) {
    throw new Error(`--target-window must be a positive number, got: ${out.targetWindow}`);
  }
  if (!Number.isFinite(out.iterations) || out.iterations <= 0) {
    throw new Error(`--iterations must be a positive number, got: ${out.iterations}`);
  }
  if (!Number.isFinite(out.preSessionIdleMs) || out.preSessionIdleMs < 0) {
    throw new Error(`--pre-idle-ms must be >= 0, got: ${out.preSessionIdleMs}`);
  }

  return out;
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getSnapshot(client: Letta, agentId: string): Promise<AgentSnapshot> {
  const state = await client.agents.retrieve(agentId);
  const unsafe = state as Record<string, unknown>;
  const contextWindowLimit = typeof unsafe.context_window_limit === 'number'
    ? unsafe.context_window_limit
    : null;
  const llmConfig = unsafe.llm_config as Record<string, unknown> | undefined;
  const llmContextWindow = llmConfig && typeof llmConfig.context_window === 'number'
    ? llmConfig.context_window
    : null;
  const effectiveContextWindow = contextWindowLimit ?? llmContextWindow;
  const system = typeof unsafe.system === 'string' ? unsafe.system : '';
  const compactionSettings = unsafe.compaction_settings ?? null;

  return {
    at: new Date().toISOString(),
    contextWindowLimit,
    llmContextWindow,
    effectiveContextWindow,
    systemHash: hashText(system),
    systemLength: system.length,
    compactionSettings,
  };
}

function isWindowChanged(snapshot: AgentSnapshot, targetWindow: number): boolean {
  return snapshot.effectiveContextWindow !== targetWindow;
}

async function initializeAndClose(agentId: string, memfs: boolean | undefined): Promise<void> {
  const opts = memfs === undefined ? {} : { memfs };
  const session = resumeSession(agentId, opts);
  try {
    await session.initialize();
  } finally {
    session.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const baseURL = args.baseUrl || process.env.LETTA_BASE_URL || 'https://api.letta.com';
  const apiKey = args.apiKey || process.env.LETTA_API_KEY;

  if (!apiKey) {
    throw new Error('LETTA_API_KEY is required (set env or pass --api-key).');
  }

  process.env.LETTA_BASE_URL = baseURL;
  process.env.LETTA_API_KEY = apiKey;

  const client = new Letta({ apiKey, baseURL });
  const startedAt = new Date().toISOString();

  let agentId = args.agentId;
  let createdAgent = false;

  if (!agentId) {
    agentId = await createAgent({
      ...(args.model ? { model: args.model } : {}),
      // Keep baseline deterministic: avoid cloud auto-memfs behavior on new agents.
      memfs: false,
      tags: ['origin:context-window-repro'],
    });
    createdAgent = true;
  }

  console.log(`Using agent: ${agentId}${createdAgent ? ' (created for repro)' : ''}`);

  const initial = await getSnapshot(client, agentId);

  await client.agents.update(agentId, { context_window_limit: args.targetWindow });
  await sleep(750);
  const afterPin = await getSnapshot(client, agentId);

  const steps: StepResult[] = [];

  if (args.preSessionIdleMs > 0) {
    await sleep(args.preSessionIdleMs);
    const idle = await getSnapshot(client, agentId);
    steps.push({
      step: `control: idle wait ${args.preSessionIdleMs}ms (no SDK session)`,
      snapshot: idle,
      changedFromTarget: isWindowChanged(idle, args.targetWindow),
    });
  }

  if (!args.skipControl) {
    await initializeAndClose(agentId, undefined);
    await sleep(750);
    const control = await getSnapshot(client, agentId);
    steps.push({
      step: 'control: sdk init with memfs omitted',
      snapshot: control,
      changedFromTarget: isWindowChanged(control, args.targetWindow),
    });
  }

  for (let i = 1; i <= args.iterations; i += 1) {
    await initializeAndClose(agentId, false);
    await sleep(750);
    const snap = await getSnapshot(client, agentId);
    steps.push({
      step: `trigger ${i}: sdk init with memfs=false (--no-memfs)`,
      snapshot: snap,
      changedFromTarget: isWindowChanged(snap, args.targetWindow),
    });
  }

  if (args.includeDirectSystemPatch) {
    const latest = await getSnapshot(client, agentId);
    const state = await client.agents.retrieve(agentId);
    const system = typeof (state as Record<string, unknown>).system === 'string'
      ? (state as Record<string, unknown>).system as string
      : '';
    await client.agents.update(agentId, { system });
    await sleep(750);
    const afterDirectPatch = await getSnapshot(client, agentId);
    steps.push({
      step: 'trigger: direct client.agents.update({system: sameText})',
      snapshot: afterDirectPatch,
      changedFromTarget: isWindowChanged(afterDirectPatch, args.targetWindow),
    });

    if (latest.systemHash !== afterDirectPatch.systemHash) {
      console.warn('Note: system hash changed across direct system patch step.');
    }
  }

  const reproduced = steps.some((s) => s.changedFromTarget);
  const finishedAt = new Date().toISOString();

  const report = {
    scenario: 'context-window-limit drift on partial agent updates',
    startedAt,
    finishedAt,
    baseURL,
    agentId,
    createdAgent,
    targetWindow: args.targetWindow,
    initial,
    afterPin,
    steps,
    note: 'effectiveContextWindow uses context_window_limit when available, otherwise llm_config.context_window.',
    reproduced,
    summary: reproduced
      ? 'BUG REPRODUCED: context_window_limit changed away from pinned value.'
      : 'No drift observed in this run.',
  };

  console.log('\n=== Repro Report (JSON) ===');
  console.log(JSON.stringify(report, null, 2));

  if (createdAgent && !args.keepAgent) {
    await client.agents.delete(agentId);
    console.log(`Deleted temporary agent: ${agentId}`);
  } else if (createdAgent && args.keepAgent) {
    console.log(`Kept temporary agent for inspection: ${agentId}`);
  }

  if (reproduced) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exit(1);
});

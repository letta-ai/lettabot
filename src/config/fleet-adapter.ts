/**
 * Fleet Config Adapter
 *
 * Detects and transforms lettactl's agents.yml (fleet format) into
 * LettaBot's native config shape so users can define everything in one file.
 *
 * Fleet format is identified by the presence of `agents[]` entries that contain
 * lettactl-only fields like `llm_config` or `system_prompt`.
 */

import type { LettaBotConfig, AgentConfig } from './types.js';

// ---------------------------------------------------------------------------
// Fleet-loaded flag
// ---------------------------------------------------------------------------

let _loadedFromFleetConfig = false;

export function wasLoadedFromFleetConfig(): boolean {
  return _loadedFromFleetConfig;
}

export function setLoadedFromFleetConfig(value: boolean): void {
  _loadedFromFleetConfig = value;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Returns true when `parsed` looks like a fleet config (lettactl agents.yml)
 * rather than a native lettabot.yaml.
 *
 * Fleet configs have an `agents[]` array whose entries carry lettactl-only
 * fields (`llm_config`, `system_prompt`) that LettaBot's native format never
 * uses.
 */
export function isFleetConfig(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false;
  }

  const obj = parsed as Record<string, unknown>;
  const agents = obj.agents;

  if (!Array.isArray(agents) || agents.length === 0) {
    return false;
  }

  // At least one entry must have a lettactl-only field
  return agents.some(
    (a: unknown) =>
      !!a &&
      typeof a === 'object' &&
      ('llm_config' in (a as Record<string, unknown>) ||
        'system_prompt' in (a as Record<string, unknown>)),
  );
}

// ---------------------------------------------------------------------------
// Transformation
// ---------------------------------------------------------------------------

interface FleetAgent {
  name: string;
  description?: string;
  llm_config?: unknown;
  system_prompt?: unknown;
  embedding?: unknown;
  tools?: unknown;
  mcp_tools?: unknown;
  shared_blocks?: unknown;
  memory_blocks?: unknown;
  archives?: unknown;
  folders?: unknown;
  shared_folders?: unknown;
  embedding_config?: unknown;
  first_message?: unknown;
  reasoning?: unknown;
  tags?: unknown;
  lettabot?: Record<string, unknown>;
}

/**
 * Transform a fleet config object into a LettaBot native config.
 *
 * - Filters to agents that have a `lettabot:` section
 * - Throws if no agents qualify
 * - Single qualifying agent  -> single-agent format (agent: + top-level fields)
 * - Multiple qualifying agents -> multi-agent format (agents[])
 * - lettactl-only fields are dropped
 */
export function fleetConfigToLettaBotConfig(
  parsed: Record<string, unknown>,
): LettaBotConfig {
  const rawAgents = parsed.agents as FleetAgent[];

  const qualifying = rawAgents.filter(
    (a) => !!a.lettabot && typeof a.lettabot === 'object',
  );

  if (qualifying.length === 0) {
    throw new Error(
      'No agents in fleet config have a `lettabot:` section. ' +
        'Add a `lettabot:` block to at least one agent in agents.yml.',
    );
  }

  if (qualifying.length === 1) {
    return buildSingleAgentConfig(qualifying[0]);
  }

  return buildMultiAgentConfig(qualifying);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractLettabotFields(lb: Record<string, unknown>) {
  return {
    server: lb.server as LettaBotConfig['server'] | undefined,
    displayName: lb.displayName as string | undefined,
    conversations: lb.conversations as LettaBotConfig['conversations'],
    channels: lb.channels as LettaBotConfig['channels'],
    features: lb.features as LettaBotConfig['features'],
    providers: lb.providers as LettaBotConfig['providers'],
    polling: lb.polling as LettaBotConfig['polling'],
    transcription: lb.transcription as LettaBotConfig['transcription'],
    attachments: lb.attachments as LettaBotConfig['attachments'],
  };
}

function buildSingleAgentConfig(agent: FleetAgent): LettaBotConfig {
  const lb = extractLettabotFields(agent.lettabot!);

  return {
    server: { mode: 'api', ...lb.server },
    agent: {
      name: agent.name,
      displayName: lb.displayName,
    },
    channels: lb.channels ?? {},
    conversations: lb.conversations,
    features: lb.features,
    providers: lb.providers,
    polling: lb.polling,
    transcription: lb.transcription,
    attachments: lb.attachments,
  };
}

function buildMultiAgentConfig(agents: FleetAgent[]): LettaBotConfig {
  // Server, providers, transcription, attachments are promoted from the first
  // qualifying agent (they are system-wide settings, not per-agent).
  const firstLb = extractLettabotFields(agents[0].lettabot!);

  const nativeAgents: AgentConfig[] = agents.map((agent) => {
    const lb = extractLettabotFields(agent.lettabot!);
    return {
      name: agent.name,
      displayName: lb.displayName,
      channels: lb.channels ?? {},
      conversations: lb.conversations,
      features: lb.features,
      polling: lb.polling,
    };
  });

  return {
    server: { mode: 'api', ...firstLb.server },
    agent: { name: nativeAgents[0].name },
    channels: {},
    agents: nativeAgents,
    providers: firstLb.providers,
    transcription: firstLb.transcription,
    attachments: firstLb.attachments,
  };
}

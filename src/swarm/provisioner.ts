import { createAgent } from '@letta-ai/letta-code-sdk';
import { loadMemoryBlocks } from '../core/memory.js';
import { agentExists, ensureNoToolApprovals, findAgentByName } from '../tools/letta-api.js';
import type { TeamBlueprint } from './types.js';
import { logSwarmEvent } from './telemetry.js';

export interface SwarmProvisioner {
  provisionNicheAgent(blueprint: TeamBlueprint): Promise<string>;
}

export class DefaultSwarmProvisioner implements SwarmProvisioner {
  private modelFallback?: string;
  private skills: {
    cronEnabled?: boolean;
    googleEnabled?: boolean;
  };

  constructor(options?: {
    modelFallback?: string;
    skills?: {
      cronEnabled?: boolean;
      googleEnabled?: boolean;
    };
  }) {
    this.modelFallback = options?.modelFallback;
    this.skills = options?.skills || {};
  }

  private buildAgentName(blueprint: TeamBlueprint): string {
    return `lettabot-swarm-${blueprint.niche.key}`;
  }

  async provisionNicheAgent(blueprint: TeamBlueprint): Promise<string> {
    const agentName = this.buildAgentName(blueprint);

    const existing = await findAgentByName(agentName);
    if (existing && await agentExists(existing.id)) {
      logSwarmEvent('provision_reuse_agent', {
        nicheKey: blueprint.niche.key,
        blueprintId: blueprint.id,
        agentId: existing.id,
        agentName,
      });
      return existing.id;
    }

    const primary = blueprint.agents[0];
    const model = primary?.model || this.modelFallback;
    const systemPrompt = primary?.systemPrompt
      || `You are a helpful assistant specialized in ${blueprint.niche.domain} tasks on ${blueprint.niche.channel}.`;
    const memory = primary?.memoryBlocks?.length
      ? primary.memoryBlocks
      : loadMemoryBlocks(agentName);

    const agentId = await createAgent({
      model,
      systemPrompt,
      memory,
    });

    // Best-effort: keep headless operation safe for swarm agents too.
    ensureNoToolApprovals(agentId).catch(() => {});

    logSwarmEvent('provision_create_agent', {
      nicheKey: blueprint.niche.key,
      blueprintId: blueprint.id,
      agentId,
      agentName,
    });

    return agentId;
  }
}

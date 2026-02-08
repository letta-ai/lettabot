/**
 * Variation Operators — Blueprint Mutation
 *
 * Six operators that transform TeamBlueprint → TeamBlueprint as pure functions,
 * incrementing generation and recording lineage.
 */

import type {
  TeamBlueprint,
  SwarmAgentConfig,
  CoordinationStrategy,
  AgentRole,
  VariationOperator,
} from './types.js';

// Available models for model mutation
const MODEL_TIERS = [
  'anthropic/claude-haiku-4-5-20251001',
  'anthropic/claude-sonnet-4-5-20250929',
  'anthropic/claude-opus-4-5-20251101',
  'openai/gpt-5.2',
  'google_ai/gemini-3-pro-preview',
  'google_ai/gemini-3-flash-preview',
];

const STRATEGIES: CoordinationStrategy[] = ['sequential', 'parallel', 'debate', 'pipeline'];
const ROLES: AgentRole[] = ['coordinator', 'contributor', 'reviewer', 'specialist'];

const AVAILABLE_SKILLS = ['cronEnabled', 'googleEnabled'] as const;

function randomId(): string {
  return `bp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function cloneBlueprint(bp: TeamBlueprint): TeamBlueprint {
  return JSON.parse(JSON.stringify(bp));
}

function advanceGeneration(child: TeamBlueprint, parentId: string): TeamBlueprint {
  child.id = randomId();
  child.generation = child.generation + 1;
  child.parentIds = [parentId];
  return child;
}

// ─── Operators ────────────────────────────────────────────────────────────────

/**
 * Skill Mutation: Add/remove/swap a skill in a random agent's config.
 */
export function skillMutation(parent: TeamBlueprint): TeamBlueprint {
  const child = cloneBlueprint(parent);
  advanceGeneration(child, parent.id);

  const agentIdx = randomInt(0, child.agents.length - 1);
  const agent = child.agents[agentIdx];

  const action = pick(['add', 'remove', 'swap']);
  const skillKey = pick([...AVAILABLE_SKILLS]);

  if (action === 'add' || action === 'swap') {
    (agent.skills as Record<string, boolean | undefined>)[skillKey] = true;
  } else {
    (agent.skills as Record<string, boolean | undefined>)[skillKey] = undefined;
  }

  // Also toggle additionalSkills
  if (!agent.skills.additionalSkills) {
    agent.skills.additionalSkills = [];
  }
  if (action === 'add') {
    const newSkill = `skill-${Math.random().toString(36).slice(2, 6)}`;
    agent.skills.additionalSkills.push(newSkill);
  } else if (action === 'remove' && agent.skills.additionalSkills.length > 0) {
    agent.skills.additionalSkills.pop();
  }

  return child;
}

/**
 * Role Mutation: Reassign roles (enforces at most one coordinator).
 */
export function roleMutation(parent: TeamBlueprint): TeamBlueprint {
  const child = cloneBlueprint(parent);
  advanceGeneration(child, parent.id);

  const agentIdx = randomInt(0, child.agents.length - 1);
  const newRole = pick(ROLES);

  // If assigning coordinator, demote existing coordinator first
  if (newRole === 'coordinator') {
    for (const agent of child.agents) {
      if (agent.role === 'coordinator') {
        agent.role = 'contributor';
      }
    }
  }

  child.agents[agentIdx].role = newRole;

  return child;
}

/**
 * Prompt Crossover: Blend system prompts from two parent blueprints.
 * Takes sentences from each parent alternately.
 */
export function promptCrossover(parent1: TeamBlueprint, parent2: TeamBlueprint): TeamBlueprint {
  const child = cloneBlueprint(parent1);
  child.id = randomId();
  child.generation = Math.max(parent1.generation, parent2.generation) + 1;
  child.parentIds = [parent1.id, parent2.id];

  // Blend prompts for matching agent indices
  const maxAgents = Math.min(parent1.agents.length, parent2.agents.length);
  for (let i = 0; i < maxAgents; i++) {
    const prompt1 = parent1.agents[i].systemPrompt;
    const prompt2 = parent2.agents[i].systemPrompt;

    // Split into sentences and interleave
    const sentences1 = prompt1.split(/(?<=[.!?])\s+/).filter(s => s.length > 0);
    const sentences2 = prompt2.split(/(?<=[.!?])\s+/).filter(s => s.length > 0);

    const blended: string[] = [];
    const maxLen = Math.max(sentences1.length, sentences2.length);
    for (let j = 0; j < maxLen; j++) {
      if (j < sentences1.length && j % 2 === 0) {
        blended.push(sentences1[j]);
      } else if (j < sentences2.length) {
        blended.push(sentences2[j]);
      } else if (j < sentences1.length) {
        blended.push(sentences1[j]);
      }
    }

    child.agents[i].systemPrompt = blended.join(' ');
  }

  return child;
}

/**
 * Strategy Mutation: Change coordinationStrategy to a different value.
 */
export function strategyMutation(parent: TeamBlueprint): TeamBlueprint {
  const child = cloneBlueprint(parent);
  advanceGeneration(child, parent.id);

  const otherStrategies = STRATEGIES.filter(s => s !== parent.coordinationStrategy);
  child.coordinationStrategy = pick(otherStrategies);

  return child;
}

/**
 * Team Size Mutation: Add or remove agents (min 1, max 5).
 */
export function teamSizeMutation(parent: TeamBlueprint): TeamBlueprint {
  const child = cloneBlueprint(parent);
  advanceGeneration(child, parent.id);

  const canGrow = child.agents.length < 5;
  const canShrink = child.agents.length > 1;

  if (canGrow && canShrink) {
    if (Math.random() < 0.5) {
      // Add agent
      child.agents.push({
        role: 'contributor',
        model: pick(MODEL_TIERS),
        systemPrompt: 'You are a helpful team member.',
        skills: {},
        memoryBlocks: [],
      });
    } else {
      // Remove a non-coordinator agent
      const removableIdx = child.agents.findIndex(a => a.role !== 'coordinator');
      if (removableIdx >= 0) {
        child.agents.splice(removableIdx, 1);
      }
    }
  } else if (canGrow) {
    child.agents.push({
      role: 'contributor',
      model: pick(MODEL_TIERS),
      systemPrompt: 'You are a helpful team member.',
      skills: {},
      memoryBlocks: [],
    });
  } else if (canShrink) {
    const removableIdx = child.agents.findIndex(a => a.role !== 'coordinator');
    if (removableIdx >= 0) {
      child.agents.splice(removableIdx, 1);
    }
  }

  return child;
}

/**
 * Model Mutation: Swap an agent's model tier.
 */
export function modelMutation(parent: TeamBlueprint): TeamBlueprint {
  const child = cloneBlueprint(parent);
  advanceGeneration(child, parent.id);

  const agentIdx = randomInt(0, child.agents.length - 1);
  const currentModel = child.agents[agentIdx].model;
  const otherModels = MODEL_TIERS.filter(m => m !== currentModel);
  child.agents[agentIdx].model = pick(otherModels);

  return child;
}

// ─── Composite Variation ──────────────────────────────────────────────────────

const MUTATION_OPERATORS: Array<(bp: TeamBlueprint) => TeamBlueprint> = [
  skillMutation,
  roleMutation,
  strategyMutation,
  teamSizeMutation,
  modelMutation,
];

/**
 * Apply 1–3 random variation operators to a blueprint.
 * Crossover is excluded (requires 2 parents — use promptCrossover directly).
 */
export function applyVariation(parent: TeamBlueprint, numOps?: number): TeamBlueprint {
  const count = numOps ?? randomInt(1, 3);
  let result = cloneBlueprint(parent);
  // Reset generation tracking — we'll increment once
  const baseGeneration = parent.generation;

  for (let i = 0; i < count; i++) {
    const op = pick(MUTATION_OPERATORS);
    result = op(result);
  }

  // Normalize: set generation to parent+1 (not parent+N) and record parent
  result.generation = baseGeneration + 1;
  result.parentIds = [parent.id];

  return result;
}

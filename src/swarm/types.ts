/**
 * TEAM-Elites Type Definitions
 *
 * MAP-Elites quality-diversity evolution over multi-agent team blueprints.
 * Extends lettabot's existing types without breaking backward compatibility.
 */

import type { ChannelId, SkillsConfig } from '../core/types.js';

// =============================================================================
// Niche Dimensions
// =============================================================================

export type Domain = 'coding' | 'research' | 'scheduling' | 'communication' | 'general';

export interface NicheDescriptor {
  channel: ChannelId | 'multi-channel';
  domain: Domain;
  style?: 'concise' | 'detailed' | 'conversational' | 'technical' | 'creative';
  /** Computed key: `${channel}-${domain}` */
  key: string;
}

// =============================================================================
// Team Composition
// =============================================================================

export type CoordinationStrategy = 'sequential' | 'parallel' | 'debate' | 'pipeline';

export type AgentRole = 'coordinator' | 'contributor' | 'reviewer' | 'specialist';

export interface SwarmAgentConfig {
  role: AgentRole;
  model: string;
  systemPrompt: string;
  skills: SkillsConfig;
  memoryBlocks: Array<{ label: string; value: string }>;
}

// =============================================================================
// Fitness
// =============================================================================

export interface FitnessScores {
  composite: number;
  taskCompletion: number;
  reviewScore: number;
  reasoningDepth: number;
  consensusSpeed: number;
  costEfficiency: number;
  userSatisfaction?: number;
}

export interface FitnessWeights {
  w1: number; // taskCompletion (default 0.35)
  w2: number; // reviewScore (default 0.25)
  w3: number; // reasoningDepth (default 0.15)
  w4: number; // consensusSpeed (default 0.10)
  w5: number; // costEfficiency (default 0.15)
}

export const DEFAULT_FITNESS_WEIGHTS: FitnessWeights = {
  w1: 0.35,
  w2: 0.25,
  w3: 0.15,
  w4: 0.10,
  w5: 0.15,
};

// =============================================================================
// Team Blueprint (the "genome")
// =============================================================================

export interface HubRefs {
  workspaceId: string;
  problemId: string;
  proposalId?: string;
  consensusMarkerId?: string;
}

export interface TeamBlueprint {
  id: string;
  name: string;
  generation: number;
  parentIds: string[];
  agents: SwarmAgentConfig[];
  coordinationStrategy: CoordinationStrategy;
  niche: NicheDescriptor;
  fitness: FitnessScores;
  hubRefs: HubRefs;
}

// =============================================================================
// Variation
// =============================================================================

export type VariationOperator =
  | 'skillMutation'
  | 'roleMutation'
  | 'promptCrossover'
  | 'strategyMutation'
  | 'teamSizeMutation'
  | 'modelMutation';

// =============================================================================
// Swarm Registry (extends AgentStore pattern)
// =============================================================================

export type SwarmMode = 'single' | 'swarm';

export interface SwarmAgentEntry {
  agentId: string;
  blueprintId: string;
  nicheKey: string;
  conversationId?: string;
  createdAt: string;
}

export interface SwarmRegistry {
  schemaVersion: number;
  mode: SwarmMode;
  archiveReady?: boolean;
  routeSuccessCount?: number;
  routeFallbackCount?: number;
  routeSuccessByNiche?: Record<string, number>;
  routeFallbackByNiche?: Record<string, number>;
  unservedNicheCounts?: Record<string, number>;
  lastUnservedAt?: Record<string, string>;
  agents: SwarmAgentEntry[];
  blueprints: TeamBlueprint[];
  generation: number;
  hubAgentId?: string;
  hubWorkspaceId?: string;

  // Reasoning bridge state
  reasoningWorkspaceId?: string;
  reasoningSessionId?: string;
  reasoningProblemId?: string;
  agentHubIds?: Record<string, string>;

  // Single-mode backward compatibility (mirrors AgentStore)
  agentId?: string | null;
  conversationId?: string | null;
  baseUrl?: string;
  createdAt?: string;
  lastUsedAt?: string;
}

// =============================================================================
// Evolution Configuration
// =============================================================================

export interface EvolutionConfig {
  // Cron expression for evolution schedule (default: every 6 hours)

  schedule: string;
  /** Max blueprints to evaluate per generation */
  populationSize: number;
  /** Max total agents across all niches */
  maxAgents: number;
  /** Fitness weight overrides */
  fitnessWeights: FitnessWeights;
}

export const DEFAULT_EVOLUTION_CONFIG: EvolutionConfig = {
  schedule: '0 */6 * * *',
  populationSize: 5,
  maxAgents: 25,
  fitnessWeights: DEFAULT_FITNESS_WEIGHTS,
};

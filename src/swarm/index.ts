/**
 * TEAM-Elites — Swarm Module Re-exports
 */

export * from './types.js';
export { SwarmStore } from './swarm-store.js';
export { matchNiche, classifyDomain } from './niche-matcher.js';
export { HubClient } from './hub-client.js';
export {
  skillMutation,
  roleMutation,
  promptCrossover,
  strategyMutation,
  teamSizeMutation,
  modelMutation,
  applyVariation,
} from './variation-operators.js';
export { computeFitness, isEliteReplacement, normalizeReviewScore } from './fitness-evaluator.js';
export { EvolutionEngine } from './evolution-engine.js';
export { SwarmManager } from './swarm-manager.js';

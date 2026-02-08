/**
 * Fitness Evaluator — Composite Scoring
 *
 * Composite fitness = weighted sum of 5 components, clamped to [0,1].
 * Elite replacement decided by composite score (ties broken by costEfficiency).
 */

import type { FitnessScores, FitnessWeights } from './types.js';
import { DEFAULT_FITNESS_WEIGHTS } from './types.js';

function clamp(v: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, v));
}

export interface FitnessInput {
  taskCompletion: number;
  reviewScore: number;
  reasoningDepth: number;
  consensusSpeed: number;
  costEfficiency: number;
}

/**
 * Compute composite fitness as weighted sum of 5 components.
 * All components are clamped to [0, 1].
 */
export function computeFitness(
  input: FitnessInput,
  weights: FitnessWeights = DEFAULT_FITNESS_WEIGHTS,
): FitnessScores {
  const tc = clamp(input.taskCompletion);
  const rs = clamp(input.reviewScore);
  const rd = clamp(input.reasoningDepth);
  const cs = clamp(input.consensusSpeed);
  const ce = clamp(input.costEfficiency);

  const composite = clamp(
    weights.w1 * tc +
    weights.w2 * rs +
    weights.w3 * rd +
    weights.w4 * cs +
    weights.w5 * ce
  );

  return {
    composite,
    taskCompletion: tc,
    reviewScore: rs,
    reasoningDepth: rd,
    consensusSpeed: cs,
    costEfficiency: ce,
  };
}

/**
 * Determine if a candidate should replace the current elite.
 * Returns true if candidate.composite > current.composite,
 * or ties broken by costEfficiency.
 */
export function isEliteReplacement(
  candidate: FitnessScores,
  current: FitnessScores,
): boolean {
  if (candidate.composite > current.composite) return true;
  if (candidate.composite < current.composite) return false;
  // Tie: break by costEfficiency
  return candidate.costEfficiency > current.costEfficiency;
}

/**
 * Normalize a review verdict to a numeric score.
 */
export function normalizeReviewScore(
  verdict: 'approve' | 'comment' | 'request-changes',
): number {
  switch (verdict) {
    case 'approve': return 1.0;
    case 'comment': return 0.5;
    case 'request-changes': return 0.0;
  }
}

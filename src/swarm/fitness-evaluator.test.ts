/**
 * Fitness Evaluator Tests (M5)
 *
 * Hypothesis: Composite fitness = weighted sum of 5 components, clamped to [0,1],
 * with elite replacement decided by composite score (ties broken by costEfficiency).
 */

import { describe, it, expect } from 'vitest';
import {
  computeFitness,
  isEliteReplacement,
  normalizeReviewScore,
} from './fitness-evaluator.js';
import type { FitnessScores, FitnessWeights } from './types.js';
import { DEFAULT_FITNESS_WEIGHTS } from './types.js';

describe('Fitness Evaluator', () => {
  // T-FE-1
  it('computeFitness() returns weighted sum with default weights', () => {
    const scores = {
      taskCompletion: 1.0,
      reviewScore: 1.0,
      reasoningDepth: 1.0,
      consensusSpeed: 1.0,
      costEfficiency: 1.0,
    };
    const result = computeFitness(scores);
    // Sum of all weights = 0.35 + 0.25 + 0.15 + 0.10 + 0.15 = 1.0
    expect(result.composite).toBeCloseTo(1.0, 5);
  });

  // T-FE-2
  it('computeFitness() respects custom FitnessWeights', () => {
    const scores = {
      taskCompletion: 1.0,
      reviewScore: 0.0,
      reasoningDepth: 0.0,
      consensusSpeed: 0.0,
      costEfficiency: 0.0,
    };
    const weights: FitnessWeights = { w1: 1.0, w2: 0.0, w3: 0.0, w4: 0.0, w5: 0.0 };
    const result = computeFitness(scores, weights);
    expect(result.composite).toBeCloseTo(1.0, 5);

    const weights2: FitnessWeights = { w1: 0.0, w2: 1.0, w3: 0.0, w4: 0.0, w5: 0.0 };
    const result2 = computeFitness(scores, weights2);
    expect(result2.composite).toBeCloseTo(0.0, 5);
  });

  // T-FE-3
  it('all components clamped to [0, 1]', () => {
    const scores = {
      taskCompletion: 1.5,
      reviewScore: -0.3,
      reasoningDepth: 2.0,
      consensusSpeed: -1.0,
      costEfficiency: 1.1,
    };
    const result = computeFitness(scores);
    expect(result.composite).toBeGreaterThanOrEqual(0);
    expect(result.composite).toBeLessThanOrEqual(1);
    expect(result.taskCompletion).toBeLessThanOrEqual(1);
    expect(result.taskCompletion).toBeGreaterThanOrEqual(0);
    expect(result.reviewScore).toBeGreaterThanOrEqual(0);
    expect(result.consensusSpeed).toBeGreaterThanOrEqual(0);
  });

  // T-FE-4
  it('isEliteReplacement() returns true when new.composite > current.composite', () => {
    const current: FitnessScores = {
      composite: 0.6,
      taskCompletion: 0.7,
      reviewScore: 0.5,
      reasoningDepth: 0.5,
      consensusSpeed: 0.5,
      costEfficiency: 0.5,
    };
    const candidate: FitnessScores = {
      composite: 0.8,
      taskCompletion: 0.9,
      reviewScore: 0.7,
      reasoningDepth: 0.6,
      consensusSpeed: 0.8,
      costEfficiency: 0.7,
    };
    expect(isEliteReplacement(candidate, current)).toBe(true);
  });

  // T-FE-5
  it('isEliteReplacement() returns false when new.composite < current.composite', () => {
    const current: FitnessScores = {
      composite: 0.8,
      taskCompletion: 0.9,
      reviewScore: 0.7,
      reasoningDepth: 0.6,
      consensusSpeed: 0.8,
      costEfficiency: 0.7,
    };
    const candidate: FitnessScores = {
      composite: 0.5,
      taskCompletion: 0.5,
      reviewScore: 0.5,
      reasoningDepth: 0.5,
      consensusSpeed: 0.5,
      costEfficiency: 0.5,
    };
    expect(isEliteReplacement(candidate, current)).toBe(false);
  });

  // T-FE-6
  it('isEliteReplacement() breaks ties by costEfficiency', () => {
    const current: FitnessScores = {
      composite: 0.7,
      taskCompletion: 0.7,
      reviewScore: 0.7,
      reasoningDepth: 0.7,
      consensusSpeed: 0.7,
      costEfficiency: 0.5,
    };
    const better: FitnessScores = {
      composite: 0.7,
      taskCompletion: 0.7,
      reviewScore: 0.7,
      reasoningDepth: 0.7,
      consensusSpeed: 0.7,
      costEfficiency: 0.9,
    };
    const worse: FitnessScores = {
      composite: 0.7,
      taskCompletion: 0.7,
      reviewScore: 0.7,
      reasoningDepth: 0.7,
      consensusSpeed: 0.7,
      costEfficiency: 0.3,
    };
    expect(isEliteReplacement(better, current)).toBe(true);
    expect(isEliteReplacement(worse, current)).toBe(false);
  });

  // T-FE-7
  it('normalizeReviewScore() maps approve=1.0, comment=0.5, request-changes=0.0', () => {
    expect(normalizeReviewScore('approve')).toBe(1.0);
    expect(normalizeReviewScore('comment')).toBe(0.5);
    expect(normalizeReviewScore('request-changes')).toBe(0.0);
  });
});

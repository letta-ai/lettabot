/**
 * EvolutionEngine — Evolutionary Loop
 *
 * Orchestrates one generation by composing HubClient (archive),
 * variation operators, and fitness evaluator.
 */

import type { HubClient } from './hub-client.js';
import type { SwarmStore } from './swarm-store.js';
import type {
  EvolutionConfig,
  TeamBlueprint,
  NicheDescriptor,
  FitnessScores,
  SwarmAgentConfig,
} from './types.js';
import { applyVariation } from './variation-operators.js';
import { computeFitness, isEliteReplacement } from './fitness-evaluator.js';
import { logSwarmEvent } from './telemetry.js';
import type { SwarmProvisioner } from './provisioner.js';

function randomId(): string {
  return `bp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateRandomBlueprint(niche: NicheDescriptor): TeamBlueprint {
  return {
    id: randomId(),
    name: `Random-${niche.key}`,
    generation: 0,
    parentIds: [],
    agents: [{
      role: 'coordinator',
      model: 'anthropic/claude-sonnet-4-5-20250929',
      systemPrompt: `You are a helpful assistant specialized in ${niche.domain} tasks on ${niche.channel}.`,
      skills: {},
      memoryBlocks: [],
    }],
    coordinationStrategy: 'sequential',
    niche,
    fitness: {
      composite: 0,
      taskCompletion: 0,
      reviewScore: 0,
      reasoningDepth: 0,
      consensusSpeed: 0,
      costEfficiency: 0,
    },
    hubRefs: { workspaceId: '', problemId: '' },
  };
}

export class EvolutionEngine {
  private hubClient: HubClient;
  private store: SwarmStore;
  private config: EvolutionConfig;
  private nicheProblems: Map<string, string> = new Map(); // nicheKey → problemId
  private provisioner?: SwarmProvisioner;

  constructor(hubClient: HubClient, store: SwarmStore, config: EvolutionConfig, provisioner?: SwarmProvisioner) {
    this.hubClient = hubClient;
    this.store = store;
    this.config = config;
    this.provisioner = provisioner;
  }

  /**
   * Initialize the archive: register, create workspace, create problem per niche.
   */
  async initializeArchive(niches: NicheDescriptor[]): Promise<void> {
    // Register if we don't have a hub identity
    if (!this.store.hubAgentId) {
      const reg = await this.hubClient.register('TEAM-Elites-Coordinator', 'coordinator');
      this.store.hubAgentId = reg.agentId;
    }

    // Create workspace if needed
    if (!this.store.hubWorkspaceId) {
      const ws = await this.hubClient.createWorkspace(
        'team-elites-archive',
        'MAP-Elites quality-diversity archive for team blueprints',
      );
      this.store.hubWorkspaceId = ws.workspaceId;
    }

    // Create problem per niche
    for (const niche of niches) {
      if (!this.nicheProblems.has(niche.key)) {
        const prob = await this.hubClient.createProblem(
          this.store.hubWorkspaceId!,
          `niche:${niche.key}`,
          `Niche for ${niche.channel} ${niche.domain} tasks`,
        );
        this.nicheProblems.set(niche.key, prob.problemId);
      }
    }
  }

  /**
   * Select parents from ready niches.
   * Uses elite as parent if one exists, otherwise generates a random blueprint.
   */
  selectParents(niches: NicheDescriptor[]): { niche: NicheDescriptor; parent: TeamBlueprint } {
    const niche = pick(niches);
    const elite = this.store.getElite(niche);

    if (elite) {
      return { niche, parent: elite };
    }

    return { niche, parent: generateRandomBlueprint(niche) };
  }

  /**
   * Apply variation operators to produce a child blueprint.
   */
  variate(parent: TeamBlueprint): TeamBlueprint {
    return applyVariation(parent);
  }

  /**
   * Evaluate a blueprint's fitness.
   * In full implementation, this would create agents, send test messages, etc.
   * For now, generates simulated fitness scores.
   */
  async evaluate(blueprint: TeamBlueprint): Promise<FitnessScores> {
    // Simulated evaluation — in production, this would:
    // 1. createAgent() for each agent in blueprint
    // 2. Send niche-appropriate test messages
    // 3. Collect responses and compute fitness components
    const scores = computeFitness({
      taskCompletion: 0.5 + Math.random() * 0.5,
      reviewScore: 0.5 + Math.random() * 0.5,
      reasoningDepth: 0.3 + Math.random() * 0.7,
      consensusSpeed: 0.4 + Math.random() * 0.6,
      costEfficiency: 0.6 + Math.random() * 0.4,
    }, this.config.fitnessWeights);

    return scores;
  }

  /**
   * Submit a blueprint as a proposal via HubClient.
   */
  async submit(blueprint: TeamBlueprint, problemId: string): Promise<string> {
    const branchId = `gen${blueprint.generation}-${blueprint.id.slice(0, 8)}`;
    await this.hubClient.claimProblem(problemId, branchId);

    const result = await this.hubClient.createProposal(
      problemId,
      `Gen-${blueprint.generation}: ${blueprint.name}`,
      branchId,
      JSON.stringify({ blueprint, fitness: blueprint.fitness }),
    );

    return result.proposalId;
  }

  /**
   * Run one full generation: select→variate→evaluate→submit→review→merge/reject.
   */
  async runGeneration(niches: NicheDescriptor[]): Promise<void> {
    const iterations = Math.min(this.config.populationSize, niches.length);

    for (let i = 0; i < iterations; i++) {
      // 1. Select parents
      const { niche, parent } = this.selectParents(niches);
      const problemId = this.nicheProblems.get(niche.key);
      if (!problemId) continue;

      // 2. Variate
      const child = this.variate(parent);
      child.niche = niche;

      // 3. Evaluate
      const fitness = await this.evaluate(child);
      child.fitness = fitness;
      logSwarmEvent('evolution_candidate_evaluated', {
        nicheKey: niche.key,
        blueprintId: child.id,
        generation: child.generation,
        composite: fitness.composite,
      });

      // 4. Submit
      const proposalId = await this.submit(child, problemId);

      // 5. Review (self-review in automated mode)
      const currentElite = this.store.getElite(niche);
      const shouldMerge = !currentElite || isEliteReplacement(fitness, currentElite.fitness);
      const verdict = shouldMerge ? 'approve' : 'request-changes';
      await this.hubClient.reviewProposal(proposalId, verdict as any,
        shouldMerge ? 'Fitness exceeds current elite' : 'Fitness below current elite');

      // 6. Merge or reject
      if (shouldMerge) {
        await this.hubClient.mergeProposal(proposalId);

        // Update store with new elite
        child.hubRefs = {
          workspaceId: this.store.hubWorkspaceId!,
          problemId,
          proposalId,
        };
        this.store.setBlueprint(child);
        this.store.generation = child.generation;

        if (this.provisioner) {
          try {
            const agentId = await this.provisioner.provisionNicheAgent(child);
            this.store.setAgentForNiche(agentId, child.id, niche.key);
            logSwarmEvent('provision_merge_success', {
              nicheKey: niche.key,
              blueprintId: child.id,
              agentId,
            });
          } catch (err) {
            logSwarmEvent('provision_merge_failed', {
              nicheKey: niche.key,
              blueprintId: child.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        logSwarmEvent('evolution_candidate_merged', {
          nicheKey: niche.key,
          blueprintId: child.id,
          generation: child.generation,
          composite: child.fitness.composite,
        });
      } else {
        logSwarmEvent('evolution_candidate_rejected', {
          nicheKey: niche.key,
          blueprintId: child.id,
          generation: child.generation,
          composite: child.fitness.composite,
          eliteComposite: currentElite?.fitness.composite,
        });
      }
    }
  }
}

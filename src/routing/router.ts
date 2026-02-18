/**
 * Message Router
 * 
 * Routes incoming messages to the correct agent based on bindings.
 * Priority: peer match > accountId match > channel match > default agent
 */

import type { AgentBinding } from '../config/types.js';

/**
 * Context for routing a message
 */
export interface RoutingContext {
  /** Channel type: "telegram", "slack", etc. */
  channel: string;
  /** Account ID for multi-account channels */
  accountId?: string;
  /** Chat/User ID */
  peerId?: string;
  /** Type of peer */
  peerKind?: 'dm' | 'group';
}

/**
 * Result of routing
 */
export interface RoutingResult {
  /** Target agent ID */
  agentId: string;
  /** Which binding matched (null if default) */
  matchedBinding: AgentBinding | null;
  /** Match specificity level */
  matchLevel: 'peer' | 'account' | 'channel' | 'default';
}

/**
 * Message router that matches bindings to find target agent
 */
export class MessageRouter {
  private bindings: AgentBinding[];
  private defaultAgentId: string;
  
  constructor(bindings: AgentBinding[], defaultAgentId: string) {
    // Sort bindings by specificity (most specific first)
    this.bindings = this.sortBySpecificity(bindings);
    this.defaultAgentId = defaultAgentId;
  }
  
  /**
   * Route a message to an agent
   */
  route(ctx: RoutingContext): RoutingResult {
    for (const binding of this.bindings) {
      const matchLevel = this.getMatchLevel(binding, ctx);
      if (matchLevel) {
        return {
          agentId: binding.agentId,
          matchedBinding: binding,
          matchLevel,
        };
      }
    }
    
    return {
      agentId: this.defaultAgentId,
      matchedBinding: null,
      matchLevel: 'default',
    };
  }
  
  /**
   * Get the match level for a binding against context
   * Returns null if no match, or the specificity level if matched
   */
  private getMatchLevel(binding: AgentBinding, ctx: RoutingContext): 'peer' | 'account' | 'channel' | null {
    // Channel must always match
    if (binding.match.channel !== ctx.channel) {
      return null;
    }
    
    // Check peer match (most specific)
    if (binding.match.peer) {
      if (!ctx.peerId || !ctx.peerKind) {
        return null;
      }
      if (binding.match.peer.kind !== ctx.peerKind) {
        return null;
      }
      if (binding.match.peer.id !== ctx.peerId) {
        return null;
      }
      // Peer matches - also check accountId if specified
      if (binding.match.accountId && binding.match.accountId !== ctx.accountId) {
        return null;
      }
      return 'peer';
    }
    
    // Check account match
    if (binding.match.accountId) {
      if (binding.match.accountId !== ctx.accountId) {
        return null;
      }
      return 'account';
    }
    
    // Channel-only match (least specific)
    return 'channel';
  }
  
  /**
   * Sort bindings by specificity
   * 
   * Order: peer+account > peer > account > channel
   */
  private sortBySpecificity(bindings: AgentBinding[]): AgentBinding[] {
    return [...bindings].sort((a, b) => {
      const scoreA = this.getSpecificityScore(a);
      const scoreB = this.getSpecificityScore(b);
      return scoreB - scoreA; // Higher score = more specific = first
    });
  }
  
  /**
   * Calculate specificity score for sorting
   */
  private getSpecificityScore(binding: AgentBinding): number {
    let score = 0;
    
    // Peer match is most specific
    if (binding.match.peer) {
      score += 100;
    }
    
    // Account ID adds specificity
    if (binding.match.accountId) {
      score += 10;
    }
    
    // Channel is baseline (always present)
    score += 1;
    
    return score;
  }
  
  /**
   * Get all bindings for a specific agent
   */
  getBindingsForAgent(agentId: string): AgentBinding[] {
    return this.bindings.filter(b => b.agentId === agentId);
  }
  
  /**
   * Get all unique agent IDs from bindings
   */
  getRoutedAgentIds(): string[] {
    const ids = new Set<string>();
    for (const binding of this.bindings) {
      ids.add(binding.agentId);
    }
    ids.add(this.defaultAgentId);
    return Array.from(ids);
  }
  
  /**
   * Debug: describe the routing decision for a context
   */
  describeRoute(ctx: RoutingContext): string {
    const result = this.route(ctx);
    
    if (result.matchLevel === 'default') {
      return `→ ${result.agentId} (default agent)`;
    }
    
    const binding = result.matchedBinding!;
    const matchDesc = [];
    matchDesc.push(`channel=${binding.match.channel}`);
    if (binding.match.accountId) {
      matchDesc.push(`account=${binding.match.accountId}`);
    }
    if (binding.match.peer) {
      matchDesc.push(`peer=${binding.match.peer.kind}:${binding.match.peer.id}`);
    }
    
    return `→ ${result.agentId} (matched: ${matchDesc.join(', ')})`;
  }
}

/**
 * Create a router from normalized config
 */
export function createRouter(bindings: AgentBinding[], defaultAgentId: string): MessageRouter {
  return new MessageRouter(bindings, defaultAgentId);
}

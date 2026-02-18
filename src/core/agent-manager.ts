/**
 * Agent Manager
 * 
 * Manages multiple agent instances in multi-agent mode.
 * Creates, retrieves, and manages lifecycle of AgentInstance objects.
 */

import type { NormalizedConfig, AgentConfig } from '../config/types.js';
import { AgentInstance, type AgentInstanceConfig } from './agent-instance.js';
import { agentExists, findAgentByName } from '../tools/letta-api.js';

/**
 * Manager for multiple agent instances
 */
export class AgentManager {
  private agents: Map<string, AgentInstance> = new Map();
  private defaultAgentId: string;
  private config: NormalizedConfig;
  
  constructor(config: NormalizedConfig) {
    this.config = config;
    
    // Find default agent
    const defaultAgent = config.agents.list.find(a => a.default) || config.agents.list[0];
    this.defaultAgentId = defaultAgent.id;
    
    // Create agent instances
    for (const agentConfig of config.agents.list) {
      const instance = this.createInstance(agentConfig);
      this.agents.set(agentConfig.id, instance);
    }
    
    console.log(`[AgentManager] Initialized ${this.agents.size} agent(s). Default: ${this.defaultAgentId}`);
  }
  
  /**
   * Get an agent instance by ID
   */
  getAgent(agentId: string): AgentInstance | undefined {
    return this.agents.get(agentId);
  }
  
  /**
   * Get the default agent
   */
  getDefaultAgent(): AgentInstance {
    return this.agents.get(this.defaultAgentId)!;
  }
  
  /**
   * Get the default agent ID
   */
  getDefaultAgentId(): string {
    return this.defaultAgentId;
  }
  
  /**
   * List all agent IDs
   */
  listAgentIds(): string[] {
    return Array.from(this.agents.keys());
  }
  
  /**
   * List all agents with their info
   */
  listAgents(): Array<{
    configId: string;
    name: string;
    workspace: string;
    agentId: string | null;
    isDefault: boolean;
  }> {
    return Array.from(this.agents.values()).map(agent => ({
      configId: agent.configId,
      name: agent.name,
      workspace: agent.workspace,
      agentId: agent.agentId,
      isDefault: agent.configId === this.defaultAgentId,
    }));
  }
  
  /**
   * Verify all agents exist on the server
   * Clears agent IDs that no longer exist
   */
  async verifyAgents(): Promise<void> {
    for (const [configId, agent] of this.agents) {
      if (agent.agentId) {
        const exists = await agentExists(agent.agentId);
        if (!exists) {
          console.log(`[AgentManager] Agent ${configId} (${agent.agentId}) not found on server, clearing...`);
          agent.reset();
        }
      }
    }
  }
  
  /**
   * Try to discover existing agents by name on the server
   * Useful for container deploys where agents already exist
   */
  async discoverAgentsByName(): Promise<void> {
    for (const [configId, agent] of this.agents) {
      if (!agent.agentId) {
        console.log(`[AgentManager] Searching for existing agent named "${agent.name}"...`);
        const found = await findAgentByName(agent.name);
        if (found) {
          console.log(`[AgentManager] Found existing agent: ${found.id}`);
          agent.setAgentId(found.id);
        }
      }
    }
  }
  
  /**
   * Get status summary
   */
  getStatus(): {
    totalAgents: number;
    defaultAgentId: string;
    agents: Array<{
      configId: string;
      name: string;
      agentId: string | null;
      isDefault: boolean;
    }>;
  } {
    return {
      totalAgents: this.agents.size,
      defaultAgentId: this.defaultAgentId,
      agents: this.listAgents(),
    };
  }
  
  /**
   * Create an agent instance from config
   */
  private createInstance(agentConfig: AgentConfig): AgentInstance {
    const defaultModel = this.config.agents.defaults?.model;
    
    const instanceConfig: AgentInstanceConfig = {
      configId: agentConfig.id,
      name: agentConfig.name || agentConfig.id,
      workspace: agentConfig.workspace,
      model: agentConfig.model || defaultModel,
    };
    
    return new AgentInstance(instanceConfig);
  }
}

/**
 * Create an agent manager from normalized config
 */
export function createAgentManager(config: NormalizedConfig): AgentManager {
  return new AgentManager(config);
}

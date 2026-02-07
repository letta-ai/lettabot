/**
 * lettabot model - Manage the agent's model
 * 
 * Subcommands:
 *   lettabot model         - Interactive model selector
 *   lettabot model show    - Show current agent model
 *   lettabot model set <handle>  - Set model by handle
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDataDir } from '../utils/paths.js';
import { getAgentModel, updateAgentModel, listModels } from '../tools/letta-api.js';
import { buildModelOptions, handleModelSelection, getBillingTier } from '../utils/model-selection.js';
import { isLettaCloudUrl } from '../utils/server.js';

/**
 * Get agent ID from store file
 */
function getAgentId(): string | null {
  const storePath = resolve(getDataDir(), 'lettabot-agent.json');
  if (!existsSync(storePath)) return null;
  try {
    const store = JSON.parse(readFileSync(storePath, 'utf-8'));
    return store.agentId || null;
  } catch {
    return null;
  }
}

/**
 * Show the current agent's model
 */
export async function modelShow(): Promise<void> {
  const agentId = getAgentId();
  if (!agentId) {
    console.error('No agent found. Run `lettabot server` first to create an agent.');
    process.exit(1);
  }

  const model = await getAgentModel(agentId);
  if (model) {
    console.log(`Agent model: ${model}`);
  } else {
    console.error('Could not retrieve agent model. Check your connection and API key.');
    process.exit(1);
  }
}

/**
 * Set the agent's model by handle
 */
export async function modelSet(handle: string): Promise<void> {
  const agentId = getAgentId();
  if (!agentId) {
    console.error('No agent found. Run `lettabot server` first to create an agent.');
    process.exit(1);
  }

  console.log(`Setting model to: ${handle}`);
  const success = await updateAgentModel(agentId, handle);
  if (success) {
    console.log(`Model updated to: ${handle}`);
  } else {
    console.error('Failed to update model. Check the handle is valid and try again.');
    process.exit(1);
  }
}

/**
 * Interactive model selector
 */
export async function modelInteractive(): Promise<void> {
  const p = await import('@clack/prompts');

  const agentId = getAgentId();
  if (!agentId) {
    console.error('No agent found. Run `lettabot server` first to create an agent.');
    process.exit(1);
  }

  p.intro('Model Management');

  // Show current model
  const currentModel = await getAgentModel(agentId);
  if (currentModel) {
    p.log.info(`Current model: ${currentModel}`);
  }

  // Determine if self-hosted
  const baseUrl = process.env.LETTA_BASE_URL;
  const isSelfHosted = !!baseUrl && !isLettaCloudUrl(baseUrl);

  // Get billing tier for cloud users
  let billingTier: string | null = null;
  if (!isSelfHosted) {
    const spinner = p.spinner();
    spinner.start('Checking account...');
    const apiKey = process.env.LETTA_API_KEY;
    billingTier = await getBillingTier(apiKey, isSelfHosted);
    spinner.stop(billingTier === 'free' ? 'Free plan' : `Plan: ${billingTier || 'Pro'}`);
  }

  // Build model options
  const spinner = p.spinner();
  spinner.start('Fetching available models...');
  const apiKey = process.env.LETTA_API_KEY;
  const modelOptions = await buildModelOptions({ billingTier, isSelfHosted, apiKey });
  spinner.stop(`${modelOptions.length} models available`);

  // Show model selector
  let selectedModel: string | null = null;
  while (!selectedModel) {
    const modelChoice = await p.select({
      message: 'Select model',
      options: modelOptions,
      maxItems: 12,
    });
    if (p.isCancel(modelChoice)) {
      p.cancel('Cancelled');
      return;
    }

    selectedModel = await handleModelSelection(modelChoice, p.text);
    // If null (e.g., header selected), loop again
  }

  // Update the model
  const updateSpinner = p.spinner();
  updateSpinner.start(`Updating model to ${selectedModel}...`);
  const success = await updateAgentModel(agentId, selectedModel);
  if (success) {
    updateSpinner.stop(`Model updated to: ${selectedModel}`);
  } else {
    updateSpinner.stop('Failed to update model');
    p.log.error('Check the model handle is valid and try again.');
  }

  p.outro('Done');
}

/**
 * Main model command handler
 */
export async function modelCommand(subCommand?: string, arg?: string): Promise<void> {
  switch (subCommand) {
    case 'show':
      await modelShow();
      break;
    case 'set':
      if (!arg) {
        console.error('Usage: lettabot model set <handle>');
        console.error('Example: lettabot model set anthropic/claude-sonnet-4-5-20250929');
        process.exit(1);
      }
      await modelSet(arg);
      break;
    case undefined:
    case '':
      await modelInteractive();
      break;
    default:
      console.error(`Unknown subcommand: ${subCommand}`);
      console.error('Usage: lettabot model [show|set <handle>]');
      process.exit(1);
  }
}

/**
 * lettabot model - Manage the agent's model
 * 
 * Subcommands:
 *   lettabot model         - Interactive model selector
 *   lettabot model show    - Show current agent model
 *   lettabot model set <handle>  - Set model by handle
 */

import { getAgentModel, updateAgentModel } from '../tools/letta-api.js';
import { buildModelOptions, handleModelSelection, getBillingTier } from '../utils/model-selection.js';
import { isLettaApiUrl } from '../utils/server.js';
import { Store } from '../core/store.js';

import { createLogger } from '../logger.js';

const log = createLogger('Model');
/**
 * Get agent ID from store file (supports v1 and v2 formats)
 */
function getAgentId(): string | null {
  const store = new Store();
  return store.agentId;
}

/**
 * Show the current agent's model
 */
export async function modelShow(): Promise<void> {
  const agentId = getAgentId();
  if (!agentId) {
    log.error('No agent found. Run `lettabot server` first to create an agent.');
    process.exit(1);
  }

  const model = await getAgentModel(agentId);
  if (model) {
    log.info(`Agent model: ${model}`);
  } else {
    log.error('Could not retrieve agent model. Check your connection and API key.');
    process.exit(1);
  }
}

/**
 * Set the agent's model by handle
 */
export async function modelSet(handle: string): Promise<void> {
  const agentId = getAgentId();
  if (!agentId) {
    log.error('No agent found. Run `lettabot server` first to create an agent.');
    process.exit(1);
  }

  log.info(`Setting model to: ${handle}`);
  const success = await updateAgentModel(agentId, handle);
  if (success) {
    log.info(`Model updated to: ${handle}`);
  } else {
    log.error('Failed to update model. Check the handle is valid and try again.');
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
    log.error('No agent found. Run `lettabot server` first to create an agent.');
    process.exit(1);
  }

  p.intro('Model Management');

  // Show current model
  const currentModel = await getAgentModel(agentId);
  if (currentModel) {
    p.log.info(`Current model: ${currentModel}`);
  }

  // Determine if using Docker/custom server
  const baseUrl = process.env.LETTA_BASE_URL;
  const isSelfHosted = !!baseUrl && !isLettaApiUrl(baseUrl);

  // Get billing tier for Letta API users
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
        log.error('Usage: lettabot model set <handle>');
        log.error('Example: lettabot model set anthropic/claude-sonnet-4-5-20250929');
        process.exit(1);
      }
      await modelSet(arg);
      break;
    case undefined:
    case '':
      await modelInteractive();
      break;
    default:
      log.error(`Unknown subcommand: ${subCommand}`);
      log.error('Usage: lettabot model [show|set <handle>]');
      process.exit(1);
  }
}

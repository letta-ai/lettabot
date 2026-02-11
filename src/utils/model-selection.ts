/**
 * Shared utilities for model selection UI
 * 
 * Follows letta-code approach:
 * - Free plan users see free models (GLM, MiniMax) + BYOK options
 * - Paid users see all models with featured/recommended at top
 */

import type * as p from '@clack/prompts';
import modelsData from '../models.json' with { type: 'json' };

export const models = modelsData as ModelInfo[];

export interface ModelInfo {
  id: string;
  handle: string;
  label: string;
  description: string;
  isDefault?: boolean;
  isFeatured?: boolean;
  free?: boolean;
}

/**
 * Get billing tier from Letta API
 * Uses /v1/metadata/balance endpoint (same as letta-code)
 * 
 * @param apiKey - The API key to use
 * @param isSelfHosted - If true, skip billing check (Docker/custom servers have no tiers)
 */
export async function getBillingTier(apiKey?: string, isSelfHosted?: boolean): Promise<string | null> {
  try {
    // Docker/custom servers don't have billing tiers.
    if (isSelfHosted) {
      return null;
    }
    
    if (!apiKey) {
      return 'free';
    }
    
    // Always use Letta API for billing check (not process.env.LETTA_BASE_URL)
    const response = await fetch('https://api.letta.com/v1/metadata/balance', {
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
    });
    
    if (!response.ok) {
      return 'free';
    }
    
    const data = await response.json() as { billing_tier?: string };
    const tier = data.billing_tier?.toLowerCase() ?? 'free';
    return tier;
  } catch {
    return 'free';
  }
}

/**
 * Get the default model for a billing tier
 */
export function getDefaultModelForTier(billingTier?: string | null): string {
  // Free tier gets glm-4.7 (a free model)
  if (billingTier?.toLowerCase() === 'free') {
    const freeDefault = models.find(m => m.id === 'glm-4.7');
    if (freeDefault) return freeDefault.handle;
  }
  // Everyone else gets the standard default
  const defaultModel = models.find(m => m.isDefault);
  return defaultModel?.handle ?? models[0]?.handle ?? 'anthropic/claude-sonnet-4-5-20250929';
}

interface ByokModel {
  handle: string;
  name: string;
  display_name?: string;
  provider_name: string;
  provider_type: string;
}

/**
 * Fetch BYOK models from Letta API
 */
async function fetchByokModels(apiKey?: string): Promise<ByokModel[]> {
  try {
    const key = apiKey || process.env.LETTA_API_KEY;
    if (!key) return [];
    
    const response = await fetch('https://api.letta.com/v1/models?provider_category=byok', {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
    });
    
    if (!response.ok) return [];
    
    const models = await response.json() as ByokModel[];
    return models;
  } catch {
    return [];
  }
}

/**
 * Build model selection options based on billing tier
 * Returns array ready for @clack/prompts select()
 * 
 * For free users: Show free models first, then BYOK models from API
 * For paid users: Show featured models first, then all models
 * For Docker/custom servers: fetch models from server
 */
export async function buildModelOptions(options?: {
  billingTier?: string | null;
  isSelfHosted?: boolean;
  apiKey?: string;
}): Promise<Array<{ value: string; label: string; hint: string }>> {
  const billingTier = options?.billingTier;
  const isSelfHosted = options?.isSelfHosted;
  const isFreeTier = billingTier?.toLowerCase() === 'free';
  
  // For Docker/custom servers, fetch models from server
  if (isSelfHosted) {
    return buildServerModelOptions();
  }
  
  const result: Array<{ value: string; label: string; hint: string }> = [];
  
  if (isFreeTier) {
    // Free tier: Show free models first
    const freeModels = models.filter(m => m.free);
    result.push(...freeModels.map(m => ({
      value: m.handle,
      label: m.label,
      hint: `🆓 Free - ${m.description}`,
    })));
    
    // Fetch BYOK models from API
    const byokModels = await fetchByokModels(options?.apiKey);
    if (byokModels.length > 0) {
      result.push({
        value: '__byok_header__',
        label: '── Your Connected Providers ──',
        hint: 'Models from your API keys',
      });
      
      result.push(...byokModels.map(m => ({
        value: m.handle,
        label: m.display_name || m.name,
        hint: `🔑 ${m.provider_name}`,
      })));
    }
  } else {
    // Paid tier: Show featured models first
    const featured = models.filter(m => m.isFeatured);
    const nonFeatured = models.filter(m => !m.isFeatured);
    
    result.push(...featured.map(m => ({
      value: m.handle,
      label: m.label,
      hint: m.free ? `🆓 Free - ${m.description}` : `⭐ ${m.description}`,
    })));
    
    result.push(...nonFeatured.map(m => ({
      value: m.handle,
      label: m.label,
      hint: m.description,
    })));
  }
  
  // Add custom option
  result.push({ 
    value: '__custom__', 
    label: 'Other (specify handle)', 
    hint: 'e.g. anthropic/claude-sonnet-4-5-20250929' 
  });
  
  return result;
}

/**
 * Build model options from Docker/custom server
 */
async function buildServerModelOptions(): Promise<Array<{ value: string; label: string; hint: string }>> {
  const { listModels } = await import('../tools/letta-api.js');
  
  // Fetch all models from server
  const serverModels = await listModels();
  
  const result: Array<{ value: string; label: string; hint: string }> = [];
  
  // Sort by display name
  const sorted = serverModels.sort((a, b) => 
    (a.display_name || a.name).localeCompare(b.display_name || b.name)
  );
  
  result.push(...sorted.map(m => ({
    value: m.handle,
    label: m.display_name || m.name,
    hint: m.handle,
  })));
  
  // Add custom option
  result.push({ 
    value: '__custom__', 
    label: 'Other (specify handle)', 
    hint: 'e.g. anthropic/claude-sonnet-4-5-20250929' 
  });
  
  return result;
}

/**
 * Handle model selection including custom input
 * Returns the selected model handle or null if cancelled/header selected
 */
export async function handleModelSelection(
  selection: string | symbol,
  promptFn: typeof p.text,
): Promise<string | null> {
  // Handle cancellation
  const p = await import('@clack/prompts');
  if (p.isCancel(selection)) return null;
  
  // Skip header selections
  if (selection === '__byok_header__') return null;
  
  // Handle custom model input
  if (selection === '__custom__') {
    const custom = await promptFn({
      message: 'Model handle',
      placeholder: 'provider/model-name (e.g., anthropic/claude-sonnet-4-5-20250929)',
    });
    if (p.isCancel(custom) || !custom) return null;
    return custom as string;
  }
  
  // Regular model selection
  return selection as string;
}

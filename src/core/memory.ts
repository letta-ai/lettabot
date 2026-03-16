/**
 * Memory loader - reads .mdx files from src/memories/ and returns
 * CreateBlock objects for the Letta Code SDK.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

import { createLogger } from '../logger.js';

const log = createLogger('Memory');
const __dirname = dirname(fileURLToPath(import.meta.url));
// Try dist/memories first, fall back to src/memories
const MEMORIES_DIR = existsSync(join(__dirname, '..', 'memories'))
  ? join(__dirname, '..', 'memories')
  : join(__dirname, '..', '..', 'src', 'memories');

export interface MemoryBlock {
  label: string;
  value: string;
  description?: string;
  limit?: number;
}

function parseMemoryBlock(
  raw: string,
  filename: string,
  agentName: string,
): { block: MemoryBlock; managedExternally: boolean } {
  const { data, content } = matter(raw);
  const label = data.label || filename.replace('.mdx', '');
  const block: MemoryBlock = {
    label,
    value: content.trim().replaceAll('{{AGENT_NAME}}', agentName),
  };

  if (data.description) block.description = data.description;
  if (data.limit) block.limit = Number(data.limit);

  return {
    block,
    managedExternally: data.managedExternally === true,
  };
}

/**
 * Load all .mdx files from the memories directory and parse them into
 * memory blocks for the SDK's `memory` option.
 *
 * @param agentName - Name to substitute for {{AGENT_NAME}} in block values
 */
export function loadMemoryBlocks(agentName = 'LettaBot'): MemoryBlock[] {
  if (!existsSync(MEMORIES_DIR)) {
    log.warn(`No memories directory found at ${MEMORIES_DIR}`);
    return [];
  }
  
  const files = readdirSync(MEMORIES_DIR).filter((f: string) => f.endsWith('.mdx'));
  const blocks: MemoryBlock[] = [];

  for (const file of files) {
    const raw = readFileSync(join(MEMORIES_DIR, file), 'utf-8');
    const { block, managedExternally } = parseMemoryBlock(raw, file, agentName);
    if (managedExternally) continue;
    blocks.push(block);
  }

  return blocks;
}

export function loadManagedMemoryBlock(
  label: string,
  agentName = 'LettaBot',
): MemoryBlock | null {
  if (!existsSync(MEMORIES_DIR)) {
    return null;
  }

  const files = readdirSync(MEMORIES_DIR).filter((f: string) => f.endsWith('.mdx'));
  for (const file of files) {
    const raw = readFileSync(join(MEMORIES_DIR, file), 'utf-8');
    const parsed = parseMemoryBlock(raw, file, agentName);
    if (!parsed.managedExternally) continue;
    if (parsed.block.label === label) {
      return parsed.block;
    }
  }

  return null;
}

/**
 * Loom loader — reads community-contributed .txt loom files
 * from src/looms/ and picks one randomly at startup.
 *
 * File format:
 *   # name: My Loom
 *   # author: githubuser
 *   # version: 1.0
 *   ---
 *   ╔════════════════╗
 *   ║  loom art here ║
 *   ╚════════════════╝
 *
 * Everything above --- is metadata (# key: value).
 * Everything below --- is the raw art printed to the terminal.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../logger.js';

const log = createLogger('Looms');

export interface LoomMetadata {
  name: string;
  author: string;
  version?: string;
}

export interface Loom {
  metadata: LoomMetadata;
  lines: string[];
  filename: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Parse a loom .txt file into metadata + art lines. */
export function parseLoomFile(content: string, filename: string): Loom | null {
  const separatorIndex = content.indexOf('\n---\n');
  if (separatorIndex === -1) {
    // Also handle --- at the very start or with \r\n
    const altIndex = content.indexOf('\r\n---\r\n');
    if (altIndex === -1) {
      log.warn(`Skipping ${filename}: no --- separator found`);
      return null;
    }
    return parseLoomContent(
      content.slice(0, altIndex),
      content.slice(altIndex + 7), // skip \r\n---\r\n
      filename,
    );
  }
  return parseLoomContent(
    content.slice(0, separatorIndex),
    content.slice(separatorIndex + 5), // skip \n---\n
    filename,
  );
}

function parseLoomContent(header: string, art: string, filename: string): Loom | null {
  // Parse metadata from # key: value lines
  const meta: Record<string, string> = {};
  for (const line of header.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^#\s*(\w+)\s*:\s*(.+)$/);
    if (match) {
      meta[match[1].toLowerCase()] = match[2].trim();
    }
  }

  if (!meta.name || !meta.author) {
    log.warn(`Skipping ${filename}: missing required name or author in metadata`);
    return null;
  }

  // Split art into lines, removing trailing empty lines
  const lines = art.split(/\r?\n/);

  // Trim leading empty line (artifact of \n---\n split)
  if (lines.length > 0 && lines[0].trim() === '') {
    lines.shift();
  }

  // Trim trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }

  return {
    metadata: {
      name: meta.name,
      author: meta.author,
      version: meta.version,
    },
    lines,
    filename,
  };
}

/** Load all valid loom files from the looms directory. */
export function loadAllLooms(loomsDir?: string): Loom[] {
  const dir = loomsDir ?? __dirname;
  const looms: Loom[] = [];

  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.txt'));
  } catch (err) {
    log.warn(`Could not read looms directory: ${dir}`);
    return looms;
  }

  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), 'utf-8');
      const loom = parseLoomFile(content, file);
      if (loom) {
        looms.push(loom);
      }
    } catch (err) {
      log.warn(`Error reading ${file}:`, err);
    }
  }

  return looms;
}

/** Pick a random loom from the directory, or null if none available. */
export function loadRandomLoom(loomsDir?: string): Loom | null {
  const looms = loadAllLooms(loomsDir);
  if (looms.length === 0) return null;
  const index = Math.floor(Math.random() * looms.length);
  return looms[index];
}

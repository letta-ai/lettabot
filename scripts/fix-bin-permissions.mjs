#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { chmodSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const packageJsonPath = resolve(repoRoot, 'package.json');

function normalizeBinPaths(binField) {
  if (!binField) return [];
  if (typeof binField === 'string') return [binField];
  if (typeof binField === 'object') return Object.values(binField).filter((v) => typeof v === 'string');
  return [];
}

function ensureExecutable(filePath) {
  const stat = statSync(filePath);
  const nextMode = stat.mode | 0o111;
  if (nextMode !== stat.mode) {
    chmodSync(filePath, nextMode);
    return true;
  }
  return false;
}

async function main() {
  const pkgRaw = await readFile(packageJsonPath, 'utf8');
  const pkg = JSON.parse(pkgRaw);
  const binPaths = normalizeBinPaths(pkg.bin);

  if (binPaths.length === 0) {
    console.warn('[postbuild] No bin entries found in package.json');
    return;
  }

  let changed = 0;
  for (const relativeBinPath of binPaths) {
    const cleanRelPath = relativeBinPath.replace(/^\.\//, '');
    const absolutePath = resolve(repoRoot, cleanRelPath);
    const didChange = ensureExecutable(absolutePath);
    if (didChange) changed += 1;
  }

  console.log(`[postbuild] Ensured executable bit on ${binPaths.length} bin file(s); updated ${changed}.`);
}

main().catch((error) => {
  console.error('[postbuild] Failed to fix bin permissions:', error);
  process.exit(1);
});

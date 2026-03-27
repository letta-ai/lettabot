#!/usr/bin/env node
/**
 * copy-looms.mjs - Cross-platform postbuild script for copying loom .txt files
 *
 * Replaces the Unix-only `cp -r src/looms/*.txt dist/looms/` in the postbuild
 * step. Works on Linux, macOS, and Windows.
 */

import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const srcDir = join(repoRoot, 'src', 'looms');
const destDir = join(repoRoot, 'dist', 'looms');

async function main() {
  // Ensure dest directory exists
  await mkdir(destDir, { recursive: true });

  const entries = await readdir(srcDir);
  const txtFiles = entries.filter((f) => extname(f) === '.txt');

  if (txtFiles.length === 0) {
    console.warn('[copy-looms] No .txt files found in src/looms/');
    return;
  }

  let copied = 0;
  for (const file of txtFiles) {
    await copyFile(join(srcDir, file), join(destDir, file));
    copied++;
  }

  console.log(`[copy-looms] Copied ${copied} loom file(s) to dist/looms/`);
}

main().catch((err) => {
  console.error('[copy-looms] Failed:', err);
  process.exit(1);
});

/**
 * Use Letta Code's provider connection flow from Lettabot.
 */

import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

interface CommandCandidate {
  command: string;
  args: string[];
}

const require = createRequire(import.meta.url);

/** Lines that add noise without helping the user. */
const SUPPRESSED_PATTERNS = [
  /^Checking account/i,
  /^Starting OAuth/i,
  /^Starting local OAuth/i,
  /^A browser window will open/i,
  /^Opening browser/i,
  /^Waiting for authorization/i,
  /^Please complete the sign-in/i,
  /^The page will redirect/i,
  /^Authorization received/i,
  /^Exchanging code/i,
  /^Extracting account/i,
  /^Creating ChatGPT/i,
];

/** Lines we rewrite to something shorter. */
const REWRITE_RULES: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /^If the browser doesn't open automatically,? visit:$/i, replacement: 'If the browser doesn\'t open, visit:' },
  { pattern: /^If needed,? visit:$/i, replacement: '' }, // suppress the duplicate URL header
];

function filterOAuthLine(line: string, state: { urlPrinted: boolean }): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // Suppress known noise lines.
  if (SUPPRESSED_PATTERNS.some(p => p.test(trimmed))) return null;

  // Rewrite rules.
  for (const rule of REWRITE_RULES) {
    if (rule.pattern.test(trimmed)) {
      return rule.replacement || null;
    }
  }

  // URLs: print once, skip duplicates.
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    if (state.urlPrinted) return null;
    state.urlPrinted = true;
    return `  ${trimmed}`;
  }

  // Pass through everything else (e.g. success messages).
  return trimmed;
}

async function runLettaCodeCommand(candidate: CommandCandidate, providerAlias: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(candidate.command, [...candidate.args, providerAlias], {
      stdio: ['inherit', 'pipe', 'pipe'],
      cwd: process.cwd(),
      env,
    });

    const filterState = { urlPrinted: false };
    let headerPrinted = false;

    child.stdout?.on('data', (chunk: Buffer) => {
      for (const raw of chunk.toString().split('\n')) {
        const line = filterOAuthLine(raw, filterState);
        if (line === null) continue;
        if (!headerPrinted) {
          console.log('Connecting ChatGPT subscription...\n');
          headerPrinted = true;
        }
        console.log(line);
      }
    });

    // Suppress stderr entirely (hides "Unknown command" from old versions).
    child.stderr?.resume();

    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

function getCandidateCommands(): CommandCandidate[] {
  const commands: CommandCandidate[] = [];
  const seen = new Set<string>();

  const addCandidate = (candidate: CommandCandidate): void => {
    const key = `${candidate.command} ${candidate.args.join(' ')}`;
    if (seen.has(key)) {
      return;
    }
    commands.push(candidate);
    seen.add(key);
  };

  // Resolve the bundled dependency from lettabot's install path, not only cwd.
  try {
    const resolvedScript = require.resolve('@letta-ai/letta-code/letta.js');
    if (existsSync(resolvedScript)) {
      addCandidate({
        command: process.execPath,
        args: [resolvedScript, 'connect'],
      });
    }
  } catch {
    // Fall through to other discovery paths.
  }
  
  // Direct package entrypoint when available.
  const letCodeScript = resolve(process.cwd(), 'node_modules', '@letta-ai', 'letta-code', 'letta.js');
  if (existsSync(letCodeScript)) {
    addCandidate({
      command: process.execPath,
      args: [letCodeScript, 'connect'],
    });
  }
  
  // npm-style binary from local node_modules/.bin
  const localBinary = process.platform === 'win32'
    ? resolve(process.cwd(), 'node_modules', '.bin', 'letta.cmd')
    : resolve(process.cwd(), 'node_modules', '.bin', 'letta');
  if (existsSync(localBinary)) {
    addCandidate({
      command: localBinary,
      args: ['connect'],
    });
  }

  // Fallback to npx from npm registry.
  const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  addCandidate({
    command: npxCommand,
    args: ['-y', '@letta-ai/letta-code@latest', 'connect'],
  });
  
  return commands;
}

export async function runLettaConnect(providers: string[], env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const candidates = getCandidateCommands();
  const commandEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  
  const attemptedAliases = new Set<string>();
  for (const provider of providers) {
    if (attemptedAliases.has(provider)) {
      continue;
    }
    attemptedAliases.add(provider);
    
    for (const candidate of candidates) {
      const ok = await runLettaCodeCommand(candidate, provider, commandEnv);
      if (ok) {
        return true;
      }
    }
  }
  
  return false;
}

export async function runChatgptConnect(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  // Newer Letta Code versions use `chatgpt`; older versions use `codex`.
  return runLettaConnect(['chatgpt', 'codex'], env);
}

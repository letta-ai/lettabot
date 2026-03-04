/**
 * Use Letta Code's provider connection flow from Lettabot.
 */

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

interface CommandCandidate {
  command: string;
  args: string[];
}

async function runLettaCodeCommand(candidate: CommandCandidate, providerAlias: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const result = spawnSync(candidate.command, [...candidate.args, providerAlias], {
    stdio: 'inherit',
    cwd: process.cwd(),
    env,
  });
  
  return result.status === 0 && !result.error;
}

function getCandidateCommands(): CommandCandidate[] {
  const commands: CommandCandidate[] = [];
  
  // Direct package entrypoint when available.
  const letCodeScript = resolve(process.cwd(), 'node_modules', '@letta-ai', 'letta-code', 'letta.js');
  if (existsSync(letCodeScript)) {
    commands.push({
      command: process.execPath,
      args: [letCodeScript, 'connect'],
    });
  }
  
  // npm-style binary from local node_modules/.bin
  const localBinary = process.platform === 'win32'
    ? resolve(process.cwd(), 'node_modules', '.bin', 'letta.cmd')
    : resolve(process.cwd(), 'node_modules', '.bin', 'letta');
  if (existsSync(localBinary)) {
    commands.push({
      command: localBinary,
      args: ['connect'],
    });
  }
  
  // Fallback to npx from npm registry.
  const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  commands.push({
    command: npxCommand,
    args: ['-y', '@letta-ai/letta-code', 'connect'],
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

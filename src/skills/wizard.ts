/**
 * Skills Wizard - Interactive CLI for managing skills
 */

import * as p from '@clack/prompts';
import { join } from 'node:path';
import { getSkillsSummary, type SkillsSummary } from './status.js';
import { installSkillDeps } from './install.js';
import { hasBinary, GLOBAL_SKILLS_DIR, SKILLS_SH_DIR } from './loader.js';
import type { NodeManager, SkillStatus } from './types.js';

import { createLogger } from '../logger.js';

const log = createLogger('Wizard');
// Skills in working directory (where Letta Code looks)
const WORKING_DIR = process.env.WORKING_DIR || '/tmp/lettabot';
const WORKING_SKILLS_DIR = join(WORKING_DIR, '.skills');

/**
 * Detect available node managers
 */
function detectNodeManagers(): { value: NodeManager; label: string }[] {
  const managers: { value: NodeManager; label: string }[] = [];
  
  if (hasBinary('npm')) managers.push({ value: 'npm', label: 'npm' });
  if (hasBinary('pnpm')) managers.push({ value: 'pnpm', label: 'pnpm' });
  if (hasBinary('bun')) managers.push({ value: 'bun', label: 'bun' });
  
  // Always include npm as fallback
  if (managers.length === 0) {
    managers.push({ value: 'npm', label: 'npm (not found - install Node.js)' });
  }
  
  return managers;
}

/**
 * Format skill for display in multiselect
 */
function formatSkillOption(status: SkillStatus): {
  value: string;
  label: string;
  hint: string;
} {
  const emoji = status.skill.emoji || '🧩';
  const name = status.skill.name;
  const installLabel = status.installOptions[0]?.label || status.skill.description;
  
  return {
    value: name,
    label: `${emoji} ${name}`,
    hint: installLabel.length > 60 ? installLabel.slice(0, 57) + '...' : installLabel,
  };
}

/**
 * Run the skills manager wizard
 */
export async function runSkillsWizard(): Promise<void> {
  p.intro('🧩 Skills Manager');
  
  // Load and check skills from working directory
  const summary = getSkillsSummary([WORKING_SKILLS_DIR]);
  
  if (summary.total === 0) {
    p.note(
      'No skills installed yet.\n\n' +
      'Install skills from ClawdHub:\n' +
      '  npm run skill:install weather\n' +
      '  npm run skill:install obsidian\n\n' +
      'Browse: https://clawdhub.com',
      'No skills found'
    );
    p.outro('Run this wizard again after installing skills.');
    return;
  }
  
  // Show summary
  p.note(
    [
      `Total: ${summary.total}`,
      `Eligible: ${summary.eligible}`,
      `Missing dependencies: ${summary.missingDeps}`,
      summary.wrongPlatform > 0 ? `Wrong platform: ${summary.wrongPlatform}` : null,
    ].filter(Boolean).join('\n'),
    'Skills Status'
  );
  
  // Find skills with missing deps that can be installed
  const installable = summary.skills.filter(s =>
    !s.eligible &&
    !s.missing.os &&
    s.missing.bins.length > 0 &&
    s.installOptions.length > 0
  );
  
  if (installable.length === 0) {
    if (summary.eligible === summary.total) {
      p.outro('✅ All skills are ready to use!');
    } else {
      p.note(
        'Some skills have missing dependencies but no automatic install available.\n' +
        'Check the skill documentation for manual install instructions.',
        'Manual install required'
      );
      p.outro('Done.');
    }
    return;
  }
  
  // Ask to configure
  const shouldConfigure = await p.confirm({
    message: 'Install missing dependencies?',
    initialValue: true,
  });
  
  if (p.isCancel(shouldConfigure) || !shouldConfigure) {
    p.outro('Skipped.');
    return;
  }
  
  // Select node manager
  const nodeManagers = detectNodeManagers();
  const nodeManager = await p.select({
    message: 'Preferred package manager for Node installs',
    options: nodeManagers,
  }) as NodeManager;
  
  if (p.isCancel(nodeManager)) {
    p.outro('Cancelled.');
    return;
  }
  
  // Multi-select skills to install
  const toInstall = await p.multiselect({
    message: 'Select skills to install dependencies for',
    options: [
      { value: '__skip__', label: 'Skip for now', hint: 'Continue without installing' },
      ...installable.map(formatSkillOption),
    ],
    required: false,
  });
  
  if (p.isCancel(toInstall)) {
    p.outro('Cancelled.');
    return;
  }
  
  const selected = (toInstall as string[]).filter(name => name !== '__skip__');
  
  if (selected.length === 0) {
    p.outro('No skills selected.');
    return;
  }
  
  // Install selected skills
  let successCount = 0;
  let failCount = 0;
  
  for (const name of selected) {
    const status = installable.find(s => s.skill.name === name);
    if (!status || status.installOptions.length === 0) continue;
    
    const spec = status.skill.clawdbot?.install?.find(
      s => s.id === status.installOptions[0].id || 
           `${s.kind}-0` === status.installOptions[0].id
    );
    
    if (!spec) {
      p.log.warn(`No install spec found for ${name}`);
      failCount++;
      continue;
    }
    
    const spinner = p.spinner();
    spinner.start(`Installing ${name}...`);
    
    const result = await installSkillDeps(spec, nodeManager);
    
    if (result.ok) {
      spinner.stop(`✓ Installed ${name}`);
      successCount++;
    } else {
      spinner.stop(`✗ Failed: ${name}`);
      p.log.error(`  ${result.message}`);
      if (result.stderr) {
        const lines = result.stderr.split('\n').slice(0, 3);
        for (const line of lines) {
          p.log.message(`  ${line}`);
        }
      }
      failCount++;
    }
  }
  
  // Summary
  if (failCount === 0) {
    p.outro(`✅ Installed ${successCount} skill${successCount !== 1 ? 's' : ''}`);
  } else {
    p.outro(`Installed ${successCount}, failed ${failCount}`);
  }
}

/**
 * List all skills and their status (from working directory)
 */
export async function listSkills(): Promise<void> {
  const summary = getSkillsSummary([WORKING_SKILLS_DIR]);
  
  if (summary.total === 0) {
    log.info('No skills installed.');
    log.info('Install skills from ClawdHub:');
    log.info('  npm run skill:install weather');
    log.info('  npm run skill:install obsidian');
    return;
  }
  
  log.info(`📦 Installed Skills (${summary.total}):`);
  
  for (const status of summary.skills) {
    const emoji = status.skill.emoji || '🧩';
    const name = status.skill.name;
    const desc = status.skill.description;
    
    let statusIcon: string;
    let statusText: string;
    
    if (status.eligible) {
      statusIcon = '✓';
      statusText = '';
    } else if (status.missing.os) {
      statusIcon = '○';
      statusText = ` (${status.skill.clawdbot?.os?.join('/')} only)`;
    } else if (status.missing.bins.length > 0) {
      statusIcon = '✗';
      statusText = ` (missing: ${status.missing.bins.join(', ')})`;
    } else if (status.missing.env.length > 0) {
      statusIcon = '✗';
      statusText = ` (missing env: ${status.missing.env.join(', ')})`;
    } else {
      statusIcon = '?';
      statusText = '';
    }
    
    log.info(`  ${statusIcon} ${emoji} ${name}${statusText}`);
    if (desc) {
      log.info(`      ${desc}`);
    }
  }
  
  log.info(`Eligible: ${summary.eligible}/${summary.total}`);
  if (summary.missingDeps > 0) {
    log.info(`Run 'npm run skills' to install missing dependencies.`);
  } else {
    log.info('');
  }
}

/**
 * Show skills status: enabled vs available to import
 */
export async function showStatus(): Promise<void> {
  const enabledSummary = getSkillsSummary([WORKING_SKILLS_DIR]);
  const availableSummary = getSkillsSummary([GLOBAL_SKILLS_DIR, SKILLS_SH_DIR]);
  
  // Get names of enabled skills to filter available
  const enabledNames = new Set(enabledSummary.skills.map(s => s.skill.name));
  const availableToImport = availableSummary.skills.filter(s => !enabledNames.has(s.skill.name));
  
  log.info('📊 Skills Status:');
  
  // Currently enabled (agent-scoped)
  log.info(`  Enabled (${enabledSummary.total}):`);
  if (enabledSummary.total === 0) {
    log.info('    (none)');
  } else {
    for (const status of enabledSummary.skills) {
      const emoji = status.skill.emoji || '🧩';
      const name = status.skill.name;
      const icon = status.eligible ? '✓' : '✗';
      log.info(`    ${icon} ${emoji} ${name}`);
    }
  }
  
  log.info('');
  
  // Available to import
  log.info(`  Available to import (${availableToImport.length}):`);
  if (availableToImport.length === 0) {
    log.info('    (none)');
  } else {
    for (const status of availableToImport) {
      const emoji = status.skill.emoji || '🧩';
      const name = status.skill.name;
      log.info(`    ${emoji} ${name}`);
    }
  }
  
  log.info('');
  log.info(`  To enable: lettabot skills enable <name>`);
  log.info(`  Skills dir: ${WORKING_SKILLS_DIR}`);
}

/**
 * Skills Sync - Interactive checklist to manage skills in agent-scoped directory
 *
 * Skills are installed to: ~/.letta/agents/{agentId}/skills/
 * This aligns with Letta Code CLI behavior.
 * See: https://github.com/letta-ai/lettabot/issues/108
 */

import { existsSync, readdirSync, cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import { PROJECT_SKILLS_DIR, GLOBAL_SKILLS_DIR, SKILLS_SH_DIR, parseSkillFile, getAgentSkillsDir } from './loader.js';
import { Store } from '../core/store.js';

const HOME = process.env.HOME || process.env.USERPROFILE || '';

// Agent-scoped skills directory (primary location for skill installs)
const AGENT_ID = Store.getAgentIdOrThrow();
const TARGET_DIR = getAgentSkillsDir(AGENT_ID);

// Skill source directories
const CLAWDHUB_DIR = join(HOME, 'clawd', 'skills');      // ~/clawd/skills (ClawdHub)
const VERCEL_DIR = join(HOME, '.agents', 'skills');      // ~/.agents/skills (Vercel)

interface SkillInfo {
  name: string;
  description: string;
  source: 'builtin' | 'clawdhub' | 'vercel';
  sourcePath: string;
  installed: boolean;
}

/**
 * Discover all available skills from all sources
 */
function discoverSkills(): SkillInfo[] {
  const skills: SkillInfo[] = [];
  const seen = new Set<string>();
  
  // Get existing skills in target
  const installedSkills = new Set<string>();
  if (existsSync(TARGET_DIR)) {
    for (const entry of readdirSync(TARGET_DIR, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        installedSkills.add(entry.name);
      }
    }
  }
  
  // Helper to add skills from a directory
  const addFromDir = (dir: string, source: SkillInfo['source']) => {
    if (!existsSync(dir)) return;
    
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        if (seen.has(entry.name)) continue;
        
        const skillPath = join(dir, entry.name, 'SKILL.md');
        const skill = parseSkillFile(skillPath);
        
        if (skill) {
          seen.add(entry.name);
          skills.push({
            name: entry.name,
            description: skill.description || '',
            source,
            sourcePath: join(dir, entry.name),
            installed: installedSkills.has(entry.name),
          });
        }
      }
    } catch (e) {
      // Ignore errors reading directories
    }
  };
  
  // Discover from all sources (order matters - first source wins for duplicates)
  addFromDir(CLAWDHUB_DIR, 'clawdhub');
  addFromDir(VERCEL_DIR, 'vercel');
  addFromDir(PROJECT_SKILLS_DIR, 'builtin');
  
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Interactive skills sync with checklist
 */
export async function runSkillsSync(): Promise<void> {
  p.intro('🔄 Skills Sync');
  
  const skills = discoverSkills();
  
  if (skills.length === 0) {
    p.note(
      'No skills found.\n\n' +
      'Install skills with:\n' +
      '  npm run skill:install <name>     (ClawdHub)\n' +
      '  npm run skills:add <owner/repo>  (skills.sh)',
      'No skills available'
    );
    p.outro('');
    return;
  }
  
  const installedCount = skills.filter(s => s.installed).length;
  
  p.log.info(`Target: ${TARGET_DIR}`);
  p.log.info(`Found ${skills.length} skills (${installedCount} installed)`);
  
  // Check which sources exist
  const hasBuiltin = skills.some(s => s.source === 'builtin');
  const hasClawdhub = existsSync(CLAWDHUB_DIR) && skills.some(s => s.source === 'clawdhub');
  const hasVercel = existsSync(VERCEL_DIR) && skills.some(s => s.source === 'vercel');
  
  // Build options grouped by source with headers (order: ClawdHub, Vercel, Built-in)
  const options: Array<{ value: string; label: string; hint: string }> = [];
  
  // Add ClawdHub skills section
  if (hasClawdhub) {
    options.push({ value: '__header_clawdhub__', label: '── ClawdHub Skills ── (~/clawd/skills)', hint: '' });
    for (const skill of skills.filter(s => s.source === 'clawdhub')) {
      const desc = skill.description || '';
      options.push({
        value: skill.name,
        label: `🦞 ${skill.name}`,
        hint: desc.length > 60 ? desc.slice(0, 57) + '...' : desc,
      });
    }
  }
  
  // Add Vercel skills section
  if (hasVercel) {
    options.push({ value: '__header_vercel__', label: '── Vercel Skills ── (~/.agents/skills)', hint: '' });
    for (const skill of skills.filter(s => s.source === 'vercel')) {
      const desc = skill.description || '';
      options.push({
        value: skill.name,
        label: `🔼 ${skill.name}`,
        hint: desc.length > 60 ? desc.slice(0, 57) + '...' : desc,
      });
    }
  }
  
  // Add built-in skills section
  if (hasBuiltin) {
    options.push({ value: '__header_builtin__', label: '── Built-in Skills ──', hint: '' });
    for (const skill of skills.filter(s => s.source === 'builtin')) {
      const desc = skill.description || '';
      options.push({
        value: skill.name,
        label: `📦 ${skill.name}`,
        hint: desc.length > 60 ? desc.slice(0, 57) + '...' : desc,
      });
    }
  }
  
  // Start with no skills selected (user must explicitly enable)
  const selected = await p.multiselect({
    message: 'Enable skills (space=toggle, enter=confirm):',
    options,
    initialValues: [], // Disabled by default
    required: false,
  });
  
  if (p.isCancel(selected)) {
    p.cancel('Cancelled');
    return;
  }
  
  // Filter out header items
  const selectedSkills = (selected as string[]).filter(s => !s.startsWith('__header_'));
  const selectedSet = new Set(selectedSkills);
  
  // Determine what to add and remove
  const toAdd = skills.filter(s => selectedSet.has(s.name) && !s.installed);
  const toRemove = skills.filter(s => !selectedSet.has(s.name) && s.installed);
  
  if (toAdd.length === 0 && toRemove.length === 0) {
    p.log.info('No changes needed');
    p.log.info(`Skills directory: ${TARGET_DIR}`);
    p.outro('✨ Done!');
    return;
  }
  
  // Confirm changes
  const confirmMsg = [];
  if (toAdd.length > 0) confirmMsg.push(`Add ${toAdd.length} skill(s)`);
  if (toRemove.length > 0) confirmMsg.push(`Remove ${toRemove.length} skill(s)`);
  
  const confirmed = await p.confirm({
    message: `${confirmMsg.join(', ')}?`,
  });
  
  if (!confirmed || p.isCancel(confirmed)) {
    p.cancel('Cancelled');
    return;
  }
  
  // Ensure target directory exists
  mkdirSync(TARGET_DIR, { recursive: true });
  
  // Add new skills
  for (const skill of toAdd) {
    const dest = join(TARGET_DIR, skill.name);
    try {
      cpSync(skill.sourcePath, dest, { recursive: true });
      p.log.success(`Added: ${skill.name}`);
    } catch (e) {
      p.log.error(`Failed to add ${skill.name}: ${e}`);
    }
  }
  
  // Remove skills
  for (const skill of toRemove) {
    const dest = join(TARGET_DIR, skill.name);
    try {
      rmSync(dest, { recursive: true, force: true });
      p.log.warn(`Removed: ${skill.name}`);
    } catch (e) {
      p.log.error(`Failed to remove ${skill.name}: ${e}`);
    }
  }
  
  p.log.info(`Skills directory: ${TARGET_DIR}`);
  p.outro(`✨ Added ${toAdd.length}, removed ${toRemove.length} skill(s)`);
}

/**
 * Skills Loader - Discover and parse skills from disk
 */

import { existsSync, readdirSync, readFileSync, mkdirSync, cpSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import matter from 'gray-matter';
import type { SkillEntry, ClawdbotMetadata } from './types.js';

// Skills directories (in priority order: project > agent > global > bundled > skills.sh)
const HOME = process.env.HOME || process.env.USERPROFILE || '';
export const PROJECT_SKILLS_DIR = resolve(process.cwd(), '.skills');
export const GLOBAL_SKILLS_DIR = join(HOME, '.letta', 'skills');
export const SKILLS_SH_DIR = join(HOME, '.agents', 'skills'); // skills.sh global installs

// Bundled skills from the lettabot repo itself
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
export const BUNDLED_SKILLS_DIR = resolve(__dirname, '../../skills'); // lettabot/skills/

/**
 * Get the agent-scoped skills directory for a specific agent
 */
export function getAgentSkillsDir(agentId: string): string {
  return join(HOME, '.letta', 'agents', agentId, 'skills');
}

/**
 * Check if a binary exists on PATH
 */
export function hasBinary(name: string): boolean {
  try {
    execSync(`command -v ${name}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse ClawdBot metadata from frontmatter
 * The metadata field is JSON-encoded in the YAML frontmatter
 */
function parseClawdbotMetadata(frontmatter: Record<string, unknown>): ClawdbotMetadata | undefined {
  const metadataRaw = frontmatter.metadata;
  
  if (!metadataRaw) return undefined;
  
  try {
    // metadata is typically a JSON string
    const parsed = typeof metadataRaw === 'string' 
      ? JSON.parse(metadataRaw)
      : metadataRaw;
    
    return parsed?.clawdbot as ClawdbotMetadata | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse a single SKILL.md file
 */
export function parseSkillFile(filePath: string): SkillEntry | null {
  try {
    if (!existsSync(filePath)) return null;
    
    const content = readFileSync(filePath, 'utf-8');
    const { data: frontmatter } = matter(content);
    
    const name = frontmatter.name as string | undefined;
    const description = frontmatter.description as string | undefined;
    
    if (!name) return null;
    
    const clawdbot = parseClawdbotMetadata(frontmatter);
    
    return {
      name,
      description: description || '',
      emoji: clawdbot?.emoji || (frontmatter.emoji as string | undefined),
      homepage: frontmatter.homepage as string | undefined,
      filePath,
      baseDir: resolve(filePath, '..'),
      clawdbot,
    };
  } catch (e) {
    console.error(`Failed to parse skill at ${filePath}:`, e);
    return null;
  }
}

/**
 * Load all skills from a directory
 */
export function loadSkillsFromDir(skillsDir: string): SkillEntry[] {
  const skills: SkillEntry[] = [];
  
  if (!existsSync(skillsDir)) return skills;
  
  try {
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      
      const skillPath = join(skillsDir, entry.name, 'SKILL.md');
      const skill = parseSkillFile(skillPath);
      
      if (skill) {
        skills.push(skill);
      }
    }
  } catch (e) {
    console.error(`Failed to load skills from ${skillsDir}:`, e);
  }
  
  return skills;
}

/**
 * Load all skills from the global skills directory
 */
export function loadGlobalSkills(): SkillEntry[] {
  return loadSkillsFromDir(GLOBAL_SKILLS_DIR);
}

/**
 * Load skills from multiple directories, merging results
 * Later directories override earlier ones (by skill name)
 */
export function loadSkills(dirs: string[] = [GLOBAL_SKILLS_DIR]): SkillEntry[] {
  const byName = new Map<string, SkillEntry>();
  
  for (const dir of dirs) {
    const skills = loadSkillsFromDir(dir);
    for (const skill of skills) {
      byName.set(skill.name, skill);
    }
  }
  
  return Array.from(byName.values());
}

/**
 * Load skills with full hierarchy support
 * Priority: project (.skills/) > agent (~/.letta/agents/{id}/skills/) > global (~/.letta/skills/) > skills.sh (~/.agents/skills/)
 */
export function loadAllSkills(agentId?: string | null): SkillEntry[] {
  const dirs: string[] = [];
  
  // skills.sh global installs (lowest priority)
  dirs.push(SKILLS_SH_DIR);
  
  // Global skills
  dirs.push(GLOBAL_SKILLS_DIR);
  
  // Agent-scoped skills (middle priority)
  if (agentId) {
    dirs.push(getAgentSkillsDir(agentId));
  }
  
  // Project skills (highest priority)
  dirs.push(PROJECT_SKILLS_DIR);
  
  return loadSkills(dirs);
}

/**
 * Install skills from a source directory to target directory
 */
function installSkillsFromDir(sourceDir: string, targetDir: string): string[] {
  const installed: string[] = [];
  
  if (!existsSync(sourceDir)) {
    return installed;
  }
  
  try {
    const skills = readdirSync(sourceDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name);
    
    for (const skill of skills) {
      const src = join(sourceDir, skill);
      const dest = join(targetDir, skill);
      if (!existsSync(dest)) {
        cpSync(src, dest, { recursive: true });
        installed.push(skill);
      }
    }
  } catch (e) {
    console.error(`[Skills] Failed to install from ${sourceDir}:`, e);
  }
  
  return installed;
}

/**
 * Feature-gated skills - only installed when their feature is enabled
 */
export const FEATURE_SKILLS: Record<string, string[]> = {
  cron: ['scheduling'],      // Scheduling handles both one-off reminders and recurring cron jobs
  google: ['gog', 'google'], // Installed when Google/Gmail is configured
};

/**
 * Install specific skills by name from source directories
 */
function installSpecificSkills(
  skillNames: string[],
  sourceDirs: string[],
  targetDir: string
): string[] {
  const installed: string[] = [];
  
  for (const skillName of skillNames) {
    // Skip if already installed
    const dest = join(targetDir, skillName);
    if (existsSync(dest)) continue;
    
    // Find skill in source directories (later dirs have priority)
    for (const sourceDir of sourceDirs) {
      const src = join(sourceDir, skillName);
      if (existsSync(src) && existsSync(join(src, 'SKILL.md'))) {
        cpSync(src, dest, { recursive: true });
        installed.push(skillName);
        break;
      }
    }
  }
  
  return installed;
}

export interface SkillsInstallConfig {
  cronEnabled?: boolean;
  googleEnabled?: boolean;  // Gmail polling or Google integration
  additionalSkills?: string[]; // Explicitly enabled skills
}

/**
 * Install feature-gated skills to the agent-scoped skills directory
 *
 * Skills are installed to ~/.letta/agents/{agentId}/skills/
 * This aligns with Letta Code CLI's skill discovery (see vendor/letta-code/src/agent/skills.ts)
 *
 * Called after agent creation or on server startup for returning users
 */
export function installSkillsToAgent(agentId: string, config: SkillsInstallConfig = {}): void {
  const targetDir = getAgentSkillsDir(agentId);

  // Ensure target directory exists
  mkdirSync(targetDir, { recursive: true });

  // Collect skills to install based on enabled features
  const skillsToInstall: string[] = [];

  // Cron skills (always if cron is enabled)
  if (config.cronEnabled) {
    skillsToInstall.push(...FEATURE_SKILLS.cron);
  }

  // Google skills (if Gmail polling or Google is configured)
  if (config.googleEnabled) {
    skillsToInstall.push(...FEATURE_SKILLS.google);
  }

  // Additional explicitly enabled skills
  if (config.additionalSkills?.length) {
    skillsToInstall.push(...config.additionalSkills);
  }

  if (skillsToInstall.length === 0) {
    return;
  }

  // Source directories (later has priority)
  const sourceDirs = [SKILLS_SH_DIR, BUNDLED_SKILLS_DIR, PROJECT_SKILLS_DIR];

  // Install the specific skills
  const installed = installSpecificSkills(skillsToInstall, sourceDirs, targetDir);

  if (installed.length > 0) {
    console.log(`[Skills] Installed ${installed.length} skill(s) to agent ${agentId}: ${installed.join(', ')}`);
  }
}

// Note: Migration is not needed. Existing .skills/ directories continue to work
// (read-only) because the SDK searches .skills/ with highest priority.
// New skill installs go directly to agent-scoped directory.

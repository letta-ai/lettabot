/**
 * Skills Loader Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getAgentSkillsDir,
  FEATURE_SKILLS,
  isVoiceMemoConfigured,
} from './loader.js';

describe('skills loader', () => {
  describe('getAgentSkillsDir', () => {
    it('returns path containing agent ID', () => {
      const agentId = 'agent-test-123';
      const dir = getAgentSkillsDir(agentId);
      
      expect(dir).toContain('.letta');
      expect(dir).toContain('agents');
      expect(dir).toContain(agentId);
      expect(dir).toContain('skills');
    });

    it('returns different paths for different agent IDs', () => {
      const dir1 = getAgentSkillsDir('agent-aaa');
      const dir2 = getAgentSkillsDir('agent-bbb');
      
      expect(dir1).not.toBe(dir2);
      expect(dir1).toContain('agent-aaa');
      expect(dir2).toContain('agent-bbb');
    });

    it('returns consistent path structure', () => {
      const agentId = 'agent-xyz';
      const dir = getAgentSkillsDir(agentId);
      
      // Should end with /agents/{agentId}/skills
      expect(dir).toMatch(/\/\.letta\/agents\/agent-xyz\/skills$/);
    });
  });

  describe('FEATURE_SKILLS', () => {
    it('has cron feature with scheduling skill', () => {
      expect(FEATURE_SKILLS.cron).toBeDefined();
      expect(FEATURE_SKILLS.cron).toContain('scheduling');
    });

    it('has google feature with gog and google skills', () => {
      expect(FEATURE_SKILLS.google).toBeDefined();
      expect(FEATURE_SKILLS.google).toContain('gog');
      expect(FEATURE_SKILLS.google).toContain('google');
    });

    it('has tts feature with voice-memo skill', () => {
      expect(FEATURE_SKILLS.tts).toBeDefined();
      expect(FEATURE_SKILLS.tts).toContain('voice-memo');
    });
  });

  describe('isVoiceMemoConfigured', () => {
    it('defaults to elevenlabs and requires ELEVENLABS_API_KEY', () => {
      expect(isVoiceMemoConfigured({})).toBe(false);
      expect(isVoiceMemoConfigured({ ELEVENLABS_API_KEY: 'test' })).toBe(true);
    });

    it('supports openai provider and requires OPENAI_API_KEY', () => {
      expect(isVoiceMemoConfigured({ TTS_PROVIDER: 'openai' })).toBe(false);
      expect(isVoiceMemoConfigured({ TTS_PROVIDER: 'openai', OPENAI_API_KEY: 'test' })).toBe(true);
    });
  });

  describe('installSkillsToAgent', () => {
    let tempDir: string;
    let testAgentId: string;

    beforeEach(() => {
      // Create a unique temp directory for each test
      tempDir = mkdtempSync(join(tmpdir(), 'lettabot-skills-test-'));
      testAgentId = `test-agent-${Date.now()}`;
    });

    afterEach(() => {
      // Clean up temp directory
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    });

    // Note: Full integration tests for installSkillsToAgent require mocking HOME
    // or refactoring the module. These are basic sanity checks.

    it('FEATURE_SKILLS.cron contains expected skills', () => {
      // Verify the skills that would be installed
      expect(FEATURE_SKILLS.cron).toEqual(['scheduling']);
    });

    it('FEATURE_SKILLS.google contains expected skills', () => {
      expect(FEATURE_SKILLS.google).toEqual(['gog', 'google']);
    });

    it('creates target directory structure', () => {
      // Test that mkdirSync with recursive works as expected
      const targetDir = join(tempDir, 'nested', 'path', 'skills');
      mkdirSync(targetDir, { recursive: true });
      
      expect(existsSync(targetDir)).toBe(true);
    });

    it('skill installation logic copies directories correctly', () => {
      // Create a mock source skill
      const sourceDir = join(tempDir, 'source');
      const skillDir = join(sourceDir, 'test-skill');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: Test Skill\n---\n');

      // Create target directory
      const targetDir = join(tempDir, 'target');
      mkdirSync(targetDir, { recursive: true });

      // Simulate what installSpecificSkills does (simplified)
      const skillName = 'test-skill';
      const src = join(sourceDir, skillName);
      const dest = join(targetDir, skillName);
      
      if (existsSync(src) && existsSync(join(src, 'SKILL.md'))) {
        const { cpSync } = require('node:fs');
        cpSync(src, dest, { recursive: true });
      }

      // Verify
      expect(existsSync(dest)).toBe(true);
      expect(existsSync(join(dest, 'SKILL.md'))).toBe(true);
    });

    it('does not overwrite existing skills', () => {
      // Create source and target with same skill name
      const sourceDir = join(tempDir, 'source');
      const targetDir = join(tempDir, 'target');
      const skillName = 'existing-skill';

      // Source skill
      mkdirSync(join(sourceDir, skillName), { recursive: true });
      writeFileSync(join(sourceDir, skillName, 'SKILL.md'), 'source version');

      // Existing target skill (should not be overwritten)
      mkdirSync(join(targetDir, skillName), { recursive: true });
      writeFileSync(join(targetDir, skillName, 'SKILL.md'), 'target version');

      // Simulate installSpecificSkills behavior - skip if exists
      const dest = join(targetDir, skillName);
      const shouldSkip = existsSync(dest);

      expect(shouldSkip).toBe(true);
      
      // Verify original content preserved
      const { readFileSync } = require('node:fs');
      const content = readFileSync(join(dest, 'SKILL.md'), 'utf-8');
      expect(content).toBe('target version');
    });
  });

  describe('loadAllSkills precedence', () => {
    it('prefers global skills over bundled skills for the same name', async () => {
      const originalHome = process.env.HOME;
      const originalUserProfile = process.env.USERPROFILE;
      const originalCwd = process.cwd();
      const tempHome = mkdtempSync(join(tmpdir(), 'lettabot-home-test-'));
      const tempProject = mkdtempSync(join(tmpdir(), 'lettabot-project-test-'));

      try {
        process.env.HOME = tempHome;
        process.env.USERPROFILE = tempHome;
        process.chdir(tempProject);

        const globalVoiceMemoDir = join(tempHome, '.letta', 'skills', 'voice-memo');
        mkdirSync(globalVoiceMemoDir, { recursive: true });
        writeFileSync(
          join(globalVoiceMemoDir, 'SKILL.md'),
          [
            '---',
            'name: voice-memo',
            'description: global override',
            '---',
            '',
            '# Global override',
            '',
          ].join('\n'),
        );

        vi.resetModules();
        const mod = await import('./loader.js');
        const skills = mod.loadAllSkills();
        const voiceMemo = skills.find((skill: any) => skill.name === 'voice-memo');
        const expectedPath = join(tempHome, '.letta', 'skills', 'voice-memo', 'SKILL.md');

        expect(voiceMemo).toBeDefined();
        expect(voiceMemo!.description).toBe('global override');
        expect(voiceMemo!.filePath).toContain(expectedPath);
      } finally {
        process.chdir(originalCwd);
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        if (originalUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = originalUserProfile;
        rmSync(tempHome, { recursive: true, force: true });
        rmSync(tempProject, { recursive: true, force: true });
      }
    });
  });
});

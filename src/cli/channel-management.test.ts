import { describe, expect, it } from 'vitest';
import { resolveChannels, isMultiAgentConfig } from './channel-management.js';

describe('channel-management helpers', () => {
  describe('isMultiAgentConfig', () => {
    it('returns true when agents array has entries', () => {
      const config = {
        agents: [{ name: 'Bot1', channels: {} }],
        channels: {},
      };
      expect(isMultiAgentConfig(config)).toBe(true);
    });

    it('returns false when agents is undefined', () => {
      const config = { channels: {} };
      expect(isMultiAgentConfig(config)).toBe(false);
    });

    it('returns false when agents is empty array', () => {
      const config = { agents: [], channels: {} };
      expect(isMultiAgentConfig(config)).toBe(false);
    });

    it('returns false for single-agent format', () => {
      const config = {
        agent: { name: 'Bot' },
        channels: { signal: { enabled: true } },
      };
      expect(isMultiAgentConfig(config)).toBe(false);
    });
  });

  describe('resolveChannels', () => {
    it('returns top-level channels when no agents[] present', () => {
      const config = {
        channels: {
          signal: { enabled: true, phone: '+1234' },
          telegram: { enabled: false },
        },
      };
      const resolved = resolveChannels(config);
      expect(resolved.signal.enabled).toBe(true);
      expect(resolved.signal.phone).toBe('+1234');
      expect(resolved.telegram.enabled).toBe(false);
    });

    it('merges agents[0].channels with top-level channels', () => {
      const config = {
        agents: [{
          name: 'TestBot',
          channels: {
            signal: { enabled: true, phone: '+1234' },
            telegram: { enabled: true, token: 'tg-token' },
          },
        }],
        channels: {
          signal: { enabled: false }, // top-level override (should take precedence)
          discord: { enabled: true, token: 'dc-token' },
        },
      };
      const resolved = resolveChannels(config);
      
      // Signal: agent-level merged with top-level; top-level fields override
      expect(resolved.signal.enabled).toBe(false); // top-level override
      expect(resolved.signal.phone).toBe('+1234'); // from agent-level
      
      // Telegram: only in agent-level
      expect(resolved.telegram.enabled).toBe(true);
      expect(resolved.telegram.token).toBe('tg-token');
      
      // Discord: only in top-level
      expect(resolved.discord.enabled).toBe(true);
      expect(resolved.discord.token).toBe('dc-token');
    });

    it('returns agent channels when top-level channels is empty', () => {
      const config = {
        agents: [{
          name: 'TestBot',
          channels: {
            telegram: { enabled: true, token: 'bot-token' },
            signal: { enabled: true, phone: '+1555' },
          },
        }],
        channels: {},
      };
      const resolved = resolveChannels(config);
      expect(resolved.telegram.enabled).toBe(true);
      expect(resolved.signal.enabled).toBe(true);
      expect(resolved.signal.phone).toBe('+1555');
    });

    it('handles empty config', () => {
      const config = {};
      const resolved = resolveChannels(config);
      expect(resolved).toEqual({});
    });

    it('handles agents without channels', () => {
      const config = {
        agents: [{ name: 'Bot' }],
        channels: { telegram: { enabled: true } },
      };
      const resolved = resolveChannels(config);
      expect(resolved.telegram.enabled).toBe(true);
    });
  });
});

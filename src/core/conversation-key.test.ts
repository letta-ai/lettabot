import { describe, it, expect } from 'vitest';
import { resolveConversationKey, resolveHeartbeatConversationKey } from './bot.js';

// ---------------------------------------------------------------------------
// resolveConversationKey
// ---------------------------------------------------------------------------
describe('resolveConversationKey', () => {
  it('returns "shared" in shared mode for a normal channel', () => {
    expect(resolveConversationKey('telegram', 'shared', new Set())).toBe('shared');
  });

  it('returns channel id in per-channel mode', () => {
    expect(resolveConversationKey('telegram', 'per-channel', new Set())).toBe('telegram');
  });

  it('returns channel id for override channel in shared mode', () => {
    const overrides = new Set(['slack']);
    expect(resolveConversationKey('slack', 'shared', overrides)).toBe('slack');
  });

  it('non-override channels still return "shared" when overrides are configured', () => {
    const overrides = new Set(['slack']);
    expect(resolveConversationKey('telegram', 'shared', overrides)).toBe('shared');
  });

  it('multiple override channels all get their own keys', () => {
    const overrides = new Set(['slack', 'discord']);
    expect(resolveConversationKey('slack', 'shared', overrides)).toBe('slack');
    expect(resolveConversationKey('discord', 'shared', overrides)).toBe('discord');
    expect(resolveConversationKey('telegram', 'shared', overrides)).toBe('shared');
  });

  it('normalizes channel name to lowercase', () => {
    const overrides = new Set(['slack']);
    expect(resolveConversationKey('SLACK', 'shared', overrides)).toBe('slack');
    expect(resolveConversationKey('Telegram', 'per-channel', new Set())).toBe('telegram');
  });

  it('case-insensitive override matching', () => {
    const overrides = new Set(['slack']);
    expect(resolveConversationKey('Slack', 'shared', overrides)).toBe('slack');
  });

  it('returns channel id in per-channel mode even when channel is also in overrides', () => {
    const overrides = new Set(['slack']);
    expect(resolveConversationKey('slack', 'per-channel', overrides)).toBe('slack');
  });

  it('returns "shared" when conversationMode is undefined', () => {
    expect(resolveConversationKey('telegram', undefined, new Set())).toBe('shared');
  });
});

// ---------------------------------------------------------------------------
// resolveHeartbeatConversationKey
// ---------------------------------------------------------------------------
describe('resolveHeartbeatConversationKey', () => {
  // --- per-channel mode ---

  it('returns "heartbeat" when mode=per-channel and heartbeat=dedicated', () => {
    expect(resolveHeartbeatConversationKey('per-channel', 'dedicated', new Set())).toBe('heartbeat');
  });

  it('returns last-active channel in per-channel mode with last-active', () => {
    expect(resolveHeartbeatConversationKey('per-channel', 'last-active', new Set(), 'telegram')).toBe('telegram');
  });

  it('returns "shared" when per-channel and last-active but no last channel', () => {
    expect(resolveHeartbeatConversationKey('per-channel', 'last-active', new Set(), undefined)).toBe('shared');
  });

  it('returns explicit channel name in per-channel mode', () => {
    expect(resolveHeartbeatConversationKey('per-channel', 'discord', new Set(), 'telegram')).toBe('discord');
  });

  // --- shared mode, no overrides ---

  it('returns "shared" in shared mode with no overrides', () => {
    expect(resolveHeartbeatConversationKey('shared', 'last-active', new Set(), 'telegram')).toBe('shared');
  });

  it('returns "shared" in shared mode with undefined heartbeat', () => {
    expect(resolveHeartbeatConversationKey('shared', undefined, new Set(), 'telegram')).toBe('shared');
  });

  // --- shared mode with overrides ---

  it('returns override channel key when last-active channel is an override', () => {
    const overrides = new Set(['slack']);
    expect(resolveHeartbeatConversationKey('shared', 'last-active', overrides, 'slack')).toBe('slack');
  });

  it('returns "shared" when last-active channel is NOT an override', () => {
    const overrides = new Set(['slack']);
    expect(resolveHeartbeatConversationKey('shared', 'last-active', overrides, 'telegram')).toBe('shared');
  });

  it('returns "shared" when overrides exist but no last-active channel', () => {
    const overrides = new Set(['slack']);
    expect(resolveHeartbeatConversationKey('shared', 'last-active', overrides, undefined)).toBe('shared');
  });

  it('returns "shared" in shared mode even with overrides when heartbeat is not last-active', () => {
    // Non-last-active heartbeat in shared mode always returns 'shared'
    const overrides = new Set(['slack']);
    expect(resolveHeartbeatConversationKey('shared', 'dedicated', overrides, 'slack')).toBe('shared');
  });
});

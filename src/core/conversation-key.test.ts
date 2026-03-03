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

  // --- per-chat mode ---

  it('returns channel:chatId in per-chat mode', () => {
    expect(resolveConversationKey('telegram', 'per-chat', new Set(), '12345')).toBe('telegram:12345');
  });

  it('normalizes channel name in per-chat mode', () => {
    expect(resolveConversationKey('Telegram', 'per-chat', new Set(), '12345')).toBe('telegram:12345');
  });

  it('falls back to shared in per-chat mode when chatId is missing', () => {
    expect(resolveConversationKey('telegram', 'per-chat', new Set())).toBe('shared');
    expect(resolveConversationKey('telegram', 'per-chat', new Set(), undefined)).toBe('shared');
  });

  it('per-chat mode takes precedence over overrides', () => {
    const overrides = new Set(['telegram']);
    expect(resolveConversationKey('telegram', 'per-chat', overrides, '99')).toBe('telegram:99');
  });

  it('chatId is ignored in non-per-chat modes', () => {
    expect(resolveConversationKey('telegram', 'shared', new Set(), '12345')).toBe('shared');
    expect(resolveConversationKey('telegram', 'per-channel', new Set(), '12345')).toBe('telegram');
  });

  // --- disabled mode ---

  it('returns "default" in disabled mode', () => {
    expect(resolveConversationKey('telegram', 'disabled', new Set())).toBe('default');
  });

  it('returns "default" in disabled mode regardless of chatId', () => {
    expect(resolveConversationKey('telegram', 'disabled', new Set(), '12345')).toBe('default');
  });

  it('returns "default" in disabled mode regardless of overrides', () => {
    const overrides = new Set(['telegram']);
    expect(resolveConversationKey('telegram', 'disabled', overrides)).toBe('default');
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

  // --- dedicated is orthogonal to mode ---

  it('returns \"heartbeat\" in shared mode with dedicated', () => {
    expect(resolveHeartbeatConversationKey('shared', 'dedicated', new Set())).toBe('heartbeat');
  });

  it('returns \"heartbeat\" in shared mode with dedicated even when overrides exist', () => {
    const overrides = new Set(['slack']);
    expect(resolveHeartbeatConversationKey('shared', 'dedicated', overrides, 'slack')).toBe('heartbeat');
  });

  // --- explicit channel is orthogonal to mode ---

  it('returns explicit channel name in shared mode', () => {
    expect(resolveHeartbeatConversationKey('shared', 'discord', new Set(), 'telegram')).toBe('discord');
  });

  it('returns explicit channel name in per-chat mode', () => {
    expect(resolveHeartbeatConversationKey('per-chat', 'discord', new Set(), 'telegram', '12345')).toBe('discord');
  });

  // --- per-chat mode ---

  it('returns channel:chatId in per-chat mode with last-active', () => {
    expect(resolveHeartbeatConversationKey('per-chat', 'last-active', new Set(), 'telegram', '12345')).toBe('telegram:12345');
  });

  it('returns \"heartbeat\" in per-chat mode with dedicated', () => {
    expect(resolveHeartbeatConversationKey('per-chat', 'dedicated', new Set(), 'telegram', '12345')).toBe('heartbeat');
  });

  it('falls back to shared in per-chat mode when chatId is missing', () => {
    expect(resolveHeartbeatConversationKey('per-chat', 'last-active', new Set(), 'telegram', undefined)).toBe('shared');
  });

  it('falls back to \"shared\" in per-chat mode when no last-active target', () => {
    expect(resolveHeartbeatConversationKey('per-chat', 'last-active', new Set(), undefined, undefined)).toBe('shared');
  });

  // --- disabled mode ---

  it('returns "default" in disabled mode regardless of heartbeat setting', () => {
    expect(resolveHeartbeatConversationKey('disabled', 'last-active', new Set(), 'telegram')).toBe('default');
    expect(resolveHeartbeatConversationKey('disabled', 'dedicated', new Set(), 'telegram')).toBe('default');
    expect(resolveHeartbeatConversationKey('disabled', undefined, new Set())).toBe('default');
  });
});

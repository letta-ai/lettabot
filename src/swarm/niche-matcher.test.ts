/**
 * NicheMatcher Tests (M2)
 *
 * Hypothesis: InboundMessage can be classified into NicheDescriptor using
 * msg.channel directly (channel dimension) and keyword heuristics for domain,
 * without LLM inference.
 */

import { describe, it, expect } from 'vitest';
import { matchNiche, classifyDomain } from './niche-matcher.js';
import type { InboundMessage } from '../core/types.js';

function createMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: 'telegram',
    chatId: '123456789',
    userId: 'user123',
    text: 'Hello world',
    timestamp: new Date('2026-02-02T12:00:00Z'),
    ...overrides,
  };
}

describe('NicheMatcher', () => {
  // T-NM-1
  it('channel dimension maps msg.channel to niche.channel directly', () => {
    const msg = createMessage({ channel: 'slack' });
    const niche = matchNiche(msg);
    expect(niche.channel).toBe('slack');
  });

  // T-NM-2
  it("domain 'coding' detected from keywords", () => {
    const cases = [
      'Can you help me debug this function?',
      'Write some code to parse JSON',
      'I have a bug in my TypeScript',
      'Fix the compile error please',
      'How do I implement a REST API?',
    ];
    for (const text of cases) {
      expect(classifyDomain(text)).toBe('coding');
    }
  });

  // T-NM-3
  it("domain 'research' detected from keywords", () => {
    const cases = [
      'Research the latest papers on transformers',
      'Can you find a study about climate change?',
      'Analyze this dataset for trends',
      'What does the literature say about this?',
      'Investigate the hypothesis that...',
    ];
    for (const text of cases) {
      expect(classifyDomain(text)).toBe('research');
    }
  });

  // T-NM-4
  it("domain 'scheduling' detected from keywords", () => {
    const cases = [
      'Schedule a meeting for tomorrow',
      'What is on my calendar today?',
      'Set a reminder for 3pm',
      'Can you book an appointment?',
      'Plan the event for next week',
    ];
    for (const text of cases) {
      expect(classifyDomain(text)).toBe('scheduling');
    }
  });

  // T-NM-5
  it("domain 'communication' detected from keywords", () => {
    const cases = [
      'Send an email to the team',
      'Draft a message to the client',
      'Notify everyone about the update',
      'Write a reply to this thread',
      'Compose a brief announcement',
    ];
    for (const text of cases) {
      expect(classifyDomain(text)).toBe('communication');
    }
  });

  // T-NM-6
  it("domain 'general' returned when no keywords match", () => {
    const cases = [
      'Hello, how are you?',
      'What is the weather like?',
      'Tell me a joke',
      'Thanks for your help',
    ];
    for (const text of cases) {
      expect(classifyDomain(text)).toBe('general');
    }
  });

  // T-NM-7
  it('matchNiche() returns full NicheDescriptor with computed key string', () => {
    const msg = createMessage({
      channel: 'discord',
      text: 'Can you help me debug this function?',
    });
    const niche = matchNiche(msg);
    expect(niche.channel).toBe('discord');
    expect(niche.domain).toBe('coding');
    expect(niche.key).toBe('discord-coding');
  });
});

/**
 * NicheMatcher — Message → NicheDescriptor Classification
 *
 * Uses msg.channel directly for channel dimension and keyword heuristics
 * for domain, without LLM inference.
 */

import type { InboundMessage } from '../core/types.js';
import type { Domain, NicheDescriptor } from './types.js';

const DOMAIN_KEYWORDS: Record<Exclude<Domain, 'general'>, string[]> = {
  coding: [
    'code', 'coding', 'debug', 'function', 'bug', 'compile', 'error',
    'typescript', 'javascript', 'python', 'api', 'implement', 'algorithm',
    'syntax', 'variable', 'class', 'import', 'module', 'test', 'deploy',
    'refactor', 'git', 'commit', 'merge', 'pr', 'pull request',
  ],
  research: [
    'research', 'paper', 'study', 'analyze', 'analysis', 'dataset',
    'literature', 'investigate', 'hypothesis', 'experiment', 'survey',
    'findings', 'methodology', 'citation', 'journal', 'review',
    'evidence', 'theory', 'data',
  ],
  scheduling: [
    'schedule', 'meeting', 'calendar', 'reminder', 'book', 'appointment',
    'plan', 'event', 'deadline', 'agenda', 'availability', 'slot',
    'reschedule', 'postpone', 'cancel meeting',
  ],
  communication: [
    'email', 'message', 'notify', 'reply', 'compose', 'draft',
    'announcement', 'broadcast', 'newsletter', 'memo', 'letter',
    'outreach', 'follow up', 'reach out',
  ],
};

/**
 * Classify message text into a domain using keyword heuristics.
 */
export function classifyDomain(text: string): Domain {
  const lower = text.toLowerCase();

  // Score each domain by keyword matches
  let bestDomain: Domain = 'general';
  let bestScore = 0;

  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS) as Array<[Exclude<Domain, 'general'>, string[]]>) {
    let score = 0;
    for (const keyword of keywords) {
      if (lower.includes(keyword)) {
        score++;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestDomain = domain;
    }
  }

  return bestDomain;
}

/**
 * Match an InboundMessage to a NicheDescriptor.
 */
export function matchNiche(msg: InboundMessage): NicheDescriptor {
  const channel = msg.channel;
  const domain = classifyDomain(msg.text);
  return {
    channel,
    domain,
    key: `${channel}-${domain}`,
  };
}

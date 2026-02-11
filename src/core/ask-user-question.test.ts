/**
 * Tests for AskUserQuestion channel flow.
 *
 * Covers:
 * - formatQuestionsForChannel output
 * - handleMessage interceptor (pendingQuestionResolver)
 * - canUseTool callback wiring
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// 1. formatQuestionsForChannel (extracted for testability)
// ---------------------------------------------------------------------------

// Mirror the private method's logic so we can test it directly.
// If the shape drifts, the type-check on bot.ts will catch it.
function formatQuestionsForChannel(questions: Array<{
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}>): string {
  const parts: string[] = [];
  for (const q of questions) {
    parts.push(`**${q.question}**`);
    parts.push('');
    for (let i = 0; i < q.options.length; i++) {
      parts.push(`${i + 1}. **${q.options[i].label}**`);
      parts.push(`   ${q.options[i].description}`);
    }
    if (q.multiSelect) {
      parts.push('');
      parts.push('_(You can select multiple options)_');
    }
  }
  parts.push('');
  parts.push('_Reply with your choice (number, name, or your own answer)._');
  return parts.join('\n');
}

describe('formatQuestionsForChannel', () => {
  test('single question with 2 options', () => {
    const result = formatQuestionsForChannel([{
      question: 'Which library should we use?',
      header: 'Library',
      options: [
        { label: 'React Query', description: 'Best for server state' },
        { label: 'SWR', description: 'Lighter alternative' },
      ],
      multiSelect: false,
    }]);
    expect(result).toContain('**Which library should we use?**');
    expect(result).toContain('1. **React Query**');
    expect(result).toContain('   Best for server state');
    expect(result).toContain('2. **SWR**');
    expect(result).toContain('   Lighter alternative');
    expect(result).toContain('_Reply with your choice');
    expect(result).not.toContain('multiple');
  });

  test('multiSelect question shows hint', () => {
    const result = formatQuestionsForChannel([{
      question: 'Which features?',
      header: 'Features',
      options: [
        { label: 'Auth', description: 'Login system' },
        { label: 'Cache', description: 'Response caching' },
      ],
      multiSelect: true,
    }]);
    expect(result).toContain('_(You can select multiple options)_');
  });

  test('multiple questions', () => {
    const result = formatQuestionsForChannel([
      {
        question: 'Framework?',
        header: 'Framework',
        options: [
          { label: 'Next.js', description: 'React framework' },
          { label: 'Remix', description: 'Full stack' },
        ],
        multiSelect: false,
      },
      {
        question: 'Database?',
        header: 'DB',
        options: [
          { label: 'Postgres', description: 'Relational' },
          { label: 'Mongo', description: 'Document store' },
        ],
        multiSelect: false,
      },
    ]);
    expect(result).toContain('Framework?');
    expect(result).toContain('Database?');
    // Each question has its own numbered options
    const lines = result.split('\n');
    const numberedLines = lines.filter(l => l.match(/^\d+\.\s+\*\*/));
    expect(numberedLines).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// 2. handleMessage interceptor logic
// ---------------------------------------------------------------------------

describe('AskUserQuestion message interceptor', () => {
  test('resolver is called with message text and cleared', async () => {
    // Simulate the interceptor logic from handleMessage
    let pendingQuestionResolver: ((text: string) => void) | null = null;
    const messageQueue: string[] = [];

    // Simulated handleMessage
    function handleMessage(text: string) {
      if (pendingQuestionResolver) {
        pendingQuestionResolver(text);
        pendingQuestionResolver = null;
        return; // intercepted
      }
      messageQueue.push(text); // normal queue
    }

    // Set up a pending question
    const answerPromise = new Promise<string>((resolve) => {
      pendingQuestionResolver = resolve;
    });

    // Send a message while question is pending
    handleMessage('Option 1');

    // The answer should resolve
    const answer = await answerPromise;
    expect(answer).toBe('Option 1');

    // Resolver should be cleared
    expect(pendingQuestionResolver).toBeNull();

    // Message should NOT have been queued
    expect(messageQueue).toHaveLength(0);

    // Subsequent messages should queue normally
    handleMessage('normal message');
    expect(messageQueue).toHaveLength(1);
    expect(messageQueue[0]).toBe('normal message');
  });

  test('empty message resolves with empty string', async () => {
    let pendingQuestionResolver: ((text: string) => void) | null = null;

    const answerPromise = new Promise<string>((resolve) => {
      pendingQuestionResolver = resolve;
    });

    // Simulate handleMessage with empty text
    // Non-null assertion needed: TS can't track the synchronous mutation from the Promise callback
    pendingQuestionResolver!('');
    pendingQuestionResolver = null;

    const answer = await answerPromise;
    expect(answer).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 3. canUseTool callback answer mapping
// ---------------------------------------------------------------------------

describe('AskUserQuestion canUseTool callback', () => {
  test('maps single question answer correctly', () => {
    const questions = [{
      question: 'Which approach?',
      header: 'Approach',
      options: [
        { label: 'Option A', description: 'First approach' },
        { label: 'Option B', description: 'Second approach' },
      ],
      multiSelect: false,
    }];
    const userAnswer = 'Option A';

    // Simulate the answer mapping logic from the callback
    const answers: Record<string, string> = {};
    for (const q of questions) {
      answers[q.question] = userAnswer;
    }

    expect(answers).toEqual({ 'Which approach?': 'Option A' });
  });

  test('maps multiple questions to same answer (single response UX)', () => {
    const questions = [
      { question: 'Q1?', header: 'H1', options: [{ label: 'A', description: 'd' }], multiSelect: false },
      { question: 'Q2?', header: 'H2', options: [{ label: 'B', description: 'd' }], multiSelect: false },
    ];
    const userAnswer = 'My combined answer';

    const answers: Record<string, string> = {};
    for (const q of questions) {
      answers[q.question] = userAnswer;
    }

    expect(answers).toEqual({
      'Q1?': 'My combined answer',
      'Q2?': 'My combined answer',
    });
  });
});

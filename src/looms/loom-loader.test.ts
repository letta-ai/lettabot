import { describe, it, expect } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLoomFile, loadAllLooms, loadRandomLoom } from './loom-loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('parseLoomFile', () => {
  it('parses a valid loom file with all metadata', () => {
    const content = [
      '# name: Test Loom',
      '# author: testuser',
      '# version: 2.0',
      '---',
      '╔════════╗',
      '║  test  ║',
      '╚════════╝',
    ].join('\n');

    const result = parseLoomFile(content, 'test.txt');
    expect(result).not.toBeNull();
    expect(result!.metadata.name).toBe('Test Loom');
    expect(result!.metadata.author).toBe('testuser');
    expect(result!.metadata.version).toBe('2.0');
    expect(result!.lines).toEqual([
      '╔════════╗',
      '║  test  ║',
      '╚════════╝',
    ]);
    expect(result!.filename).toBe('test.txt');
  });

  it('parses without optional version field', () => {
    const content = [
      '# name: Minimal',
      '# author: someone',
      '---',
      'art here',
    ].join('\n');

    const result = parseLoomFile(content, 'minimal.txt');
    expect(result).not.toBeNull();
    expect(result!.metadata.name).toBe('Minimal');
    expect(result!.metadata.author).toBe('someone');
    expect(result!.metadata.version).toBeUndefined();
    expect(result!.lines).toEqual(['art here']);
  });

  it('returns null when no separator found', () => {
    const content = '# name: Bad\n# author: oops\nno separator here';
    const result = parseLoomFile(content, 'bad.txt');
    expect(result).toBeNull();
  });

  it('returns null when name is missing', () => {
    const content = '# author: someone\n---\nart';
    const result = parseLoomFile(content, 'noname.txt');
    expect(result).toBeNull();
  });

  it('returns null when author is missing', () => {
    const content = '# name: Orphan\n---\nart';
    const result = parseLoomFile(content, 'noauthor.txt');
    expect(result).toBeNull();
  });

  it('trims leading and trailing empty lines from art', () => {
    const content = [
      '# name: Trimmed',
      '# author: trimmer',
      '---',
      '',
      'line 1',
      'line 2',
      '',
      '',
    ].join('\n');

    const result = parseLoomFile(content, 'trimmed.txt');
    expect(result).not.toBeNull();
    expect(result!.lines).toEqual(['line 1', 'line 2']);
  });

  it('preserves internal empty lines in art', () => {
    const content = [
      '# name: Spaced',
      '# author: spacer',
      '---',
      'top',
      '',
      'bottom',
    ].join('\n');

    const result = parseLoomFile(content, 'spaced.txt');
    expect(result).not.toBeNull();
    expect(result!.lines).toEqual(['top', '', 'bottom']);
  });

  it('handles Windows-style line endings', () => {
    const content = '# name: Win\r\n# author: dos\r\n---\r\nart line\r\n';
    const result = parseLoomFile(content, 'win.txt');
    expect(result).not.toBeNull();
    expect(result!.metadata.name).toBe('Win');
    expect(result!.lines).toEqual(['art line']);
  });

  it('ignores non-metadata lines in header', () => {
    const content = [
      '# name: Real',
      '# author: person',
      '# This is just a comment without colon-value',
      'random text in header',
      '---',
      'art',
    ].join('\n');

    const result = parseLoomFile(content, 'comments.txt');
    expect(result).not.toBeNull();
    expect(result!.metadata.name).toBe('Real');
  });
});

describe('loadAllLooms', () => {
  it('loads looms from the looms directory', () => {
    const looms = loadAllLooms(__dirname);
    // At minimum, memory-weaver.txt should be found
    expect(looms.length).toBeGreaterThanOrEqual(1);
    const weaver = looms.find(l => l.metadata.name === 'Memory Weaver');
    expect(weaver).toBeDefined();
    expect(weaver!.metadata.author).toBe('cpfiffer');
  });

  it('returns empty array for non-existent directory', () => {
    const looms = loadAllLooms('/nonexistent/path/looms');
    expect(looms).toEqual([]);
  });
});

describe('loadRandomLoom', () => {
  it('returns a loom from the default directory', () => {
    const loom = loadRandomLoom(__dirname);
    expect(loom).not.toBeNull();
    expect(loom!.metadata.name).toBeTruthy();
    expect(loom!.metadata.author).toBeTruthy();
    expect(loom!.lines.length).toBeGreaterThan(0);
  });

  it('returns null for empty directory', () => {
    const loom = loadRandomLoom('/nonexistent/path/looms');
    expect(loom).toBeNull();
  });
});

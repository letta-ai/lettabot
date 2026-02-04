import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverPluginsInDir } from '../loader.js';

describe('plugin loader', () => {
  it('falls back from index.js to index.ts during discovery', () => {
    const root = mkdtempSync(join(tmpdir(), 'lettabot-plugin-test-'));
    const pluginDir = join(root, 'example');
    mkdirSync(pluginDir, { recursive: true });

    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify(
        {
          name: 'Example',
          id: 'example',
          version: '1.0.0',
          main: 'index.js',
        },
        null,
        2
      ),
      'utf-8'
    );

    // Deliberately do NOT create index.js, only index.ts.
    writeFileSync(join(pluginDir, 'index.ts'), 'export default () => ({} as any)\n', 'utf-8');

    const discovered = discoverPluginsInDir(root);
    expect(discovered).toHaveLength(1);
    expect(discovered[0].entryPath.endsWith('index.ts')).toBe(true);
  });
});


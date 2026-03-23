/**
 * Turn viewer SPA — served by the API server at GET /turns.
 *
 * The HTML lives in turn-viewer.html (same directory).
 * getTurnViewerHtml() injects agent metadata via simple token substitution
 * so the template file can be edited and linted independently.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
let TEMPLATE: string;
try {
  TEMPLATE = readFileSync(join(__dirname, 'turn-viewer.html'), 'utf8');
} catch {
  throw new Error('turn-viewer.html not found -- did you run npm run build?');
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function getTurnViewerHtml(agentNames: string[]): string {
  const multiAgent = agentNames.length > 1;
  const defaultAgent = agentNames[0] ?? '';
  // Escape </script> to prevent XSS if an agent name contains it
  const agentNamesJson = JSON.stringify(agentNames).replace(/<\/script>/gi, '<\\/script>');
  const agentOptions = agentNames.map(n => `<option value="${escHtml(n)}">${escHtml(n)}</option>`).join('');

  return TEMPLATE
    .replaceAll('__AGENT_NAMES_JSON__', agentNamesJson)
    .replaceAll('__DEFAULT_AGENT__', escHtml(defaultAgent))
    .replaceAll('__LABEL_DISPLAY__', multiAgent ? 'none' : 'inline')
    .replaceAll('__SELECT_DISPLAY__', multiAgent ? 'inline-block' : 'none')
    .replaceAll('__AGENT_OPTIONS__', agentOptions);
}

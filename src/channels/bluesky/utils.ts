export function normalizeList(value?: string[] | string): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(v => v.trim()).filter(Boolean);
  return value.split(',').map(v => v.trim()).filter(Boolean);
}

export function uniqueList(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function truncate(value: string, max = 2000): string {
  if (value.length <= max) return value;
  return value.slice(0, max) + '...';
}

export function pruneMap<T>(map: Map<string, T>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (!oldest) break;
    map.delete(oldest);
  }
}

export function buildAtUri(did?: string, collection?: string, rkey?: string): string | undefined {
  if (!did || !collection || !rkey) return undefined;
  return `at://${did}/${collection}/${rkey}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(v => (typeof v === 'string' ? v.trim() : '')).filter(Boolean)
    : [];
}

/** Default timeout for Bluesky API calls (15 seconds) */
export const FETCH_TIMEOUT_MS = 15_000;

/**
 * fetch() wrapper with an AbortController timeout.
 * Throws on timeout just like a network error.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function parseAtUri(uri: string): { did: string; collection: string; rkey: string } | undefined {
  if (!uri.startsWith('at://')) return undefined;
  const parts = uri.slice('at://'.length).split('/');
  if (parts.length < 3) return undefined;
  return { did: parts[0], collection: parts[1], rkey: parts[2] };
}

export function getAppViewUrl(appViewUrl?: string, defaultUrl = 'https://public.api.bsky.app'): string {
  return (appViewUrl || defaultUrl).replace(/\/+$/, '');
}

export function splitPostText(text: string, maxChars = 300): string[] {
  const segmenter = new Intl.Segmenter();
  const graphemes = [...segmenter.segment(text)].map(s => s.segment);
  if (graphemes.length === 0) return [];
  if (graphemes.length <= maxChars) {
    const trimmed = text.trim();
    return trimmed ? [trimmed] : [];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < graphemes.length) {
    let end = Math.min(start + maxChars, graphemes.length);

    if (end < graphemes.length) {
      let split = end;
      for (let i = end - 1; i > start; i--) {
        if (/\s/.test(graphemes[i])) {
          split = i;
          break;
        }
      }
      end = split > start ? split : end;
    }

    let chunk = graphemes.slice(start, end).join('');
    chunk = chunk.replace(/^\s+/, '').replace(/\s+$/, '');
    if (chunk) chunks.push(chunk);

    start = end;
    while (start < graphemes.length && /\s/.test(graphemes[start])) {
      start++;
    }
  }

  return chunks;
}

export function decodeJwtExp(jwt: string): number | undefined {
  const parts = jwt.split('.');
  if (parts.length < 2) return undefined;
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload.padEnd(payload.length + (4 - (payload.length % 4 || 4)), '=');
    const json = Buffer.from(padded, 'base64').toString('utf-8');
    const data = JSON.parse(json) as { exp?: number };
    if (typeof data.exp === 'number') {
      return data.exp * 1000;
    }
  } catch {
    // ignore
  }
  return undefined;
}

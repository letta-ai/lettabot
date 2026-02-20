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

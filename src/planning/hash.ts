import { createHash } from 'node:crypto';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    const out: Record<string, unknown> = {};
    for (const [key, nested] of entries) out[key] = sortValue(nested);
    return out;
  }
  return value;
}

export function requestHash(payload: unknown): string {
  return sha256Hex(stableStringify(payload));
}

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('share clipboard fallback', () => {
  it('separates auth failure from clipboard failure in TopBar', () => {
    const topBar = readFileSync(
      path.join(root, 'web/src/components/TopBar.vue'),
      'utf8',
    );
    expect(topBar).toMatch(/copyTextToClipboard/);
    expect(topBar).toMatch(/shareAuthErrorMessage/);
    expect(topBar).toMatch(/无法自动复制/);
    expect(topBar).toMatch(/isReadonlyTeam/);
    expect(topBar).toMatch(/team-eye/);
    expect(topBar).not.toMatch(/分享失败，请确认你有编辑权限/);
    expect(topBar).not.toMatch(/await navigator\.clipboard\.writeText\(url\)/);
  });

  it('copyTextToClipboard prefers secure clipboard then execCommand', () => {
    const geometry = readFileSync(
      path.join(root, 'web/src/composables/useGeometry.ts'),
      'utf8',
    );
    expect(geometry).toMatch(/export async function copyTextToClipboard/);
    expect(geometry).toMatch(/isSecureContext/);
    expect(geometry).toMatch(/execCommand\('copy'\)/);
  });
});

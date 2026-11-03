/**
 * E-171 INIT 视角 — data-layer behavior:
 *  - import persists the Jira `Committed` field on items
 *  - import upserts parent INIT details (title / own quarter / own Committed)
 *    into the team cache; partial loads never fabricate data
 *  - refresh_from_jira mirrors `committed` like any other mirror field
 *  - dep markers carry the target ticket's own `Committed`
 *  - the snapshot exposes items.committed, markers.committed and inits
 */

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ActorContext, TeamSnapshot } from '../types.js';

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'roadmap-init-'));

const { applyIntent, createTeam, getTeamSnapshot } = await import(
  '../core/TeamService.js'
);

const actor: ActorContext = {
  name: 'Tester',
  clientId: 'test-client',
  source: 'creator',
};

let teamId = '';

function apply(intent: Record<string, unknown>) {
  const result = applyIntent(teamId, intent, actor);
  if (!result.ok) throw new Error(`intent failed: ${result.error}`);
  return result;
}

function snapshot(): TeamSnapshot {
  return getTeamSnapshot(teamId)!;
}

beforeEach(() => {
  teamId = createTeam({
    name: 'Nova CA',
    jql: 'project=NOVA and issuetype = Epic',
    actor,
  }).team.id;
});

describe('import committed + INIT details', () => {
  it('persists the Committed field on imported items', () => {
    apply({
      op: 'import',
      quarters: ['2026-Q4'],
      items: [
        { key: 'NOVA-18102', title: 'A', quarter: '2026-Q4', committed: 'No' },
        { key: 'NOVA-18117', title: 'B', quarter: '2026-Q4', committed: 'Yes' },
        { key: 'NOVA-18131', title: 'C', quarter: '2026-Q4' },
      ],
    });
    const byKey = new Map(snapshot().items.map((i) => [i.key, i]));
    expect(byKey.get('NOVA-18102')!.committed).toBe('No');
    expect(byKey.get('NOVA-18117')!.committed).toBe('Yes');
    expect(byKey.get('NOVA-18131')!.committed).toBeNull();
  });

  it('ignores values other than Yes/No', () => {
    apply({
      op: 'import',
      quarters: ['2026-Q4'],
      items: [{ key: 'NOVA-1', title: 'A', committed: 'Maybe' }],
    });
    expect(snapshot().items[0].committed).toBeNull();
  });

  it('upserts INIT details and keeps previously loaded fields on partial updates', () => {
    apply({
      op: 'import',
      quarters: ['2026-Q4'],
      items: [{ key: 'NOVA-2', title: 'A', quarter: '2026-Q4' }],
      inits: [
        {
          key: 'INIT-6120',
          title: 'AI Copilot 2.0',
          quarter: '2026-Q4',
          committed: 'Yes',
        },
      ],
    });
    let snap = snapshot();
    expect(snap.inits).toEqual([
      {
        key: 'INIT-6120',
        title: 'AI Copilot 2.0',
        quarter: '2026-Q4',
        committed: 'Yes',
        fetchedAt: expect.any(Number),
      },
    ]);

    // A later import that only re-fetched the quarter keeps title + committed.
    apply({
      op: 'import',
      quarters: ['2026-Q4'],
      items: [{ key: 'NOVA-2', title: 'A', quarter: '2026-Q4' }],
      inits: [{ key: 'INIT-6120', quarter: '2027-Q1' }],
    });
    snap = snapshot();
    expect(snap.inits![0]).toMatchObject({
      key: 'INIT-6120',
      title: 'AI Copilot 2.0',
      committed: 'Yes',
      quarter: '2027-Q1',
    });
  });
});

describe('refresh_from_jira mirrors committed', () => {
  it('updates committed on items when the field is present', () => {
    apply({
      op: 'import',
      quarters: ['2026-Q4'],
      items: [{ key: 'NOVA-3', title: 'A', quarter: '2026-Q4' }],
    });
    apply({
      op: 'refresh_from_jira',
      ignoreTtl: true,
      issues: [
        {
          key: 'NOVA-3',
          fetchedAt: Date.now(),
          fields: { summary: 'A', committed: 'No' },
        },
      ],
    });
    expect(
      snapshot().items.find((i) => i.key === 'NOVA-3')!.committed,
    ).toBe('No');
  });
});

describe('dep marker committed', () => {
  it('stores the target ticket committed on create and update', () => {
    apply({ op: 'add_item', title: 'Epic A', quarter: '2026-Q4' });
    const key = snapshot().items[0].key;
    const created = apply({
      op: 'add_marker',
      itemKey: key,
      kind: 'dep',
      label: 'API-42',
      jiraKey: 'PLAT-2091',
      date: '2026-11-20',
      committed: 'No',
    }) as unknown as { snapshot: TeamSnapshot };
    const markerId = created.snapshot.items
      .find((i) => i.key === key)!
      .markers.find((m) => m.jiraKey === 'PLAT-2091')!.id;
    let snap = snapshot();
    expect(
      snap.items[0].markers.find((m) => m.id === markerId)!.committed,
    ).toBe('No');

    apply({
      op: 'update_marker',
      markerId,
      committed: 'Yes',
    });
    snap = snapshot();
    expect(
      snap.items[0].markers.find((m) => m.id === markerId)!.committed,
    ).toBe('Yes');
  });
});

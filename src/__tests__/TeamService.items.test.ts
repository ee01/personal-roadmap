import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ActorContext, TeamSnapshot } from '../types.js';

// config.ts reads DATA_DIR at import time, so the temp dir has to exist first.
process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'roadmap-test-'));

const { applyIntent, createTeam, getTeamSnapshot, listActivity } = await import(
  '../core/TeamService.js'
);

const actor: ActorContext = {
  name: 'Tester',
  clientId: 'test-client',
  source: 'creator',
};

const JQL =
  `issueFunction in portfolioChildrenOf('project = INIT AND Team in ("Nova CA - Brandy")') ` +
  `and issuetype = Epic and project=NOVA`;

function apply(teamId: string, intent: Record<string, unknown>) {
  return applyIntent(teamId, intent, actor);
}

function expectOk(result: ReturnType<typeof applyIntent>) {
  if (!result.ok) throw new Error(`intent failed: ${result.error}`);
  return result;
}

function itemOf(snapshot: TeamSnapshot, key: string) {
  const item = snapshot.items.find((candidate) => candidate.key === key);
  if (!item) throw new Error(`item ${key} missing`);
  return item;
}

let teamId = '';

beforeAll(() => {
  const snapshot = createTeam({ name: 'Nova CA', jql: JQL, actor });
  teamId = snapshot.team.id;
  expectOk(
    apply(teamId, {
      op: 'import',
      quarters: ['2026-Q3'],
      overwrite: true,
      items: [
        { key: 'NOVA-1', type: 'Epic', title: 'Imported one', quarter: '2026-Q3' },
        { key: 'NOVA-2', type: 'Epic', title: 'Imported two', quarter: '2026-Q3' },
      ],
    }),
  );
});

describe('snapshot contract', () => {
  it('exposes jqlHints derived from the team JQL', () => {
    const snapshot = getTeamSnapshot(teamId)!;
    expect(snapshot.team.jqlHints).toEqual({
      projectKey: 'NOVA',
      itemType: 'Epic',
      subType: 'Task',
      linkField: 'customfield_11450',
      confident: true,
    });
  });

  it('marks imported rows as jira and mirrors the key into jiraKey', () => {
    const item = itemOf(getTeamSnapshot(teamId)!, 'NOVA-1');
    expect(item.source).toBe('jira');
    expect(item.jiraKey).toBe('NOVA-1');
    expect(item.projectKey).toBe('NOVA');
  });
});

describe('add_item / delete_item', () => {
  it('creates a manual row with an immutable synthetic key', () => {
    const result = expectOk(
      apply(teamId, {
        op: 'add_item',
        title: 'Manual work',
        quarter: '2026-Q3',
        estimate: 2,
      }),
    );
    expect(result.itemKey).toMatch(/^LOCAL-[\w-]{8}$/);
    const item = itemOf(result.snapshot, result.itemKey!);
    expect(item.source).toBe('manual');
    expect(item.jiraKey).toBeNull();
    expect(item.type).toBe('Epic');
    expect(item.projectKey).toBe('NOVA');
    // Backlog floats the newest manual row, so the row needs a creation stamp.
    expect(item.createdAt).toBeGreaterThan(0);
    expect(item.createdAt).toBeGreaterThanOrEqual(
      itemOf(result.snapshot, 'NOVA-1').createdAt,
    );
  });

  it('hard-deletes an unresolved manual row together with its subs', () => {
    const created = expectOk(
      apply(teamId, { op: 'add_item', title: 'Throwaway' }),
    );
    const key = created.itemKey!;
    expectOk(apply(teamId, { op: 'add_sub', itemKey: key, title: 'child' }));
    const removed = expectOk(apply(teamId, { op: 'delete_item', itemKey: key }));
    expect(
      removed.snapshot.items.some((item) => item.key === key),
    ).toBe(false);
  });

  it('refuses to delete rows that already have a Jira issue', () => {
    const result = apply(teamId, { op: 'delete_item', itemKey: 'NOVA-1' });
    expect(result).toEqual({ ok: false, error: 'item_has_jira' });
  });
});

describe('resolve_item', () => {
  it('backfills the Jira key without any version check and stays idempotent', () => {
    const key = expectOk(
      apply(teamId, { op: 'add_item', title: 'To be created', quarter: '2026-Q3' }),
    ).itemKey!;

    // Simulate a concurrent drag bumping the version before the key comes back.
    const before = itemOf(getTeamSnapshot(teamId)!, key);
    expectOk(
      apply(teamId, {
        op: 'schedule',
        itemKey: key,
        baseVersion: before.version,
        start: '2026-07-01',
        days: 10,
      }),
    );

    const resolved = expectOk(
      apply(teamId, { op: 'resolve_item', itemKey: key, jiraKey: 'NOVA-77' }),
    );
    const item = itemOf(resolved.snapshot, key);
    expect(item.key).toBe(key);
    expect(item.jiraKey).toBe('NOVA-77');
    expect(item.source).toBe('manual');

    const again = expectOk(
      apply(teamId, { op: 'resolve_item', itemKey: key, jiraKey: 'NOVA-77' }),
    );
    expect(itemOf(again.snapshot, key).version).toBe(item.version);

    expect(apply(teamId, { op: 'delete_item', itemKey: key })).toEqual({
      ok: false,
      error: 'item_has_jira',
    });
  });

  it('corrects type and projectKey when provided', () => {
    const key = expectOk(apply(teamId, { op: 'add_item', title: 'Retyped' }))
      .itemKey!;
    const resolved = expectOk(
      apply(teamId, {
        op: 'resolve_item',
        itemKey: key,
        jiraKey: 'OTHER-5',
        type: 'Task',
        projectKey: 'OTHER',
      }),
    );
    const item = itemOf(resolved.snapshot, key);
    expect(item.type).toBe('Task');
    expect(item.projectKey).toBe('OTHER');
  });

  it('carries the draft title into alias, and never overwrites a pre-existing one', () => {
    const key = expectOk(
      apply(teamId, { op: 'add_item', title: 'Draft epic name' }),
    ).itemKey!;
    const resolved = expectOk(
      apply(teamId, { op: 'resolve_item', itemKey: key, jiraKey: 'NOVA-800' }),
    ).snapshot;
    expect(itemOf(resolved, key).alias).toBe('Draft epic name');

    const withAlias = expectOk(
      apply(teamId, { op: 'add_item', title: 'Draft epic name two' }),
    ).itemKey!;
    expectOk(
      apply(teamId, {
        op: 'set_alias',
        itemKey: withAlias,
        alias: 'User alias',
        baseVersion: itemOf(getTeamSnapshot(teamId)!, withAlias).version,
      }),
    );
    const resolvedTwo = expectOk(
      apply(teamId, { op: 'resolve_item', itemKey: withAlias, jiraKey: 'NOVA-801' }),
    ).snapshot;
    expect(itemOf(resolvedTwo, withAlias).alias).toBe('User alias');
  });
});

describe('resolve_draft', () => {
  function subOf(snapshot: TeamSnapshot, itemKey: string, subId: string) {
    const sub = itemOf(snapshot, itemKey).subs.find(
      (candidate) => candidate.id === subId,
    );
    if (!sub) throw new Error(`sub ${subId} missing`);
    return sub;
  }

  function activityFor(snapshotTeamId: string, subId: string) {
    return listActivity(snapshotTeamId, 200).filter(
      (entry) => entry.op === 'resolve_draft' && entry.targetKey === subId,
    );
  }

  /**
   * Both the create modal and the extension write the same child mapping — the
   * extension right after the issue exists, the page once the batch returns.
   */
  it('is a no-op when the same mapping arrives twice', () => {
    const itemKey = expectOk(
      apply(teamId, { op: 'add_item', title: 'Parent for children' }),
    ).itemKey!;
    const withSub = expectOk(
      apply(teamId, { op: 'add_sub', itemKey, title: 'child one' }),
    ).snapshot;
    const subId = itemOf(withSub, itemKey).subs[0].id;

    const first = expectOk(
      apply(teamId, {
        op: 'resolve_draft',
        mappings: [{ draftId: subId, jiraKey: 'NOVA-500' }],
      }),
    ).snapshot;
    const resolved = subOf(first, itemKey, subId);
    expect(resolved.key).toBe('NOVA-500');
    expect(resolved.temp).toBe(false);

    const second = expectOk(
      apply(teamId, {
        op: 'resolve_draft',
        mappings: [{ draftId: subId, jiraKey: 'NOVA-500' }],
      }),
    ).snapshot;
    const again = subOf(second, itemKey, subId);
    expect(again.version).toBe(resolved.version);
    expect(again.key).toBe('NOVA-500');
    expect(activityFor(teamId, subId)).toHaveLength(1);
  });

  it('still applies a corrected key for an already resolved sub', () => {
    const itemKey = expectOk(
      apply(teamId, { op: 'add_item', title: 'Parent for retry' }),
    ).itemKey!;
    const withSub = expectOk(
      apply(teamId, { op: 'add_sub', itemKey, title: 'child two' }),
    ).snapshot;
    const subId = itemOf(withSub, itemKey).subs[0].id;

    expectOk(
      apply(teamId, {
        op: 'resolve_draft',
        mappings: [{ draftId: subId, jiraKey: 'NOVA-600' }],
      }),
    );
    const corrected = expectOk(
      apply(teamId, {
        op: 'resolve_draft',
        mappings: [{ draftId: subId, jiraKey: 'NOVA-601' }],
      }),
    ).snapshot;
    expect(subOf(corrected, itemKey, subId).key).toBe('NOVA-601');
  });

  it('carries the draft title into alias so the gantt name survives a later refresh_from_jira summary rewrite', () => {
    const itemKey = expectOk(
      apply(teamId, { op: 'add_item', title: 'Parent for alias carry' }),
    ).itemKey!;
    const withSub = expectOk(
      apply(teamId, {
        op: 'add_sub',
        itemKey,
        title: 'My hand-typed draft title',
      }),
    ).snapshot;
    const subId = itemOf(withSub, itemKey).subs[0].id;
    expect(subOf(withSub, itemKey, subId).alias).toBeNull();

    const resolved = expectOk(
      apply(teamId, {
        op: 'resolve_draft',
        mappings: [{ draftId: subId, jiraKey: 'NOVA-700' }],
      }),
    ).snapshot;
    const sub = subOf(resolved, itemKey, subId);
    expect(sub.alias).toBe('My hand-typed draft title');
    expect(sub.title).toBe('My hand-typed draft title');
  });

  it('does not clobber an alias the user already set before resolving', () => {
    const itemKey = expectOk(
      apply(teamId, { op: 'add_item', title: 'Parent for existing alias' }),
    ).itemKey!;
    const withSub = expectOk(
      apply(teamId, { op: 'add_sub', itemKey, title: 'Original draft title' }),
    ).snapshot;
    const subId = itemOf(withSub, itemKey).subs[0].id;
    expectOk(
      apply(teamId, {
        op: 'update_sub',
        subId,
        alias: 'User chosen alias',
        baseVersion: subOf(withSub, itemKey, subId).version,
      }),
    );

    const resolved = expectOk(
      apply(teamId, {
        op: 'resolve_draft',
        mappings: [{ draftId: subId, jiraKey: 'NOVA-701' }],
      }),
    ).snapshot;
    expect(subOf(resolved, itemKey, subId).alias).toBe('User chosen alias');
  });
});

describe('import guard', () => {
  it('keeps manual rows (and their subs) out of an overwrite import', () => {
    const key = expectOk(
      apply(teamId, {
        op: 'add_item',
        title: 'Survivor',
        quarter: '2026-Q3',
      }),
    ).itemKey!;
    expectOk(apply(teamId, { op: 'add_sub', itemKey: key, title: 'sub keeps' }));

    const after = expectOk(
      apply(teamId, {
        op: 'import',
        quarters: ['2026-Q3'],
        overwrite: true,
        items: [
          {
            key: 'NOVA-3',
            type: 'Epic',
            title: 'Only survivor of the import',
            quarter: '2026-Q3',
          },
        ],
      }),
    ).snapshot;

    const survivor = itemOf(after, key);
    expect(survivor.source).toBe('manual');
    expect(survivor.subs.map((sub) => sub.title)).toContain('sub keeps');
    expect(after.items.some((item) => item.key === 'NOVA-1')).toBe(false);
    expect(after.items.some((item) => item.key === 'NOVA-3')).toBe(true);
  });

  it('updates the manual row in place when its Jira key is imported', () => {
    const key = expectOk(
      apply(teamId, { op: 'add_item', title: 'Created in Jira', quarter: '2026-Q4' }),
    ).itemKey!;
    expectOk(
      apply(teamId, { op: 'resolve_item', itemKey: key, jiraKey: 'NOVA-900' }),
    );

    const after = expectOk(
      apply(teamId, {
        op: 'import',
        quarters: ['2026-Q4'],
        overwrite: true,
        items: [
          {
            key: 'NOVA-900',
            type: 'Epic',
            title: 'Created in Jira (renamed)',
            quarter: '2026-Q4',
          },
        ],
      }),
    ).snapshot;

    expect(after.items.filter((item) => item.jiraKey === 'NOVA-900')).toHaveLength(
      1,
    );
    expect(after.items.some((item) => item.key === 'NOVA-900')).toBe(false);
    const promoted = itemOf(after, key);
    expect(promoted.source).toBe('jira');
    expect(promoted.title).toBe('Created in Jira (renamed)');
  });
});

describe('owner / members / cleared memory', () => {
  it('defaults new subs to 14 days and accumulates the owner as a member', () => {
    expectOk(
      apply(teamId, {
        op: 'import',
        quarters: ['2026-Q1'],
        overwrite: false,
        items: [
          {
            key: 'NOVA-OWN',
            type: 'Epic',
            title: 'Owner epic',
            quarter: '2026-Q1',
          },
        ],
      }),
    );
    expectOk(
      apply(teamId, {
        op: 'schedule',
        itemKey: 'NOVA-OWN',
        start: '2026-08-03',
        days: 21,
        baseVersion: itemOf(getTeamSnapshot(teamId)!, 'NOVA-OWN').version,
      }),
    );
    const after = expectOk(
      apply(teamId, {
        op: 'add_sub',
        itemKey: 'NOVA-OWN',
        title: 'Owned work',
        owner: 'Ada',
      }),
    ).snapshot;
    const sub = itemOf(after, 'NOVA-OWN').subs.find((s) => s.title === 'Owned work')!;
    expect(sub.days).toBe(14);
    expect(sub.owner).toBe('Ada');
    expect(after.members.some((m) => m.name === 'Ada')).toBe(true);
  });

  it('update_sub moves a bar without recreating the draft identity', () => {
    const before = itemOf(getTeamSnapshot(teamId)!, 'NOVA-OWN').subs.find(
      (s) => s.title === 'Owned work',
    )!;
    const after = expectOk(
      apply(teamId, {
        op: 'update_sub',
        subId: before.id,
        start: '2026-08-10',
        days: 10,
        baseVersion: before.version,
      }),
    ).snapshot;
    const sub = itemOf(after, 'NOVA-OWN').subs.find((s) => s.id === before.id)!;
    expect(sub.start).toBe('2026-08-10');
    expect(sub.days).toBe(10);
    expect(sub.temp).toBe(true);
    expect(sub.owner).toBe('Ada');
  });

  it('update_member renames and cascades to sub owners', () => {
    const member = getTeamSnapshot(teamId)!.members.find((m) => m.name === 'Ada')!;
    const after = expectOk(
      apply(teamId, {
        op: 'update_member',
        memberId: member.id,
        name: 'Ada Lovelace',
      }),
    ).snapshot;
    expect(after.members.some((m) => m.name === 'Ada Lovelace')).toBe(true);
    expect(
      itemOf(after, 'NOVA-OWN').subs.find((s) => s.title === 'Owned work')!.owner,
    ).toBe('Ada Lovelace');
  });

  it('cleanup soft-clears expired subs; schedule restores them', () => {
    const snap = getTeamSnapshot(teamId)!;
    const epic = itemOf(snap, 'NOVA-OWN');
    const sub = epic.subs.find((s) => s.title === 'Owned work')!;
    expectOk(
      apply(teamId, {
        op: 'update_sub',
        subId: sub.id,
        start: '2026-01-01',
        days: 5,
        baseVersion: sub.version,
      }),
    );
    const cleared = expectOk(
      apply(teamId, {
        op: 'cleanup',
        itemKeys: [],
        subIds: [sub.id],
      }),
    ).snapshot;
    expect(
      itemOf(cleared, 'NOVA-OWN').subs.find((s) => s.id === sub.id)!.cleared,
    ).toBe(true);

    const restored = expectOk(
      apply(teamId, {
        op: 'unschedule',
        itemKey: 'NOVA-OWN',
        baseVersion: itemOf(cleared, 'NOVA-OWN').version,
      }),
    ).snapshot;
    const back = expectOk(
      apply(teamId, {
        op: 'schedule',
        itemKey: 'NOVA-OWN',
        start: '2026-08-03',
        days: 21,
        baseVersion: itemOf(restored, 'NOVA-OWN').version,
      }),
    ).snapshot;
    expect(
      itemOf(back, 'NOVA-OWN').subs.find((s) => s.id === sub.id)!.cleared,
    ).toBe(false);
  });
});

describe('expand / collapse (viewer-local)', () => {
  it('accepts expand/collapse without mutating shared expanded or version', () => {
    const key = expectOk(
      apply(teamId, { op: 'add_item', title: 'Expand local only', quarter: '2026-Q3' }),
    ).itemKey!;
    const before = itemOf(getTeamSnapshot(teamId)!, key);
    const expandedBefore = before.expanded;
    const versionBefore = before.version;

    const afterExpand = expectOk(
      apply(teamId, {
        op: 'expand',
        itemKey: key,
        baseVersion: versionBefore,
      }),
    ).snapshot;
    const expanded = itemOf(afterExpand, key);
    expect(expanded.expanded).toBe(expandedBefore);
    expect(expanded.version).toBe(versionBefore);

    const afterCollapse = expectOk(
      apply(teamId, {
        op: 'collapse',
        itemKey: key,
        baseVersion: versionBefore,
      }),
    ).snapshot;
    const collapsed = itemOf(afterCollapse, key);
    expect(collapsed.expanded).toBe(expandedBefore);
    expect(collapsed.version).toBe(versionBefore);
  });
});

describe('gantt lane reorder', () => {
  it('reindexes siblings so dragging a lower row upward sticks', () => {
    const a = expectOk(
      apply(teamId, { op: 'add_item', title: 'Lane A', quarter: '2026-Q3' }),
    ).itemKey!;
    const b = expectOk(
      apply(teamId, { op: 'add_item', title: 'Lane B', quarter: '2026-Q3' }),
    ).itemKey!;
    const c = expectOk(
      apply(teamId, { op: 'add_item', title: 'Lane C', quarter: '2026-Q3' }),
    ).itemKey!;

    for (const [key, lane] of [
      [a, 0],
      [b, 1],
      [c, 2],
    ] as const) {
      const item = itemOf(getTeamSnapshot(teamId)!, key);
      expectOk(
        apply(teamId, {
          op: 'schedule',
          itemKey: key,
          start: '2026-08-01',
          days: 7,
          lane,
          baseVersion: item.version,
        }),
      );
    }

    const before = itemOf(getTeamSnapshot(teamId)!, c);
    expectOk(
      apply(teamId, {
        op: 'move',
        itemKey: c,
        start: before.start,
        days: before.days,
        lane: 0,
        baseVersion: before.version,
      }),
    );

    const ordered = getTeamSnapshot(teamId)!
      .items.filter((i) => i.scheduled && [a, b, c].includes(i.key))
      .sort((x, y) => x.lane - y.lane)
      .map((i) => i.key);
    expect(ordered).toEqual([c, a, b]);
    expect(itemOf(getTeamSnapshot(teamId)!, c).lane).toBe(0);
    expect(itemOf(getTeamSnapshot(teamId)!, a).lane).toBe(1);
    expect(itemOf(getTeamSnapshot(teamId)!, b).lane).toBe(2);
  });
});

describe('update_item title', () => {
  it('renames a draft item title used by Create Jira', () => {
    const key = expectOk(
      apply(teamId, { op: 'add_item', title: 'Old draft title', quarter: '2026-Q3' }),
    ).itemKey!;
    const item = itemOf(getTeamSnapshot(teamId)!, key);
    expectOk(
      apply(teamId, {
        op: 'update_item',
        itemKey: key,
        title: 'New draft title for Jira',
        baseVersion: item.version,
      }),
    );
    expect(itemOf(getTeamSnapshot(teamId)!, key).title).toBe(
      'New draft title for Jira',
    );
  });

  it('rejects empty title', () => {
    const key = expectOk(
      apply(teamId, { op: 'add_item', title: 'Keep me', quarter: '2026-Q3' }),
    ).itemKey!;
    const item = itemOf(getTeamSnapshot(teamId)!, key);
    const result = apply(teamId, {
      op: 'update_item',
      itemKey: key,
      title: '   ',
      baseVersion: item.version,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('title_required');
  });
});

describe('draft description', () => {
  it('stores description on add_item and add_sub', () => {
    const key = expectOk(
      apply(teamId, {
        op: 'add_item',
        title: 'Draft with desc',
        quarter: '2026-Q3',
        description: '  parent background  ',
      }),
    ).itemKey!;
    const item = itemOf(getTeamSnapshot(teamId)!, key);
    expect(item.description).toBe('parent background');
    expectOk(
      apply(teamId, {
        op: 'add_sub',
        itemKey: key,
        title: 'child',
        description: 'child constraint',
      }),
    );
    const sub = itemOf(getTeamSnapshot(teamId)!, key).subs[0];
    expect(sub.description).toBe('child constraint');
  });

  it('update_item description is draft-only', () => {
    const key = expectOk(
      apply(teamId, { op: 'add_item', title: 'Will resolve', quarter: '2026-Q3' }),
    ).itemKey!;
    const draft = itemOf(getTeamSnapshot(teamId)!, key);
    expectOk(
      apply(teamId, {
        op: 'update_item',
        itemKey: key,
        title: draft.title,
        description: 'before jira',
        baseVersion: draft.version,
      }),
    );
    expect(itemOf(getTeamSnapshot(teamId)!, key).description).toBe('before jira');
    expectOk(
      apply(teamId, {
        op: 'resolve_item',
        itemKey: key,
        jiraKey: 'NOVA-DESC-1',
      }),
    );
    const resolved = itemOf(getTeamSnapshot(teamId)!, key);
    const result = apply(teamId, {
      op: 'update_item',
      itemKey: key,
      title: resolved.title,
      description: 'should fail',
      baseVersion: resolved.version,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('item_not_draft');
  });

  it('update_sub description is draft-only', () => {
    expectOk(
      apply(teamId, {
        op: 'import',
        quarters: ['2026-Q3'],
        items: [{ key: 'NOVA-DESC-P', type: 'Epic', title: 'Parent', quarter: '2026-Q3' }],
      }),
    );
    expectOk(
      apply(teamId, { op: 'add_sub', itemKey: 'NOVA-DESC-P', title: 'draft child' }),
    );
    const sub = itemOf(getTeamSnapshot(teamId)!, 'NOVA-DESC-P').subs[0];
    expectOk(
      apply(teamId, {
        op: 'update_sub',
        subId: sub.id,
        description: 'user notes',
        baseVersion: sub.version,
      }),
    );
    const withDesc = itemOf(getTeamSnapshot(teamId)!, 'NOVA-DESC-P').subs[0];
    expect(withDesc.description).toBe('user notes');
    expectOk(
      apply(teamId, {
        op: 'resolve_draft',
        mappings: [{ draftId: withDesc.id, jiraKey: 'NOVA-DESC-C' }],
      }),
    );
    const resolved = itemOf(getTeamSnapshot(teamId)!, 'NOVA-DESC-P').subs[0];
    const result = apply(teamId, {
      op: 'update_sub',
      subId: resolved.id,
      description: 'nope',
      baseVersion: resolved.version,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('item_not_draft');
  });
});

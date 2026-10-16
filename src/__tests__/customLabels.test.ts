import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ActorContext } from '../types.js';

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'roadmap-labels-'));

const {
  applyIntent,
  createTeam,
  getTeamSnapshot,
  listCustomLabelValues,
  upsertCustomLabelValues,
} = await import('../core/TeamService.js');
const {
  parseCustomLabelsField,
  resolveMilestoneDate,
} = await import('../core/customLabels.js');

const actor: ActorContext = {
  name: 'Tester',
  clientId: 'test-client',
  source: 'extension',
};

function apply(teamId: string, intent: Record<string, unknown>) {
  return applyIntent(teamId, intent, actor);
}

function expectOk(result: ReturnType<typeof applyIntent>) {
  if (!result.ok) throw new Error(`intent failed: ${result.error}`);
  return result;
}

describe('parseCustomLabelsField', () => {
  it('parses raw Jira field text with newline-separated pairs', () => {
    expect(
      parseCustomLabelsField('LBL-288:LBL-291\nLBL-288:LBL-297'),
    ).toEqual([
      { labelKey: 'LBL-288', valueKey: 'LBL-291' },
      { labelKey: 'LBL-288', valueKey: 'LBL-297' },
    ]);
  });

  it('accepts already-parsed pair arrays and de-duplicates by value key', () => {
    expect(
      parseCustomLabelsField([
        { labelKey: 'LBL-288', valueKey: 'LBL-291' },
        { labelKey: 'LBL-288', valueKey: 'LBL-291' },
        { labelKey: 'LBL-289', valueKey: 'LBL-301' },
      ]),
    ).toEqual([
      { labelKey: 'LBL-288', valueKey: 'LBL-291' },
      { labelKey: 'LBL-289', valueKey: 'LBL-301' },
    ]);
  });

  it('drops lines that are not issue keys', () => {
    expect(parseCustomLabelsField('not-a-key\nLBL-288:LBL-291')).toEqual([
      { labelKey: 'LBL-288', valueKey: 'LBL-291' },
    ]);
    expect(parseCustomLabelsField(null)).toEqual([]);
  });
});

describe('resolveMilestoneDate', () => {
  it('prefers Due Date, then Target End, then the description first line', () => {
    expect(
      resolveMilestoneDate({
        dueDate: '2026-11-30',
        targetEnd: '2026-12-15',
        description: 'Milestone: 11/20/26',
      }),
    ).toEqual({ date: '2026-11-30', source: 'duedate' });
    expect(
      resolveMilestoneDate({
        dueDate: null,
        targetEnd: '2026-12-15',
        description: 'Milestone: 11/20/26',
      }),
    ).toEqual({ date: '2026-12-15', source: 'targetEnd' });
    expect(
      resolveMilestoneDate({ description: 'Milestone: 11/30/26\n\nBeta release.' }),
    ).toEqual({ date: '2026-11-30', source: 'description' });
  });

  it('matches the "Milestone - 1/31/27" dash variant and 4-digit years', () => {
    expect(resolveMilestoneDate({ description: 'Milestone - 1/31/27' })).toEqual({
      date: '2027-01-31',
      source: 'description',
    });
    expect(resolveMilestoneDate({ description: 'Milestone: 2/1/2026' })).toEqual({
      date: '2026-02-01',
      source: 'description',
    });
  });

  it('returns null when no date can be resolved', () => {
    expect(
      resolveMilestoneDate({ description: 'Timing to be agreed with partners.' }),
    ).toBeNull();
    expect(resolveMilestoneDate({})).toBeNull();
    expect(resolveMilestoneDate({ dueDate: '2026-02-30' })).toBeNull();
  });
});

describe('custom label milestones', () => {
  let teamId = '';

  beforeAll(() => {
    const snapshot = createTeam({
      name: 'Labels',
      jql: 'project = NOVA AND issuetype = Epic',
      actor,
    });
    teamId = snapshot.team.id;
    expectOk(
      apply(teamId, {
        op: 'import',
        quarters: ['2026-Q3'],
        items: [
          {
            key: 'NOVA-100',
            type: 'Epic',
            title: 'Labeled epic',
            quarter: '2026-Q3',
            // Raw Jira field text exactly as customfield_33875 returns it.
            customLabels: 'LBL-288:LBL-291\nLBL-288:LBL-297',
          },
          {
            key: 'NOVA-101',
            type: 'Epic',
            title: 'Unlabeled epic',
            quarter: '2026-Q3',
          },
        ],
      }),
    );
  });

  it('exposes item.ms value keys on the snapshot', () => {
    const items = getTeamSnapshot(teamId)!.items;
    expect(items.find((i) => i.key === 'NOVA-100')!.ms).toEqual([
      'LBL-291',
      'LBL-297',
    ]);
    expect(items.find((i) => i.key === 'NOVA-101')!.ms).toEqual([]);
  });

  it('upserts dictionary entries and resolves milestone dates server-side', () => {
    const result = upsertCustomLabelValues(teamId, actor, [
      {
        key: 'LBL-291',
        name: 'AIR 2.0 Beta',
        labelKey: 'LBL-288',
        labelName: 'AIR 2.0 Milestones',
        description: 'Milestone: 11/30/26\n\nThe first external release.',
      },
      {
        key: 'LBL-297',
        name: 'Advance Analytics and Integration with ACE Phase 1',
        labelKey: 'LBL-288',
        labelName: 'AIR 2.0 Milestones',
        description: '',
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byKey = new Map(result.values.map((v) => [v.key, v]));
    expect(byKey.get('LBL-291')).toMatchObject({
      labelKey: 'LBL-288',
      labelName: 'AIR 2.0 Milestones',
      name: 'AIR 2.0 Beta',
      milestoneDate: '2026-11-30',
      dateSource: 'description',
    });
    expect(byKey.get('LBL-297')).toMatchObject({
      milestoneDate: null,
      dateSource: null,
    });

    const snapshot = getTeamSnapshot(teamId)!;
    expect(snapshot.team.customLabels).toHaveLength(2);
    expect(listCustomLabelValues(teamId)).toHaveLength(2);
  });

  it('keeps the latest description and date on re-upsert', () => {
    const result = upsertCustomLabelValues(teamId, actor, [
      {
        key: 'LBL-291',
        name: 'AIR 2.0 Beta',
        labelKey: 'LBL-288',
        labelName: 'AIR 2.0 Milestones',
        description: 'Milestone: 12/15/26',
        dueDate: '2026-12-14',
      },
    ]);
    expect(result.ok).toBe(true);
    const entry = listCustomLabelValues(teamId).find((v) => v.key === 'LBL-291');
    expect(entry).toMatchObject({
      milestoneDate: '2026-12-14',
      dateSource: 'duedate',
    });
  });

  it('rejects non-array payloads', () => {
    const result = upsertCustomLabelValues(teamId, actor, 'nope');
    expect(result.ok).toBe(false);
  });

  it('mirrors custom labels from refresh_from_jira issue fields', () => {
    apply(teamId, {
      op: 'refresh_from_jira',
      ignoreTtl: true,
      issues: [
        {
          key: 'NOVA-100',
          fetchedAt: Date.now(),
          fields: {
            summary: 'Labeled epic',
            customLabels: [
              { labelKey: 'LBL-288', valueKey: 'LBL-293' },
              { labelKey: 'LBL-288', valueKey: 'LBL-291' },
            ],
          },
        },
      ],
    });
    const item = getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-100');
    expect(item!.ms).toEqual(['LBL-293', 'LBL-291']);
  });
});

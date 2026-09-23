import { describe, expect, it } from 'vitest';
import {
  buildBacklogGroups,
  collectJiraRefreshKeys,
  collectUnsyncedTargetRefs,
  scheduleDivergesFromMirroredTarget,
  buildCreateJiraPayload,
  buildDraftGroups,
  buildStateMessage,
  createItemRowId,
  createSubRowId,
  draftGroupCanRetry,
  NO_QUARTER_GROUP,
  canDeleteItem,
  defaultPhaseDate,
  canAdoptJiraTargetEnd,
  depAdoptLabel,
  depBadgeTip,
  depHoverTip,
  depStatusChipLabel,
  depStatusIsStale,
  driftedDepCount,
  epicColor,
  epicShort,
  formatEstimate,
  isDoneStatus,
  isDraftItem,
  isSystemActivity,
  itemDisplayKey,
  pendingDepCount,
  pickTickerEntry,
  shouldWrapAlias,
  sliceDraftGroupForRetry,
  subTypeComesFromCreateMeta,
  tickerLabel,
  tooltipHintLine,
  trackMarkers,
  typeBadge,
  clampDescription,
  DESCRIPTION_MAX_CHARS,
} from '../composables/useRoadmapContract';
import {
  buildAgentCreatePrompt,
  describeFixVersionConstraint,
  FIX_VERSION_OMIT_IF_MISSING,
  ROADMAP_CREATE_JIRA_SYSTEM_PROMPT,
  truncateEpicDesc,
} from '../composables/useCreateJiraAgentPrompt';
import type { RoadmapItem, RoadmapSub } from '../types';

function sub(overrides: Partial<RoadmapSub> = {}): RoadmapSub {
  return {
    id: 'sub1',
    key: null,
    title: 'child task',
    alias: null,
    owner: null,
    start: '2026-07-01',
    days: 14,
    temp: true,
    createdBy: 'Tester',
    version: 1,
    ...overrides,
  };
}

function item(overrides: Partial<RoadmapItem> = {}): RoadmapItem {
  return {
    key: 'NOVA-1',
    type: 'Epic',
    title: 'Imported epic',
    source: 'jira',
    jiraKey: 'NOVA-1',
    projectKey: 'NOVA',
    alias: null,
    quarter: '2026-Q3',
    estimate: 3,
    targetStart: '2026-07-01',
    targetEnd: '2026-08-01',
    scheduled: true,
    start: '2026-07-01',
    days: 30,
    lane: 0,
    expanded: false,
    version: 1,
    subs: [],
    markers: [],
    ...overrides,
  };
}

describe('draft detection', () => {
  it('treats a missing jiraKey as draft regardless of source', () => {
    expect(isDraftItem(item({ jiraKey: null }))).toBe(true);
    expect(isDraftItem(item({ source: 'manual', jiraKey: null }))).toBe(true);
  });

  it('does not treat a resolved manual item as draft', () => {
    const resolved = item({
      key: 'LOCAL-ab12cd34',
      source: 'manual',
      jiraKey: 'NOVA-900',
    });
    expect(isDraftItem(resolved)).toBe(false);
    expect(itemDisplayKey(resolved)).toBe('NOVA-900');
    expect(canDeleteItem(resolved)).toBe(false);
  });

  it('only allows deleting manual items without a Jira issue', () => {
    expect(canDeleteItem(item({ source: 'manual', jiraKey: null }))).toBe(true);
    expect(canDeleteItem(item({ source: 'jira', jiraKey: null }))).toBe(false);
  });

  it('falls back to the local key while no Jira issue exists', () => {
    expect(itemDisplayKey(item({ key: 'LOCAL-ab12cd34', jiraKey: null }))).toBe(
      'LOCAL-ab12cd34',
    );
  });
});

describe('display helpers', () => {
  it('renders an empty estimate as a dash instead of 0 / NaN', () => {
    expect(formatEstimate(null)).toBe('—');
    expect(formatEstimate(undefined)).toBe('—');
    expect(formatEstimate(0)).toBe('—');
    expect(formatEstimate(Number.NaN)).toBe('—');
    expect(formatEstimate(2)).toBe('2w');
  });

  it('maps canonical Jira casing onto the uppercase badge classes', () => {
    expect(typeBadge('Epic')).toEqual({ cls: 'type-EPIC', label: 'EPIC' });
    expect(typeBadge('Initiative')).toEqual({ cls: 'type-INIT', label: 'INIT' });
    expect(typeBadge('Task')).toEqual({ cls: 'type-TASK', label: 'TASK' });
    expect(typeBadge('Story').cls).toBe('type-TASK');
  });

  it('only wraps an alias to multiple lines when it reads like a short display name', () => {
    expect(shouldWrapAlias(null)).toBe(false);
    expect(shouldWrapAlias(undefined)).toBe(false);
    expect(shouldWrapAlias('')).toBe(false);
    expect(shouldWrapAlias('智能快捷回复')).toBe(true);
    // A preserved draft title (see resolve_item/resolve_draft) is usually long
    // English prose — wrapping that to multiple lines blows up bar height for
    // no benefit, so it falls back to single-line ellipsis like a plain title.
    expect(
      shouldWrapAlias(
        'Wire A/B experiment flags and metrics events for smart replies rollout',
      ),
    ).toBe(false);
  });

  it('assigns each Epic a stable color from its position in the gantt row order', () => {
    const order = ['NOVA-1', 'NOVA-2', 'NOVA-3'];
    expect(epicColor(order, 'NOVA-1')).toBe(epicColor(order, 'NOVA-1'));
    expect(epicColor(order, 'NOVA-1')).not.toBe(epicColor(order, 'NOVA-2'));
    // A key with no known row position still gets a deterministic color
    // instead of throwing or falling back to the same swatch every time.
    expect(epicColor(order, 'UNKNOWN-KEY')).toBe(epicColor(order, 'UNKNOWN-KEY'));
  });

  it('treats Closed/Resolved/Done as finished, everything else (including no status yet) as open', () => {
    expect(isDoneStatus(sub({ status: 'Closed' }))).toBe(true);
    expect(isDoneStatus(sub({ status: 'Resolved' }))).toBe(true);
    expect(isDoneStatus(sub({ status: 'Done' }))).toBe(true);
    expect(isDoneStatus(sub({ status: 'In Progress' }))).toBe(false);
    expect(isDoneStatus(sub({ status: null }))).toBe(false);
    expect(isDoneStatus(sub({}))).toBe(false);
    expect(isDoneStatus(item({ status: 'Closed' }))).toBe(true);
    expect(isDoneStatus(item({ status: 'In Progress' }))).toBe(false);
    expect(isDoneStatus(item({}))).toBe(false);
  });

  it('prefers the alias over the title for the resource-view Epic prefix chip', () => {
    expect(epicShort({ alias: '短名', title: 'Some very long epic title here' })).toBe(
      '短名',
    );
    expect(epicShort({ alias: null, title: 'Short title' })).toBe('Short title');
    expect(
      epicShort({ alias: null, title: 'A title so long it needs truncation applied' })
        .length,
    ).toBeLessThan('A title so long it needs truncation applied'.length);
  });
});

describe('collectJiraRefreshKeys', () => {
  const backlog = (overrides: Partial<RoadmapItem> = {}) =>
    item({ scheduled: false, start: null, days: null, ...overrides });

  it('includes backlog jira keys after scheduled keys within the 50-key budget', () => {
    const scheduled = item({
      key: 'NOVA-1',
      jiraKey: 'NOVA-1',
      subs: [{ ...sub({ key: 'NOVA-2' }), cleared: false }],
    });
    const keys = collectJiraRefreshKeys(
      [scheduled],
      [
        backlog({ key: 'NOVA-9', jiraKey: 'NOVA-9' }),
        backlog({ key: 'LOCAL-x', jiraKey: null }),
      ],
      new Set(),
    );
    expect(keys).toEqual(['NOVA-1', 'NOVA-2', 'NOVA-9']);
  });
});

describe('unsynced Target writeback', () => {
  it('treats a resized epic as dirty when last mirrored Target still has the old span', () => {
    expect(
      scheduleDivergesFromMirroredTarget({
        start: '2026-08-01',
        days: 21,
        targetStart: '2026-08-01',
        targetEnd: '2026-08-14',
      }),
    ).toBe(true);
    expect(
      scheduleDivergesFromMirroredTarget({
        start: '2026-08-01',
        days: 14,
        targetStart: '2026-08-01',
        targetEnd: '2026-08-14',
      }),
    ).toBe(false);
    expect(
      scheduleDivergesFromMirroredTarget({
        start: '2026-08-01',
        days: 21,
        targetStart: null,
        targetEnd: null,
      }),
    ).toBe(false);
  });

  it('collects dirty epics and subs for extension writeback', () => {
    const refs = collectUnsyncedTargetRefs([
      item({
        key: 'NOVA-1',
        jiraKey: 'NOVA-1',
        start: '2026-08-01',
        days: 21,
        targetStart: '2026-08-01',
        targetEnd: '2026-08-14',
        subs: [
          sub({
            id: 's1',
            key: 'NOVA-2',
            temp: false,
            start: '2026-08-03',
            days: 10,
            targetStart: '2026-08-03',
            targetEnd: '2026-08-07',
          }),
          sub({
            id: 's2',
            key: 'NOVA-3',
            temp: false,
            start: '2026-08-03',
            days: 5,
            targetStart: '2026-08-03',
            targetEnd: '2026-08-07',
          }),
        ],
      }),
    ]);
    expect(refs).toEqual([
      {
        itemKey: 'NOVA-1',
        jiraKey: 'NOVA-1',
        start: '2026-08-01',
        days: 21,
      },
      {
        subId: 's1',
        jiraKey: 'NOVA-2',
        start: '2026-08-03',
        days: 10,
      },
    ]);
  });
});

describe('backlog grouping', () => {
  const backlog = (overrides: Partial<RoadmapItem> = {}) =>
    item({ scheduled: false, start: null, days: null, ...overrides });

  it('puts the newest manual item first in the whole list', () => {
    const groups = buildBacklogGroups([
      backlog({ key: 'NOVA-1', quarter: '2026-Q3' }),
      backlog({ key: 'NOVA-2', quarter: '2026-Q4' }),
      backlog({
        key: 'LOCAL-new',
        quarter: '2026-Q4',
        source: 'manual',
        jiraKey: null,
        createdAt: 200,
      }),
      backlog({
        key: 'LOCAL-old',
        quarter: '2026-Q3',
        source: 'manual',
        jiraKey: null,
        createdAt: 100,
      }),
    ]);
    expect(groups.map(([q]) => q)).toEqual(['2026-Q4', '2026-Q3']);
    expect(groups[0][1].map((i) => i.key)).toEqual(['LOCAL-new', 'NOVA-2']);
    expect(groups[1][1].map((i) => i.key)).toEqual(['LOCAL-old', 'NOVA-1']);
  });

  it('keeps quarters in order and Jira rows in server key order without manual items', () => {
    const groups = buildBacklogGroups([
      backlog({ key: 'NOVA-9', quarter: '2026-Q4' }),
      backlog({ key: 'NOVA-2', quarter: '2026-Q3' }),
      backlog({ key: 'NOVA-1', quarter: '2026-Q3' }),
    ]);
    expect(groups.map(([q]) => q)).toEqual(['2026-Q3', '2026-Q4']);
    expect(groups[0][1].map((i) => i.key)).toEqual(['NOVA-2', 'NOVA-1']);
  });

  it('floats an unscheduled manual item created without a quarter', () => {
    const groups = buildBacklogGroups([
      backlog({ key: 'NOVA-1', quarter: '2026-Q3' }),
      backlog({
        key: 'LOCAL-noq',
        quarter: null,
        source: 'manual',
        jiraKey: null,
        createdAt: 300,
      }),
    ]);
    expect(groups.map(([q]) => q)).toEqual([NO_QUARTER_GROUP, '2026-Q3']);
  });

  it('sorts the no-quarter group last when nothing was created by hand', () => {
    const groups = buildBacklogGroups([
      backlog({ key: 'NOVA-0', quarter: null }),
      backlog({ key: 'NOVA-1', quarter: '2026-Q4' }),
      backlog({ key: 'NOVA-2', quarter: '2026-Q3' }),
    ]);
    expect(groups.map(([q]) => q)).toEqual(['2026-Q3', '2026-Q4', NO_QUARTER_GROUP]);
  });

  it('tolerates a server that does not send createdAt yet', () => {
    const groups = buildBacklogGroups([
      backlog({ key: 'NOVA-1', quarter: '2026-Q3' }),
      backlog({ key: 'LOCAL-a', quarter: '2026-Q3', source: 'manual', jiraKey: null }),
      backlog({ key: 'LOCAL-b', quarter: '2026-Q3', source: 'manual', jiraKey: null }),
    ]);
    expect(groups[0][1].map((i) => i.key)).toEqual(['LOCAL-a', 'LOCAL-b', 'NOVA-1']);
  });

  it('sinks Closed/Resolved/Done epics to the back of each quarter group', () => {
    const groups = buildBacklogGroups([
      backlog({ key: 'NOVA-3', quarter: '2026-Q3', status: 'Closed' }),
      backlog({ key: 'NOVA-1', quarter: '2026-Q3', status: 'In Progress' }),
      backlog({ key: 'NOVA-2', quarter: '2026-Q3', status: 'Resolved' }),
      backlog({
        key: 'LOCAL-open',
        quarter: '2026-Q3',
        source: 'manual',
        jiraKey: null,
        createdAt: 50,
      }),
      backlog({
        key: 'LOCAL-done',
        quarter: '2026-Q3',
        source: 'manual',
        jiraKey: 'NOVA-9',
        status: 'Closed',
        createdAt: 200,
      }),
    ]);
    expect(groups[0][1].map((i) => i.key)).toEqual([
      'LOCAL-open',
      'NOVA-1',
      'LOCAL-done',
      'NOVA-3',
      'NOVA-2',
    ]);
  });
});

describe('sub-type source', () => {
  /**
   * The backend sends `subType: null` for a Task-level parent on purpose; the
   * create modal must let that through instead of demanding a name the user
   * cannot know, because only the project's createmeta has it.
   */
  it('leaves the Task-level sub-task name to the extension', () => {
    expect(subTypeComesFromCreateMeta('Task')).toBe(true);
    expect(subTypeComesFromCreateMeta('Story')).toBe(true);
    expect(subTypeComesFromCreateMeta('User Story')).toBe(true);
    expect(subTypeComesFromCreateMeta('Bug')).toBe(true);
  });

  it('keeps the named child types under the user’s control', () => {
    expect(subTypeComesFromCreateMeta('Epic')).toBe(false);
    expect(subTypeComesFromCreateMeta('Initiative')).toBe(false);
    expect(subTypeComesFromCreateMeta('INIT')).toBe(false);
    expect(subTypeComesFromCreateMeta('')).toBe(false);
    expect(subTypeComesFromCreateMeta(null)).toBe(false);
  });
});

describe('postMessage state', () => {
  it('emits teamId plus the legacy team alias and the memory fields', () => {
    const message = buildStateMessage({
      teamId: 'T1',
      teamName: 'Nova',
      quarter: '2026-Q3',
      editable: true,
      items: [
        item({ key: 'LOCAL-a1', source: 'manual', jiraKey: null, quarter: null, subs: [sub()] }),
      ],
    });

    expect(message.type).toBe('pai-roadmap-state');
    expect(message.teamId).toBe('T1');
    expect(message.team).toBe('T1');
    expect(message.items[0]).toEqual({
      key: 'LOCAL-a1',
      type: 'Epic',
      title: 'Imported epic',
      alias: null,
      quarter: '2026-Q3',
      targetStart: '2026-07-01',
      targetEnd: '2026-08-01',
      start: '2026-07-01',
      days: 30,
      isDraft: true,
      jiraKey: null,
      subActivity: true,
      description: null,
    });
  });

  it('marks resolved items as non-draft and carries the real key', () => {
    const message = buildStateMessage({
      teamId: 'T1',
      teamName: 'Nova',
      quarter: '2026-Q3',
      editable: true,
      items: [item({ key: 'LOCAL-a1', source: 'manual', jiraKey: 'NOVA-900' })],
    });
    expect(message.items[0].isDraft).toBe(false);
    expect(message.items[0].jiraKey).toBe('NOVA-900');
    expect(message.items[0].key).toBe('LOCAL-a1');
  });
});

describe('create-jira payload', () => {
  const fields = {
    teamId: 'T1',
    token: 'tok',
    projectKey: 'NOVA',
    issueType: 'Epic',
    subType: 'Task',
  };

  it('groups only items that still need creating', () => {
    const groups = buildDraftGroups([
      item({ key: 'LOCAL-a1', source: 'manual', jiraKey: null }),
      item({ key: 'NOVA-2', subs: [sub({ id: 's2' })] }),
      item({ key: 'NOVA-3', subs: [sub({ id: 's3', temp: false })] }),
    ]);
    expect(groups.map((g) => g.item.key)).toEqual(['LOCAL-a1', 'NOVA-2']);
  });

  it('sends a parent block for a draft main item', () => {
    const group = buildDraftGroups([
      item({
        key: 'LOCAL-ab12cd34',
        source: 'manual',
        jiraKey: null,
        title: 'Manual epic',
        subs: [sub({ id: 'd1', title: 'first child' })],
      }),
    ])[0];

    expect(buildCreateJiraPayload(group, fields)).toEqual({
      teamId: 'T1',
      token: 'tok',
      parent: {
        itemKey: 'LOCAL-ab12cd34',
        title: 'Manual epic',
        issueType: 'Epic',
        projectKey: 'NOVA',
        targetStart: '2026-07-01',
        targetEnd: '2026-08-01',
        fixVersion: null,
        suggestedFixVersion: null,
        description: null,
      },
      children: [
        {
          draftId: 'd1',
          title: 'first child',
          issueType: 'Task',
          projectKey: 'NOVA',
          parentItemKey: 'LOCAL-ab12cd34',
          parentJiraKey: null,
          fixVersion: null,
          suggestedFixVersion: null,
          assignee: null,
          description: null,
        },
      ],
    });
  });

  it('applies per-row fixVersion suggestions and a uniform override', () => {
    const group = buildDraftGroups([
      item({
        key: 'LOCAL-ab12cd34',
        source: 'manual',
        jiraKey: null,
        title: 'Manual epic',
        subs: [sub({ id: 'd1', title: 'first child' })],
      }),
    ])[0];

    expect(
      buildCreateJiraPayload(group, {
        ...fields,
        fixVersionByKey: {
          'LOCAL-ab12cd34': '26.3.220',
          d1: '26.4.10',
        },
      }).parent?.fixVersion,
    ).toBe('26.3.220');
    expect(
      buildCreateJiraPayload(group, {
        ...fields,
        fixVersionOverride: '26.5.0',
        fixVersionByKey: {
          'LOCAL-ab12cd34': '26.3.220',
          d1: '26.4.10',
        },
      }).children[0],
    ).toMatchObject({
      fixVersion: '26.5.0',
      suggestedFixVersion: '26.4.10',
    });
  });

  it('omits the parent and passes its key when the issue already exists', () => {
    const group = buildDraftGroups([
      item({ key: 'NOVA-7', jiraKey: 'NOVA-7', subs: [sub({ id: 'd2' })] }),
    ])[0];
    const payload = buildCreateJiraPayload(group, fields);

    expect(payload.parent).toBeNull();
    expect(payload.children[0].parentJiraKey).toBe('NOVA-7');
    expect(payload.children[0].parentItemKey).toBe('NOVA-7');
  });

  it('forwards draft descriptions on parent and children', () => {
    const group = buildDraftGroups([
      item({
        key: 'LOCAL-ab12cd34',
        source: 'manual',
        jiraKey: null,
        title: 'Manual epic',
        description: 'parent notes',
        subs: [sub({ id: 'd1', title: 'first child', description: 'child notes' })],
      }),
    ])[0];
    const payload = buildCreateJiraPayload(group, fields);
    expect(payload.parent?.description).toBe('parent notes');
    expect(payload.children[0].description).toBe('child notes');
  });
});

describe('markers helpers', () => {
  it('counts pending deps and sorts track markers', () => {
    const row = item({
      markers: [
        {
          id: 'd1',
          kind: 'dep',
          label: 'no eta',
          date: null,
          createdBy: 't',
          version: 1,
        },
        {
          id: 'p1',
          kind: 'phase',
          phaseKind: 'production',
          label: 'Production',
          date: '2026-09-01',
          createdBy: 't',
          version: 1,
        },
        {
          id: 'd2',
          kind: 'dep',
          label: 'with eta',
          date: '2026-08-10',
          jiraKey: 'PLAT-1',
          etaSource: 'jira',
          createdBy: 't',
          version: 1,
        },
      ],
    });
    expect(pendingDepCount(row)).toBe(1);
    expect(trackMarkers(row).map((m) => m.id)).toEqual(['d2', 'p1']);
  });

  it('describes missing ETA vs Target End mismatch for hover', () => {
    const missing = item({
      markers: [
        {
          id: 'd1',
          kind: 'dep',
          label: 'Legal copy',
          date: null,
          jiraKey: 'LEGAL-1',
          jiraStatus: 'In Progress',
          jiraTargetEnd: '2026-08-18',
          jiraFetchedAt: 1,
          createdBy: 't',
          version: 1,
        },
      ],
    });
    expect(depHoverTip(missing.markers[0])).toContain('缺 ETA · Jira Target End 08-18');
    expect(depBadgeTip(missing)).toContain('单击可同步为 ETA');

    const drift = item({
      markers: [
        {
          id: 'd2',
          kind: 'dep',
          label: 'Platform',
          date: '2026-08-12',
          jiraKey: 'PLAT-1',
          jiraStatus: 'In Progress',
          jiraTargetEnd: '2026-08-18',
          createdBy: 't',
          version: 1,
        },
      ],
    });
    expect(driftedDepCount(drift)).toBe(1);
    expect(depHoverTip(drift.markers[0])).toContain('不一致');
    expect(depBadgeTip(drift)).toContain('不一致');
    expect(canAdoptJiraTargetEnd(drift.markers[0])).toBe(true);
    expect(depAdoptLabel(drift.markers[0])).toBe('改用 Jira 08-18');
  });

  it('builds adopt labels for mixed deps without requiring every row to have Target End', () => {
    expect(
      depAdoptLabel({ date: '2026-08-12', jiraTargetEnd: '2026-08-18' }),
    ).toBe('改用 Jira 08-18');
    expect(depAdoptLabel({ date: null, jiraTargetEnd: '2026-08-18' })).toBe(
      '采用 08-18 为 ETA',
    );
    expect(depAdoptLabel({ date: '2026-08-10', jiraTargetEnd: null })).toBe(null);
    expect(depAdoptLabel({ date: null, jiraTargetEnd: undefined })).toBe(null);
    expect(
      depStatusChipLabel({
        jiraKey: 'CNV-1',
        jiraStatus: null,
      }),
    ).toBe('未刷新');
    expect(
      depStatusIsStale({ jiraKey: 'CNV-1', jiraStatus: null }),
    ).toBe(true);
    expect(
      depStatusChipLabel({
        jiraKey: 'CNV-1',
        jiraStatus: 'In Progress',
      }),
    ).toBe('In Progress');
    expect(
      depStatusIsStale({ jiraKey: 'CNV-1', jiraStatus: 'In Progress' }),
    ).toBe(false);
    expect(
      depStatusChipLabel({
        jiraKey: 'CNV-1',
        jiraStatus: null,
      }),
    ).toBe('未刷新');
    expect(
      canAdoptJiraTargetEnd({
        id: 'd3',
        kind: 'dep',
        label: 'manual',
        date: '2026-08-10',
        jiraKey: null,
        createdBy: 't',
        version: 1,
      }),
    ).toBe(false);
  });

  it('defaults phase dates past the bar end with stagger', () => {
    const row = item({
      start: '2026-08-01',
      days: 14,
      markers: [
        {
          id: 'p0',
          kind: 'phase',
          phaseKind: 'design',
          label: 'Design',
          date: '2026-08-20',
          createdBy: 't',
          version: 1,
        },
      ],
    });
    // end = Aug 14; +7 + 1*7 = Aug 28
    expect(defaultPhaseDate(row)).toBe('2026-08-28');
  });
});

describe('sync ticker', () => {
  function entry(
    overrides: Partial<import('../types').ActivityEntry> = {},
  ): import('../types').ActivityEntry {
    return {
      id: 'a1',
      teamId: 't1',
      at: Date.now(),
      actorName: 'Kevin',
      actorClientId: 'other',
      actorSource: 'anonymous',
      op: 'move',
      targetType: 'item',
      targetKey: 'NOVA-1',
      summary: { alias: 'Readiness' },
      text: 'Kevin 把 Readiness 从 2026-08-01 移到 2026-08-05',
      ...overrides,
    };
  }

  it('pickTickerEntry skips self and noise ops', () => {
    expect(pickTickerEntry([], 'me')).toBeNull();
    expect(
      pickTickerEntry(
        [entry({ actorClientId: 'me' }), entry({ id: 'a2', op: 'lock' })],
        'me',
      ),
    ).toBeNull();
    const hit = entry({ id: 'a3', actorClientId: 'other', op: 'add_sub' });
    expect(
      pickTickerEntry(
        [
          entry({ actorClientId: 'me' }),
          entry({ id: 'noise', op: 'expand' }),
          entry({ id: 'refresh', op: 'refresh_from_jira' }),
          hit,
        ],
        'me',
      ),
    ).toBe(hit);
  });

  it('pickTickerEntry skips other teams and silent release-sheet refresh', () => {
    const otherTeam = entry({
      id: 'other-team',
      teamId: 't2',
      op: 'move',
    });
    const silentSheet = entry({
      id: 'sheet',
      op: 'update_release_sheet',
      actorName: '系统',
      actorClientId: 'system',
      summary: { cleared: false, silent: true, rowCount: 499 },
      text: '系统 静默更新了发布时间表标尺',
    });
    const cleared = entry({
      id: 'cleared',
      op: 'update_release_sheet',
      summary: { cleared: true },
      text: 'Kevin 清除了发布时间表标尺',
    });
    expect(pickTickerEntry([otherTeam, silentSheet], 'me', 't1')).toBeNull();
    expect(pickTickerEntry([silentSheet, cleared], 'me', 't1')).toBe(cleared);
    expect(isSystemActivity(silentSheet)).toBe(true);
    expect(isSystemActivity(cleared)).toBe(false);
  });

  it('tickerLabel strips actor prefix and truncates', () => {
    expect(tickerLabel(entry())).toBe(
      '把 Readiness 从 2026-08-01 移到 2026-08-05',
    );
    const long = entry({
      text: `Kevin ${'很长的动作文案'.repeat(20)}`,
    });
    const label = tickerLabel(long, 20);
    expect(label.endsWith('…')).toBe(true);
    expect(label.length).toBe(20);
  });
});

describe('draft description contract', () => {
  it('tooltip hint prefers description over the operation hint', () => {
    expect(tooltipHintLine('LaunchDarkly 开关覆盖 Web 与移动端', '双击修改备注名')).toBe(
      'LaunchDarkly 开关覆盖 Web 与移动端',
    );
    expect(tooltipHintLine(null, '双击修改备注名')).toBe('双击修改备注名');
    expect(tooltipHintLine('   ', '拖到右侧时间轴排期')).toBe('拖到右侧时间轴排期');
  });

  it('system prompt combines user description and allows rewrite', () => {
    expect(ROADMAP_CREATE_JIRA_SYSTEM_PROMPT).toContain(
      '该子任务用户填写的描述',
    );
    expect(ROADMAP_CREATE_JIRA_SYSTEM_PROMPT).toContain(
      '不必与用户输入逐字一致',
    );
    expect(ROADMAP_CREATE_JIRA_SYSTEM_PROMPT).toContain(
      '带用户描述的 draft 主任务以用户描述为基础润色',
    );
  });

  it('system prompt treats a missing fixVersion as omit-and-continue, not a hard gate', () => {
    expect(ROADMAP_CREATE_JIRA_SYSTEM_PROMPT).toContain('【fixVersion 规则');
    expect(ROADMAP_CREATE_JIRA_SYSTEM_PROMPT).toContain(FIX_VERSION_OMIT_IF_MISSING);
    expect(ROADMAP_CREATE_JIRA_SYSTEM_PROMPT).toContain('Roadmap 收不到这次提问');
    expect(ROADMAP_CREATE_JIRA_SYSTEM_PROMPT).toContain(
      '未创建任何 issue，以免写入错误版本',
    );
    expect(ROADMAP_CREATE_JIRA_SYSTEM_PROMPT).toContain('不是硬约束');
    expect(ROADMAP_CREATE_JIRA_SYSTEM_PROMPT).toContain('去掉 fixVersions 后重新提交创建');
  });
});

describe('fixVersion create constraint', () => {
  it('tells the Agent to omit a missing version instead of refusing the row', () => {
    expect(describeFixVersionConstraint({ override: '26.4.120', suggestedValues: [] })).toContain(
      '26.4.120',
    );
    expect(describeFixVersionConstraint({ override: '', suggestedValues: ['26.4.110'] })).toContain(
      '优先按此填写',
    );
    expect(describeFixVersionConstraint({ override: '', suggestedValues: ['26.4.110'] })).toContain(
      FIX_VERSION_OMIT_IF_MISSING,
    );
  });
});

describe('retry remaining drafts', () => {
  const fields = {
    teamId: 'T1',
    token: 'tok',
    projectKey: 'NOVA',
    issueType: 'Epic',
    subType: 'Task',
  };

  it('keeps already-created parent and children out of the retry payload', () => {
    const group = buildDraftGroups([
      item({
        key: 'LOCAL-ab12cd34',
        source: 'manual',
        jiraKey: null,
        title: 'Manual epic',
        subs: [
          sub({ id: 'd1', title: 'ok child' }),
          sub({ id: 'd2', title: 'failed child' }),
        ],
      }),
    ])[0];
    const rowStatus = {
      [createItemRowId('LOCAL-ab12cd34')]: { kind: 'ok' as const, jiraKey: 'NOVA-18674' },
      [createSubRowId('d1')]: { kind: 'ok' as const, jiraKey: 'NOVA-18675' },
      [createSubRowId('d2')]: {
        kind: 'error' as const,
        message: 'Required fixVersion Nova 26.4.120 does not exist',
      },
    };

    const sliced = sliceDraftGroupForRetry(group, rowStatus);
    expect(sliced?.item.jiraKey).toBe('NOVA-18674');
    expect(sliced?.subs.map((row) => row.id)).toEqual(['d2']);
    expect(draftGroupCanRetry(group, rowStatus)).toBe(true);
    expect(buildCreateJiraPayload(sliced!, fields).parent).toBeNull();
    expect(buildCreateJiraPayload(sliced!, fields).children).toHaveLength(1);
    expect(buildCreateJiraPayload(sliced!, fields).children[0].parentJiraKey).toBe(
      'NOVA-18674',
    );
  });

  it('returns null when every row already has a Jira key', () => {
    const group = buildDraftGroups([
      item({
        key: 'LOCAL-ab12cd34',
        source: 'manual',
        jiraKey: 'NOVA-1',
        subs: [sub({ id: 'd1' })],
      }),
    ])[0];
    const rowStatus = {
      [createSubRowId('d1')]: { kind: 'ok' as const, jiraKey: 'NOVA-2' },
    };
    expect(sliceDraftGroupForRetry(group, rowStatus)).toBeNull();
    expect(draftGroupCanRetry(group, rowStatus)).toBe(false);
  });
});

describe('draft description cap 2000', () => {
  it('keeps 2000-character descriptions intact and does not silently clip shorter text', () => {
    expect(DESCRIPTION_MAX_CHARS).toBe(2000);
    const exact = 'A'.repeat(2000);
    expect(clampDescription(exact)).toBe(exact);
    expect(clampDescription(`${exact}X`)).toBe(exact);
    expect(truncateEpicDesc(exact)).toBe(exact);
  });

  it('marks Agent Epic excerpts as truncated instead of dropping the tail silently', () => {
    const long = `${'风险约束 '.repeat(400)}UNIQUE_TAIL`;
    const truncated = truncateEpicDesc(long);
    expect(truncated.length).toBeGreaterThan(2000);
    expect(truncated).toContain('【父描述已截断至 2000 字，完整内容请读取 Jira】');
    expect(truncated).not.toContain('UNIQUE_TAIL');
    const parent = item({
      key: 'NOVA-1',
      jiraKey: 'NOVA-1',
      title: 'Parent',
      description: long,
    });
    const prompt = buildAgentCreatePrompt({
      userPrompt: 'create',
      projectKey: 'NOVA',
      itemType: 'Epic',
      subType: 'Task',
      fixVersion: '',
      sprint: '',
      map: {},
      currentUser: 'Tester',
      members: [],
      items: [parent],
      drafts: [{ item: parent, sub: sub({ id: 'd1', title: 'Child' }) }],
      epicDescriptions: { 'NOVA-1': long },
    });
    expect(prompt).toContain('【父描述已截断至 2000 字，完整内容请读取 Jira】');
    expect(prompt).not.toContain('UNIQUE_TAIL');
  });
});

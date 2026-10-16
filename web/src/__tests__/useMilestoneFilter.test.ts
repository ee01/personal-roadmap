import { effectScope, type EffectScope } from 'vue';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_JQL_HINTS } from '../composables/useRoadmapContract';
import { createRoadmapState } from '../composables/useRoadmapState';
import type { MilestoneValue, RoadmapItem, TeamSnapshot } from '../types';

const api = vi.hoisted(() => ({
  sendIntent: vi.fn(),
  fetchTeam: vi.fn(),
  upsertCustomLabelValues: vi.fn(),
}));

vi.mock('../composables/useRoadmapApi', () => ({
  useRoadmapApi: () => ({
    actorName: { value: 'Tester' },
    getShareToken: () => 'token',
    hasExtension: () => false,
    setActorName: () => undefined,
    markExtensionConnected: () => undefined,
    unsubscribeEvents: () => undefined,
    sendIntent: api.sendIntent,
    fetchTeam: api.fetchTeam,
    upsertCustomLabelValues: api.upsertCustomLabelValues,
  }),
}));

function ms(key: string, overrides: Partial<MilestoneValue> = {}): MilestoneValue {
  return {
    key,
    labelKey: 'LBL-288',
    labelName: 'AIR 2.0 Milestones',
    name: key,
    description: null,
    milestoneDate: null,
    dateSource: null,
    status: null,
    fetchedAt: 1,
    ...overrides,
  };
}

function item(overrides: Partial<RoadmapItem> = {}): RoadmapItem {
  return {
    key: 'A',
    type: 'Epic',
    title: 'Alpha',
    source: 'jira',
    jiraKey: 'NOVA-1',
    projectKey: 'NOVA',
    alias: null,
    quarter: '2026-Q3',
    estimate: 2,
    targetStart: null,
    targetEnd: null,
    scheduled: true,
    start: '2026-07-01',
    days: 14,
    lane: 1,
    expanded: false,
    version: 3,
    subs: [],
    markers: [],
    ms: [],
    ...overrides,
  };
}

function snap(
  items: RoadmapItem[],
  customLabels: MilestoneValue[] = [],
): TeamSnapshot {
  return {
    team: {
      id: 'team-ms',
      name: 'Team',
      jql: '',
      checkedQuarters: [],
      importedQuarters: [],
      version: 1,
      createdBy: 'me',
      jqlHints: EMPTY_JQL_HINTS,
      customLabels,
    },
    items,
    members: [],
    presence: [],
    locks: [],
  };
}

describe('milestone filter state', () => {
  let scope: EffectScope | null = null;

  beforeAll(() => {
    vi.stubGlobal('window', {
      postMessage() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return true;
      },
      location: { search: '', pathname: '/', href: 'http://localhost/' },
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
    vi.stubGlobal('history', { replaceState() {} });
    vi.stubGlobal('location', { search: '', pathname: '/', href: 'http://localhost/' });
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    api.sendIntent.mockReset();
    api.fetchTeam.mockReset();
  });

  afterEach(() => {
    scope?.stop();
    scope = null;
  });

  function mount(items: RoadmapItem[], customLabels: MilestoneValue[] = []) {
    scope = effectScope();
    const state = scope.run(() => createRoadmapState())!;
    state.commitSnapshot(snap(items, customLabels));
    return state;
  }

  const dict = [
    ms('LBL-291', { name: 'AIR 2.0 Beta', milestoneDate: '2026-07-10', dateSource: 'description' }),
    ms('LBL-292', { name: 'AIR 2.0 Controlled Availability', milestoneDate: '2026-08-01', dateSource: 'description' }),
    ms('LBL-301', { name: 'Partner Pilot' }),
  ];

  it('msMatch is a no-op until milestones are selected, then ORs across values', () => {
    const state = mount(
      [
        item({ key: 'A', ms: ['LBL-291'] }),
        item({ key: 'B', ms: ['LBL-292', 'LBL-301'] }),
        item({ key: 'C', ms: [] }),
      ],
      dict,
    );

    expect(state.msActive.value).toBe(false);
    expect(state.backlogItems.value.every(() => true)).toBe(true);
    for (const it of state.snapshot.value!.items) {
      expect(state.msMatch(it)).toBe(true);
    }

    state.setMsSel(['LBL-291']);
    expect(state.msActive.value).toBe(true);
    expect(state.snapshot.value!.items.filter((i) => state.msMatch(i)).map((i) => i.key)).toEqual(['A']);

    state.setMsSel(['LBL-291', 'LBL-301']);
    expect(state.snapshot.value!.items.filter((i) => state.msMatch(i)).map((i) => i.key)).toEqual(['A', 'B']);

    state.setMsSel([]);
    expect(state.msActive.value).toBe(false);
  });

  it('msLateOf returns the worst overdue selected milestone for scheduled bars', () => {
    const state = mount(
      [
        // 2026-07-01 + 14d → ends 2026-07-14, 4 days past LBL-291 (07-10)
        item({ key: 'A', ms: ['LBL-291'] }),
        // Done items never count as late
        item({ key: 'D', ms: ['LBL-291'], start: '2026-07-01', days: 14, status: 'Closed' }),
        // Backlog items never count
        item({ key: 'B', ms: ['LBL-291'], scheduled: false, start: null, days: null }),
        // Unknown-date milestone contributes nothing
        item({ key: 'C', ms: ['LBL-301'] }),
      ],
      dict,
    );
    state.setMsSel(['LBL-291', 'LBL-301']);

    const items = state.snapshot.value!.items;
    const late = state.msLateOf(items.find((i) => i.key === 'A')!);
    expect(late).toMatchObject({ ms: expect.objectContaining({ key: 'LBL-291' }), days: 4 });
    expect(state.msLateOf(items.find((i) => i.key === 'D')!)).toBeNull();
    expect(state.msLateOf(items.find((i) => i.key === 'B')!)).toBeNull();
    expect(state.msLateOf(items.find((i) => i.key === 'C')!)).toBeNull();

    // 结束日早于 milestone → 不算晚
    state.setMsSel(['LBL-292']);
    const early = state.msLateOf(items.find((i) => i.key === 'A')!);
    expect(early).toBeNull();
  });

  it('msStats counts hits, scheduled hits, and overdue items', () => {
    const state = mount(
      [
        item({ key: 'A', ms: ['LBL-291'] }),
        item({ key: 'B', ms: ['LBL-291'], scheduled: false, start: null, days: null }),
        item({ key: 'C', ms: [] }),
      ],
      dict,
    );
    state.setMsSel(['LBL-291']);
    expect(state.msStats.value).toEqual({ hits: 2, scheduled: 1, late: 1 });
  });

  it('hasMsData hides the filter row until labels or mirrored items exist', () => {
    const empty = mount([item({ key: 'A' })], []);
    expect(empty.hasMsData.value).toBe(false);

    const withItems = mount([item({ key: 'A', ms: ['LBL-291'] })], []);
    expect(withItems.hasMsData.value).toBe(true);

    const withDict = mount([item({ key: 'A' })], dict);
    expect(withDict.hasMsData.value).toBe(true);
  });
});

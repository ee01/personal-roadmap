import { effectScope, type EffectScope } from 'vue';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_JQL_HINTS } from '../composables/useRoadmapContract';
import { createRoadmapState, QUARTER_NONE } from '../composables/useRoadmapState';
import { CURQ, nextQ, prevQ } from '../composables/useGeometry';
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

function item(overrides: Partial<RoadmapItem> = {}): RoadmapItem {
  return {
    key: 'A',
    type: 'Epic',
    title: 'Alpha',
    source: 'jira',
    jiraKey: 'NOVA-1',
    projectKey: 'NOVA',
    alias: null,
    quarter: CURQ,
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

function snap(items: RoadmapItem[]): TeamSnapshot {
  return {
    team: {
      id: 'team-q',
      name: 'Team',
      jql: '',
      checkedQuarters: [],
      importedQuarters: items.some((i) => i.quarter) ? [CURQ] : [],
      version: 1,
      createdBy: 'me',
      jqlHints: EMPTY_JQL_HINTS,
    },
    items,
    members: [],
    presence: [],
    locks: [],
  };
}

describe('quarter filter state', () => {
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

  function mount(items: RoadmapItem[]) {
    scope = effectScope();
    const state = scope.run(() => createRoadmapState())!;
    state.commitSnapshot(snap(items));
    return state;
  }

  it('qMatch is a no-op until quarters are selected, then ORs across values', () => {
    const state = mount([
      item({ key: 'A', quarter: CURQ }),
      item({ key: 'B', quarter: nextQ(CURQ) }),
      item({ key: 'C', quarter: null, scheduled: false, start: null, days: null }),
    ]);

    expect(state.qActive.value).toBe(false);
    for (const it of state.snapshot.value!.items) {
      expect(state.qMatch(it)).toBe(true);
    }

    state.setQSel([CURQ]);
    expect(state.qActive.value).toBe(true);
    expect(
      state.snapshot.value!.items.filter((i) => state.qMatch(i)).map((i) => i.key),
    ).toEqual(['A']);

    state.setQSel([CURQ, QUARTER_NONE]);
    expect(
      state.snapshot.value!.items.filter((i) => state.qMatch(i)).map((i) => i.key),
    ).toEqual(['A', 'C']);

    state.setQSel([]);
    expect(state.qActive.value).toBe(false);
  });

  it('viewMatch ANDs quarter with milestone and text filters', () => {
    const dict: MilestoneValue[] = [
      {
        key: 'LBL-291',
        labelKey: 'LBL-288',
        labelName: 'AIR 2.0 Milestones',
        name: 'AIR 2.0 Beta',
        description: null,
        milestoneDate: '2026-07-10',
        dateSource: 'description',
        status: null,
        fetchedAt: 1,
      },
    ];
    const state = mount([
      item({ key: 'A', quarter: CURQ, ms: ['LBL-291'] }),
      item({ key: 'B', quarter: CURQ, title: 'Billing' }),
      item({ key: 'C', quarter: nextQ(CURQ), ms: ['LBL-291'], title: 'Catalog' }),
    ]);
    const keys = () =>
      state.snapshot.value!.items.filter((i) => state.viewMatch(i)).map((i) => i.key);

    expect(state.filterActive.value).toBe(false);
    expect(keys()).toEqual(['A', 'B', 'C']);

    state.setQSel([CURQ]);
    state.setMsSel(['LBL-291']);
    expect(keys()).toEqual(['A']);

    state.setMsSel([]);
    state.setSearchQuery('alpha');
    expect(keys()).toEqual(['A']);

    state.setSearchQuery('');
    state.setQSel([]);
    expect(state.filterActive.value).toBe(false);
  });

  it('qOverOf flags end dates past the quarter end, for bars and Target End alike', () => {
    // CURQ ends at the quarter boundary; build dates relative to it.
    const qEnd = new Date(
      Number(CURQ.slice(0, 4)),
      Number(CURQ.slice(6)) * 3,
      0,
    );
    const iso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
        d.getDate(),
      ).padStart(2, '0')}`;

    const state = mount([
      // bar ends 9 days past the quarter end
      item({
        key: 'A',
        quarter: CURQ,
        start: iso(new Date(qEnd.getFullYear(), qEnd.getMonth(), qEnd.getDate() - 4)),
        days: 14,
      }),
      // backlog item whose Jira Target End is 3 days past the quarter end
      item({
        key: 'B',
        quarter: CURQ,
        scheduled: false,
        start: null,
        days: null,
        targetEnd: iso(new Date(qEnd.getFullYear(), qEnd.getMonth(), qEnd.getDate() + 3)),
      }),
      // done items never count
      item({ key: 'D', quarter: CURQ, status: 'Closed' }),
      // no quarter / no dates → null
      item({ key: 'E', quarter: null, scheduled: false, start: null, days: null }),
      item({
        key: 'F',
        quarter: CURQ,
        scheduled: false,
        start: null,
        days: null,
        targetEnd: null,
      }),
    ]);

    // 过滤未开启 → 全部 null；force 供 chip 红点使用
    const items = state.snapshot.value!.items;
    for (const it of items) expect(state.qOverOf(it)).toBeNull();
    expect(state.qOverOf(items.find((i) => i.key === 'A')!, true)).toMatchObject({
      q: CURQ,
      days: 9,
    });

    state.setQSel([CURQ]);
    expect(state.qOverOf(items.find((i) => i.key === 'A')!)).toMatchObject({ q: CURQ, days: 9 });
    expect(state.qOverOf(items.find((i) => i.key === 'B')!)).toMatchObject({
      q: CURQ,
      days: 3,
    });
    expect(state.qOverOf(items.find((i) => i.key === 'D')!)).toBeNull();
    expect(state.qOverOf(items.find((i) => i.key === 'E')!)).toBeNull();
    expect(state.qOverOf(items.find((i) => i.key === 'F')!)).toBeNull();

    // 选中的 Quarter 不含该条目的 Quarter → null
    state.setQSel([nextQ(CURQ)]);
    expect(state.qOverOf(items.find((i) => i.key === 'A')!)).toBeNull();

    // stats: A / B / D / F 命中 Quarter 过滤，其中 A + B 超界
    state.setQSel([CURQ]);
    expect(state.msStats.value).toMatchObject({ hits: 4, qOver: 2 });
  });

  it('qCandidates falls back to a prev-2/next-1 window and merges item-only values', () => {
    const state = mount([
      item({ key: 'A', quarter: CURQ }),
      item({ key: 'B', quarter: prevQ(prevQ(CURQ)) }), // 已在回落窗口内
      item({ key: 'C', quarter: '2030-Q1' }), // 条目上出现的新值
      item({ key: 'D', quarter: null, scheduled: false, start: null, days: null }),
    ]);

    const { list, extra, source } = state.qCandidates.value;
    expect(source).toBe('fallback');
    expect(extra).toEqual(['2030-Q1']);
    for (const q of [prevQ(prevQ(CURQ)), prevQ(CURQ), CURQ, nextQ(CURQ), '2030-Q1']) {
      expect(list).toContain(q);
    }
    // 未设置 Quarter 的分组垫底
    expect(list[list.length - 1]).toBe(QUARTER_NONE);
    // 排序有序
    const real = list.filter((q) => q !== QUARTER_NONE);
    expect([...real].sort()).toEqual(real);

    // 快速平铺：当前 + 下一个，外加已选中的其他 Quarter
    state.setQSel(['2030-Q1', CURQ]);
    expect(state.quickQuarters.value).toEqual([CURQ, nextQ(CURQ), '2030-Q1']);
  });

  it('qCount / qOverCount expose per-quarter counts for chips and popover', () => {
    const qEnd = new Date(
      Number(CURQ.slice(0, 4)),
      Number(CURQ.slice(6)) * 3,
      0,
    );
    const iso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
        d.getDate(),
      ).padStart(2, '0')}`;

    const state = mount([
      item({ key: 'A', quarter: CURQ }),
      item({
        key: 'B',
        quarter: CURQ,
        start: iso(new Date(qEnd.getFullYear(), qEnd.getMonth(), qEnd.getDate() - 4)),
        days: 14,
      }),
      item({ key: 'C', quarter: nextQ(CURQ) }),
      item({ key: 'D', quarter: null, scheduled: false, start: null, days: null }),
    ]);

    expect(state.qCount(CURQ)).toBe(2);
    expect(state.qCount(nextQ(CURQ))).toBe(1);
    expect(state.qCount(QUARTER_NONE)).toBe(1);
    // 超界计数不受过滤开关影响（force）
    expect(state.qOverCount(CURQ)).toBe(1);
    expect(state.qOverCount(nextQ(CURQ))).toBe(0);
    expect(state.qOverCount(QUARTER_NONE)).toBe(0);
  });

  it('hasQData hides the quarter segment until any item carries a quarter', () => {
    expect(mount([item({ key: 'A', quarter: null })]).hasQData.value).toBe(false);
    expect(mount([item({ key: 'A', quarter: CURQ })]).hasQData.value).toBe(true);
  });
});

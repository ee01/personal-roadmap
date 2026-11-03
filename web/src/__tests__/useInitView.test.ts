import { effectScope, type EffectScope } from 'vue';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_JQL_HINTS } from '../composables/useRoadmapContract';
import { createRoadmapState, INIT_NONE, initKeyOf } from '../composables/useRoadmapState';
import { depCommittedText } from '../composables/dependency';
import type { InitDetail, RoadmapItem, TeamSnapshot } from '../types';

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
    quarter: '2026-Q4',
    estimate: 2,
    targetStart: null,
    targetEnd: null,
    scheduled: true,
    start: '2026-11-02',
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

function inits(): InitDetail[] {
  return [
    { key: 'INIT-6120', title: 'AI Copilot 2.0', quarter: '2026-Q4', committed: 'Yes', fetchedAt: 1 },
    { key: 'INIT-6134', title: 'Unified Conversation Platform', quarter: '2026-Q4', committed: 'No', fetchedAt: 1 },
  ];
}

function snap(items: RoadmapItem[], initDetails: InitDetail[] = []): TeamSnapshot {
  return {
    team: {
      id: 'team-init',
      name: 'Team',
      jql: '',
      checkedQuarters: [],
      importedQuarters: [],
      version: 1,
      createdBy: 'me',
      jqlHints: EMPTY_JQL_HINTS,
    },
    inits: initDetails,
    items,
    members: [],
    presence: [],
    locks: [],
  };
}

describe('INIT view state (E-171)', () => {
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

  function mount(items: RoadmapItem[], initDetails: InitDetail[] = []) {
    scope = effectScope();
    const state = scope.run(() => createRoadmapState())!;
    state.commitSnapshot(snap(items, initDetails));
    return state;
  }

  it('groups items by parentLink, epics without a parent fall into INIT_NONE', () => {
    const state = mount([
      item({ key: 'A', parentLink: 'INIT-6120' }),
      item({ key: 'B', parentLink: 'INIT-6120', scheduled: false, start: null, days: null }),
      item({ key: 'C' }),
    ]);
    expect(initKeyOf(state.snapshot.value!.items[0])).toBe('INIT-6120');
    expect(initKeyOf(state.snapshot.value!.items[2])).toBe(INIT_NONE);
    const groups = state.initGroups(state.snapshot.value!.items);
    expect([...groups.keys()].sort()).toEqual(['INIT-6120', INIT_NONE]);
    // 保持传入顺序（排序由 initKeyCmp 负责）
    expect(groups.get('INIT-6120')!.map((i) => i.key)).toEqual(['A', 'B']);
  });

  it('initStats splits hit epics into scheduled / backlog without changing grouping', () => {
    const state = mount([
      item({ key: 'A', parentLink: 'INIT-6120' }),
      item({ key: 'B', parentLink: 'INIT-6120', scheduled: false, start: null, days: null }),
      item({ key: 'C', parentLink: 'INIT-6120', quarter: '2027-Q1' }),
    ]);
    const stats = state.initStats('INIT-6120');
    expect(stats.all).toHaveLength(3);
    expect(stats.hit).toHaveLength(3);
    expect(stats.sched.map((i) => i.key)).toEqual(['A', 'C']);
    expect(stats.back.map((i) => i.key)).toEqual(['B']);
  });

  it('quarter filter applies at Epic level, then aggregates into INIT stats', () => {
    const state = mount([
      item({ key: 'A', parentLink: 'INIT-6120', quarter: '2026-Q4' }),
      item({ key: 'B', parentLink: 'INIT-6120', quarter: '2027-Q1' }),
      item({ key: 'C', parentLink: 'INIT-6134', quarter: '2026-Q4' }),
    ]);
    state.setQSel(['2026-Q4']);
    const stats = state.initStats('INIT-6120');
    expect(stats.all).toHaveLength(2);
    expect(stats.hit.map((i) => i.key)).toEqual(['A']);
    expect(state.zeroHitInits()).toEqual([]);
    const groups = state.initGroups(state.snapshot.value!.items.filter((i) => state.viewMatch(i)));
    expect([...groups.keys()]).toEqual(['INIT-6120', 'INIT-6134']);
  });

  it('zero-hit INITs are listed so the UI can explain them at the bottom', () => {
    const state = mount([
      item({ key: 'A', parentLink: 'INIT-6120', quarter: '2026-Q4' }),
      item({ key: 'C', parentLink: 'INIT-6134', quarter: '2027-Q1' }),
    ]);
    state.setQSel(['2026-Q4']);
    expect(state.zeroHitInits()).toEqual(['INIT-6134']);
  });

  it('search matches the loaded INIT title against its child epics', () => {
    const state = mount(
      [item({ key: 'A', parentLink: 'INIT-6120', title: 'Unrelated words' })],
      inits(),
    );
    state.setSearchQuery('copilot');
    expect(state.viewMatch(state.snapshot.value!.items[0])).toBe(true);
    state.setSearchQuery('不存在的标题');
    expect(state.viewMatch(state.snapshot.value!.items[0])).toBe(false);
  });

  it('initInfo reports loaded titles and never fabricates unknown ones', () => {
    const state = mount([item({ key: 'A', parentLink: 'INIT-6120' })], inits());
    expect(state.initInfo('INIT-6120')).toMatchObject({
      loaded: true,
      title: 'AI Copilot 2.0',
      committed: 'Yes',
    });
    expect(state.initInfo('INIT-9999')).toMatchObject({ loaded: false, title: null });
    expect(state.initInfo(INIT_NONE).none).toBe(true);
    expect(state.initName('INIT-9999')).toBe('INIT-9999（详情未加载）');
  });

  it('unpulledSelectedQuarters separates "not pulled yet" from "no match"', () => {
    const state = mount([item({ key: 'A', quarter: '2026-Q4' })]);
    state.setQSel(['2026-Q4', '2027-Q2']);
    expect(state.unpulledSelectedQuarters()).toEqual(['2027-Q2']);
  });
});

describe('Committed = No helpers (E-171)', () => {
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

  afterEach(() => {
    scope?.stop();
    scope = null;
  });

  function mount(items: RoadmapItem[], initDetails: InitDetail[] = []) {
    scope = effectScope();
    const state = scope.run(() => createRoadmapState())!;
    state.commitSnapshot(snap(items, initDetails));
    return state;
  }

  it('itemUc only flags own Committed = No epics, and only while a filter is active', () => {
    const state = mount([
      item({ key: 'A', committed: 'No' }),
      item({ key: 'B', committed: 'Yes' }),
      item({ key: 'C' }),
      item({ key: 'D', committed: 'No', status: 'Done' }),
    ]);
    expect(state.itemUc(state.snapshot.value!.items[0])).toBe(false); // 无过滤 → 不显示
    state.setQSel(['2026-Q4']);
    expect(state.itemUc(state.snapshot.value!.items[0])).toBe(true);
    expect(state.itemUc(state.snapshot.value!.items[1])).toBe(false);
    expect(state.itemUc(state.snapshot.value!.items[2])).toBe(false);
    expect(state.itemUc(state.snapshot.value!.items[3])).toBe(false); // 已完成不提示
  });

  it('initUc reads the INIT own field, not derived from children', () => {
    const state = mount(
      [item({ key: 'A', parentLink: 'INIT-6134', committed: 'Yes' })],
      inits(),
    );
    expect(state.initUc('INIT-6134')).toBe(false); // 过滤未开启
    state.setQSel(['2026-Q4']);
    expect(state.initUc('INIT-6134')).toBe(true); // INIT 自身 No，即便子 Epic 是 Yes
    expect(state.initUc('INIT-6120')).toBe(false); // 自身 Yes
    expect(state.initUc('INIT-9999')).toBe(false); // 详情未加载 ≠ No
    expect(state.initUc(INIT_NONE)).toBe(false);
  });

  it('msStats counts only epics whose own field is No', () => {
    const state = mount([
      item({ key: 'A', committed: 'No' }),
      item({ key: 'B', committed: 'Yes' }),
    ]);
    state.setQSel(['2026-Q4']);
    expect(state.msStats.value.uc).toBe(1);
  });

  it('depCommittedText attributes the status to the specific ticket', () => {
    expect(depCommittedText({ jiraKey: 'SEC-1203', committed: 'No' })).toBe(
      'SEC-1203 自身 Committed: No（对方未承诺交付）',
    );
    expect(depCommittedText({ jiraKey: 'SEC-1203', committed: 'Yes' })).toBe(
      'SEC-1203 自身 Committed: Yes',
    );
    expect(depCommittedText({ jiraKey: 'SEC-1203', committed: null })).toBe(
      'SEC-1203 自身 Committed: 未知',
    );
    expect(depCommittedText({ jiraKey: null, committed: null })).toBe(
      '无 ticket，没有 Committed 字段',
    );
  });
});

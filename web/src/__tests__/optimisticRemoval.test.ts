import { effectScope, type EffectScope } from 'vue';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_JQL_HINTS } from '../composables/useRoadmapContract';
import {
  applyOptimisticRemovals,
  createRoadmapState,
} from '../composables/useRoadmapState';
import type { RoadmapItem, TeamSnapshot } from '../types';

const api = vi.hoisted(() => ({
  sendIntent: vi.fn(),
  fetchTeam: vi.fn(),
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
  }),
}));

function item(overrides: Partial<RoadmapItem> = {}): RoadmapItem {
  return {
    key: 'A',
    type: 'Epic',
    title: 'Alpha',
    source: 'manual',
    jiraKey: null,
    projectKey: null,
    alias: null,
    quarter: '2026-Q3',
    estimate: 2,
    targetStart: null,
    targetEnd: null,
    scheduled: true,
    start: '2026-07-01',
    days: 14,
    lane: 1,
    expanded: true,
    version: 3,
    subs: [],
    markers: [],
    ...overrides,
  };
}

function snap(items: RoadmapItem[], version = 1): TeamSnapshot {
  return {
    team: {
      id: 'team-1',
      name: 'Team',
      jql: '',
      checkedQuarters: [],
      importedQuarters: [],
      version,
      createdBy: 'me',
      jqlHints: EMPTY_JQL_HINTS,
    },
    items,
    members: [],
    presence: [],
    locks: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function httpError(status: number, error: string) {
  return Object.assign(new Error(error), { status, body: { error } });
}

describe('applyOptimisticRemovals', () => {
  it('moves a scheduled row to backlog without mutating the source item', () => {
    const scheduled = item({ subs: [{ id: 's1' } as RoadmapItem['subs'][number]] });
    const source = snap([scheduled, item({ key: 'B', scheduled: false, start: null, days: null })]);
    const next = applyOptimisticRemovals(source, [{ kind: 'unschedule', itemKey: 'A' }]);

    expect(scheduled.scheduled).toBe(true);
    expect(scheduled.start).toBe('2026-07-01');
    expect(next.items[0]).toMatchObject({
      key: 'A',
      scheduled: false,
      start: null,
      days: null,
      expanded: false,
      lane: 1,
      version: 3,
    });
    expect(next.items[0]?.subs).toBe(scheduled.subs);
    expect(next.items.map((row) => row.key)).toEqual(['A', 'B']);
  });

  it('drops only the deleted key and ignores an already-applied unschedule', () => {
    const source = snap([
      item({ key: 'A', scheduled: false, start: null, days: null }),
      item({ key: 'B' }),
    ]);
    const next = applyOptimisticRemovals(source, [
      { kind: 'unschedule', itemKey: 'A' },
      { kind: 'delete', itemKey: 'B' },
    ]);
    expect(next.items.map((row) => row.key)).toEqual(['A']);
    expect(source.items.map((row) => row.key)).toEqual(['A', 'B']);
  });
});

describe('optimistic removal against the server', () => {
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

  beforeEach(() => {
    api.sendIntent.mockReset();
    api.fetchTeam.mockReset();
    vi.spyOn(console, 'warn').mockImplementation((message?: unknown) => {
      const text = String(message ?? '');
      if (text.includes('no active component instance')) return;
      throw new Error(text);
    });
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

  it('hides a backlog delete immediately, keeps it hidden across SSE, and restores it with a toast if the intent fails', async () => {
    const state = mount([
      item({ key: 'A', scheduled: false, start: null, days: null, title: 'Keep me' }),
      item({ key: 'B', scheduled: false, start: null, days: null, title: 'Sibling' }),
    ]);
    const gate = deferred<TeamSnapshot>();
    api.sendIntent.mockReturnValue(gate.promise);

    const pending = state.applyOptimisticRemoval(
      { kind: 'delete', itemKey: 'A' },
      { op: 'delete_item', itemKey: 'A' },
    );
    expect(state.backlogItems.value.map((row) => row.key)).toEqual(['B']);

    state.commitSnapshot(
      snap([
        item({ key: 'A', scheduled: false, start: null, days: null, title: 'Keep me' }),
        item({ key: 'B', scheduled: false, start: null, days: null, title: 'Sibling from SSE' }),
      ]),
    );
    expect(state.backlogItems.value.map((row) => row.key)).toEqual(['B']);
    expect(state.backlogItems.value[0]?.title).toBe('Sibling from SSE');

    gate.reject(httpError(400, 'item_has_jira'));
    await expect(pending).rejects.toThrow('item_has_jira');
    expect(state.backlogItems.value.map((row) => row.title)).toEqual([
      'Keep me',
      'Sibling from SSE',
    ]);
    expect(state.toasts.value.some((toast) => toast.html.includes('不能从 Roadmap 删除'))).toBe(
      true,
    );
    expect(api.sendIntent).toHaveBeenCalledWith('team-1', {
      op: 'delete_item',
      itemKey: 'A',
    });
  });

  it('moves a gantt bar to backlog before the intent resolves, then keeps the server row', async () => {
    const scheduled = item();
    const state = mount([scheduled, item({ key: 'B', title: 'Other', lane: 0 })]);
    const gate = deferred<TeamSnapshot>();
    api.sendIntent.mockReturnValue(gate.promise);

    const pending = state.applyOptimisticRemoval(
      { kind: 'unschedule', itemKey: 'A' },
      { op: 'unschedule', itemKey: 'A', baseVersion: 3 },
    );
    expect(scheduled.scheduled).toBe(true);
    expect(state.scheduledItems.value.map((row) => row.key)).toEqual(['B']);
    expect(state.backlogItems.value.map((row) => row.key)).toEqual(['A']);
    expect(state.backlogItems.value[0]).toMatchObject({ start: null, days: null });

    gate.resolve(
      snap(
        [
          item({
            scheduled: false,
            start: null,
            days: null,
            expanded: false,
            version: 4,
          }),
          item({ key: 'B', title: 'Other', lane: 0 }),
        ],
        2,
      ),
    );
    await pending;
    expect(state.scheduledItems.value.map((row) => row.key)).toEqual(['B']);
    expect(state.backlogItems.value[0]).toMatchObject({ key: 'A', version: 4, start: null });
  });

  it('keeps the row hidden while a 409 refresh is in flight, then shows the refreshed server row', async () => {
    const state = mount([item({ scheduled: false, start: null, days: null })]);
    const fetchGate = deferred<TeamSnapshot>();
    api.sendIntent.mockRejectedValue(httpError(409, 'version_conflict'));
    api.fetchTeam.mockReturnValue(fetchGate.promise);

    const pending = state.applyOptimisticRemoval(
      { kind: 'delete', itemKey: 'A' },
      { op: 'delete_item', itemKey: 'A' },
    );
    await Promise.resolve();
    expect(state.backlogItems.value).toEqual([]);
    expect(api.fetchTeam).toHaveBeenCalledWith('team-1');

    fetchGate.resolve(
      snap([
        item({
          scheduled: false,
          start: null,
          days: null,
          title: 'Refreshed',
          version: 9,
        }),
      ]),
    );
    await expect(pending).rejects.toThrow('version_conflict');
    expect(state.backlogItems.value.map((row) => row.title)).toEqual(['Refreshed']);
    expect(state.toasts.value.some((toast) => toast.html.includes('版本冲突'))).toBe(true);
  });
});

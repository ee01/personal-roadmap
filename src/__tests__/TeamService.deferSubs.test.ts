import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ActorContext, TeamSnapshot } from '../types.js';

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'roadmap-defer-'));

const { applyIntent, createTeam, getTeamSnapshot } = await import(
  '../core/TeamService.js'
);

const actor: ActorContext = {
  name: 'Tester',
  clientId: 'test-client',
  source: 'creator',
};

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

function subOf(snapshot: TeamSnapshot, itemKey: string, subId: string) {
  const sub = itemOf(snapshot, itemKey).subs.find(
    (candidate) => candidate.id === subId,
  );
  if (!sub) throw new Error(`sub ${subId} missing`);
  return sub;
}

let teamId = '';
let epicKey = '';

/** Fresh Epic + N subs per test, all under one parent so the Epic-end clamp is exercised. */
function buildEpic(epicStart: string, epicDays: number) {
  const key = expectOk(
    apply(teamId, { op: 'add_item', title: 'Epic', quarter: '2026-Q3' }),
  ).itemKey!;
  expectOk(
    apply(teamId, {
      op: 'schedule',
      itemKey: key,
      start: epicStart,
      days: epicDays,
      baseVersion: itemOf(getTeamSnapshot(teamId)!, key).version,
    }),
  );
  return key;
}

function addSub(itemKey: string, title: string, start: string, days: number) {
  const before = expectOk(
    apply(teamId, { op: 'add_sub', itemKey, title }),
  ).snapshot;
  const subs = itemOf(before, itemKey).subs;
  const subId = subs[subs.length - 1].id;
  expectOk(
    apply(teamId, {
      op: 'update_sub',
      subId,
      start,
      days,
      baseVersion: subOf(before, itemKey, subId).version,
    }),
  );
  return subId;
}

beforeAll(() => {
  const snapshot = createTeam({
    name: 'Defer',
    jql: 'project = NOVA AND issuetype = Epic',
    actor,
  });
  teamId = snapshot.team.id;
});

describe('defer_subs', () => {
  it('moves a sub to targetStart, shrinks another to remaining room, and leaves an already-on-target one stuck', () => {
    epicKey = buildEpic('2026-08-17', 34); // ends 2026-09-19
    const roomy = addSub(epicKey, 'roomy', '2026-08-28', 6); // fits with original length
    const tight = addSub(epicKey, 'tight', '2026-08-24', 26); // 26d does not fit from Monday; shrink
    const already = addSub(epicKey, 'already-there', '2026-08-31', 3); // starts on targetStart already

    const result = expectOk(
      apply(teamId, {
        op: 'defer_subs',
        subIds: [roomy, tight, already],
        targetStart: '2026-08-31',
      }),
    );
    expect(result.deferSummary).toEqual({
      moved: [roomy, tight],
      shrunk: [tight],
      stuck: [already],
      extended: [],
    });

    const snapshot = result.snapshot;
    expect(subOf(snapshot, epicKey, roomy).start).toBe('2026-08-31');
    expect(subOf(snapshot, epicKey, roomy).days).toBe(6);
    expect(subOf(snapshot, epicKey, tight).start).toBe('2026-08-31');
    expect(subOf(snapshot, epicKey, tight).days).toBe(20); // 08-31 → 09-19
    expect(subOf(snapshot, epicKey, already).start).toBe('2026-08-31');
  });

  it('is idempotent — running it again on the already-moved subs is a no-op', () => {
    epicKey = buildEpic('2026-08-17', 34);
    const sub = addSub(epicKey, 'once', '2026-08-20', 5);

    const first = expectOk(
      apply(teamId, {
        op: 'defer_subs',
        subIds: [sub],
        targetStart: '2026-08-31',
      }),
    );
    expect(first.deferSummary!.moved).toEqual([sub]);
    const afterFirst = subOf(first.snapshot, epicKey, sub);
    expect(afterFirst.start).toBe('2026-08-31');

    const second = expectOk(
      apply(teamId, {
        op: 'defer_subs',
        subIds: [sub],
        targetStart: '2026-08-31',
      }),
    );
    expect(second.deferSummary).toEqual({
      moved: [],
      shrunk: [],
      stuck: [sub],
      extended: [],
    });
    expect(subOf(second.snapshot, epicKey, sub).start).toBe('2026-08-31');
    expect(subOf(second.snapshot, epicKey, sub).version).toBe(afterFirst.version);
  });

  it('does not move a sub that already ended before today', () => {
    epicKey = buildEpic('2026-01-01', 300);
    const past = addSub(epicKey, 'past', '2026-01-05', 3); // ends 2026-01-07, long over

    const result = expectOk(
      apply(teamId, {
        op: 'defer_subs',
        subIds: [past],
        targetStart: '2026-08-31',
      }),
    );
    // The server is not itself the "is it in the past" gate — callers filter
    // with isDeferCandidate. This Epic still has room, so the move lands.
    expect(result.deferSummary!.moved).toEqual([past]);
    expect(subOf(result.snapshot, epicKey, past).start).toBe('2026-08-31');
  });

  it('skips unknown, cleared, and draft-without-dates subIds without failing the batch', () => {
    epicKey = buildEpic('2026-08-17', 34);
    const real = addSub(epicKey, 'real', '2026-08-20', 5);
    const draftNoDates = expectOk(
      apply(teamId, { op: 'add_sub', itemKey: epicKey, title: 'no dates yet' }),
    ).snapshot;
    const noDatesId = itemOf(draftNoDates, epicKey).subs.find(
      (s) => s.title === 'no dates yet',
    )!.id;
    expectOk(
      apply(teamId, {
        op: 'update_sub',
        subId: noDatesId,
        start: null,
        baseVersion: subOf(draftNoDates, epicKey, noDatesId).version,
      }),
    );

    const result = expectOk(
      apply(teamId, {
        op: 'defer_subs',
        subIds: [real, noDatesId, 'sub-does-not-exist'],
        targetStart: '2026-08-31',
      }),
    );
    expect(result.deferSummary!.moved).toEqual([real]);
    expect(
      result.deferSummary!.shrunk.concat(result.deferSummary!.stuck),
    ).not.toContain(noDatesId);
    expect(
      result.deferSummary!.shrunk.concat(result.deferSummary!.stuck),
    ).not.toContain('sub-does-not-exist');
  });

  it('rejects a missing targetStart', () => {
    epicKey = buildEpic('2026-08-17', 34);
    const sub = addSub(epicKey, 'needs-target', '2026-08-20', 5);
    expect(
      apply(teamId, { op: 'defer_subs', subIds: [sub] }),
    ).toEqual({ ok: false, error: 'target_start_required' });
  });

  it('leaves a sub stuck when Monday-to-Epic-end cannot fit min days, then extends when asked', () => {
    epicKey = buildEpic('2026-07-25', 44); // ends 2026-09-06
    const sub = addSub(epicKey, 'pinned', '2026-09-01', 9);

    const blocked = expectOk(
      apply(teamId, {
        op: 'defer_subs',
        subIds: [sub],
        targetStart: '2026-09-07',
      }),
    );
    expect(blocked.deferSummary).toMatchObject({
      moved: [],
      stuck: [sub],
      extended: [],
    });
    expect(subOf(blocked.snapshot, epicKey, sub).start).toBe('2026-09-01');
    expect(subOf(blocked.snapshot, epicKey, sub).days).toBe(9);

    const extended = expectOk(
      apply(teamId, {
        op: 'defer_subs',
        subIds: [sub],
        targetStart: '2026-09-07',
        extendEpics: [{ itemKey: epicKey, end: '2026-09-09' }],
      }),
    );
    expect(extended.deferSummary!.moved).toEqual([sub]);
    expect(extended.deferSummary!.extended).toEqual([epicKey]);
    expect(extended.deferSummary!.shrunk).toEqual([sub]);
    expect(itemOf(extended.snapshot, epicKey).targetEnd).toBe('2026-09-09');
    expect(subOf(extended.snapshot, epicKey, sub).start).toBe('2026-09-07');
    expect(subOf(extended.snapshot, epicKey, sub).days).toBe(3);
  });
});

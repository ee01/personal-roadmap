import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ActorContext } from '../types.js';

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'roadmap-relsheet-'));

const { applyIntent, createTeam, getTeamSnapshot, listActivity } = await import(
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

const sampleSheet = {
  url: 'https://docs.google.com/spreadsheets/d/1sWRtByTquVLKeyv_kQG7nkSjP6-JBbSbNIVv4I3UzTM/edit',
  spreadsheetId: '1sWRtByTquVLKeyv_kQG7nkSjP6-JBbSbNIVv4I3UzTM',
  sheetName: '2026 phases',
  range: 'A1:C500',
  splitPhase: 'ff',
  showPhases: ['ff', 'stage', 'pro'],
  releaseFilter: { mode: 'major', pattern: '' },
  rows: [
    { Release: '26.3.130', Phase: 'FF', Date: '2026-07-26T16:00:00.000Z' },
    { Release: '26.3.130', Phase: 'Pro', Date: '2026-08-04T16:00:00.000Z' },
  ],
  fetchedAt: '2026-08-07T00:00:00.000Z',
};

let teamId = '';

beforeAll(() => {
  const snapshot = createTeam({
    name: 'Release Sheet Team',
    jql: 'project = NOVA AND issuetype = Epic',
    actor,
  });
  teamId = snapshot.team.id;
});

describe('release sheet team config', () => {
  it('defaults releaseSheet to null on create', () => {
    expect(getTeamSnapshot(teamId)!.team.releaseSheet).toBeNull();
  });

  it('stores releaseSheet alongside update_jql', () => {
    const result = expectOk(
      apply(teamId, {
        op: 'update_jql',
        jql: 'project = NOVA',
        releaseSheet: sampleSheet,
      }),
    );
    expect(result.snapshot.team.jql).toBe('project = NOVA');
    expect(result.snapshot.team.releaseSheet).toMatchObject({
      spreadsheetId: sampleSheet.spreadsheetId,
      sheetName: '2026 phases',
      splitPhase: 'ff',
      showPhases: ['ff', 'stage', 'pro'],
      releaseFilter: { mode: 'major', pattern: '' },
    });
    expect(result.snapshot.team.releaseSheet?.rows).toHaveLength(2);
  });

  it('clears releaseSheet via update_release_sheet', () => {
    expectOk(
      apply(teamId, {
        op: 'update_release_sheet',
        releaseSheet: null,
      }),
    );
    expect(getTeamSnapshot(teamId)!.team.releaseSheet).toBeNull();
    const activity = listActivity(teamId, 5);
    expect(activity.some((a) => a.op === 'update_release_sheet')).toBe(true);
  });

  it('rejects blank releaseSheet payloads as clear', () => {
    expectOk(
      apply(teamId, {
        op: 'update_release_sheet',
        releaseSheet: { url: '', spreadsheetId: '' },
      }),
    );
    expect(getTeamSnapshot(teamId)!.team.releaseSheet).toBeNull();
  });

  it('records silent refresh as a system activity only when sheet content changes', () => {
    expectOk(
      apply(teamId, {
        op: 'update_release_sheet',
        releaseSheet: sampleSheet,
      }),
    );
    expectOk(
      apply(teamId, {
        op: 'update_release_sheet',
        releaseSheet: { ...sampleSheet, fetchedAt: '2026-08-17T00:00:00.000Z' },
        silent: true,
      }),
    );
    expect(listActivity(teamId, 8).some((a) => a.summary?.silent)).toBe(false);

    expectOk(
      apply(teamId, {
        op: 'update_release_sheet',
        releaseSheet: {
          ...sampleSheet,
          fetchedAt: '2026-08-17T01:00:00.000Z',
          rows: [
            ...sampleSheet.rows,
            { Release: '26.4.0', Phase: 'FF', Date: '2026-09-01T16:00:00.000Z' },
          ],
        },
        silent: true,
      }),
    );
    const activity = listActivity(teamId, 8);
    const silent = activity.find((a) => a.summary?.silent);
    expect(silent).toMatchObject({
      actorName: '系统',
      actorClientId: 'system',
      actorSource: 'system',
      op: 'update_release_sheet',
      text: '系统 静默更新了发布时间表标尺',
    });
    expect(silent?.summary).toMatchObject({
      silent: true,
      triggeredBy: 'Tester',
      cleared: false,
      rowCount: 3,
    });
    const manual = activity.find(
      (a) => a.op === 'update_release_sheet' && !a.summary?.silent && !a.summary?.cleared,
    );
    expect(manual?.actorName).toBe('Tester');
    expect(manual?.text).toBe('Tester 更新了发布时间表标尺');
  });
});

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ActorContext } from '../types.js';

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'roadmap-asg-'));

const { applyIntent, createTeam, getTeamSnapshot } = await import(
  '../core/TeamService.js'
);

const actor: ActorContext = {
  name: 'Esone Qiu',
  clientId: 'test-client',
  source: 'creator',
};

describe('assignee map intent', () => {
  let teamId = '';

  beforeAll(() => {
    const snapshot = createTeam({
      name: 'Asg Map',
      jql: 'project = NOVA AND issuetype = Epic',
      actor,
    });
    teamId = snapshot.team.id;
  });

  it('defaults to empty map and persists update_assignee_map', () => {
    expect(getTeamSnapshot(teamId)!.team.assigneeMap).toEqual({});
    const result = applyIntent(
      teamId,
      {
        op: 'update_assignee_map',
        assigneeMap: { ray: 'Ray Zhang', Vivi: 'Vivi Wang' },
      },
      actor,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.team.assigneeMap).toEqual({
      ray: 'Ray Zhang',
      vivi: 'Vivi Wang',
    });
  });

  it('merge_people rewrites owners/createdBy, collapses members, keeps alias', () => {
    expectOk(
      applyIntent(
        teamId,
        { op: 'add_member', name: 'ray', avatarColor: '#111111' },
        actor,
      ),
    );
    expectOk(
      applyIntent(
        teamId,
        { op: 'add_member', name: 'Ray Zhang', avatarColor: '#222222' },
        actor,
      ),
    );
    const added = expectOk(
      applyIntent(
        teamId,
        {
          op: 'add_item',
          title: 'Merge Epic',
          type: 'Epic',
        },
        actor,
      ),
    );
    const itemKey = added.itemKey!;
    expectOk(
      applyIntent(
        teamId,
        {
          op: 'add_sub',
          itemKey,
          title: 'Owned by short name',
          owner: 'ray',
          start: '2026-08-01',
          days: 7,
          temp: true,
        },
        actor,
      ),
    );

    const merged = expectOk(
      applyIntent(
        teamId,
        { op: 'merge_people', fromName: 'ray', toName: 'Ray Zhang' },
        actor,
      ),
    );

    expect(merged.snapshot.members.some((m) => m.name === 'ray')).toBe(false);
    expect(merged.snapshot.members.some((m) => m.name === 'Ray Zhang')).toBe(
      true,
    );
    const sub = merged.snapshot.items
      .find((it) => it.key === itemKey)!
      .subs.find((s) => s.title === 'Owned by short name')!;
    expect(sub.owner).toBe('Ray Zhang');
    expect(merged.snapshot.team.assigneeMap).toMatchObject({
      ray: 'Ray Zhang',
      'ray zhang': 'Ray Zhang',
    });
  });
});

function expectOk<T extends { ok: boolean }>(result: T): T & { ok: true } {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('expected ok');
  return result as T & { ok: true };
}

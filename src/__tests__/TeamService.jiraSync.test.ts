import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '../types.js';

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'roadmap-jsync-'));

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>(
    '../config.js',
  );
  return {
    config: {
      ...actual.config,
      jira: {
        baseUrl: 'https://jira.example.com',
        pat: 'test-pat',
        fieldTargetStart: 'customfield_18350',
        fieldTargetEnd: 'customfield_18351',
        enabled: true,
      },
    },
  };
});

const jiraUpdate = vi.fn(async () => undefined);
vi.mock('../core/JiraClient.js', async () => {
  const actual = await vi.importActual<typeof import('../core/JiraClient.js')>(
    '../core/JiraClient.js',
  );
  return {
    ...actual,
    jiraUpdateTargetDates: (...args: unknown[]) => jiraUpdate(...args),
  };
});

const { applyIntent, createTeam, getTeamSnapshot, listActivity } = await import(
  '../core/TeamService.js'
);
const { clearTargetSyncQueue, flushAllTargetSyncs, queueTargetSync } =
  await import('../core/TargetSync.js');

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

let teamId = '';

beforeAll(() => {
  const snapshot = createTeam({ name: 'Nova Sync', jql: JQL, actor });
  teamId = snapshot.team.id;
  expectOk(
    apply(teamId, {
      op: 'import',
      quarters: ['2026-Q3'],
      overwrite: true,
      items: [
        {
          key: 'NOVA-100',
          type: 'Epic',
          title: 'Synced epic',
          quarter: '2026-Q3',
        },
      ],
    }),
  );
});

afterEach(() => {
  clearTargetSyncQueue();
  jiraUpdate.mockReset();
  jiraUpdate.mockResolvedValue(undefined);
});

describe('Target sync debounce', () => {
  it('collapses rapid moves into one Jira write', async () => {
    const item = getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-100')!;
    expectOk(
      apply(teamId, {
        op: 'schedule',
        itemKey: 'NOVA-100',
        start: '2026-08-01',
        days: 14,
        baseVersion: item.version,
      }),
    );
    const v2 = getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-100')!;
    expectOk(
      apply(teamId, {
        op: 'move',
        itemKey: 'NOVA-100',
        start: '2026-08-05',
        days: 14,
        baseVersion: v2.version,
      }),
    );

    // applyIntent no longer auto-queues; viewer (or API) must request sync.
    expect(queueTargetSync(teamId, 'NOVA-100', actor)).toEqual({ queued: true });
    expect(queueTargetSync(teamId, 'NOVA-100', actor)).toEqual({ queued: true });
    expect(jiraUpdate).not.toHaveBeenCalled();
    await flushAllTargetSyncs();
    expect(jiraUpdate).toHaveBeenCalledOnce();
    expect(jiraUpdate.mock.calls[0]).toEqual([
      'NOVA-100',
      '2026-08-05',
      '2026-08-18',
    ]);

    const snap = getTeamSnapshot(teamId)!;
    const updated = snap.items.find((i) => i.key === 'NOVA-100')!;
    expect(updated.targetStart).toBe('2026-08-05');
    expect(updated.targetEnd).toBe('2026-08-18');

    const syncLog = listActivity(teamId).find((a) => a.op === 'jira_sync');
    expect(syncLog?.text).toContain('已回写');
  });

  it('does not queue draft items without jira_key', async () => {
    const key = expectOk(
      apply(teamId, { op: 'add_item', title: 'Local only', quarter: '2026-Q3' }),
    ).itemKey!;
    const item = getTeamSnapshot(teamId)!.items.find((i) => i.key === key)!;
    expectOk(
      apply(teamId, {
        op: 'schedule',
        itemKey: key,
        start: '2026-08-01',
        days: 7,
        baseVersion: item.version,
      }),
    );
    expect(queueTargetSync(teamId, key, actor)).toEqual({ queued: true });
    await flushAllTargetSyncs();
    // flush skips items without jira_key
    expect(jiraUpdate).not.toHaveBeenCalled();
  });

  it('records jira_sync_failed without rolling back schedule', async () => {
    const { JiraHttpError } = await import('../core/JiraClient.js');
    jiraUpdate.mockRejectedValueOnce(new JiraHttpError(500, 'nope'));

    const item = getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-100')!;
    expectOk(
      apply(teamId, {
        op: 'move',
        itemKey: 'NOVA-100',
        start: '2026-09-01',
        days: 10,
        baseVersion: item.version,
      }),
    );
    queueTargetSync(teamId, 'NOVA-100', actor);
    await flushAllTargetSyncs();

    const after = getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-100')!;
    expect(after.start).toBe('2026-09-01');
    expect(after.days).toBe(10);
    expect(listActivity(teamId).some((a) => a.op === 'jira_sync_failed')).toBe(
      true,
    );
  });

  it('skips when jira disabled', async () => {
    const { config } = await import('../config.js');
    const prev = config.jira.enabled;
    (config.jira as { enabled: boolean }).enabled = false;
    try {
      expect(queueTargetSync(teamId, 'NOVA-100', actor)).toEqual({
        queued: false,
        skipped: 'jira_not_configured',
      });
      await flushAllTargetSyncs();
      expect(jiraUpdate).not.toHaveBeenCalled();
    } finally {
      (config.jira as { enabled: boolean }).enabled = prev;
    }
  });
});

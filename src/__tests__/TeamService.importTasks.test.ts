import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '../types.js';

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'roadmap-import-'));

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

const searchMock = vi.fn();
vi.mock('../core/JiraClient.js', async () => {
  const actual = await vi.importActual<typeof import('../core/JiraClient.js')>(
    '../core/JiraClient.js',
  );
  return {
    ...actual,
    jiraSearchChildTasks: (...args: unknown[]) => searchMock(...args),
  };
});

const {
  applyIntent,
  confirmTargetSync,
  createTeam,
  getTeamSnapshot,
  importRemoteTasks,
  importTasksFromJira,
} = await import('../core/TeamService.js');

const actor: ActorContext = {
  name: 'Tester',
  clientId: 'test-client',
  source: 'creator',
};

const JQL =
  `issueFunction in portfolioChildrenOf('project = INIT') ` +
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
  const snapshot = createTeam({ name: 'Import Tasks', jql: JQL, actor });
  teamId = snapshot.team.id;
  expectOk(
    apply(teamId, {
      op: 'import',
      quarters: ['2026-Q3'],
      overwrite: true,
      items: [
        {
          key: 'NOVA-200',
          type: 'Epic',
          title: 'Parent epic',
          quarter: '2026-Q3',
        },
      ],
    }),
  );
  const item = getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-200')!;
  expectOk(
    apply(teamId, {
      op: 'schedule',
      itemKey: 'NOVA-200',
      start: '2026-08-01',
      days: 30,
      baseVersion: item.version,
    }),
  );
});

describe('importTasksFromJira', () => {
  it('imports new Tasks and skips existing jira keys on second run', async () => {
    searchMock.mockResolvedValue([
      {
        key: 'NOVA-201',
        summary: 'New child',
        epicKey: 'NOVA-200',
        targetStart: '2026-08-03',
        targetEnd: '2026-08-10',
        assignee: 'Vivi',
      },
      {
        key: 'NOVA-202',
        summary: 'Another',
        epicKey: 'NOVA-200',
        targetStart: null,
        targetEnd: null,
        assignee: null,
      },
    ]);

    const first = await importTasksFromJira(teamId, actor);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.result.added).toBe(2);
    expect(first.result.skipped).toBe(0);

    const subs = getTeamSnapshot(teamId)!.items.find(
      (i) => i.key === 'NOVA-200',
    )!.subs;
    expect(subs.map((s) => s.key).sort()).toEqual(['NOVA-201', 'NOVA-202']);
    expect(subs.find((s) => s.key === 'NOVA-201')!.owner).toBe('Vivi');
    expect(subs.find((s) => s.key === 'NOVA-201')!.temp).toBe(false);
    expect(subs.find((s) => s.key === 'NOVA-201')!.targetStart).toBe('2026-08-03');
    expect(subs.find((s) => s.key === 'NOVA-201')!.targetEnd).toBe('2026-08-10');
    const mirrored = subs.find((s) => s.key === 'NOVA-202')!;
    expect(mirrored.start).toBe('2026-08-01');
    expect(mirrored.days).toBe(30);

    const second = await importTasksFromJira(teamId, actor);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.result.added).toBe(0);
    expect(second.result.skipped).toBe(2);
  });

  it('returns 501 when jira is not configured', async () => {
    const { config } = await import('../config.js');
    const prev = config.jira.enabled;
    (config.jira as { enabled: boolean }).enabled = false;
    try {
      const result = await importTasksFromJira(teamId, actor);
      expect(result).toEqual({
        ok: false,
        error: 'jira_not_configured',
        status: 501,
      });
    } finally {
      (config.jira as { enabled: boolean }).enabled = prev;
    }
  });

  it('importRemoteTasks works without server JIRA_PAT (extension path)', async () => {
    const { config } = await import('../config.js');
    const prev = config.jira.enabled;
    (config.jira as { enabled: boolean }).enabled = false;
    try {
      const result = importRemoteTasks(teamId, actor, [
        {
          key: 'NOVA-301',
          summary: 'From extension',
          epicKey: 'NOVA-200',
          targetStart: '2026-08-05',
          targetEnd: '2026-08-12',
          assignee: null,
        },
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.result.added).toBe(1);
      const sub = getTeamSnapshot(teamId)!
        .items.find((i) => i.key === 'NOVA-200')!
        .subs.find((s) => s.key === 'NOVA-301');
      expect(sub?.temp).toBe(false);
    } finally {
      (config.jira as { enabled: boolean }).enabled = prev;
    }
  });

  it('confirmTargetSync mirrors extension write into local targets', () => {
    const item = getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-200')!;
    const result = confirmTargetSync(teamId, actor, {
      itemKey: 'NOVA-200',
      start: '2026-08-10',
      end: '2026-08-24',
      jiraKey: item.jiraKey || 'NOVA-200',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const updated = result.snapshot.items.find((i) => i.key === 'NOVA-200')!;
    expect(updated.targetStart).toBe('2026-08-10');
    expect(updated.targetEnd).toBe('2026-08-24');
  });

  it('confirmTargetSync stamps last mirrored Target onto a sub', () => {
    expectOk(
      apply(teamId, {
        op: 'add_sub',
        itemKey: 'NOVA-200',
        title: 'confirm-child',
        start: '2026-08-10',
        days: 4,
      }),
    );
    const draft = getTeamSnapshot(teamId)!
      .items.find((i) => i.key === 'NOVA-200')!
      .subs.find((s) => s.title === 'confirm-child')!;
    expectOk(
      apply(teamId, {
        op: 'resolve_draft',
        mappings: [{ draftId: draft.id, jiraKey: 'NOVA-209' }],
      }),
    );
    const result = confirmTargetSync(teamId, actor, {
      subId: draft.id,
      start: '2026-08-12',
      end: '2026-08-21',
      jiraKey: 'NOVA-209',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sub = result.snapshot.items
      .find((i) => i.key === 'NOVA-200')!
      .subs.find((s) => s.id === draft.id)!;
    expect(sub.start).toBe('2026-08-12');
    expect(sub.days).toBe(10);
    expect(sub.targetStart).toBe('2026-08-12');
    expect(sub.targetEnd).toBe('2026-08-21');
  });

  it('confirmTargetSync restores schedule if silent refresh raced stale Target', () => {
    const before = getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-200')!;
    // Simulate open-page refresh applying old Jira Target after the user resized.
    expectOk(
      apply(teamId, {
        op: 'resize',
        itemKey: 'NOVA-200',
        start: '2026-08-01',
        days: 12,
        baseVersion: before.version,
      }),
    );
    const mid = getTeamSnapshot(teamId)!.items.find((i) => i.key === 'NOVA-200')!;
    expect(mid.start).toBe('2026-08-01');
    expect(mid.days).toBe(12);

    const result = confirmTargetSync(teamId, actor, {
      itemKey: 'NOVA-200',
      start: '2026-08-01',
      end: '2026-08-18',
      jiraKey: 'NOVA-200',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const updated = result.snapshot.items.find((i) => i.key === 'NOVA-200')!;
    expect(updated.targetStart).toBe('2026-08-01');
    expect(updated.targetEnd).toBe('2026-08-18');
    expect(updated.start).toBe('2026-08-01');
    expect(updated.days).toBe(18);
  });
});

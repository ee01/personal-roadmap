import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ActorContext } from '../types.js';
import { E12_SOURCE, E12_PLAN, e12PlanWithKeys } from './fixtures/e12.js';

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'roadmap-plan-'));
process.env.ROADMAP_AI_ENABLED = 'true';
process.env.ROADMAP_OPENAI_API_KEY = 'test-key';

const {
  applyIntent,
  createShareToken,
  createTeam,
  getTeamSnapshot,
} = await import('../core/TeamService.js');
const { validateDraftPlan } = await import('../planning/DraftPlanValidator.js');
const {
  submitStructuredPlan,
  commitPlan,
  undoPlanningBatch,
  planningCapabilities,
  declareJiraHandoff,
  listPlanningItems,
  deletePlanningItem,
  unschedulePlanningItem,
} = await import('../planning/DraftPlanningService.js');
const { stripSecrets, publicIntentEvent } = await import('../planning/sanitize.js');
const { getEventBus } = await import('../core/EventBus.js');

const actor: ActorContext = {
  name: 'Planner',
  clientId: 'plan-client',
  source: 'web_ai',
};

function expectOk<T extends { ok: boolean; error?: string }>(result: T): T & { ok: true } {
  if (!result.ok) throw new Error(result.error);
  return result as T & { ok: true };
}

describe('planning security', () => {
  it('strips share tokens from events', () => {
    const cleaned = stripSecrets({
      op: 'add_item',
      shareToken: 'secret-token',
      title: 'x',
    });
    expect(cleaned).toEqual({ op: 'add_item', title: 'x' });
    const event = publicIntentEvent(
      'add_item',
      { title: 'x', shareToken: 'secret-token' },
      { ...actor, shareTokenId: 'tok1' },
    );
    expect(JSON.stringify(event)).not.toMatch(/secret-token/);
    expect(event.actor).toEqual({
      name: 'Planner',
      clientId: 'plan-client',
      source: 'web_ai',
    });
  });

  it('does not broadcast shareToken on intents', () => {
    const snapshot = createTeam({
      name: 'Sec',
      jql: 'project = NOVA AND issuetype = Epic',
      actor,
    });
    const seen: unknown[] = [];
    const unsub = getEventBus().subscribe((event, data) => {
      if (event === 'intent') seen.push(data);
    });
    expectOk(
      applyIntent(
        snapshot.team.id,
        { op: 'add_item', title: 'Secret check', shareToken: 'leak-me' },
        actor,
      ),
    );
    unsub();
    expect(JSON.stringify(seen)).not.toMatch(/leak-me/);
  });
});

describe('planning capabilities', () => {
  it('advertises autoCommit as a per-request option whenever LLM is configured', () => {
    const caps = planningCapabilities();
    expect(caps.features.autoCommit).toBe(caps.features.serverLlm);
    expect(caps.autoCommitEligible).toBe(caps.features.serverLlm);
    expect(caps.features.undo).toBe(true);
  });
});

describe('preview without autoCommit', () => {
  it('does not write Drafts when autoCommit is omitted', () => {
    const snapshot = createTeam({
      name: 'Preview',
      jql: 'project = NOVA AND issuetype = Epic',
      actor,
    });
    const submitted = submitStructuredPlan({
      teamId: snapshot.team.id,
      requestId: '00000000-0000-4000-8000-0000000000pv',
      sources: [{ id: 'paste', title: 'p', text: 'Parent Preview\nChild' }],
      plan: {
        schemaVersion: '1',
        documentTitle: 'preview',
        globalContext: { background: '', constraints: [], milestones: [], risks: [] },
        parents: [
          {
            ref: 'p1',
            action: 'create',
            existingItemKey: null,
            title: 'Parent Preview',
            description: 'A',
            schedule: { start: '2026-09-15', end: '2026-09-21', basis: 'explicit' },
            evidence: [],
            children: [
              {
                ref: 'c1',
                title: 'Child',
                description: 'c',
                owner: null,
                ownerCandidates: [],
                schedule: { start: null, end: null, basis: 'missing' },
                dependsOnRefs: [],
                evidence: [],
              },
            ],
          },
        ],
        assumptions: [],
      },
      referenceDate: '2026-09-16',
      planningStart: '2026-09-15',
      timezone: 'Asia/Shanghai',
      quarter: '2026-Q3',
      parentSelection: { itemKeys: [] },
      actor,
    });
    expect(submitted.status).toBe(200);
    expect(submitted.body.status).toBe('ready');
    expect(submitted.body.receipt).toBeUndefined();
    expect(
      getTeamSnapshot(snapshot.team.id)!.items.some((row) => row.title === 'Parent Preview'),
    ).toBe(false);
  });
});

describe('E-12 fixture commit', () => {
  let teamId = '';
  let keys = { inbound: '', outbound: '', ringcx: '' };

  beforeAll(() => {
    const snapshot = createTeam({
      name: 'Nova brandy',
      jql: 'project = NOVA AND issuetype = Epic',
      actor,
    });
    teamId = snapshot.team.id;
    const inbound = expectOk(
      applyIntent(teamId, { op: 'add_item', title: 'AIR as virtual assistant in RCCC - Inbound Voice' }, actor),
    ).itemKey!;
    const outbound = expectOk(
      applyIntent(teamId, { op: 'add_item', title: 'AIR as virtual assistant in RCCC - Outbound Voice' }, actor),
    ).itemKey!;
    const ringcx = expectOk(
      applyIntent(teamId, { op: 'add_item', title: 'AIR as virtual assistant in RingCX' }, actor),
    ).itemKey!;
    for (const key of [inbound, outbound, ringcx]) {
      const item = getTeamSnapshot(teamId)!.items.find((row) => row.key === key)!;
      expectOk(
        applyIntent(
          teamId,
          { op: 'schedule', itemKey: key, baseVersion: item.version, start: '2026-09-15', days: 90 },
          actor,
        ),
      );
    }
    keys = { inbound, outbound, ringcx };
  });

  it('validates the E-12 plan against the source document', () => {
    const result = validateDraftPlan({
      plan: E12_PLAN,
      sources: [{ id: 'paste', title: 'paste', text: E12_SOURCE }],
    });
    expect(result.ok).toBe(true);
  });

  it('attaches 12 children under 3 existing parents without duplicating them', () => {
    const plan = e12PlanWithKeys(keys);
    const submitted = submitStructuredPlan({
      teamId,
      requestId: '00000000-0000-4000-8000-0000000000e1',
      sources: [{ id: 'paste', title: 'paste', text: E12_SOURCE }],
      plan,
      referenceDate: '2026-09-16',
      planningStart: '2026-09-15',
      timezone: 'Asia/Shanghai',
      quarter: '2026-Q3',
      parentSelection: { itemKeys: [keys.inbound, keys.outbound, keys.ringcx] },
      actor,
      autoCommit: true,
    });
    expect(submitted.status).toBe(201);
    const receipt = submitted.body.receipt as {
      createdParents: string[];
      attachedParents: string[];
      createdChildren: string[];
      jiraCreated: boolean;
    };
    expect(receipt.createdParents).toEqual([]);
    expect(receipt.attachedParents).toEqual([keys.inbound, keys.outbound, keys.ringcx]);
    expect(receipt.createdChildren).toHaveLength(12);
    expect(receipt.jiraCreated).toBe(false);
    const snap = getTeamSnapshot(teamId)!;
    const inbound = snap.items.find((item) => item.key === keys.inbound)!;
    const outbound = snap.items.find((item) => item.key === keys.outbound)!;
    const ringcx = snap.items.find((item) => item.key === keys.ringcx)!;
    expect(inbound.subs).toHaveLength(4);
    expect(outbound.subs).toHaveLength(3);
    expect(ringcx.subs).toHaveLength(5);
    expect(inbound.jiraKey).toBeNull();
    const fairy = ringcx.subs.find((sub) => sub.title.includes('Digital'))!;
    expect(fairy.owner).toBeNull();
    expect(fairy.ownerResolution).toBe('ambiguous');
    const tbd = ringcx.subs.find((sub) => sub.title.includes('Autodiscovery'))!;
    expect(tbd.owner).toBeNull();
    expect(tbd.ownerResolution).toBe('unassigned');
    expect(inbound.description || '').toContain('整体背景');
    expect(JSON.stringify(snap)).not.toMatch(/jiraCreated\":true/);
  });

  it('is idempotent for the same requestId', () => {
    const before = getTeamSnapshot(teamId)!.items.reduce((n, item) => n + item.subs.length, 0);
    const again = submitStructuredPlan({
      teamId,
      requestId: '00000000-0000-4000-8000-0000000000e1',
      sources: [{ id: 'paste', title: 'paste', text: E12_SOURCE }],
      plan: e12PlanWithKeys(keys),
      referenceDate: '2026-09-16',
      planningStart: '2026-09-15',
      timezone: 'Asia/Shanghai',
      quarter: '2026-Q3',
      parentSelection: { itemKeys: [keys.inbound, keys.outbound, keys.ringcx] },
      actor,
      autoCommit: true,
    });
    expect(again.status).toBe(200);
    const after = getTeamSnapshot(teamId)!.items.reduce((n, item) => n + item.subs.length, 0);
    expect(after).toBe(before);
  });

  it('rejects a different payload with the same requestId', () => {
    const result = submitStructuredPlan({
      teamId,
      requestId: '00000000-0000-4000-8000-0000000000e1',
      sources: [{ id: 'paste', title: 'paste', text: E12_SOURCE }],
      plan: { ...E12_PLAN, documentTitle: 'other' },
      referenceDate: '2026-09-16',
      planningStart: '2026-09-15',
      timezone: 'Asia/Shanghai',
      quarter: '2026-Q3',
      parentSelection: { itemKeys: [] },
      actor,
    });
    expect(result.status).toBe(409);
  });
});

describe('planning rollback and undo', () => {
  it('rolls back when a later insert would violate uniqueness', () => {
    const snapshot = createTeam({
      name: 'Tx',
      jql: 'project = NOVA AND issuetype = Epic',
      actor,
    });
    const plan = {
      schemaVersion: '1' as const,
      documentTitle: 'tx',
      globalContext: { background: '', constraints: [], milestones: [], risks: [] },
      parents: [
        {
          ref: 'p1',
          action: 'create' as const,
          existingItemKey: null,
          title: 'Parent A',
          description: 'A',
          schedule: { start: '2026-09-15', end: '2026-09-21', basis: 'explicit' as const },
          evidence: [],
          children: [
            {
              ref: 'c1',
              title: 'Child',
              description: 'c',
              owner: null,
              ownerCandidates: [],
              schedule: { start: null, end: null, basis: 'missing' as const },
              dependsOnRefs: [],
              evidence: [],
            },
          ],
        },
      ],
      assumptions: [],
    };
    const first = submitStructuredPlan({
      teamId: snapshot.team.id,
      requestId: '00000000-0000-4000-8000-0000000000a1',
      sources: [{ id: 'paste', title: 'p', text: 'Parent A\nChild' }],
      plan,
      referenceDate: '2026-09-16',
      planningStart: '2026-09-15',
      timezone: 'Asia/Shanghai',
      quarter: '2026-Q3',
      parentSelection: { itemKeys: [] },
      actor,
      autoCommit: true,
    });
    expect(first.status).toBe(201);
    const receipt = first.body.receipt as { batchId: string; createdChildren: string[] };
    const undone = undoPlanningBatch({
      teamId: snapshot.team.id,
      batchId: receipt.batchId,
      actor,
    });
    expect(undone.status).toBe(200);
    const after = getTeamSnapshot(snapshot.team.id)!;
    expect(after.items.some((item) => item.title === 'Parent A')).toBe(false);
  });

  it('still undoes a Draft batch after a jira-handoff mark', () => {
    const snapshot = createTeam({
      name: 'HandoffUndo',
      jql: 'project = NOVA AND issuetype = Epic',
      actor,
    });
    const first = submitStructuredPlan({
      teamId: snapshot.team.id,
      requestId: '00000000-0000-4000-8000-0000000000h1',
      sources: [{ id: 'paste', title: 'p', text: 'Parent Handoff\nChild' }],
      plan: {
        schemaVersion: '1',
        documentTitle: 'handoff',
        globalContext: { background: '', constraints: [], milestones: [], risks: [] },
        parents: [
          {
            ref: 'p1',
            action: 'create',
            existingItemKey: null,
            title: 'Parent Handoff',
            description: 'A',
            schedule: { start: '2026-09-15', end: '2026-09-21', basis: 'explicit' },
            evidence: [],
            children: [
              {
                ref: 'c1',
                title: 'Child',
                description: 'c',
                owner: null,
                ownerCandidates: [],
                schedule: { start: null, end: null, basis: 'missing' },
                dependsOnRefs: [],
                evidence: [],
              },
            ],
          },
        ],
        assumptions: [],
      },
      referenceDate: '2026-09-16',
      planningStart: '2026-09-15',
      timezone: 'Asia/Shanghai',
      quarter: '2026-Q3',
      parentSelection: { itemKeys: [] },
      actor,
      autoCommit: true,
    });
    expect(first.status).toBe(201);
    const receipt = first.body.receipt as { batchId: string };
    const item = getTeamSnapshot(snapshot.team.id)!.items.find((row) => row.title === 'Parent Handoff')!;
    const marked = declareJiraHandoff(snapshot.team.id, [{ itemKey: item.key }]);
    expect(marked.status).toBe(200);
    const undone = undoPlanningBatch({
      teamId: snapshot.team.id,
      batchId: receipt.batchId,
      actor,
    });
    expect(undone.status).toBe(200);
    expect(getTeamSnapshot(snapshot.team.id)!.items.some((row) => row.title === 'Parent Handoff')).toBe(
      false,
    );
  });

  it('keeps rows that already have a Jira key', () => {
    const snapshot = createTeam({
      name: 'HasJira',
      jql: 'project = NOVA AND issuetype = Epic',
      actor,
    });
    const first = submitStructuredPlan({
      teamId: snapshot.team.id,
      requestId: '00000000-0000-4000-8000-0000000000j1',
      sources: [{ id: 'paste', title: 'p', text: 'Parent Jira\nChild' }],
      plan: {
        schemaVersion: '1',
        documentTitle: 'jira',
        globalContext: { background: '', constraints: [], milestones: [], risks: [] },
        parents: [
          {
            ref: 'p1',
            action: 'create',
            existingItemKey: null,
            title: 'Parent Jira',
            description: 'A',
            schedule: { start: '2026-09-15', end: '2026-09-21', basis: 'explicit' },
            evidence: [],
            children: [
              {
                ref: 'c1',
                title: 'Child',
                description: 'c',
                owner: null,
                ownerCandidates: [],
                schedule: { start: null, end: null, basis: 'missing' },
                dependsOnRefs: [],
                evidence: [],
              },
            ],
          },
        ],
        assumptions: [],
      },
      referenceDate: '2026-09-16',
      planningStart: '2026-09-15',
      timezone: 'Asia/Shanghai',
      quarter: '2026-Q3',
      parentSelection: { itemKeys: [] },
      actor,
      autoCommit: true,
    });
    expect(first.status).toBe(201);
    const receipt = first.body.receipt as { batchId: string };
    const item = getTeamSnapshot(snapshot.team.id)!.items.find((row) => row.title === 'Parent Jira')!;
    expectOk(
      applyIntent(snapshot.team.id, { op: 'resolve_item', itemKey: item.key, jiraKey: 'NOVA-9' }, actor),
    );
    const undone = undoPlanningBatch({
      teamId: snapshot.team.id,
      batchId: receipt.batchId,
      actor,
    });
    expect(undone.status).toBe(409);
    expect(undone.body.error).toBe('undo_conflict');
    const kept = getTeamSnapshot(snapshot.team.id)!.items.find((row) => row.title === 'Parent Jira');
    expect(kept?.jiraKey).toBe('NOVA-9');
  });

  it('keeps TBD from falling back to the current user', () => {
    const snapshot = createTeam({
      name: 'Owner',
      jql: 'project = NOVA AND issuetype = Epic',
      actor,
    });
    const submitted = submitStructuredPlan({
      teamId: snapshot.team.id,
      requestId: '00000000-0000-4000-8000-0000000000b1',
      sources: [{ id: 'paste', title: 'p', text: 'Epic Solo\nTicket TBD person' }],
      plan: {
        schemaVersion: '1',
        documentTitle: 'solo',
        globalContext: { background: '', constraints: [], milestones: [], risks: [] },
        parents: [
          {
            ref: 'p1',
            action: 'create',
            existingItemKey: null,
            title: 'Epic Solo',
            description: 'd',
            schedule: { start: null, end: null, basis: 'missing' },
            evidence: [],
            children: [
              {
                ref: 'c1',
                title: 'Ticket TBD person',
                description: 'TBD',
                owner: null,
                ownerCandidates: ['TBD'],
                schedule: { start: null, end: null, basis: 'missing' },
                dependsOnRefs: [],
                evidence: [],
              },
            ],
          },
        ],
        assumptions: [],
      },
      referenceDate: '2026-09-16',
      planningStart: '2026-09-15',
      timezone: 'Asia/Shanghai',
      quarter: '2026-Q3',
      parentSelection: { itemKeys: [] },
      actor,
      autoCommit: true,
    });
    expect(submitted.status).toBe(201);
    const item = getTeamSnapshot(snapshot.team.id)!.items.find((row) => row.title === 'Epic Solo')!;
    expect(item.subs[0].owner).toBeNull();
    expect(item.subs[0].ownerResolution).toBe('unassigned');
    expect(item.subs[0].createdBy).toBe('Planner');
  });

  it('rejects attach to an unknown parent key without writing', () => {
    const snapshot = createTeam({
      name: 'Ghost',
      jql: 'project = NOVA AND issuetype = Epic',
      actor,
    });
    const submitted = submitStructuredPlan({
      teamId: snapshot.team.id,
      requestId: '00000000-0000-4000-8000-0000000000g1',
      sources: [{ id: 'paste', title: 'p', text: 'Epic Ghost\nTicket One' }],
      plan: {
        schemaVersion: '1',
        documentTitle: 'ghost',
        globalContext: { background: '', constraints: [], milestones: [], risks: [] },
        parents: [
          {
            ref: 'p1',
            action: 'attach',
            existingItemKey: 'LOCAL-not-real',
            title: 'Epic Ghost',
            description: 'd',
            schedule: { start: null, end: null, basis: 'missing' },
            evidence: [],
            children: [
              {
                ref: 'c1',
                title: 'Ticket One',
                description: 'c',
                owner: null,
                ownerCandidates: [],
                schedule: { start: null, end: null, basis: 'missing' },
                dependsOnRefs: [],
                evidence: [],
              },
            ],
          },
        ],
        assumptions: [],
      },
      referenceDate: '2026-09-16',
      planningStart: '2026-09-15',
      timezone: 'Asia/Shanghai',
      quarter: '2026-Q3',
      parentSelection: { itemKeys: ['LOCAL-not-real'] },
      actor,
      autoCommit: true,
    });
    expect(submitted.status).toBeGreaterThanOrEqual(400);
    expect(getTeamSnapshot(snapshot.team.id)!.items).toHaveLength(0);
  });
});

describe('share token minting', () => {
  it('refuses to mint a new share token without an existing editor token', async () => {
    const { default: Fastify } = await import('fastify');
    const { registerRoutes } = await import('../routes/api.js');
    const app = Fastify();
    await registerRoutes(app);
    const snapshot = createTeam({
      name: 'Share',
      jql: 'project = NOVA',
      actor,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/teams/${snapshot.team.id}/share`,
      payload: { actorSource: 'creator', actorName: 'forger' },
    });
    expect(res.statusCode).toBe(403);
    const token = createShareToken(snapshot.team.id, actor);
    const ok = await app.inject({
      method: 'POST',
      url: `/api/v1/teams/${snapshot.team.id}/share`,
      headers: { 'x-share-token': token.token },
      payload: { actorName: 'Planner' },
    });
    expect(ok.statusCode).toBe(200);
    await app.close();
  });
});

describe('MCP item list / delete / unschedule', () => {
  it('groups gantt vs backlog, unschedules onto backlog, and hard-deletes drafts only', () => {
    const snapshot = createTeam({
      name: 'Item tools',
      jql: 'project = NOVA AND issuetype = Epic',
      actor,
    });
    const teamId = snapshot.team.id;
    const ganttKey = expectOk(
      applyIntent(teamId, { op: 'add_item', title: 'On gantt' }, actor),
    ).itemKey!;
    expectOk(
      applyIntent(
        teamId,
        {
          op: 'schedule',
          itemKey: ganttKey,
          start: '2026-09-01',
          days: 5,
          baseVersion: 1,
        },
        actor,
      ),
    );
    const backlogKey = expectOk(
      applyIntent(teamId, { op: 'add_item', title: 'In backlog' }, actor),
    ).itemKey!;
    const jiraKey = expectOk(
      applyIntent(teamId, { op: 'add_item', title: 'Has jira' }, actor),
    ).itemKey!;
    expectOk(
      applyIntent(teamId, { op: 'resolve_item', itemKey: jiraKey, jiraKey: 'NOVA-88' }, actor),
    );

    const listed = listPlanningItems(teamId, undefined, 'all');
    expect(listed.gantt.some((item) => item.key === ganttKey && item.view === 'gantt')).toBe(
      true,
    );
    expect(listed.backlog.some((item) => item.key === backlogKey && item.view === 'backlog')).toBe(
      true,
    );
    expect(listPlanningItems(teamId, undefined, 'gantt').backlog).toEqual([]);
    expect(listPlanningItems(teamId, undefined, 'backlog').gantt).toEqual([]);

    const moved = unschedulePlanningItem(teamId, actor, ganttKey);
    expect(moved.status).toBe(200);
    expect(moved.body.view).toBe('backlog');
    expect(listPlanningItems(teamId, undefined, 'gantt').gantt.some((item) => item.key === ganttKey)).toBe(
      false,
    );
    expect(
      listPlanningItems(teamId, undefined, 'backlog').backlog.some((item) => item.key === ganttKey),
    ).toBe(true);

    const deleted = deletePlanningItem(teamId, actor, backlogKey);
    expect(deleted.status).toBe(200);
    expect(deleted.body.deletedKey).toBe(backlogKey);
    expect(
      getTeamSnapshot(teamId)!.items.some((item) => item.key === backlogKey),
    ).toBe(false);

    const refused = deletePlanningItem(teamId, actor, jiraKey);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('item_has_jira');
    expect(getTeamSnapshot(teamId)!.items.some((item) => item.key === jiraKey)).toBe(true);
  });
});

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ActorContext } from '../types.js';

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'roadmap-ai-prompt-'));

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

let teamId = '';

beforeAll(() => {
  const snapshot = createTeam({
    name: 'Prompt Team',
    jql: 'project = NOVA AND issuetype = Epic',
    actor,
  });
  teamId = snapshot.team.id;
});

describe('create Jira prompt team config', () => {
  it('defaults createJiraPrompt to empty on create', () => {
    expect(getTeamSnapshot(teamId)!.team.createJiraPrompt).toBe('');
  });

  it('stores createJiraPrompt via update_create_jira_prompt', () => {
    const prompt =
      '创建 Task，Sprint 填当前 sprint，fixVersion 按发布时间表';
    const result = expectOk(
      apply(teamId, {
        op: 'update_create_jira_prompt',
        prompt,
      }),
    );
    expect(result.snapshot.team.createJiraPrompt).toBe(prompt);
    const activity = listActivity(teamId, 5);
    expect(activity.some((a) => a.op === 'update_create_jira_prompt')).toBe(
      true,
    );
  });

  it('overwrite import without quarters clears all jira items', () => {
    expectOk(
      apply(teamId, {
        op: 'import',
        quarters: [],
        overwrite: false,
        items: [
          { key: 'NOVA-1', type: 'Epic', title: 'One' },
          { key: 'NOVA-2', type: 'Epic', title: 'Two' },
        ],
      }),
    );
    expect(getTeamSnapshot(teamId)!.items).toHaveLength(2);

    expectOk(
      apply(teamId, {
        op: 'import',
        quarters: [],
        overwrite: true,
        items: [{ key: 'NOVA-3', type: 'Epic', title: 'Three' }],
      }),
    );
    const items = getTeamSnapshot(teamId)!.items;
    expect(items.map((i) => i.key).sort()).toEqual(['NOVA-3']);
  });
});

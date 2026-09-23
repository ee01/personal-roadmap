import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ActorContext } from '../types.js';

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'roadmap-listteams-'));

const { createTeam, listTeams } = await import('../core/TeamService.js');

const actor: ActorContext = {
  name: 'Tester',
  clientId: 'test-client',
  source: 'creator',
};

let brandy = '';
let milo = '';

beforeAll(() => {
  brandy = createTeam({
    name: 'Nova brandy',
    jql: 'project = NOVA',
    actor,
  }).team.id;
  milo = createTeam({
    name: 'Milo',
    jql: 'project = MILO',
    actor,
  }).team.id;
});

describe('listTeams', () => {
  it('returns no teams when ids are omitted', () => {
    expect(listTeams()).toEqual([]);
    expect(listTeams([])).toEqual([]);
  });

  it('returns only requested teams in request order', () => {
    const items = listTeams([milo, 'missing', brandy]);
    expect(items.map((t) => t.id)).toEqual([milo, brandy]);
    expect(items.map((t) => t.name)).toEqual(['Milo', 'Nova brandy']);
  });
});

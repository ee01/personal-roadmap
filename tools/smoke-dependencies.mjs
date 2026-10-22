// Verify the built API against a temporary database, including on the deploy host.
// Run from the repository root (or pipe into node --input-type=module in /app).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';

const dir = mkdtempSync(path.join(os.tmpdir(), 'roadmap-dependency-smoke-'));
process.env.DATA_DIR = dir;
process.env.JIRA_PAT = '';
const load = (file) => import(pathToFileURL(path.resolve('dist', file)).href);
const { registerRoutes } = await load('routes/api.js');
const { closeDb } = await load('storage/Database.js');
const app = Fastify();
let exitCode = 0;
try {
  await registerRoutes(app);
  const request = async (url, body, token) => {
    const result = await app.inject({
      method: body ? 'POST' : 'GET',
      url,
      payload: body,
      headers: {
        'x-actor-name': 'Dependency smoke',
        'x-client-id': 'dependency-smoke',
        ...(token ? { 'x-share-token': token } : {}),
      },
    });
    assert.equal(result.statusCode, 200, result.body);
    const data = result.json();
    assert.notEqual(data.ok, false, result.body);
    return data;
  };
  const created = await request('/api/v1/teams', {
    name: 'Dependency smoke',
    jql: 'project = SMOKE',
  });
  const base = `/api/v1/teams/${created.snapshot.team.id}`;
  const intent = (body) => request(`${base}/intents`, body, created.editToken);
  await intent({
    op: 'import',
    quarters: ['2026-Q4'],
    items: [
      { key: 'SMOKE-1', title: 'Host', type: 'Epic', quarter: '2026-Q4' },
    ],
    overwrite: true,
  });
  let result = await intent({
    op: 'add_marker',
    itemKey: 'SMOKE-1',
    kind: 'dep',
    label: 'API smoke',
    jiraKey: 'PLAT-1',
    date: '2026-11-05',
    need: '2026-11-01',
    etaSource: 'jira',
    jiraTargetStart: '2026-10-20',
    jiraTargetEnd: '2026-11-05',
  });
  const markerOf = (data) => data.snapshot.items[0].markers[0];
  const original = markerOf(result);
  assert.equal(original.need, '2026-11-01');
  assert.equal(original.jiraTargetStart, '2026-10-20');
  assert.equal(typeof original.etaAt, 'number');
  result = await intent({
    op: 'update_marker',
    markerId: original.id,
    need: '2026-10-30',
    baseVersion: original.version,
  });
  const moved = markerOf(result);
  assert.equal(moved.date, original.date);
  assert.equal(moved.etaAt, original.etaAt);
  assert.equal(moved.need, '2026-10-30');
  result = await intent({
    op: 'refresh_from_jira',
    issues: [
      {
        key: 'PLAT-1',
        fetchedAt: Date.now(),
        fields: {
          targetStart: '2026-10-22',
          targetEnd: '2026-11-08',
          status: 'In Progress',
        },
      },
    ],
  });
  assert.equal(markerOf(result).date, original.date);
  assert.equal(markerOf(result).need, moved.need);
  assert.equal(markerOf(result).version, moved.version);
  assert.equal(markerOf(result).jiraTargetStart, '2026-10-22');
  assert.equal(markerOf(result).jiraTargetEnd, '2026-11-08');
  result = await intent({
    op: 'update_marker',
    markerId: original.id,
    date: '2026-11-08',
    etaSource: 'jira',
    baseVersion: moved.version,
  });
  const confirmed = markerOf(result);
  assert.equal(confirmed.need, moved.need);
  result = await intent({
    op: 'update_marker',
    markerId: original.id,
    need: null,
    baseVersion: confirmed.version,
  });
  assert.equal(markerOf(result).need, null);
  assert.equal(markerOf(await request(base)).date, '2026-11-08');
  const current = markerOf(result);
  result = await intent({
    op: 'update_marker',
    markerId: original.id,
    jiraKey: 'PLAT-2',
    baseVersion: current.version,
  });
  const rebound = markerOf(result);
  assert.equal(rebound.date, null);
  assert.equal(rebound.need, '2026-11-08');
  assert.equal(rebound.jiraStatus, null);
  assert.equal(rebound.jiraTargetEnd, null);
  assert.equal(rebound.jiraFetchedAt, null);
  result = await intent({
    op: 'update_marker',
    markerId: original.id,
    jiraKey: 'PLAT-3',
    date: '2026-11-10',
    etaSource: 'jira',
    jiraTargetEnd: '2026-11-10',
    baseVersion: rebound.version,
  });
  const relinked = markerOf(result);
  result = await intent({
    op: 'update_marker',
    markerId: original.id,
    jiraKey: null,
    baseVersion: relinked.version,
  });
  assert.equal(markerOf(result).date, '2026-11-10');
  assert.equal(markerOf(result).need, '2026-11-08');
  assert.equal(markerOf(result).etaSource, 'manual');
  assert.equal(markerOf(result).jiraTargetEnd, null);
  const denied = await app.inject({
    method: 'POST',
    url: `${base}/intents`,
    payload: { op: 'update_marker', markerId: original.id, need: null },
  });
  assert.equal(denied.statusCode, 403);
  const conflict = await app.inject({
    method: 'POST',
    url: `${base}/intents`,
    headers: { 'x-share-token': created.editToken },
    payload: {
      op: 'update_marker',
      markerId: original.id,
      need: null,
      baseVersion: original.version,
    },
  });
  assert.equal(conflict.statusCode, 409);
  console.log(
    'PASS: deployed dependency intent fields, ETA separation, Jira mirror, ticket rebind/unlink, readback, authorization and version conflicts',
  );
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  await app.close();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
}
// registerRoutes owns a maintenance interval; this standalone probe is finished.
process.exit(exitCode);

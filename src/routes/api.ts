import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  applyIntent,
  confirmTargetSync,
  createShareToken,
  createTeam,
  getTeamSnapshot,
  importRemoteTasks,
  importTasksFromJira,
  listActivity,
  listFocusItems,
  listTeams,
  pruneOldActivity,
  touchPresence,
  validateShareToken,
} from '../core/TeamService.js';
import { getEventBus } from '../core/EventBus.js';
import { config } from '../config.js';
import { serializeTeamEvent } from '../planning/sanitize.js';
import { queueTargetSync, queueSubTargetSync } from '../core/TargetSync.js';
import type { ActorContext, ActorSource } from '../types.js';

function readActor(request: FastifyRequest): ActorContext {
  const body = (request.body || {}) as Record<string, unknown>;
  const headers = request.headers;
  const name =
    String(body.actorName || headers['x-actor-name'] || '').trim() || 'Guest';
  const clientId =
    String(body.clientId || headers['x-client-id'] || '').trim() || 'anonymous';
  const sourceRaw = String(
    body.actorSource || headers['x-actor-source'] || 'anonymous',
  );
  const source: ActorSource =
    sourceRaw === 'extension' || sourceRaw === 'creator'
      ? sourceRaw
      : 'anonymous';
  const shareToken = String(
    body.shareToken || headers['x-share-token'] || '',
  ).trim();
  return {
    name,
    clientId,
    source,
    shareTokenId: null,
    ip: request.ip,
    // stash token temporarily for validation helpers
    ...(shareToken ? { shareToken } : {}),
  } as ActorContext & { shareToken?: string };
}

function requireWriteAccess(
  teamId: string,
  actor: ActorContext & { shareToken?: string },
): { ok: true; actor: ActorContext } | { ok: false; status: number; error: string } {
  const result = validateShareToken(teamId, actor.shareToken);
  if (!result.ok) {
    return {
      ok: false,
      status: 403,
      error: 'Editable share token required for write operations',
    };
  }
  const { shareToken: _ignored, ...rest } = actor;
  return {
    ok: true,
    actor: { ...rest, shareTokenId: result.shareTokenId || null },
  };
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({
    ok: true,
    service: 'roadmap-service',
    ts: Date.now(),
    jiraEnabled: config.jira.enabled,
    mcp: {
      endpoint: '/mcp',
      skill: '/skills/roadmap-planning/SKILL.md',
    },
  }));

  app.get('/api/v1/teams', async (request) => {
    const raw = String((request.query as { ids?: string }).ids || '');
    const ids = raw
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    return { items: listTeams(ids) };
  });

  app.post('/api/v1/teams', async (request, reply) => {
    const body = (request.body || {}) as Record<string, unknown>;
    const name = String(body.name || '').trim();
    const jql = String(body.jql || '').trim();
    if (!name || !jql) {
      return reply.code(400).send({ error: 'name and jql are required' });
    }
    const actor = readActor(request);
    // Creating a team does not require a prior share token; creator becomes editor.
    actor.source = actor.source === 'anonymous' ? 'creator' : actor.source;
    const snapshot = createTeam({
      name,
      jql,
      checkedQuarters: Array.isArray(body.checkedQuarters)
        ? body.checkedQuarters.map(String)
        : undefined,
      actor,
    });
    const share = createShareToken(snapshot.team.id, actor);
    return {
      snapshot,
      editToken: share.token,
    };
  });

  app.get<{ Params: { teamId: string } }>(
    '/api/v1/teams/:teamId',
    async (request, reply) => {
      const snapshot = getTeamSnapshot(request.params.teamId);
      if (!snapshot) return reply.code(404).send({ error: 'team_not_found' });
      const actor = readActor(request);
      touchPresence(request.params.teamId, actor);
      return { snapshot };
    },
  );

  app.get<{ Params: { teamId: string } }>(
    '/api/v1/teams/:teamId/focus-items',
    async (request, reply) => {
      const snapshot = getTeamSnapshot(request.params.teamId);
      if (!snapshot) return reply.code(404).send({ error: 'team_not_found' });
      return {
        teamId: request.params.teamId,
        teamName: snapshot.team.name,
        items: listFocusItems(request.params.teamId),
        syncedAt: Date.now(),
      };
    },
  );

  app.post<{ Params: { teamId: string } }>(
    '/api/v1/teams/:teamId/share',
    async (request, reply) => {
      const actor = readActor(request) as ActorContext & { shareToken?: string };
      const access = requireWriteAccess(request.params.teamId, actor);
      if (!access.ok) {
        return reply.code(access.status).send({ error: access.error });
      }
      const share = createShareToken(
        request.params.teamId,
        access.actor,
      );
      return { token: share.token, id: share.id };
    },
  );

  app.post<{ Params: { teamId: string } }>(
    '/api/v1/teams/:teamId/intents',
    async (request, reply) => {
      const body = (request.body || {}) as Record<string, unknown>;
      const actor = readActor(request) as ActorContext & { shareToken?: string };
      const access = requireWriteAccess(request.params.teamId, actor);
      if (!access.ok) {
        return reply.code(access.status).send({ error: access.error });
      }
      const result = applyIntent(request.params.teamId, body, access.actor);
      if (!result.ok) {
        const status = result.error === 'version_conflict' ? 409 : 400;
        return reply.code(status).send(result);
      }
      return result;
    },
  );

  app.post<{ Params: { teamId: string } }>(
    '/api/v1/teams/:teamId/import-tasks',
    async (request, reply) => {
      const actor = readActor(request) as ActorContext & { shareToken?: string };
      const access = requireWriteAccess(request.params.teamId, actor);
      if (!access.ok) {
        return reply.code(access.status).send({ error: access.error });
      }
      const body = (request.body || {}) as Record<string, unknown>;
      // Primary path: extension already searched with Options token.
      if (Array.isArray(body.tasks)) {
        const result = importRemoteTasks(
          request.params.teamId,
          access.actor,
          body.tasks,
        );
        if (!result.ok) {
          return reply.code(result.status || 400).send({ error: result.error });
        }
        return result.result;
      }
      // Legacy / server-PAT fallback search.
      const result = await importTasksFromJira(
        request.params.teamId,
        access.actor,
      );
      if (!result.ok) {
        return reply
          .code(result.status || 400)
          .send({ error: result.error });
      }
      return result.result;
    },
  );

  app.post<{ Params: { teamId: string } }>(
    '/api/v1/teams/:teamId/sync-target',
    async (request, reply) => {
      const actor = readActor(request) as ActorContext & { shareToken?: string };
      const access = requireWriteAccess(request.params.teamId, actor);
      if (!access.ok) {
        return reply.code(access.status).send({ error: access.error });
      }
      const body = (request.body || {}) as Record<string, unknown>;
      const itemKey = String(body.itemKey || '').trim();
      const subId = String(body.subId || '').trim();
      if (!itemKey && !subId) {
        return reply.code(400).send({ error: 'itemKey_required' });
      }
      // mode=confirm: extension already wrote Jira; mirror DB + activity.
      if (body.mode === 'confirm') {
        const result = confirmTargetSync(request.params.teamId, access.actor, {
          itemKey: itemKey || undefined,
          subId: subId || undefined,
          start: String(body.start || ''),
          end: String(body.end || ''),
          jiraKey: body.jiraKey ? String(body.jiraKey) : undefined,
        });
        if (!result.ok) {
          return reply.code(result.status || 400).send({ error: result.error });
        }
        return { ok: true, via: 'extension', snapshot: result.snapshot };
      }
      // Fallback: queue server JIRA_PAT sync (silent skip if not configured).
      const queued = subId
        ? queueSubTargetSync(request.params.teamId, subId, access.actor)
        : queueTargetSync(request.params.teamId, itemKey, access.actor);
      return { ok: true, ...queued, via: 'server' };
    },
  );

  app.get<{ Params: { teamId: string } }>(
    '/api/v1/teams/:teamId/activity',
    async (request, reply) => {
      const snapshot = getTeamSnapshot(request.params.teamId);
      if (!snapshot) return reply.code(404).send({ error: 'team_not_found' });
      const limit = Number((request.query as { limit?: string }).limit || 100);
      return { items: listActivity(request.params.teamId, limit) };
    },
  );

  app.get<{ Params: { teamId: string }; Querystring: { clientId?: string } }>(
    '/api/v1/teams/:teamId/events',
    async (request, reply) => {
      const teamId = request.params.teamId;
      const snapshot = getTeamSnapshot(teamId);
      if (!snapshot) return reply.code(404).send({ error: 'team_not_found' });

      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      reply.raw.write(`event: connected\ndata: ${JSON.stringify({ teamId })}\n\n`);

      const actor = readActor(request);
      if (request.query.clientId) actor.clientId = request.query.clientId;
      touchPresence(teamId, actor);

      const unsubscribe = getEventBus().subscribe((event, data, eventTeamId) => {
        if (eventTeamId !== teamId) return;
        const serialized = serializeTeamEvent(event, data);
        if (!serialized) return;
        reply.raw.write(
          `event: ${serialized.event}\ndata: ${JSON.stringify(serialized.data)}\n\n`,
        );
      });

      const heartbeat = setInterval(() => {
        reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
      }, 15000);

      request.raw.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    },
  );

  // Periodic cleanup of old activity
  setInterval(() => {
    try {
      pruneOldActivity();
    } catch {
      // ignore
    }
  }, 6 * 60 * 60 * 1000);
}

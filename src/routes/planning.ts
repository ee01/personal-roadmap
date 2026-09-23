import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { getTeamSnapshot, validateShareToken } from '../core/TeamService.js';
import type { ActorContext } from '../types.js';
import {
  cancelJob,
  commitPlan,
  createPlanningJob,
  declareJiraHandoff,
  getBatchPayload,
  jobPayload,
  listPlanningItems,
  lookupRequest,
  parsePlanningView,
  planPayload,
  planningCapabilities,
  planningContext,
  revisePlan,
  submitStructuredPlan,
  undoPlanningBatch,
  unschedulePlanningItem,
  deletePlanningItem,
} from '../planning/DraftPlanningService.js';
import { todayInTimeZone } from '../planning/dates.js';
import { randomUUID } from 'node:crypto';

function uuid(raw: unknown): string {
  const value = String(raw || '').trim();
  return value || randomUUID();
}

function readActor(request: FastifyRequest): ActorContext & { shareToken?: string } {
  const body = (request.body || {}) as Record<string, unknown>;
  const name =
    String(body.actorName || request.headers['x-actor-name'] || '').trim() || 'Guest';
  const clientId =
    String(body.clientId || request.headers['x-client-id'] || '').trim() || 'anonymous';
  const shareToken = String(
    body.shareToken || request.headers['x-share-token'] || '',
  ).trim();
  return {
    name,
    clientId,
    source: 'anonymous',
    shareTokenId: null,
    ip: request.ip,
    ...(shareToken ? { shareToken } : {}),
  };
}

function requireEdit(teamId: string, request: FastifyRequest) {
  const snapshot = getTeamSnapshot(teamId);
  if (!snapshot) return { ok: false as const, status: 404, error: 'team_not_found' };
  const actor = readActor(request);
  const result = validateShareToken(teamId, actor.shareToken);
  if (!result.ok) {
    return { ok: false as const, status: 403, error: 'Editable share token required' };
  }
  const { shareToken: _ignored, ...rest } = actor;
  return {
    ok: true as const,
    actor: { ...rest, shareTokenId: result.shareTokenId || null } as ActorContext,
  };
}

function planningSource(request: FastifyRequest): 'agent' | 'web_ai' {
  const raw = String(request.headers['x-actor-source'] || '').trim().toLowerCase();
  return raw === 'agent' ? 'agent' : 'web_ai';
}

function requireAgentAccess(request: FastifyRequest) {
  if (planningSource(request) === 'agent' && !config.ai.agentAccess) {
    return { ok: false as const, status: 403, error: 'agent_access_disabled' };
  }
  return { ok: true as const };
}

export async function registerPlanningRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { teamId: string } }>(
    '/api/v1/teams/:teamId/planning/capabilities',
    async (request, reply) => {
      const access = requireEdit(request.params.teamId, request);
      if (!access.ok) return reply.code(access.status).send({ error: access.error });
      return planningCapabilities();
    },
  );

  app.get<{
    Params: { teamId: string };
    Querystring: { itemKeys?: string; view?: string };
  }>(
    '/api/v1/teams/:teamId/planning/context',
    async (request, reply) => {
      const access = requireEdit(request.params.teamId, request);
      if (!access.ok) return reply.code(access.status).send({ error: access.error });
      const keys = String(request.query.itemKeys || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      return planningContext(
        request.params.teamId,
        keys.length ? keys : undefined,
        parsePlanningView(request.query.view),
      );
    },
  );

  app.get<{
    Params: { teamId: string };
    Querystring: { itemKeys?: string; view?: string };
  }>(
    '/api/v1/teams/:teamId/planning/items',
    async (request, reply) => {
      const access = requireEdit(request.params.teamId, request);
      if (!access.ok) return reply.code(access.status).send({ error: access.error });
      const keys = String(request.query.itemKeys || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      return listPlanningItems(
        request.params.teamId,
        keys.length ? keys : undefined,
        parsePlanningView(request.query.view),
      );
    },
  );

  app.post<{ Params: { teamId: string; itemKey: string } }>(
    '/api/v1/teams/:teamId/planning/items/:itemKey/delete',
    async (request, reply) => {
      const access = requireEdit(request.params.teamId, request);
      if (!access.ok) return reply.code(access.status).send({ error: access.error });
      const result = deletePlanningItem(
        request.params.teamId,
        { ...access.actor, source: planningSource(request) },
        request.params.itemKey,
      );
      return reply.code(result.status).send(result.body);
    },
  );

  app.post<{ Params: { teamId: string; itemKey: string } }>(
    '/api/v1/teams/:teamId/planning/items/:itemKey/unschedule',
    async (request, reply) => {
      const access = requireEdit(request.params.teamId, request);
      if (!access.ok) return reply.code(access.status).send({ error: access.error });
      const body = (request.body || {}) as Record<string, unknown>;
      const result = unschedulePlanningItem(
        request.params.teamId,
        { ...access.actor, source: planningSource(request) },
        request.params.itemKey,
        body.baseVersion,
      );
      return reply.code(result.status).send(result.body);
    },
  );

  app.post<{ Params: { teamId: string } }>(
    '/api/v1/teams/:teamId/planning/jobs',
    async (request, reply) => {
      const access = requireEdit(request.params.teamId, request);
      if (!access.ok) return reply.code(access.status).send({ error: access.error });
      const body = (request.body || {}) as Record<string, unknown>;
      const result = createPlanningJob({
        teamId: request.params.teamId,
        requestId: uuid(body.requestId),
        text: String(body.text || ''),
        referenceDate:
          String(body.referenceDate || '') || todayInTimeZone(Date.now(), 'Asia/Shanghai'),
        planningStart: body.planningStart ? String(body.planningStart) : null,
        timezone: String(body.timezone || 'Asia/Shanghai'),
        quarter: body.quarter ? String(body.quarter) : null,
        parentSelection: {
          itemKeys: Array.isArray(body.parentSelection)
            ? body.parentSelection.map(String)
            : Array.isArray((body.parentSelection as { itemKeys?: unknown })?.itemKeys)
              ? ((body.parentSelection as { itemKeys: unknown[] }).itemKeys).map(String)
              : [],
        },
        configurationVersion: body.configurationVersion
          ? String(body.configurationVersion)
          : null,
        autoCommit: body.autoCommit === true,
        actor: { ...access.actor, source: planningSource(request) },
      });
      return reply.code(result.status).send(result.body);
    },
  );

  app.get<{ Params: { teamId: string; jobId: string } }>(
    '/api/v1/teams/:teamId/planning/jobs/:jobId',
    async (request, reply) => {
      const access = requireEdit(request.params.teamId, request);
      if (!access.ok) return reply.code(access.status).send({ error: access.error });
      const job = jobPayload(request.params.teamId, request.params.jobId);
      if (!job) return reply.code(404).send({ error: 'job_not_found' });
      return job;
    },
  );

  app.post<{ Params: { teamId: string; jobId: string } }>(
    '/api/v1/teams/:teamId/planning/jobs/:jobId/cancel',
    async (request, reply) => {
      const access = requireEdit(request.params.teamId, request);
      if (!access.ok) return reply.code(access.status).send({ error: access.error });
      const result = cancelJob(request.params.teamId, request.params.jobId);
      return reply.code(result.status).send(result.body);
    },
  );

  app.get<{ Params: { teamId: string; planId: string } }>(
    '/api/v1/teams/:teamId/draft-plans/:planId',
    async (request, reply) => {
      const access = requireEdit(request.params.teamId, request);
      if (!access.ok) return reply.code(access.status).send({ error: access.error });
      const plan = planPayload(request.params.teamId, request.params.planId);
      if (!plan) return reply.code(404).send({ error: 'plan_not_found' });
      return plan;
    },
  );

  app.post<{ Params: { teamId: string } }>(
    '/api/v1/teams/:teamId/draft-plans',
    async (request, reply) => {
      const access = requireEdit(request.params.teamId, request);
      if (!access.ok) return reply.code(access.status).send({ error: access.error });
      const agent = requireAgentAccess(request);
      if (!agent.ok) return reply.code(agent.status).send({ error: agent.error });
      const body = (request.body || {}) as Record<string, unknown>;
      const sources = Array.isArray(body.sources)
        ? body.sources.map((item) => {
            const row = (item || {}) as Record<string, unknown>;
            return {
              id: String(row.id || 'paste'),
              title: String(row.title || 'paste'),
              text: String(row.text || ''),
            };
          })
        : [];
      const result = submitStructuredPlan({
        teamId: request.params.teamId,
        requestId: uuid(body.requestId),
        sources,
        plan: body.plan,
        referenceDate:
          String(body.referenceDate || '') || todayInTimeZone(Date.now(), 'Asia/Shanghai'),
        planningStart: body.planningStart ? String(body.planningStart) : null,
        timezone: String(body.timezone || 'Asia/Shanghai'),
        quarter: body.quarter ? String(body.quarter) : null,
        parentSelection: {
          itemKeys: Array.isArray((body.parentSelection as { itemKeys?: unknown[] })?.itemKeys)
            ? ((body.parentSelection as { itemKeys: unknown[] }).itemKeys).map(String)
            : [],
        },
        actor: { ...access.actor, source: planningSource(request) },
        autoCommit: Boolean(body.autoCommit),
        decisions: (body.decisions || {}) as Record<string, string>,
      });
      return reply.code(result.status).send(result.body);
    },
  );

  app.post<{ Params: { teamId: string; planId: string } }>(
    '/api/v1/teams/:teamId/draft-plans/:planId/revisions',
    async (request, reply) => {
      const access = requireEdit(request.params.teamId, request);
      if (!access.ok) return reply.code(access.status).send({ error: access.error });
      const agent = requireAgentAccess(request);
      if (!agent.ok) return reply.code(agent.status).send({ error: agent.error });
      const body = (request.body || {}) as Record<string, unknown>;
      const result = revisePlan({
        teamId: request.params.teamId,
        planId: request.params.planId,
        baseRevision: Number(body.baseRevision),
        changes: (body.changes || body) as Record<string, unknown>,
      });
      return reply.code(result.status).send(result.body);
    },
  );

  app.post<{ Params: { teamId: string; planId: string } }>(
    '/api/v1/teams/:teamId/draft-plans/:planId/commit',
    async (request, reply) => {
      const access = requireEdit(request.params.teamId, request);
      if (!access.ok) return reply.code(access.status).send({ error: access.error });
      const agent = requireAgentAccess(request);
      if (!agent.ok) return reply.code(agent.status).send({ error: agent.error });
      const body = (request.body || {}) as Record<string, unknown>;
      const result = commitPlan({
        teamId: request.params.teamId,
        planId: request.params.planId,
        requestId: uuid(body.requestId),
        revision: Number(body.revision),
        planHash: String(body.planHash || ''),
        actor: { ...access.actor, source: planningSource(request) },
        decisions: (body.decisions || {}) as Record<string, string>,
        quarter: body.quarter ? String(body.quarter) : null,
      });
      return reply.code(result.status).send(result.body);
    },
  );

  app.get<{ Params: { teamId: string; requestId: string } }>(
    '/api/v1/teams/:teamId/planning/requests/:requestId',
    async (request, reply) => {
      const access = requireEdit(request.params.teamId, request);
      if (!access.ok) return reply.code(access.status).send({ error: access.error });
      const result = lookupRequest(request.params.teamId, request.params.requestId);
      return reply.code(result.status).send(result.body);
    },
  );

  app.get<{ Params: { teamId: string; batchId: string } }>(
    '/api/v1/teams/:teamId/draft-batches/:batchId',
    async (request, reply) => {
      const access = requireEdit(request.params.teamId, request);
      if (!access.ok) return reply.code(access.status).send({ error: access.error });
      const result = getBatchPayload(request.params.teamId, request.params.batchId);
      return reply.code(result.status).send(result.body);
    },
  );

  app.post<{ Params: { teamId: string; batchId: string } }>(
    '/api/v1/teams/:teamId/draft-batches/:batchId/undo',
    async (request, reply) => {
      const access = requireEdit(request.params.teamId, request);
      if (!access.ok) return reply.code(access.status).send({ error: access.error });
      const result = undoPlanningBatch({
        teamId: request.params.teamId,
        batchId: request.params.batchId,
        actor: access.actor,
      });
      return reply.code(result.status).send(result.body);
    },
  );

  app.post<{ Params: { teamId: string } }>(
    '/api/v1/teams/:teamId/draft-batches/jira-handoff',
    async (request, reply) => {
      const access = requireEdit(request.params.teamId, request);
      if (!access.ok) return reply.code(access.status).send({ error: access.error });
      const body = (request.body || {}) as Record<string, unknown>;
      const refs = Array.isArray(body.refs)
        ? body.refs.map((item) => {
            const row = (item || {}) as Record<string, unknown>;
            return {
              itemKey: row.itemKey ? String(row.itemKey) : undefined,
              subId: row.subId ? String(row.subId) : undefined,
            };
          })
        : [];
      const result = declareJiraHandoff(request.params.teamId, refs);
      return reply.code(result.status).send(result.body);
    },
  );
}

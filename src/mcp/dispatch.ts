import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import type { ActorContext } from '../types.js';
import {
  PLANNING_CLIENT_MIN_VERSION,
  PLANNING_CONTRACT_VERSION,
} from '../planning/contracts.js';
import { todayInTimeZone } from '../planning/dates.js';
import {
  cancelJob,
  commitPlan,
  createPlanningJob,
  deletePlanningItem,
  getBatchPayload,
  jobPayload,
  listPlanningItems,
  lookupRequest,
  parsePlanningView,
  planningCapabilities,
  planningContext,
  revisePlan,
  submitStructuredPlan,
  undoPlanningBatch,
  unschedulePlanningItem,
} from '../planning/DraftPlanningService.js';

function uuid(raw: unknown): string {
  const value = String(raw || '').trim();
  return value || randomUUID();
}

function parentKeys(args: Record<string, unknown>): string[] {
  const selection = args.parentSelection as { itemKeys?: unknown } | unknown[] | undefined;
  if (Array.isArray(selection)) return selection.map(String);
  if (Array.isArray(selection?.itemKeys)) return selection.itemKeys.map(String);
  return [];
}

export function dispatchMcpTool(
  teamId: string,
  actor: ActorContext,
  name: string,
  args: Record<string, unknown>,
): { status: number; body: unknown } {
  if (!config.ai.agentAccess) {
    return { status: 403, body: { error: 'agent_access_disabled' } };
  }
  switch (name) {
    case 'roadmap_get_context':
      return {
        status: 200,
        body: {
          contractVersion: PLANNING_CONTRACT_VERSION,
          schemaVersion: '1',
          planningClientMinVersion: PLANNING_CLIENT_MIN_VERSION,
          capabilities: planningCapabilities(),
          context: planningContext(
            teamId,
            Array.isArray(args.itemKeys) ? args.itemKeys.map(String) : undefined,
            parsePlanningView(args.view),
          ),
        },
      };
    case 'roadmap_list_items':
      return {
        status: 200,
        body: listPlanningItems(
          teamId,
          Array.isArray(args.itemKeys) ? args.itemKeys.map(String) : undefined,
          parsePlanningView(args.view),
        ),
      };
    case 'roadmap_validate_plan': {
      const sources = Array.isArray(args.sources)
        ? args.sources.map((item) => {
            const row = (item || {}) as Record<string, unknown>;
            return {
              id: String(row.id || 'paste'),
              title: String(row.title || 'paste'),
              text: String(row.text || ''),
            };
          })
        : [];
      return submitStructuredPlan({
        teamId,
        requestId: uuid(args.requestId),
        sources,
        plan: args.plan,
        referenceDate:
          String(args.referenceDate || '') || todayInTimeZone(Date.now(), 'Asia/Shanghai'),
        planningStart: args.planningStart ? String(args.planningStart) : null,
        timezone: String(args.timezone || 'Asia/Shanghai'),
        quarter: args.quarter ? String(args.quarter) : null,
        parentSelection: { itemKeys: parentKeys(args) },
        actor,
        autoCommit: false,
        decisions: (args.decisions || {}) as Record<string, string>,
      });
    }
    case 'roadmap_revise_plan':
      return revisePlan({
        teamId,
        planId: String(args.planId),
        baseRevision: Number(args.baseRevision),
        changes: (args.changes || {}) as Record<string, unknown>,
      });
    case 'roadmap_generate_plan':
      return createPlanningJob({
        teamId,
        requestId: uuid(args.requestId),
        text: String(args.text || ''),
        referenceDate:
          String(args.referenceDate || '') || todayInTimeZone(Date.now(), 'Asia/Shanghai'),
        planningStart: args.planningStart ? String(args.planningStart) : null,
        timezone: String(args.timezone || 'Asia/Shanghai'),
        quarter: args.quarter ? String(args.quarter) : null,
        parentSelection: { itemKeys: parentKeys(args) },
        configurationVersion: args.configurationVersion
          ? String(args.configurationVersion)
          : null,
        autoCommit: args.autoCommit === true,
        actor,
      });
    case 'roadmap_get_request':
      if (args.jobId) {
        const job = jobPayload(teamId, String(args.jobId));
        return job
          ? { status: 200, body: job }
          : { status: 404, body: { error: 'job_not_found' } };
      }
      return lookupRequest(teamId, String(args.requestId || ''));
    case 'roadmap_cancel_job':
      return cancelJob(teamId, String(args.jobId));
    case 'roadmap_commit_plan':
      return commitPlan({
        teamId,
        planId: String(args.planId),
        requestId: uuid(args.requestId),
        revision: Number(args.revision),
        planHash: String(args.planHash || ''),
        actor,
        decisions: (args.decisions || {}) as Record<string, string>,
        quarter: args.quarter ? String(args.quarter) : null,
      });
    case 'roadmap_get_batch':
      return getBatchPayload(teamId, String(args.batchId));
    case 'roadmap_undo_batch':
      return undoPlanningBatch({ teamId, batchId: String(args.batchId), actor });
    case 'roadmap_delete_item':
      return deletePlanningItem(teamId, actor, String(args.itemKey || ''));
    case 'roadmap_unschedule_item':
      return unschedulePlanningItem(
        teamId,
        actor,
        String(args.itemKey || ''),
        args.baseVersion,
      );
    default:
      return { status: 404, body: { error: `unknown_tool:${name}` } };
  }
}

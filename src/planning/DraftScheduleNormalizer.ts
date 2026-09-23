import type { ItemRow, MemberRow } from '../types.js';
import { looksFullName } from '../core/assigneeMap.js';
import {
  PLANNING_LIMITS,
  type DraftChildPlan,
  type DraftGlobalContext,
  type DraftParentPlan,
  type DraftPlanV1,
  type NormalizedChild,
  type NormalizedDraftPlan,
  type NormalizedNodeSchedule,
  type NormalizedParent,
  type OwnerResolutionResult,
  type ParentPatch,
  type ParentSelection,
  type PlanningIssue,
  type PlanningSource,
} from './contracts.js';
import {
  addDaysIso,
  defaultPlanningStart,
  endFromStart,
  inclusiveDays,
  isIsoDate,
  maxIso,
  minIso,
} from './dates.js';
import { requestHash } from './hash.js';

export interface ScheduleContext {
  teamId: string;
  quarter: string | null;
  referenceDate: string;
  planningStart: string | null;
  timezone: string;
  items: ItemRow[];
  members: MemberRow[];
  parentSelection: ParentSelection;
  planId: string;
  revision: number;
}

export function normalizeDraftPlan(
  plan: DraftPlanV1,
  context: ScheduleContext,
  extraIssues: PlanningIssue[] = [],
): NormalizedDraftPlan {
  const issues: PlanningIssue[] = [...extraIssues];
  const warnings: PlanningIssue[] = [];
  const planningStart =
    context.planningStart && isIsoDate(context.planningStart)
      ? context.planningStart
      : defaultPlanningStart({
          quarter: context.quarter,
          referenceDate: context.referenceDate,
        });

  const selected = new Set(context.parentSelection.itemKeys);
  const parents: NormalizedParent[] = [];
  const ownerResolution: OwnerResolutionResult[] = [];

  for (const parent of plan.parents) {
    const attach = resolveAttach(parent, context.items, selected, issues);
    const children = parent.children.map((child) =>
      normalizeChild(child, planningStart, context.members, ownerResolution, warnings),
    );
    applyDependencies(children, issues);
    const schedule = normalizeParentSchedule(parent, children, planningStart, attach.item);
    const description = materializeDescription(
      parent,
      plan.globalContext,
      attach.item,
      issues,
    );
    const parentPatches: ParentPatch[] = [];
    let scheduleParent = false;
    if (attach.item) {
      if (!attach.item.scheduled) {
        issues.push({
          code: 'schedule_parent',
          severity: 'decision',
          ref: parent.ref,
          decisionId: `schedule-parent:${attach.item.key}`,
          message: `父任务「${attach.item.title}」仍在 Backlog，需要同时排入甘特才能声称本批已进入时间轴`,
          options: [
            { id: 'schedule', label: '同时将此父项排入甘特' },
            { id: 'keep_backlog', label: '只保留 Backlog 草稿，不进入甘特' },
          ],
        });
        scheduleParent = false;
      } else if (!childrenFit(schedule, attach.item, children)) {
        issues.push({
          code: 'date_conflict',
          severity: 'decision',
          ref: parent.ref,
          decisionId: `fit-parent:${attach.item.key}`,
          message: '子任务窗口超出已有父任务排期',
          options: [
            { id: 'shrink_children', label: '调整本批子任务排期以落入父窗口' },
            { id: 'extend_parent', label: '显式延长父窗口' },
          ],
        });
      }
      if (
        !attach.item.jira_key &&
        needsOverallAppend(attach.item.description, plan.globalContext)
      ) {
        const after = appendOverall(attach.item.description || '', plan.globalContext);
        if (after.length > PLANNING_LIMITS.maxDescriptionChars) {
          issues.push({
            code: 'description_overflow',
            severity: 'decision',
            ref: parent.ref,
            message: '补充整体背景后父描述超限，请缩短或拆分',
          });
        } else if (!(attach.item.description || '').trim()) {
          parentPatches.push({
            itemKey: attach.item.key,
            baseVersion: attach.item.version,
            field: 'description',
            before: attach.item.description,
            after,
            reason: '空描述自动补充文档级背景、里程碑与风险',
            decisionId: `append-overall:${attach.item.key}`,
          });
        } else {
          parentPatches.push({
            itemKey: attach.item.key,
            baseVersion: attach.item.version,
            field: 'description',
            before: attach.item.description,
            after,
            reason: '补充文档级背景、里程碑与风险',
            decisionId: `append-overall:${attach.item.key}`,
          });
          issues.push({
            code: 'schedule_parent',
            severity: 'decision',
            ref: parent.ref,
            decisionId: `append-overall:${attach.item.key}`,
            message: '现有 Draft 父描述缺少整体背景，将追加补丁',
            options: [
              { id: 'apply', label: '追加整体背景' },
              { id: 'skip', label: '保持现有描述' },
            ],
          });
        }
      } else if (attach.item.jira_key && needsOverallAppend(attach.item.description, plan.globalContext)) {
        warnings.push({
          code: 'invalid_plan',
          severity: 'warning',
          ref: parent.ref,
          message: '已有 Jira 父任务描述与文档整体背景存在差异，本路径不会改写父描述',
        });
      }
    }

    parents.push({
      ref: parent.ref,
      action: attach.action,
      existingItemKey: attach.item?.key || null,
      title: parent.title.trim(),
      description,
      schedule,
      children,
      evidence: parent.evidence,
      parentPatches,
      scheduleParent,
    });
  }

  const normalized: NormalizedDraftPlan = {
    planId: context.planId,
    revision: context.revision,
    hash: '',
    schemaVersion: '1',
    documentTitle: plan.documentTitle,
    globalContext: plan.globalContext,
    parents,
    assumptions: plan.assumptions,
    ownerResolution,
    warnings: [...warnings, ...issues.filter((issue) => issue.severity === 'warning')],
    issues: issues.filter((issue) => issue.severity !== 'warning'),
    contextFingerprint: requestHash({
      itemVersions: context.items.map((item) => ({
        key: item.key,
        version: item.version,
        scheduled: item.scheduled,
        start: item.start_date,
        days: item.days,
        jiraKey: item.jira_key,
      })),
      members: context.members.map((m) => m.name),
    }),
  };
  normalized.hash = requestHash({
    planId: normalized.planId,
    revision: normalized.revision,
    parents: normalized.parents,
    assumptions: normalized.assumptions,
  });
  return normalized;
}

function resolveAttach(
  parent: DraftParentPlan,
  items: ItemRow[],
  selected: Set<string>,
  issues: PlanningIssue[],
): { action: 'create' | 'attach'; item: ItemRow | null } {
  if (parent.action === 'attach' || parent.existingItemKey) {
    const key = parent.existingItemKey || '';
    const item = items.find((row) => row.key === key) || null;
    if (!item || (selected.size && !selected.has(key) && !itemMatchesTitle(item, parent.title))) {
      const candidates = items.filter((row) => itemMatchesTitle(row, parent.title));
      if (!item && !candidates.length) {
        issues.push({
          code: 'unknown_ref',
          severity: 'error',
          ref: parent.ref,
          message: `找不到要复用的父任务 ${key || parent.title}`,
        });
        return { action: 'attach', item: null };
      }
      issues.push({
        code: 'ambiguous_parent',
        severity: 'decision',
        ref: parent.ref,
        message: item
          ? '指定的父任务不在本次授权范围内'
          : candidates.length
            ? '存在多个同名父任务，需要选择'
            : '找不到要复用的父任务',
        options: candidates.map((row) => ({
          id: row.key,
          label: `${row.title} (${row.key})`,
        })),
      });
      return { action: 'attach', item: null };
    }
    return { action: 'attach', item };
  }
  const matches = items.filter((row) => itemMatchesTitle(row, parent.title));
  if (matches.length === 1 && (selected.size === 0 || selected.has(matches[0].key))) {
    return { action: 'attach', item: matches[0] };
  }
  if (matches.length > 1) {
    issues.push({
      code: 'ambiguous_parent',
      severity: 'decision',
      ref: parent.ref,
      message: '同名父任务不唯一，不能自动复用',
      options: matches.map((row) => ({
        id: row.key,
        label: `${row.title} (${row.key})`,
      })),
    });
  }
  return { action: 'create', item: null };
}

function itemMatchesTitle(item: ItemRow, title: string): boolean {
  return normalizeTitle(item.title) === normalizeTitle(title);
}

export function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeChild(
  child: DraftChildPlan,
  planningStart: string,
  members: MemberRow[],
  ownerResolution: OwnerResolutionResult[],
  warnings: PlanningIssue[],
): NormalizedChild {
  const owner = resolveOwner(child, members, ownerResolution, warnings);
  return {
    ref: child.ref,
    title: child.title.trim(),
    description: child.description,
    owner: owner.owner,
    ownerCandidates: child.ownerCandidates,
    ownerResolution: owner.resolution,
    schedule: normalizeNodeSchedule(child.schedule, planningStart),
    dependsOnRefs: child.dependsOnRefs,
    evidence: child.evidence,
  };
}

function resolveOwner(
  child: DraftChildPlan,
  members: MemberRow[],
  ownerResolution: OwnerResolutionResult[],
  warnings: PlanningIssue[],
): OwnerResolutionResult {
  const candidates = uniqueNames([
    ...child.ownerCandidates,
    ...(child.owner ? [child.owner] : []),
  ]);
  if (candidates.length > 1) {
    const result: OwnerResolutionResult = {
      ref: child.ref,
      owner: null,
      ownerCandidates: candidates,
      resolution: 'ambiguous',
    };
    ownerResolution.push(result);
    warnings.push({
      code: 'invalid_plan',
      severity: 'warning',
      ref: child.ref,
      message: `多人负责人保留候选：${candidates.join(' / ')}`,
    });
    return result;
  }
  const raw = candidates[0] || '';
  if (!raw || /^(tbd|n\/a|未知|待定)$/i.test(raw)) {
    const result: OwnerResolutionResult = {
      ref: child.ref,
      owner: null,
      ownerCandidates: [],
      resolution: 'unassigned',
    };
    ownerResolution.push(result);
    return result;
  }
  const matches = members.filter(
    (member) => member.name.trim().toLowerCase() === raw.toLowerCase(),
  );
  if (matches.length === 1) {
    const result: OwnerResolutionResult = {
      ref: child.ref,
      owner: matches[0].name,
      ownerCandidates: [matches[0].name],
      resolution: 'explicit',
    };
    ownerResolution.push(result);
    return result;
  }
  if (looksFullName(raw) || /^[A-Za-z][A-Za-z .'-]*$/.test(raw) || /[\u4e00-\u9fff]/.test(raw)) {
    const result: OwnerResolutionResult = {
      ref: child.ref,
      owner: raw,
      ownerCandidates: [raw],
      resolution: 'explicit',
      createdMember: !matches.length,
    };
    ownerResolution.push(result);
    return result;
  }
  const result: OwnerResolutionResult = {
    ref: child.ref,
    owner: null,
    ownerCandidates: [raw],
    resolution: 'unassigned',
  };
  ownerResolution.push(result);
  warnings.push({
    code: 'invalid_plan',
    severity: 'warning',
    ref: child.ref,
    message: `无法确认负责人「${raw}」，保持待分配`,
  });
  return result;
}

function normalizeNodeSchedule(
  schedule: DraftChildPlan['schedule'],
  planningStart: string,
): NormalizedNodeSchedule {
  const explicitStart = schedule.start && isIsoDate(schedule.start) ? schedule.start : null;
  const explicitEnd = schedule.end && isIsoDate(schedule.end) ? schedule.end : null;
  let start = explicitStart;
  let end = explicitEnd;
  let days: number = PLANNING_LIMITS.placeholderDays;
  let basis = schedule.basis;
  if (start && end) {
    days = inclusiveDays(start, end);
    basis = 'explicit';
  } else if (start && !end) {
    days = PLANNING_LIMITS.placeholderDays;
    end = endFromStart(start, days);
    basis = schedule.basis === 'explicit' ? 'explicit' : 'inferred';
  } else if (!start && end) {
    days = PLANNING_LIMITS.placeholderDays;
    start = addDaysIso(end, -(days - 1));
    basis = schedule.basis === 'explicit' ? 'explicit' : 'inferred';
  } else {
    start = planningStart;
    days = PLANNING_LIMITS.placeholderDays;
    end = endFromStart(start, days);
    basis = 'missing';
  }
  const writeTargetDates = Boolean(explicitStart || explicitEnd);
  return {
    start,
    days,
    end,
    basis,
    scheduled: true,
    writeTargetDates,
    targetStart: explicitStart,
    targetEnd: explicitEnd,
  };
}

function applyDependencies(
  children: NormalizedChild[],
  issues: PlanningIssue[],
): void {
  const byRef = new Map(children.map((child) => [child.ref, child]));
  for (const child of children) {
    for (const depRef of child.dependsOnRefs) {
      const dep = byRef.get(depRef);
      if (!dep) continue;
      const nextStart = addDaysIso(dep.schedule.end, 1);
      if (child.schedule.basis === 'missing' || child.schedule.start < nextStart) {
        if (child.schedule.basis === 'explicit' && child.schedule.start < nextStart) {
          issues.push({
            code: 'date_conflict',
            severity: 'error',
            ref: child.ref,
            message: `无法在依赖 ${depRef} 完成后的硬截止内保持原日期`,
          });
          continue;
        }
        const days = child.schedule.days;
        child.schedule.start = nextStart;
        child.schedule.end = endFromStart(nextStart, days);
        if (child.schedule.basis === 'missing') child.schedule.basis = 'inferred';
      }
    }
  }
}

function normalizeParentSchedule(
  parent: DraftParentPlan,
  children: NormalizedChild[],
  planningStart: string,
  existing: ItemRow | null,
): NormalizedNodeSchedule {
  if (parent.schedule.start || parent.schedule.end) {
    return normalizeNodeSchedule(parent.schedule, planningStart);
  }
  if (children.length) {
    const start = children.reduce(
      (acc, child) => minIso(acc, child.schedule.start),
      children[0].schedule.start,
    );
    const end = children.reduce(
      (acc, child) => maxIso(acc, child.schedule.end),
      children[0].schedule.end,
    );
    return {
      start,
      end,
      days: inclusiveDays(start, end),
      basis: 'inferred',
      scheduled: true,
      writeTargetDates: false,
      targetStart: null,
      targetEnd: null,
    };
  }
  if (existing?.scheduled && existing.start_date && existing.days) {
    return {
      start: existing.start_date,
      days: existing.days,
      end: endFromStart(existing.start_date, existing.days),
      basis: 'explicit',
      scheduled: true,
      writeTargetDates: false,
      targetStart: existing.target_start,
      targetEnd: existing.target_end,
    };
  }
  return normalizeNodeSchedule(parent.schedule, planningStart);
}

function childrenFit(
  parentSchedule: NormalizedNodeSchedule,
  existing: ItemRow,
  children: NormalizedChild[],
): boolean {
  if (!existing.scheduled || !existing.start_date || !existing.days) return true;
  const start = existing.start_date;
  const end = endFromStart(existing.start_date, existing.days);
  return children.every(
    (child) => child.schedule.start >= start && child.schedule.end <= end,
  ) && parentSchedule.start >= start && parentSchedule.end <= end;
}

export function materializeDescription(
  parent: DraftParentPlan,
  global: DraftGlobalContext,
  existing: ItemRow | null,
  issues: PlanningIssue[],
): string {
  if (existing) return existing.description || parent.description;
  const text = appendOverall(parent.description, global);
  if (text.length <= PLANNING_LIMITS.maxDescriptionChars) return text;
  const compact = compactOverall(parent.description, global);
  if (compact.length <= PLANNING_LIMITS.maxDescriptionChars) return compact;
  issues.push({
    code: 'description_overflow',
    severity: 'decision',
    ref: parent.ref,
    message: '主任务描述加上整体背景后仍超过 2000 字符',
  });
  return compact.slice(0, PLANNING_LIMITS.maxDescriptionChars);
}

export function appendOverall(base: string, global: DraftGlobalContext): string {
  const parts = [base.trim()];
  const overall = formatOverall(global);
  if (overall && !base.includes('【整体背景与约束】')) parts.push(overall);
  return parts.filter(Boolean).join('\n\n').trim();
}

function compactOverall(base: string, global: DraftGlobalContext): string {
  const background = collapse(global.background, 400);
  const constraints = global.constraints.map((item) => collapse(item, 80)).join('；');
  const milestones = global.milestones
    .map((item) => `${item.label}${item.date ? ` ${item.date}` : ''}${item.approximate ? '（约）' : ''}`)
    .join('；');
  const risks = global.risks.map((item) => collapse(item, 80)).join('；');
  return [
    collapse(base, 800),
    background ? `【整体背景与约束】${background}` : '',
    constraints ? `边界：${constraints}` : '',
    milestones ? `【里程碑】${milestones}` : '',
    risks ? `【风险】${risks}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function formatOverall(global: DraftGlobalContext): string {
  const blocks: string[] = [];
  const bg = [
    global.background.trim(),
    ...global.constraints.map((item) => `- ${item}`),
  ]
    .filter(Boolean)
    .join('\n');
  if (bg) blocks.push(`【整体背景与约束】\n${bg}`);
  if (global.milestones.length) {
    blocks.push(
      `【里程碑】\n${global.milestones
        .map(
          (item) =>
            `- ${item.label}${item.date ? `：${item.date}` : ''}${item.approximate ? '（约）' : ''}`,
        )
        .join('\n')}`,
    );
  }
  if (global.risks.length) {
    blocks.push(`【风险】\n${global.risks.map((item) => `- ${item}`).join('\n')}`);
  }
  return blocks.join('\n\n');
}

function needsOverallAppend(
  description: string | null,
  global: DraftGlobalContext,
): boolean {
  const text = description || '';
  if (text.includes('【整体背景与约束】')) return false;
  return Boolean(global.background || global.milestones.length || global.risks.length);
}

function uniqueNames(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    for (const part of String(value)
      .split(/\s*(?:\/|&| and |、)\s*/i)
      .map((item) => item.trim())
      .filter(Boolean)) {
      const key = part.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(part);
    }
  }
  return out;
}

function collapse(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

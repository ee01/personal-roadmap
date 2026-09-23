import {
  FORBIDDEN_PLAN_KEYS,
  PLANNING_LIMITS,
  type DraftChildPlan,
  type DraftEvidence,
  type DraftGlobalContext,
  type DraftParentPlan,
  type DraftPlanV1,
  type DraftSchedule,
  type PlanningIssue,
  type PlanningSource,
} from './contracts.js';
import { isIsoDate } from './dates.js';
import { utf8Bytes } from './hash.js';

const REF = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export interface ValidatePlanInput {
  plan: unknown;
  sources: PlanningSource[];
  verbatim?: boolean;
}

export interface ValidatePlanResult {
  ok: boolean;
  plan?: DraftPlanV1;
  issues: PlanningIssue[];
}

export function validateSources(sources: PlanningSource[]): PlanningIssue[] {
  const issues: PlanningIssue[] = [];
  if (!Array.isArray(sources) || sources.length === 0) {
    issues.push({
      code: 'invalid_plan',
      severity: 'error',
      message: '至少需要一个来源文本',
    });
    return issues;
  }
  const ids = new Set<string>();
  let chars = 0;
  let bytes = 0;
  for (const source of sources) {
    const id = String(source?.id || '').trim();
    const text = String(source?.text || '');
    if (!id || ids.has(id)) {
      issues.push({
        code: 'invalid_plan',
        severity: 'error',
        message: '来源 id 必须批内唯一',
      });
    }
    ids.add(id);
    chars += text.length;
    bytes += utf8Bytes(text);
  }
  if (chars > PLANNING_LIMITS.maxInputChars || bytes > PLANNING_LIMITS.maxInputBytes) {
    issues.push({
      code: 'input_too_large',
      severity: 'error',
      message: `输入超过 ${PLANNING_LIMITS.maxInputChars} 字符或 128KiB`,
    });
  }
  return issues;
}

export function validateDraftPlan(input: ValidatePlanInput): ValidatePlanResult {
  const issues: PlanningIssue[] = [...validateSources(input.sources)];
  const extra = collectForbiddenKeys(input.plan);
  if (extra.length) {
    issues.push({
      code: 'invalid_plan',
      severity: 'error',
      message: `计划包含禁止字段：${extra.join(', ')}`,
    });
  }
  const plan = parsePlan(input.plan, issues);
  if (!plan) return { ok: false, issues };

  const refs = new Set<string>();
  let nodeCount = 0;
  if (plan.parents.length > PLANNING_LIMITS.maxParents) {
    issues.push({
      code: 'limit_exceeded',
      severity: 'error',
      message: `主任务不能超过 ${PLANNING_LIMITS.maxParents} 个`,
    });
  }
  for (const parent of plan.parents) {
    nodeCount += 1 + parent.children.length;
    addRef(parent.ref, refs, issues, parent.ref);
    checkTitle(parent.title, parent.ref, issues);
    checkDescription(parent.description, parent.ref, input.verbatim, issues);
    checkSchedule(parent.schedule, parent.ref, issues);
    checkEvidence(parent.evidence, input.sources, parent.ref, issues);
    if (parent.action === 'attach' && !parent.existingItemKey) {
      issues.push({
        code: 'invalid_plan',
        severity: 'error',
        ref: parent.ref,
        message: 'attach 必须提供 existingItemKey',
      });
    }
    if (parent.action === 'create' && parent.existingItemKey) {
      issues.push({
        code: 'invalid_plan',
        severity: 'error',
        ref: parent.ref,
        message: 'create 不能携带 existingItemKey',
      });
    }
    for (const child of parent.children) {
      addRef(child.ref, refs, issues, child.ref);
      checkTitle(child.title, child.ref, issues);
      checkDescription(child.description, child.ref, input.verbatim, issues);
      checkSchedule(child.schedule, child.ref, issues);
      checkEvidence(child.evidence, input.sources, child.ref, issues);
      if (child.owner && child.ownerCandidates.length > 1) {
        issues.push({
          code: 'invalid_plan',
          severity: 'error',
          ref: child.ref,
          message: '多人候选时 owner 必须为空',
        });
      }
    }
  }
  if (nodeCount > PLANNING_LIMITS.maxNodes) {
    issues.push({
      code: 'limit_exceeded',
      severity: 'error',
      message: `父子合计不能超过 ${PLANNING_LIMITS.maxNodes} 个节点`,
    });
  }
  if (nodeCount === 0) {
    issues.push({
      code: 'no_actionable_content',
      severity: 'decision',
      message: '没有可执行的主任务或子任务',
    });
  }

  const allChildRefs = new Set(
    plan.parents.flatMap((p) => p.children.map((c) => c.ref)),
  );
  for (const parent of plan.parents) {
    for (const child of parent.children) {
      for (const dep of child.dependsOnRefs) {
        if (!allChildRefs.has(dep) && !refs.has(dep)) {
          issues.push({
            code: 'unknown_ref',
            severity: 'error',
            ref: child.ref,
            message: `未知依赖 ${dep}`,
          });
        }
        if (dep === child.ref) {
          issues.push({
            code: 'dependency_cycle',
            severity: 'error',
            ref: child.ref,
            message: '不能依赖自身',
          });
        }
      }
    }
  }
  if (hasCycle(plan)) {
    issues.push({
      code: 'dependency_cycle',
      severity: 'error',
      message: '依赖存在环路',
    });
  }

  const blocking = issues.some((issue) => issue.severity === 'error');
  return { ok: !blocking, plan, issues };
}

function parsePlan(raw: unknown, issues: PlanningIssue[]): DraftPlanV1 | null {
  if (!raw || typeof raw !== 'object') {
    issues.push({ code: 'invalid_plan', severity: 'error', message: '计划必须是对象' });
    return null;
  }
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== '1') {
    issues.push({
      code: 'invalid_plan',
      severity: 'error',
      message: '不支持的 schemaVersion',
    });
    return null;
  }
  const global = parseGlobal(value.globalContext, issues);
  const parents = Array.isArray(value.parents)
    ? value.parents.map((item, index) => parseParent(item, index, issues))
    : [];
  if (!Array.isArray(value.parents)) {
    issues.push({ code: 'invalid_plan', severity: 'error', message: 'parents 必须是数组' });
  }
  const assumptions = Array.isArray(value.assumptions)
    ? value.assumptions
        .map((item) => parseAssumption(item))
        .filter((item): item is DraftPlanV1['assumptions'][number] => Boolean(item))
    : [];
  return {
    schemaVersion: '1',
    documentTitle: String(value.documentTitle || '').trim() || '未命名需求',
    globalContext: global,
    parents: parents.filter((item): item is DraftParentPlan => Boolean(item)),
    assumptions,
  };
}

function parseGlobal(raw: unknown, issues: PlanningIssue[]): DraftGlobalContext {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    background: String(value.background || ''),
    constraints: asStringArray(value.constraints),
    milestones: Array.isArray(value.milestones)
      ? value.milestones.map((item) => {
          const row = (item && typeof item === 'object' ? item : {}) as Record<
            string,
            unknown
          >;
          const date = row.date == null || row.date === '' ? null : String(row.date);
          if (date && !isIsoDate(date)) {
            issues.push({
              code: 'invalid_plan',
              severity: 'error',
              message: `里程碑日期非法：${date}`,
            });
          }
          return {
            label: String(row.label || '').trim(),
            date,
            approximate: Boolean(row.approximate),
          };
        })
      : [],
    risks: asStringArray(value.risks),
  };
}

function parseParent(
  raw: unknown,
  index: number,
  issues: PlanningIssue[],
): DraftParentPlan | null {
  if (!raw || typeof raw !== 'object') {
    issues.push({
      code: 'invalid_plan',
      severity: 'error',
      message: `parents[${index}] 不是对象`,
    });
    return null;
  }
  const value = raw as Record<string, unknown>;
  const action = value.action === 'attach' ? 'attach' : value.action === 'create' ? 'create' : null;
  if (!action) {
    issues.push({
      code: 'invalid_plan',
      severity: 'error',
      message: `parents[${index}].action 必须是 create 或 attach`,
    });
    return null;
  }
  const children = Array.isArray(value.children)
    ? value.children
        .map((item, childIndex) => parseChild(item, index, childIndex, issues))
        .filter((item): item is DraftChildPlan => Boolean(item))
    : [];
  return {
    ref: String(value.ref || ''),
    action,
    existingItemKey: value.existingItemKey ? String(value.existingItemKey) : null,
    title: String(value.title || ''),
    description: String(value.description || ''),
    children,
    schedule: parseSchedule(value.schedule, issues, String(value.ref || `p${index}`)),
    evidence: parseEvidence(value.evidence),
  };
}

function parseChild(
  raw: unknown,
  parentIndex: number,
  childIndex: number,
  issues: PlanningIssue[],
): DraftChildPlan | null {
  if (!raw || typeof raw !== 'object') {
    issues.push({
      code: 'invalid_plan',
      severity: 'error',
      message: `parents[${parentIndex}].children[${childIndex}] 不是对象`,
    });
    return null;
  }
  const value = raw as Record<string, unknown>;
  return {
    ref: String(value.ref || ''),
    title: String(value.title || ''),
    description: String(value.description || ''),
    ownerCandidates: asStringArray(value.ownerCandidates),
    owner: value.owner == null || value.owner === '' ? null : String(value.owner),
    schedule: parseSchedule(value.schedule, issues, String(value.ref || `c${childIndex}`)),
    dependsOnRefs: asStringArray(value.dependsOnRefs),
    evidence: parseEvidence(value.evidence),
  };
}

function parseSchedule(raw: unknown, issues: PlanningIssue[], ref: string): DraftSchedule {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const start = emptyToNull(value.start);
  const end = emptyToNull(value.end);
  const basis =
    value.basis === 'explicit' || value.basis === 'inferred' || value.basis === 'missing'
      ? value.basis
      : start || end
        ? 'inferred'
        : 'missing';
  if (start && !isIsoDate(start)) {
    issues.push({ code: 'invalid_plan', severity: 'error', ref, message: `非法开始日期 ${start}` });
  }
  if (end && !isIsoDate(end)) {
    issues.push({ code: 'invalid_plan', severity: 'error', ref, message: `非法结束日期 ${end}` });
  }
  if (start && end && start > end) {
    issues.push({ code: 'date_conflict', severity: 'error', ref, message: '开始日期晚于结束日期' });
  }
  return { start, end, basis };
}

function parseEvidence(raw: unknown): DraftEvidence[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const row = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
      const sourceId = String(row.sourceId || '').trim();
      const quote = String(row.quote || '');
      if (!sourceId || !quote) return null;
      return { sourceId, quote };
    })
    .filter((item): item is DraftEvidence => Boolean(item));
}

function parseAssumption(raw: unknown): DraftPlanV1['assumptions'][number] | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const ref = String(value.ref || '').trim();
  const field = String(value.field || '').trim();
  const reason = String(value.reason || '').trim();
  if (!ref || !field || !reason) return null;
  return { ref, field, reason };
}

function addRef(
  ref: string,
  refs: Set<string>,
  issues: PlanningIssue[],
  at: string,
): void {
  if (!REF.test(ref)) {
    issues.push({
      code: 'invalid_plan',
      severity: 'error',
      ref: at,
      message: `非法 ref：${ref}`,
    });
    return;
  }
  if (refs.has(ref)) {
    issues.push({
      code: 'invalid_plan',
      severity: 'error',
      ref,
      message: `重复 ref：${ref}`,
    });
  }
  refs.add(ref);
}

function checkTitle(title: string, ref: string, issues: PlanningIssue[]): void {
  const text = title.trim();
  if (!text) {
    issues.push({ code: 'invalid_plan', severity: 'error', ref, message: '标题不能为空' });
  }
  if (text.length > PLANNING_LIMITS.maxTitleChars) {
    issues.push({
      code: 'limit_exceeded',
      severity: 'error',
      ref,
      message: `标题超过 ${PLANNING_LIMITS.maxTitleChars} 字符`,
    });
  }
}

function checkDescription(
  description: string,
  ref: string,
  verbatim: boolean | undefined,
  issues: PlanningIssue[],
): void {
  if (description.length <= PLANNING_LIMITS.maxDescriptionChars) return;
  issues.push({
    code: 'description_overflow',
    severity: verbatim ? 'decision' : 'error',
    ref,
    message: `描述超过 ${PLANNING_LIMITS.maxDescriptionChars} 字符，不能静默截断`,
  });
}

function checkSchedule(
  schedule: DraftSchedule,
  ref: string,
  issues: PlanningIssue[],
): void {
  if (schedule.start && schedule.end && schedule.start > schedule.end) {
    issues.push({
      code: 'date_conflict',
      severity: 'error',
      ref,
      message: '开始日期晚于结束日期',
    });
  }
}

function checkEvidence(
  evidence: DraftEvidence[],
  sources: PlanningSource[],
  ref: string,
  issues: PlanningIssue[],
): void {
  const byId = new Map(sources.map((source) => [source.id, source.text]));
  for (const item of evidence) {
    if (item.quote.length > PLANNING_LIMITS.maxQuoteChars) {
      issues.push({
        code: 'invalid_plan',
        severity: 'error',
        ref,
        message: '引用过长',
      });
    }
    const text = byId.get(item.sourceId);
    if (text == null) {
      issues.push({
        code: 'evidence_mismatch',
        severity: 'error',
        ref,
        message: `未知来源 ${item.sourceId}`,
      });
      continue;
    }
    if (!text.includes(item.quote)) {
      issues.push({
        code: 'evidence_mismatch',
        severity: 'error',
        ref,
        message: '引用无法在来源原文中匹配',
      });
    }
  }
}

function hasCycle(plan: DraftPlanV1): boolean {
  const edges = new Map<string, string[]>();
  for (const parent of plan.parents) {
    for (const child of parent.children) {
      edges.set(child.ref, [...(edges.get(child.ref) || []), ...child.dependsOnRefs]);
    }
  }
  const visiting = new Set<string>();
  const seen = new Set<string>();
  const walk = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (seen.has(node)) return false;
    visiting.add(node);
    for (const next of edges.get(node) || []) {
      if (walk(next)) return true;
    }
    visiting.delete(node);
    seen.add(node);
    return false;
  };
  return [...edges.keys()].some(walk);
}

function collectForbiddenKeys(value: unknown, path = ''): string[] {
  const found: string[] = [];
  const walk = (node: unknown, here: string) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${here}[${index}]`));
      return;
    }
    for (const [key, nested] of Object.entries(node as Record<string, unknown>)) {
      if ((FORBIDDEN_PLAN_KEYS as readonly string[]).includes(key)) {
        found.push(here ? `${here}.${key}` : key);
      }
      walk(nested, here ? `${here}.${key}` : key);
    }
  };
  walk(value, path);
  return found;
}

function asStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => String(item || '').trim()).filter(Boolean);
}

function emptyToNull(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

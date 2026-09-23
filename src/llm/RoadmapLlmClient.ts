import { PLANNING_LIMITS, type DraftPlanV1, type PlanningSource } from '../planning/contracts.js';

export interface LlmGenerateInput {
  sources: PlanningSource[];
  referenceDate: string;
  planningStart: string;
  timezone: string;
  quarter: string | null;
  parentHints: Array<{ key: string; title: string; scheduled: boolean }>;
  members: string[];
  signal?: AbortSignal;
}

export interface LlmGenerateResult {
  plan: DraftPlanV1;
  usage: { inputTokens: number; outputTokens: number };
  truncated: boolean;
  refused: boolean;
  model: string;
  provider: string;
}

export type LlmGenerator = (input: LlmGenerateInput) => Promise<LlmGenerateResult>;

let testGenerator: LlmGenerator | null = null;

export function setRoadmapLlmGeneratorForTests(generator: LlmGenerator | null): void {
  testGenerator = generator;
}

export async function generateDraftPlan(
  input: LlmGenerateInput,
): Promise<LlmGenerateResult> {
  if (testGenerator) return testGenerator(input);
  const { config } = await import('../config.js');
  if (!config.ai.enabled) {
    throw Object.assign(new Error('provider_unconfigured'), {
      errorCode: 'provider_unconfigured',
    });
  }
  const { generateWithClaude, generateWithOpenAi } = await import('./adapters.js');
  if (config.ai.provider === 'claude') return generateWithClaude(input);
  return generateWithOpenAi(input);
}

export function buildPlanningPrompt(input: LlmGenerateInput): {
  system: string;
  user: string;
} {
  return {
    system: [
      'You convert planning documents into DraftPlanV1 JSON.',
      'schemaVersion must be "1". Only two levels: parents and children.',
      'Do not invent teamId, jiraKey, source, SQL, intents, tokens, or database ids.',
      'existingItemKey is allowed only when it exactly matches a provided parent hint key.',
      'Preserve unresolved choices such as “RCCC 还是 Telco”; do not pick a side.',
      'Multi-person owners stay in ownerCandidates with owner=null. TBD/未知 stay unassigned.',
      'Copy ticket descriptions, links, dependencies and notes into child.description.',
      'Put document-level background, constraints, milestones and risks into globalContext.',
      'Quotes in evidence must be exact substrings of the chosen source.',
      `Limits: title ${PLANNING_LIMITS.maxTitleChars}, description ${PLANNING_LIMITS.maxDescriptionChars}, parents ${PLANNING_LIMITS.maxParents}, nodes ${PLANNING_LIMITS.maxNodes}.`,
      'If there is no actionable work, return parents:[].',
      'Dates YYYY-MM-DD. Relative dates use the provided referenceDate and timezone.',
    ].join(' '),
    user: JSON.stringify({
      referenceDate: input.referenceDate,
      planningStart: input.planningStart,
      timezone: input.timezone,
      quarter: input.quarter,
      parentHints: input.parentHints,
      members: input.members,
      sources: input.sources.map((source) => ({
        id: source.id,
        title: source.title,
        text: source.text,
      })),
    }),
  };
}

export const MCP_PROTOCOL_VERSION = '2025-03-26';
export const MCP_SERVER_NAME = 'roadmap-planning';
export const MCP_SERVER_VERSION = '1.2.0';

export const MCP_TOOL_NAMES = [
  'roadmap_get_context',
  'roadmap_list_items',
  'roadmap_validate_plan',
  'roadmap_revise_plan',
  'roadmap_generate_plan',
  'roadmap_get_request',
  'roadmap_cancel_job',
  'roadmap_commit_plan',
  'roadmap_get_batch',
  'roadmap_undo_batch',
  'roadmap_delete_item',
  'roadmap_unschedule_item',
  'roadmap_add_item',
] as const;

export const MCP_TOOLS = [
  {
    name: 'roadmap_get_context',
    description:
      'Read the bound team planning context: limits, candidate parents, members, versions. Each item has view=gantt|backlog (scheduled vs unscheduled) and parentLink (INIT issue key, or null). Optional view filter. Does not write Draft or call the server LLM. Team is bound by X-Team-Id / X-Share-Token headers on the MCP HTTP connection.',
    inputSchema: {
      type: 'object',
      properties: {
        itemKeys: { type: 'array', items: { type: 'string' } },
        view: { type: 'string', enum: ['gantt', 'backlog', 'all'] },
      },
    },
  },
  {
    name: 'roadmap_list_items',
    description:
      'List parent items grouped by Gantt vs Backlog. view=gantt (scheduled on the chart), view=backlog (unscheduled), or view=all (default, returns both arrays). Each item includes parentLink (INIT issue key, or null). Does not write.',
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: ['gantt', 'backlog', 'all'] },
        itemKeys: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'roadmap_validate_plan',
    description:
      'Submit a DraftPlanV1 structured plan for validation/normalization. Saves a pending revision. No Draft/Jira writes and no server LLM cost. autoCommit is always false.',
    inputSchema: {
      type: 'object',
      required: ['requestId', 'sources', 'plan', 'referenceDate'],
      properties: {
        requestId: { type: 'string' },
        sources: { type: 'array' },
        plan: { type: 'object' },
        referenceDate: { type: 'string' },
        planningStart: { type: 'string' },
        timezone: { type: 'string' },
        quarter: { type: 'string' },
        parentSelection: { type: 'object' },
      },
    },
  },
  {
    name: 'roadmap_revise_plan',
    description: 'Revise a saved plan revision and re-validate. Does not write Draft.',
    inputSchema: {
      type: 'object',
      required: ['planId', 'baseRevision'],
      properties: {
        planId: { type: 'string' },
        baseRevision: { type: 'number' },
        changes: { type: 'object' },
      },
    },
  },
  {
    name: 'roadmap_generate_plan',
    description:
      'Explicitly delegate parsing to the Roadmap server LLM. Consumes server quota. Defaults to autoCommit=false.',
    inputSchema: {
      type: 'object',
      required: ['requestId', 'text', 'referenceDate'],
      properties: {
        requestId: { type: 'string' },
        text: { type: 'string' },
        referenceDate: { type: 'string' },
        planningStart: { type: 'string' },
        timezone: { type: 'string' },
        quarter: { type: 'string' },
        parentSelection: { type: 'object' },
        autoCommit: { type: 'boolean' },
      },
    },
  },
  {
    name: 'roadmap_get_request',
    description: 'Look up a generate/validate/commit result by requestId or jobId for timeout recovery.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string' },
        jobId: { type: 'string' },
      },
    },
  },
  {
    name: 'roadmap_cancel_job',
    description:
      'Cancel a generation job that has not committed. If already committed, returns the receipt instead of pretending it was undone.',
    inputSchema: {
      type: 'object',
      required: ['jobId'],
      properties: { jobId: { type: 'string' } },
    },
  },
  {
    name: 'roadmap_commit_plan',
    description: 'Atomically write Draft items from a fixed plan revision/hash. Jira issue creation is out of scope.',
    inputSchema: {
      type: 'object',
      required: ['planId', 'requestId', 'revision', 'planHash'],
      properties: {
        planId: { type: 'string' },
        requestId: { type: 'string' },
        revision: { type: 'number' },
        planHash: { type: 'string' },
        decisions: { type: 'object' },
        quarter: { type: 'string' },
      },
    },
  },
  {
    name: 'roadmap_get_batch',
    description: 'Read a committed batch receipt and Roadmap URL (never includes the edit token).',
    inputSchema: {
      type: 'object',
      required: ['batchId'],
      properties: { batchId: { type: 'string' } },
    },
  },
  {
    name: 'roadmap_undo_batch',
    description:
      'Undo a whole Draft generation batch. Not for a single item. For one Draft parent use roadmap_delete_item. Rows that already have a Jira key, or were edited after commit, are left in place.',
    inputSchema: {
      type: 'object',
      required: ['batchId'],
      properties: { batchId: { type: 'string' } },
    },
  },
  {
    name: 'roadmap_delete_item',
    description:
      'Permanently delete one Draft parent item (no Jira key) and its children from Roadmap. Does not delete Jira issues. To remove a bar from the Gantt without deleting, use roadmap_unschedule_item.',
    inputSchema: {
      type: 'object',
      required: ['itemKey'],
      properties: { itemKey: { type: 'string' } },
    },
  },
  {
    name: 'roadmap_unschedule_item',
    description:
      'Move one Gantt item back to Backlog (unschedule / move to backlog). Keeps the row; does not delete. Works for Draft and Jira-linked items.',
    inputSchema: {
      type: 'object',
      required: ['itemKey'],
      properties: {
        itemKey: { type: 'string' },
        baseVersion: { type: 'number' },
      },
    },
  },
  {
    name: 'roadmap_add_item',
    description:
      'Create one unscheduled Backlog draft. Optional parentLink is the INIT issue key (for example INIT-123) stored on the item and returned by roadmap_list_items and roadmap_get_context. Does not create a Jira issue and does not place the row on the Gantt.',
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        parentLink: {
          type: 'string',
          description: 'INIT (or other parent) issue key, e.g. INIT-123. Empty omits the field.',
        },
        type: { type: 'string' },
        quarter: { type: 'string' },
        estimate: { type: 'number' },
        targetStart: { type: 'string' },
        targetEnd: { type: 'string' },
        description: { type: 'string' },
      },
    },
  },
] as const;

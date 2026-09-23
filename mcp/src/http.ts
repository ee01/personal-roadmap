export const PLANNING_CONTRACT_VERSION = '1.0.0';
export const PLANNING_SCHEMA_VERSION = '1';
export const PLANNING_CLIENT_MIN_VERSION = 2;

export class RoadmapHttpError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export interface RoadmapClientConfig {
  baseUrl: string;
  teamId: string;
  token: string;
  fetchFn?: typeof fetch;
  allowInsecureHttp?: boolean;
}

export function assertSafeBaseUrl(baseUrl: string, allowInsecureHttp = false): URL {
  const url = new URL(baseUrl);
  const host = url.hostname;
  const local =
    host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local');
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && (local || allowInsecureHttp)) return url;
  throw new Error(
    'ROADMAP_BASE_URL must be https (localhost / ROADMAP_ALLOW_INSECURE_HTTP=1 are the only HTTP exceptions)',
  );
}

export function createRoadmapClient(config: RoadmapClientConfig) {
  const base = assertSafeBaseUrl(
    config.baseUrl,
    config.allowInsecureHttp || process.env.ROADMAP_ALLOW_INSECURE_HTTP === '1',
  );
  const teamId = config.teamId.trim();
  const token = config.token.trim();
  if (!teamId) throw new Error('ROADMAP_TEAM_ID is required');
  if (!token) throw new Error('ROADMAP_EDIT_TOKEN is required');
  const fetchFn = config.fetchFn || fetch;
  const prefix = `${String(base).replace(/\/+$/, '')}/api/v1/teams/${encodeURIComponent(teamId)}`;

  async function request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const res = await fetchFn(`${prefix}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Share-Token': token,
        'X-Actor-Source': 'agent',
        'X-Actor-Name': 'roadmap-mcp',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({ error: res.statusText }));
    if (!res.ok) {
      const message = String((json as { error?: string }).error || `http_${res.status}`);
      throw new RoadmapHttpError(res.status, json, message);
    }
    return json as T;
  }

  return {
    contractVersion: PLANNING_CONTRACT_VERSION,
    schemaVersion: PLANNING_SCHEMA_VERSION,
    capabilities: () => request('GET', '/planning/capabilities'),
    context: (itemKeys?: string[], view?: string) => {
      const qs = new URLSearchParams();
      if (itemKeys?.length) qs.set('itemKeys', itemKeys.join(','));
      if (view) qs.set('view', view);
      const query = qs.toString();
      return request('GET', `/planning/context${query ? `?${query}` : ''}`);
    },
    listItems: (itemKeys?: string[], view?: string) => {
      const qs = new URLSearchParams();
      if (itemKeys?.length) qs.set('itemKeys', itemKeys.join(','));
      if (view) qs.set('view', view);
      const query = qs.toString();
      return request('GET', `/planning/items${query ? `?${query}` : ''}`);
    },
    validatePlan: (body: Record<string, unknown>) =>
      request('POST', '/draft-plans', { ...body, autoCommit: false }),
    revisePlan: (planId: string, body: Record<string, unknown>) =>
      request('POST', `/draft-plans/${planId}/revisions`, body),
    generatePlan: (body: Record<string, unknown>) =>
      request('POST', '/planning/jobs', { autoCommit: false, ...body }),
    getJob: (jobId: string) => request('GET', `/planning/jobs/${jobId}`),
    cancelJob: (jobId: string) => request('POST', `/planning/jobs/${jobId}/cancel`, {}),
    getRequest: (requestId: string) => request('GET', `/planning/requests/${requestId}`),
    commitPlan: (planId: string, body: Record<string, unknown>) =>
      request('POST', `/draft-plans/${planId}/commit`, body),
    getBatch: (batchId: string) => request('GET', `/draft-batches/${batchId}`),
    undoBatch: (batchId: string) => request('POST', `/draft-batches/${batchId}/undo`, {}),
    deleteItem: (itemKey: string) =>
      request('POST', `/planning/items/${encodeURIComponent(itemKey)}/delete`, {}),
    unscheduleItem: (itemKey: string, baseVersion?: number) =>
      request('POST', `/planning/items/${encodeURIComponent(itemKey)}/unschedule`, {
        ...(baseVersion != null ? { baseVersion } : {}),
      }),
  };
}

export function loadClientFromEnv(env: NodeJS.ProcessEnv = process.env) {
  return createRoadmapClient({
    baseUrl: String(env.ROADMAP_BASE_URL || '').trim(),
    teamId: String(env.ROADMAP_TEAM_ID || '').trim(),
    token: String(env.ROADMAP_EDIT_TOKEN || '').trim(),
    allowInsecureHttp: env.ROADMAP_ALLOW_INSECURE_HTTP === '1',
  });
}

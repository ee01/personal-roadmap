import type {
  AgentCreateJiraPayload,
  CreateJiraPayload,
  CreateJiraResult,
} from './useRoadmapContract';

export type ImportItemPayload = {
  key: string;
  type: string;
  title: string;
  quarter?: string;
  estimate?: number;
  targetStart?: string;
  targetEnd?: string;
};

export type AgentExecutorOption = {
  id: string;
  label: string;
};

type BridgeResultType =
  | 'pai-roadmap-import-jql-result'
  | 'pai-roadmap-create-jira-result'
  | 'pai-roadmap-agent-create-result'
  | 'pai-roadmap-agent-executors-result'
  | 'pai-roadmap-open-options-result'
  | 'pai-roadmap-ai-alias-result'
  | 'pai-roadmap-fetch-issue-dates-result'
  | 'pai-roadmap-import-tasks-result'
  | 'pai-roadmap-update-target-dates-result'
  | 'pai-roadmap-update-assignee-result'
  | 'pai-roadmap-refresh-jira-result';

const ACK_TIMEOUT_MS = 4_000;
/** Must cover one Epic Agent run (content script polls up to 30 min). */
const AGENT_CREATE_TIMEOUT_MS = 30 * 60 * 1000;

function requestId(): string {
  return `req_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/**
 * 内容脚本收到请求后会立刻回执。没有回执说明扩展根本没接到这条消息（多数是
 * 扩展被重新加载后页面还是旧的注入），此时不该让用户一直看 loading。
 */
function waitForBridgeAck(
  ackType: string,
  id: string,
  timeoutMs = ACK_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error('扩展未接收请求，请在 chrome://extensions 重新加载扩展后刷新本页'));
    }, timeoutMs);

    function onMessage(ev: MessageEvent) {
      const data = ev.data || {};
      if (data.type !== ackType || data.requestId !== id) return;
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve();
    }

    window.addEventListener('message', onMessage);
  });
}

function waitForBridgeResult<T>(
  resultType: BridgeResultType,
  id: string,
  timeoutMs = 120_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error('扩展响应超时'));
    }, timeoutMs);

    function onMessage(ev: MessageEvent) {
      const data = ev.data || {};
      if (data.type !== resultType || data.requestId !== id) return;
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      if (!data.ok) {
        reject(new Error(data.error || '扩展调用失败'));
        return;
      }
      resolve(data as T);
    }

    window.addEventListener('message', onMessage);
  });
}

export async function bridgeImportJql(
  jql: string,
  quarters: string[],
): Promise<ImportItemPayload[]> {
  const id = requestId();
  const pending = waitForBridgeResult<{
    ok: true;
    items: ImportItemPayload[];
  }>('pai-roadmap-import-jql-result', id);
  const acked = waitForBridgeAck('pai-roadmap-import-jql-ack', id);
  // 两个 promise 各自挂空 handler：race 只用先到的那个，另一个的 reject 不该冒泡成未处理异常
  pending.catch(() => undefined);
  acked.catch(() => undefined);

  window.postMessage(
    { type: 'pai-roadmap-import-jql', requestId: id, jql, quarters },
    '*',
  );

  await Promise.race([acked, pending]);
  const result = await pending;
  return Array.isArray(result.items) ? result.items : [];
}

/**
 * Two-phase creation: the extension creates the parent issue (when `parent` is
 * set), resolves its key back into the roadmap itself, then creates the
 * children. Partial success is normal — read the per-row `error` fields.
 */
export async function bridgeCreateJira(
  payload: CreateJiraPayload,
): Promise<CreateJiraResult> {
  const id = requestId();
  const pending = waitForBridgeResult<{
    ok: true;
    result: CreateJiraResult;
  }>('pai-roadmap-create-jira-result', id);
  const acked = waitForBridgeAck('pai-roadmap-create-jira-ack', id);
  pending.catch(() => undefined);
  acked.catch(() => undefined);
  window.postMessage(
    {
      type: 'pai-roadmap-create-jira',
      requestId: id,
      payload: payload as unknown as Record<string, unknown>,
    },
    '*',
  );
  await Promise.race([acked, pending]);
  const result = await pending;
  return {
    parent: result.result?.parent,
    children: result.result?.children || [],
  };
}

/** Prompt path: extension enqueues an AgentTask and resolves mappings. */
export async function bridgeAgentCreateJira(
  payload: AgentCreateJiraPayload,
): Promise<CreateJiraResult> {
  const id = requestId();
  const pending = waitForBridgeResult<{
    ok: true;
    result: CreateJiraResult;
  }>('pai-roadmap-agent-create-result', id, AGENT_CREATE_TIMEOUT_MS);
  const acked = waitForBridgeAck('pai-roadmap-agent-create-ack', id);
  pending.catch(() => undefined);
  acked.catch(() => undefined);
  window.postMessage(
    {
      type: 'pai-roadmap-agent-create',
      requestId: id,
      payload: payload as unknown as Record<string, unknown>,
    },
    '*',
  );
  await Promise.race([acked, pending]);
  const result = await pending;
  return {
    parent: result.result?.parent,
    children: result.result?.children || [],
  };
}

export async function bridgeListAgentExecutors(): Promise<AgentExecutorOption[]> {
  const id = requestId();
  const pending = waitForBridgeResult<{
    ok: true;
    executors: AgentExecutorOption[];
  }>('pai-roadmap-agent-executors-result', id, 30_000);
  const acked = waitForBridgeAck('pai-roadmap-agent-executors-ack', id);
  pending.catch(() => undefined);
  acked.catch(() => undefined);
  window.postMessage({ type: 'pai-roadmap-agent-executors', requestId: id }, '*');
  await Promise.race([acked, pending]);
  const result = await pending;
  return Array.isArray(result.executors) ? result.executors : [];
}

export async function bridgeOpenOptionsPage(): Promise<void> {
  const id = requestId();
  const pending = waitForBridgeResult<{ ok: true }>(
    'pai-roadmap-open-options-result',
    id,
    15_000,
  );
  const acked = waitForBridgeAck('pai-roadmap-open-options-ack', id);
  pending.catch(() => undefined);
  acked.catch(() => undefined);
  window.postMessage({ type: 'pai-roadmap-open-options', requestId: id }, '*');
  await Promise.race([acked, pending]);
  await pending;
}

export type JiraIssueDateInfo = {
  targetEnd: string | null;
  status: string | null;
};

/** Read Target End / status from a Jira issue for external-dep ETA. */
export async function bridgeFetchIssueDates(
  jiraKey: string,
): Promise<JiraIssueDateInfo> {
  const id = requestId();
  const pending = waitForBridgeResult<{
    ok: true;
    targetEnd?: string | null;
    status?: string | null;
  }>('pai-roadmap-fetch-issue-dates-result', id, 30_000);
  const acked = waitForBridgeAck('pai-roadmap-fetch-issue-dates-ack', id);
  pending.catch(() => undefined);
  acked.catch(() => undefined);
  window.postMessage(
    { type: 'pai-roadmap-fetch-issue-dates', requestId: id, jiraKey },
    '*',
  );
  await Promise.race([acked, pending]);
  const result = await pending;
  return {
    targetEnd: result.targetEnd || null,
    status: result.status || null,
  };
}

export type RemoteChildTask = {
  key: string;
  summary: string;
  epicKey: string;
  targetStart: string | null;
  targetEnd: string | null;
  assignee: string | null;
  originalEstimateDays?: number | null;
};

/** Search child Tasks under Epics via extension Options JIRA_API_TOKEN. */
export async function bridgeImportChildTasks(
  epicKeys: string[],
  linkField: string | null,
): Promise<RemoteChildTask[]> {
  const id = requestId();
  const pending = waitForBridgeResult<{
    ok: true;
    tasks: RemoteChildTask[];
  }>('pai-roadmap-import-tasks-result', id, 120_000);
  const acked = waitForBridgeAck('pai-roadmap-import-tasks-ack', id);
  pending.catch(() => undefined);
  acked.catch(() => undefined);
  window.postMessage(
    {
      type: 'pai-roadmap-import-tasks',
      requestId: id,
      epicKeys,
      linkField,
    },
    '*',
  );
  await Promise.race([acked, pending]);
  const result = await pending;
  return Array.isArray(result.tasks) ? result.tasks : [];
}

/**
 * Write Target Start/End via extension Options token.
 * Throws with message `jira_token_missing` when Options has no token.
 */
export async function bridgeUpdateTargetDates(
  jiraKey: string,
  start: string,
  end: string,
): Promise<void> {
  const id = requestId();
  const pending = waitForBridgeResult<{ ok: true }>(
    'pai-roadmap-update-target-dates-result',
    id,
    30_000,
  );
  const acked = waitForBridgeAck('pai-roadmap-update-target-dates-ack', id);
  pending.catch(() => undefined);
  acked.catch(() => undefined);
  window.postMessage(
    {
      type: 'pai-roadmap-update-target-dates',
      requestId: id,
      jiraKey,
      start,
      end,
    },
    '*',
  );
  await Promise.race([acked, pending]);
  await pending;
}

export type JiraRefreshIssue = {
  key: string;
  summary: string | null;
  description: string | null;
  targetStart: string | null;
  targetEnd: string | null;
  assignee: string | null;
  status: string | null;
  originalEstimateDays?: number | null;
  fetchedAt: number;
};

export async function bridgeRefreshJiraIssues(
  keys: string[],
): Promise<JiraRefreshIssue[]> {
  const id = requestId();
  const pending = waitForBridgeResult<{
    ok: true;
    issues: JiraRefreshIssue[];
  }>('pai-roadmap-refresh-jira-result', id, 60_000);
  const acked = waitForBridgeAck('pai-roadmap-refresh-jira-ack', id);
  pending.catch(() => undefined);
  acked.catch(() => undefined);
  window.postMessage(
    { type: 'pai-roadmap-refresh-jira', requestId: id, keys },
    '*',
  );
  await Promise.race([acked, pending]);
  const result = await pending;
  return Array.isArray(result.issues) ? result.issues : [];
}

export async function bridgeUpdateAssignee(
  jiraKey: string,
  assignee: string | null,
): Promise<void> {
  const id = requestId();
  const pending = waitForBridgeResult<{ ok: true }>(
    'pai-roadmap-update-assignee-result',
    id,
    30_000,
  );
  const acked = waitForBridgeAck('pai-roadmap-update-assignee-ack', id);
  pending.catch(() => undefined);
  acked.catch(() => undefined);
  window.postMessage(
    {
      type: 'pai-roadmap-update-assignee',
      requestId: id,
      jiraKey,
      assignee,
    },
    '*',
  );
  await Promise.race([acked, pending]);
  await pending;
}

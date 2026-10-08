import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const DEFAULT_BASE_URL = 'http://roadmap.xmnup.com';

export const SETUP_HINT =
  '还没有 Setup 团队。在 Codex 里先运行 Roadmap Setup（$roadmap-setup），填入地址栏 ?team= 后面的团队 id，以及顶栏「分享可编辑链接」里的 token。配好之前不要调用 roadmap_* 工具，也不要编造 token。';

const TEAM_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN_RE = /^rw_[A-Za-z0-9_-]{8,200}$/;

export function credentialsPath(env = process.env) {
  const override = String(env.ROADMAP_CREDENTIALS_PATH || '').trim();
  if (override) return override;
  return path.join(homedir(), '.codex', 'personal-roadmap.json');
}

export function normalizeBaseUrl(raw) {
  const text = String(raw || '').trim() || DEFAULT_BASE_URL;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('baseUrl 必须是 http 或 https 地址');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('baseUrl 只允许 http 或 https');
  }
  if (url.username || url.password) throw new Error('baseUrl 不能带账号密码');
  url.search = '';
  url.hash = '';
  let pathname = url.pathname.replace(/\/+$/, '');
  if (pathname.endsWith('/mcp')) pathname = pathname.slice(0, -4);
  const suffix = pathname && pathname !== '/' ? pathname : '';
  return `${url.protocol}//${url.host}${suffix}`;
}

export function mcpEndpoint(baseUrl) {
  return `${normalizeBaseUrl(baseUrl)}/mcp`;
}

export function parseSetupInput({ url, teamId, token, baseUrl } = {}) {
  let team = String(teamId || '').trim();
  let share = String(token || '').trim();
  let site = String(baseUrl || '').trim();
  if (url) {
    let parsed;
    try {
      parsed = new URL(String(url).trim());
    } catch {
      throw new Error('分享链接不是合法 URL');
    }
    team = team || parsed.searchParams.get('team') || parsed.searchParams.get('teamId') || '';
    share = share || parsed.searchParams.get('token') || '';
    if (!site) site = parsed.origin;
    if (!share) {
      throw new Error('这条链接没有 token。请用顶栏「分享可编辑链接」，只读链接不能写入。');
    }
  }
  team = team.trim();
  share = share.trim();
  if (!TEAM_RE.test(team)) {
    throw new Error('团队 id 无效。它是地址栏 ?team= 后面的一段，不要带空格或整段 URL。');
  }
  if (!TOKEN_RE.test(share)) {
    throw new Error('token 无效。它应以 rw_ 开头，来自可编辑分享链接，不要贴整段 URL。');
  }
  return { teamId: team, token: share, baseUrl: normalizeBaseUrl(site || DEFAULT_BASE_URL) };
}

function credentialsFromEnv(env) {
  const teamId = String(env.ROADMAP_TEAM_ID || '').trim();
  const token = String(env.ROADMAP_EDIT_TOKEN || '').trim();
  if (!teamId || !token) return null;
  return {
    source: 'env',
    teamId,
    token,
    baseUrl: normalizeBaseUrl(env.ROADMAP_BASE_URL || DEFAULT_BASE_URL),
  };
}

export function readCredentials(env = process.env) {
  const fromEnv = credentialsFromEnv(env);
  if (fromEnv) return fromEnv;
  const file = credentialsPath(env);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    return { error: 'unreadable', path: file };
  }
  try {
    const parsed = JSON.parse(raw);
    const teamId = String(parsed.teamId || '').trim();
    const token = String(parsed.token || '').trim();
    if (!teamId || !token) return null;
    return {
      source: 'file',
      teamId,
      token,
      baseUrl: normalizeBaseUrl(parsed.baseUrl || DEFAULT_BASE_URL),
      path: file,
    };
  } catch {
    return { error: 'invalid_json', path: file };
  }
}

export function status(env = process.env) {
  const file = credentialsPath(env);
  try {
    const creds = readCredentials(env);
    if (!creds) return { configured: false, path: file };
    if (creds.error) return { configured: false, error: creds.error, path: creds.path || file };
    return {
      configured: true,
      source: creds.source,
      teamId: creds.teamId,
      baseUrl: creds.baseUrl,
      path: creds.path || file,
    };
  } catch {
    return { configured: false, error: 'invalid_json', path: file };
  }
}

export function writeCredentials(input, env = process.env) {
  const parsed = parseSetupInput(input);
  const file = credentialsPath(env);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const body = `${JSON.stringify(
    { baseUrl: parsed.baseUrl, teamId: parsed.teamId, token: parsed.token },
    null,
    2,
  )}\n`;
  writeFileSync(tmp, body, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  chmodSync(file, 0o600);
  return status(env);
}

export function clearCredentials(env = process.env) {
  rmSync(credentialsPath(env), { force: true });
  return status(env);
}

export function notConfiguredCallResult(id) {
  const body = { error: 'roadmap_setup_required', message: SETUP_HINT };
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    result: {
      content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
      structuredContent: body,
      isError: true,
    },
  };
}

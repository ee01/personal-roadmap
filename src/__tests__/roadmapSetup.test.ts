import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { forwardRpc } from '../../plugin/scripts/mcp-bridge.mjs';
import {
  clearCredentials,
  parseSetupInput,
  status,
  writeCredentials,
} from '../../plugin/scripts/roadmap-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const token = 'rw_testtokenvalue';

function envWith(file: string, extra: Record<string, string> = {}) {
  return {
    ...process.env,
    ROADMAP_CREDENTIALS_PATH: file,
    ROADMAP_TEAM_ID: '',
    ROADMAP_EDIT_TOKEN: '',
    ROADMAP_BASE_URL: '',
    ...extra,
  };
}

describe('Roadmap Setup credentials', () => {
  it('parses an editable share link and rejects a read-only link', () => {
    const parsed = parseSetupInput({
      url: `http://roadmap.xmnup.com/?team=team_abc-1&token=${token}&view=gantt`,
    });
    expect(parsed).toEqual({
      teamId: 'team_abc-1',
      token,
      baseUrl: 'http://roadmap.xmnup.com',
    });
    expect(() =>
      parseSetupInput({ url: 'http://roadmap.xmnup.com/?team=team_abc-1' }),
    ).toThrow(/只读/);
  });

  it('writes a private file and never returns the token', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'roadmap-setup-'));
    const file = path.join(dir, 'personal-roadmap.json');
    const env = envWith(file);
    expect(status(env).configured).toBe(false);
    const written = writeCredentials(
      { teamId: 'team_abc', token, baseUrl: 'http://roadmap.xmnup.com/mcp' },
      env,
    );
    expect(written).toEqual({
      configured: true,
      source: 'file',
      teamId: 'team_abc',
      baseUrl: 'http://roadmap.xmnup.com',
      path: file,
    });
    expect(JSON.stringify(written)).not.toContain(token);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8')).token).toBe(token);
    expect(clearCredentials(env).configured).toBe(false);
  });

  it('prefers environment credentials over the file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'roadmap-setup-'));
    const file = path.join(dir, 'personal-roadmap.json');
    const env = envWith(file, {
      ROADMAP_TEAM_ID: 'from_env',
      ROADMAP_EDIT_TOKEN: token,
      ROADMAP_BASE_URL: 'https://roadmap.example',
    });
    expect(status(env)).toMatchObject({
      configured: true,
      source: 'env',
      teamId: 'from_env',
      baseUrl: 'https://roadmap.example',
    });
  });
});

describe('Roadmap Setup CLI', () => {
  it('applies stdin JSON without printing the token', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'roadmap-setup-'));
    const file = path.join(dir, 'personal-roadmap.json');
    const script = path.join(root, 'plugin/scripts/setup.mjs');
    const applied = spawnSync(process.execPath, [script, 'apply'], {
      input: JSON.stringify({
        url: `http://roadmap.xmnup.com/board?team=cliTeam1&token=${token}`,
      }),
      env: envWith(file),
      encoding: 'utf8',
    });
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain('"configured":true');
    expect(applied.stdout).not.toContain(token);
    expect(applied.stderr).not.toContain(token);

    const checked = spawnSync(process.execPath, [script, 'status'], {
      env: envWith(file),
      encoding: 'utf8',
    });
    expect(checked.status).toBe(0);
    expect(checked.stdout).toContain('"teamId":"cliTeam1"');
    expect(checked.stdout).not.toContain(token);
  });
});

describe('plugin MCP bridge', () => {
  it('refuses tool calls until Setup and does not contact the server', async () => {
    const fetchFn = () => {
      throw new Error('should not fetch');
    };
    const rpc = await forwardRpc(
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'roadmap_get_context' } },
      { fetchFn, readCredentials: () => null },
    );
    expect(rpc.result.isError).toBe(true);
    expect(rpc.result.structuredContent.error).toBe('roadmap_setup_required');
    expect(rpc.result.structuredContent.message).toContain('$roadmap-setup');
  });

  it('forwards a configured call with team headers and without the token in the URL', async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null;
    const fetchFn = async (url: string, init: { headers: Record<string, string> }) => {
      seen = { url, headers: init.headers };
      return {
        status: 200,
        text: async () => JSON.stringify({ jsonrpc: '2.0', id: 3, result: { ok: true } }),
      };
    };
    const rpc = await forwardRpc(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'roadmap_list_items' } },
      {
        fetchFn,
        readCredentials: () => ({
          teamId: 'team_abc',
          token,
          baseUrl: 'https://roadmap.example',
        }),
      },
    );
    expect(rpc.result).toEqual({ ok: true });
    expect(seen?.url).toBe('https://roadmap.example/mcp');
    expect(seen?.url).not.toContain(token);
    expect(seen?.headers['X-Team-Id']).toBe('team_abc');
    expect(seen?.headers['X-Share-Token']).toBe(token);
  });
});

describe('Setup hooks', () => {
  it('tells a new session to run Setup and blocks roadmap tools when unset', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'roadmap-setup-'));
    const file = path.join(dir, 'missing.json');
    const env = envWith(file);
    const session = spawnSync(process.execPath, [path.join(root, 'plugin/hooks/session-start.mjs')], {
      input: '{}',
      env,
      encoding: 'utf8',
    });
    expect(session.status).toBe(0);
    expect(session.stdout).toContain('SessionStart');
    expect(session.stdout).toContain('$roadmap-setup');
    expect(session.stdout).not.toContain(token);

    const blocked = spawnSync(process.execPath, [path.join(root, 'plugin/hooks/require-setup.mjs')], {
      input: '{"tool_name":"mcp__roadmap-planning__roadmap_get_context"}',
      env,
      encoding: 'utf8',
    });
    expect(blocked.status).toBe(0);
    const decision = JSON.parse(blocked.stdout);
    expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain('Roadmap Setup');
  });

  it('stays quiet once the team is configured', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'roadmap-setup-'));
    const file = path.join(dir, 'personal-roadmap.json');
    const env = envWith(file);
    writeCredentials({ teamId: 'team_abc', token }, env);
    const session = spawnSync(process.execPath, [path.join(root, 'plugin/hooks/session-start.mjs')], {
      input: '{}',
      env,
      encoding: 'utf8',
    });
    expect(session.status).toBe(0);
    expect(session.stdout).toBe('');
    const allowed = spawnSync(process.execPath, [path.join(root, 'plugin/hooks/require-setup.mjs')], {
      input: '{}',
      env,
      encoding: 'utf8',
    });
    expect(allowed.status).toBe(0);
    expect(allowed.stdout).toBe('');
  });
});

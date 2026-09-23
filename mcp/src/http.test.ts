import { describe, expect, it, vi } from 'vitest';
import { MCP_TOOL_NAMES, MCP_TOOLS, dispatchTool } from './tools.js';
import { assertSafeBaseUrl, createRoadmapClient } from './http.js';

describe('roadmap planning MCP', () => {
  it('does not expose Jira create or Memory tools', () => {
    expect(MCP_TOOL_NAMES.join(',')).not.toMatch(/jira|memory/i);
    expect(MCP_TOOLS.some((tool) => /jira|memory/i.test(tool.name))).toBe(false);
  });

  it('rejects non-local HTTP base URLs', () => {
    expect(() => assertSafeBaseUrl('http://evil.example.com')).toThrow(/https/);
    expect(() => assertSafeBaseUrl('http://localhost:3220')).not.toThrow();
    expect(() => assertSafeBaseUrl('https://roadmap.example.com')).not.toThrow();
  });

  it('sends share token only as a header and defaults generate to autoCommit=false', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init: init || {} });
      return {
        ok: true,
        json: async () => ({ jobId: 'j1', status: 'queued' }),
      };
    });
    const client = createRoadmapClient({
      baseUrl: 'http://localhost:3220',
      teamId: 'team-1',
      token: 'secret-token',
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await dispatchTool(client, 'roadmap_generate_plan', {
      requestId: 'req-1',
      text: 'hello',
      referenceDate: '2026-09-16',
    });
    expect(calls).toHaveLength(1);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['X-Share-Token']).toBe('secret-token');
    expect(String(calls[0].url)).not.toContain('secret-token');
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      autoCommit: false,
      requestId: 'req-1',
    });
  });
});

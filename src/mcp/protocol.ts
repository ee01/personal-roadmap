import { randomUUID } from 'node:crypto';
import type { ActorContext } from '../types.js';
import {
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  MCP_TOOLS,
} from './catalog.js';
import { dispatchMcpTool } from './dispatch.js';

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, data } };
}

function toolResult(id: unknown, status: number, body: unknown) {
  const text = JSON.stringify(body, null, 2);
  return rpcResult(id, {
    content: [{ type: 'text', text }],
    structuredContent: body,
    isError: status >= 400,
  });
}

export function handleMcpMessage(
  message: JsonRpcMessage,
  ctx: { teamId: string; actor: ActorContext } | null,
): { rpc: Record<string, unknown> | null; sessionId?: string } {
  const id = message.id;
  const method = String(message.method || '');
  const params = (message.params || {}) as Record<string, unknown>;

  if (id == null && method === 'notifications/initialized') {
    return { rpc: null };
  }
  if (method === 'initialize') {
    const requested = String(params.protocolVersion || MCP_PROTOCOL_VERSION);
    return {
      sessionId: randomUUID(),
      rpc: rpcResult(id, {
        protocolVersion:
          requested === '2024-11-05' ? '2024-11-05' : MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: MCP_SERVER_NAME,
          version: MCP_SERVER_VERSION,
          title: 'Roadmap Draft planning',
        },
        instructions:
          'If the team is not set up, stop before any roadmap_* tool. Ask the user for the editable share link and set HTTP headers X-Team-Id and X-Share-Token on this MCP connection (default URL http://roadmap.xmnup.com/mcp). The Codex plugin uses Roadmap Setup ($roadmap-setup) instead of editing config.toml. Create a Backlog draft with roadmap_add_item (optional parentLink INIT key, optional owner/assignee team member name). Does not create Jira issues.',
      }),
    };
  }
  if (method === 'ping') {
    return { rpc: rpcResult(id, {}) };
  }
  if (method === 'tools/list') {
    return { rpc: rpcResult(id, { tools: MCP_TOOLS }) };
  }
  if (method === 'tools/call') {
    if (!ctx?.teamId) {
      return {
        rpc: toolResult(id, 401, {
          error: 'mcp_auth_required',
          message:
            '还没有绑定团队。请用户从 Roadmap 顶栏复制「分享可编辑链接」（含 team 与 rw_ token），把 X-Team-Id 和 X-Share-Token 写进当前宿主的 MCP 配置后新开会话。若装的是 Codex 插件 Personal Roadmap，改为运行 Roadmap Setup（$roadmap-setup），不要手改 config.toml。配好之前不要继续写 Roadmap。',
        }),
      };
    }
    const name = String(params.name || '');
    const args = (params.arguments || {}) as Record<string, unknown>;
    const result = dispatchMcpTool(ctx.teamId, ctx.actor, name, args);
    return { rpc: toolResult(id, result.status, result.body) };
  }
  if (id != null) {
    return { rpc: rpcError(id, -32601, `Method not found: ${method}`) };
  }
  return { rpc: null };
}

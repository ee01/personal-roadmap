import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config, DEFAULT_PUBLIC_BASE_URL } from '../config.js';
import { getTeamSnapshot, validateShareToken } from '../core/TeamService.js';
import type { ActorContext } from '../types.js';
import { handleMcpMessage, type JsonRpcMessage } from '../mcp/protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function publicBase(): string {
  const raw = (config.publicBaseUrl || DEFAULT_PUBLIC_BASE_URL).replace(/\/+$/, '');
  return raw.replace(/^(https?:\/\/roadmap\.xmnup\.com):3220$/i, '$1');
}

function header(request: FastifyRequest, name: string): string {
  return String(request.headers[name] || '').trim();
}

function bearerToken(request: FastifyRequest): string {
  const raw = header(request, 'authorization');
  const match = /^Bearer\s+(.+)$/i.exec(raw);
  return match ? match[1].trim() : '';
}

function queryValue(request: FastifyRequest, key: string): string {
  const query = request.query as Record<string, unknown>;
  return String(query?.[key] || '').trim();
}

function readTeamId(request: FastifyRequest): string {
  return header(request, 'x-team-id') || queryValue(request, 'team') || queryValue(request, 'teamId');
}

function readShareToken(request: FastifyRequest): string {
  return header(request, 'x-share-token') || bearerToken(request);
}

function readActor(request: FastifyRequest): ActorContext {
  return {
    name: header(request, 'x-actor-name') || 'roadmap-mcp',
    clientId: header(request, 'x-client-id') || 'mcp-http',
    source: 'agent',
    shareTokenId: null,
    ip: request.ip,
  };
}

function bindTeam(request: FastifyRequest):
  | { ok: true; teamId: string; actor: ActorContext }
  | { ok: false } {
  const teamId = readTeamId(request);
  const token = readShareToken(request);
  if (!teamId || !token) return { ok: false };
  if (!getTeamSnapshot(teamId)) return { ok: false };
  const result = validateShareToken(teamId, token);
  if (!result.ok) return { ok: false };
  return {
    ok: true,
    teamId,
    actor: { ...readActor(request), shareTokenId: result.shareTokenId || null },
  };
}

function wantsSse(request: FastifyRequest): boolean {
  const accept = header(request, 'accept').toLowerCase();
  return accept.includes('text/event-stream') && !accept.includes('application/json');
}

function sendRpc(request: FastifyRequest, reply: FastifyReply, rpc: Record<string, unknown>, sessionId?: string) {
  if (sessionId) reply.header('Mcp-Session-Id', sessionId);
  reply.header('MCP-Protocol-Version', '2025-03-26');
  if (wantsSse(request)) {
    return reply
      .type('text/event-stream')
      .header('Cache-Control', 'no-cache')
      .send(`event: message\ndata: ${JSON.stringify(rpc)}\n\n`);
  }
  return reply.type('application/json').send(rpc);
}

function skillRoot(): string {
  const built = path.resolve(__dirname, '../skills/roadmap-planning');
  if (fs.existsSync(path.join(built, 'SKILL.md'))) return built;
  return path.resolve(__dirname, '../../plugin/skills/roadmap-planning');
}

export async function registerMcpRoutes(app: FastifyInstance): Promise<void> {
  const discovery = () => ({
    name: 'roadmap-planning',
    transport: 'streamable-http',
    protocolVersion: '2025-03-26',
    mcpUrl: `${publicBase()}/mcp`,
    skillUrl: `${publicBase()}/skills/roadmap-planning/SKILL.md`,
    defaultBaseUrl: publicBase(),
    auth: {
      headers: ['X-Team-Id', 'X-Share-Token'],
      notes:
        'X-Team-Id is the Roadmap ?team= value. X-Share-Token is the editable share-link token. Authorization: Bearer <token> is also accepted.',
    },
  });

  app.get('/mcp', async (request, reply) => {
    reply.header('MCP-Protocol-Version', '2025-03-26');
    if (header(request, 'accept').includes('text/event-stream')) {
      return reply
        .type('text/event-stream')
        .header('Cache-Control', 'no-cache')
        .send(': connected\n\n');
    }
    return discovery();
  });

  app.delete('/mcp', async (_request, reply) => {
    return reply.code(204).send();
  });

  app.post('/mcp', async (request, reply) => {
    const body = request.body as JsonRpcMessage | JsonRpcMessage[] | null;
    if (!body || (typeof body !== 'object' && !Array.isArray(body))) {
      return reply.code(400).send({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
    }
    const bound = bindTeam(request);
    const ctx = bound.ok ? { teamId: bound.teamId, actor: bound.actor } : null;
    const messages = Array.isArray(body) ? body : [body];
    const out: Record<string, unknown>[] = [];
    let sessionId: string | undefined;
    for (const message of messages) {
      const handled = handleMcpMessage(message, ctx);
      if (handled.sessionId) sessionId = handled.sessionId;
      if (handled.rpc) out.push(handled.rpc);
    }
    if (!out.length) {
      if (sessionId) reply.header('Mcp-Session-Id', sessionId);
      return reply.code(202).send();
    }
    const payload = Array.isArray(body) ? out : out[0];
    return sendRpc(request, reply, payload as Record<string, unknown>, sessionId);
  });

  app.get('/skills/roadmap-planning/SKILL.md', async (_request, reply) => {
    const file = path.join(skillRoot(), 'SKILL.md');
    if (!fs.existsSync(file)) return reply.code(404).send({ error: 'skill_not_found' });
    return reply.type('text/markdown; charset=utf-8').send(fs.readFileSync(file, 'utf8'));
  });

  app.get('/skills/roadmap-planning/references/plan-schema.md', async (_request, reply) => {
    const file = path.join(skillRoot(), 'references/plan-schema.md');
    if (!fs.existsSync(file)) return reply.code(404).send({ error: 'skill_not_found' });
    return reply.type('text/markdown; charset=utf-8').send(fs.readFileSync(file, 'utf8'));
  });
}

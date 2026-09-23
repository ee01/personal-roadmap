#!/usr/bin/env node
/**
 * Roadmap planning MCP server (stdio). stdout is JSON-RPC only; diagnostics go to stderr.
 */
import { createClient, dispatchTool, MCP_TOOLS } from './tools.js';
import { RoadmapHttpError } from './http.js';

const PROTOCOL = '2024-11-05';

function writeMessage(message: unknown) {
  const json = JSON.stringify(message);
  const payload = Buffer.from(json, 'utf8');
  const header = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, 'utf8');
  process.stdout.write(Buffer.concat([header, payload]));
}

function sendResult(id: unknown, result: unknown) {
  writeMessage({ jsonrpc: '2.0', id, result });
}

function sendError(id: unknown, code: number, message: string, data?: unknown) {
  writeMessage({ jsonrpc: '2.0', id, error: { code, message, data } });
}

async function handle(message: Record<string, unknown>) {
  const id = message.id;
  const method = String(message.method || '');
  const params = (message.params || {}) as Record<string, unknown>;
  if (id == null && method === 'notifications/initialized') return;
  if (method === 'initialize') {
    sendResult(id, {
      protocolVersion: PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: {
        name: 'roadmap-planning',
        version: '1.0.0',
        contractVersion: '1.0.0',
        schemaVersion: '1',
      },
    });
    return;
  }
  if (method === 'ping') {
    sendResult(id, {});
    return;
  }
  if (method === 'tools/list') {
    sendResult(id, { tools: MCP_TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const name = String(params.name || '');
    const args = (params.arguments || {}) as Record<string, unknown>;
    try {
      const client = createClient();
      const result = await dispatchTool(client, name, args);
      sendResult(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      });
    } catch (error) {
      const err = error as RoadmapHttpError;
      const text = err instanceof RoadmapHttpError
        ? JSON.stringify({ error: err.message, status: err.status, body: err.body })
        : String((error as Error).message || error);
      sendResult(id, {
        content: [{ type: 'text', text }],
        isError: true,
      });
    }
    return;
  }
  if (id != null) sendError(id, -32601, `Method not found: ${method}`);
}

let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString('utf8');
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      process.stderr.write('invalid MCP framing\n');
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const total = headerEnd + 4 + length;
    if (buffer.length < total) return;
    const body = buffer.subarray(headerEnd + 4, total).toString('utf8');
    buffer = buffer.subarray(total);
    try {
      void handle(JSON.parse(body));
    } catch (error) {
      process.stderr.write(`mcp parse error: ${(error as Error).message}\n`);
    }
  }
});

process.stdin.resume();

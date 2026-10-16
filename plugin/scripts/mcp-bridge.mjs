#!/usr/bin/env node
/**
 * stdio MCP bridge. Credentials are re-read on every call from the environment
 * or ~/.codex/personal-roadmap.json, so Roadmap Setup takes effect without a new process.
 * stdout is JSON-RPC only.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_BASE_URL,
  mcpEndpoint,
  notConfiguredCallResult,
  readCredentials,
} from './roadmap-config.mjs';

function redact(text) {
  return String(text || '').replace(/rw_[A-Za-z0-9_-]+/g, 'rw_[redacted]');
}

export async function forwardRpc(message, options = {}) {
  const read = options.readCredentials || readCredentials;
  const fetchFn = options.fetchFn || fetch;
  const method = String(message?.method || '');
  const id = message?.id;
  const creds = read();
  const ready = Boolean(creds?.teamId && creds?.token);
  if (method === 'tools/call' && !ready) return notConfiguredCallResult(id);
  if (id == null && method.startsWith('notifications/')) return null;

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'MCP-Protocol-Version': '2025-03-26',
  };
  if (ready) {
    headers['X-Team-Id'] = creds.teamId;
    headers['X-Share-Token'] = creds.token;
  }
  const endpoint = mcpEndpoint(creds?.baseUrl || options.baseUrl || DEFAULT_BASE_URL);
  let response;
  try {
    response = await fetchFn(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(message),
    });
  } catch (error) {
    if (id == null) return null;
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: `Roadmap MCP 连不上：${redact(error?.message || error)}` },
    };
  }
  if (response.status === 202 || response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    if (id == null) return null;
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: `Roadmap MCP 返回了无法解析的内容（HTTP ${response.status}）` },
    };
  }
}

function writeMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, 'utf8');
  process.stdout.write(Buffer.concat([header, payload]));
}

let chain = Promise.resolve();
function enqueue(message) {
  chain = chain.then(async () => {
    const rpc = await forwardRpc(message);
    if (rpc) writeMessage(rpc);
  }).catch((error) => {
    process.stderr.write(`roadmap mcp bridge: ${redact(error?.message || error)}\n`);
  });
}

function listen() {
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
        enqueue(JSON.parse(body));
      } catch (error) {
        process.stderr.write(`mcp parse error: ${redact(error?.message || error)}\n`);
      }
    }
  });
  process.stdin.resume();
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (entry === import.meta.url) listen();

#!/usr/bin/env node
import { clearCredentials, status, writeCredentials } from './roadmap-config.mjs';

function flag(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return '';
  return process.argv[index + 1] || '';
}

async function readStdinJson() {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 16 * 1024) throw new Error('输入过长');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not-object');
    }
    return parsed;
  } catch {
    throw new Error('输入必须是 JSON 对象');
  }
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const command = process.argv[2];
try {
  if (command === 'status') {
    print(status());
  } else if (command === 'clear') {
    print(clearCredentials());
  } else if (command === 'apply') {
    const input = await readStdinJson();
    print(
      writeCredentials({
        url: flag('--url') || input.url,
        teamId: flag('--team-id') || input.teamId,
        token: flag('--token') || input.token,
        baseUrl: flag('--base-url') || input.baseUrl,
      }),
    );
  } else {
    process.stderr.write('usage: setup.mjs status|apply|clear\n');
    process.exitCode = 2;
  }
} catch (error) {
  const message = String(error?.message || error).replace(/rw_[A-Za-z0-9_-]+/g, 'rw_[redacted]');
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

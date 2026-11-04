import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'roadmap-health-'));

const { registerRoutes } = await import('../routes/api.js');

describe('GET /health', () => {
  const app = Fastify({ logger: false });

  beforeAll(async () => {
    await registerRoutes(app);
  });

  it('returns 200 with a db probe when the database is readable', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; db: { ok: boolean } };
    expect(body.ok).toBe(true);
    expect(body.db.ok).toBe(true);
  });
});
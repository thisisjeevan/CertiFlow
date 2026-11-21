import type { PrismaClient } from '../../src/generated/prisma/client.js';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { readApiConfig } from '../../src/config.js';

const config = readApiConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost/certiflow_test',
  APP_ORIGIN: 'http://localhost:8080',
});

describe('health HTTP contracts', () => {
  it('serves liveness independently of database access', async () => {
    const query = vi.fn().mockRejectedValue(new Error('Database unreachable'));
    const app = createApp(config, { $queryRaw: query } as unknown as PrismaClient);
    const response = await request(app).get('/health/live').expect(200, { status: 'live' });
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]+$/);
    expect(query).not.toHaveBeenCalled();
  });

  it('reports readiness when the migrated database responds', async () => {
    const app = createApp(config, { $queryRaw: vi.fn().mockResolvedValue([]) } as unknown as PrismaClient);
    await request(app).get('/health/ready').expect(200, { status: 'ready', database: 'up' });
  });

  it('reports database failure without exposing database errors', async () => {
    const app = createApp(config, {
      $queryRaw: vi.fn().mockRejectedValue(new Error('private connection detail')),
    } as unknown as PrismaClient);
    await request(app).get('/health/ready').expect(503, { status: 'unavailable', database: 'down' });
  });
});

describe('authentication request validation', () => {
  const app = createApp(config, {} as PrismaClient);

  it('requires authentication for protected routes', async () => {
    await request(app).get('/api/auth/me').expect(401);
    await request(app).get('/api/centres').expect(401);
  });

  it('rejects malformed JSON and non-JSON mutations', async () => {
    await request(app).post('/api/auth/login').type('json').send('{bad').expect(400);
    await request(app).post('/api/auth/logout').type('form').send({}).expect(415);
  });

  it('rejects a foreign browser origin and accepts the configured origin', async () => {
    await request(app).post('/api/auth/login').set('Origin', 'https://example.test').send({}).expect(403);
    await request(app).post('/api/auth/logout').set('Origin', config.APP_ORIGIN).send({}).expect(204);
  });

  it('rejects client-supplied roles before looking up credentials', async () => {
    await request(app).post('/api/auth/login').send({
      email: 'staff@example.test', password: 'placeholder', role: 'STATE_OFFICER',
    }).expect(400);
  });

  it('rate limits repeated login attempts per client', async () => {
    const isolatedApp = createApp(config, {} as PrismaClient);
    const client = request.agent(isolatedApp);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await client.post('/api/auth/login').send({}).expect(400);
    }
    const last = await client.post('/api/auth/login').send({}).expect(429);
    expect(last.body.error.code).toBe('LOGIN_RATE_LIMIT');
  });
});

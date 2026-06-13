process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-with-32-characters';
process.env.INVITE_SECRET = process.env.INVITE_SECRET ?? 'test-invite-secret-with-32-chars';

import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

let app: Express;

beforeAll(async () => {
  app = (await import('../src/server')).default;
});

describe('SightBridge API contract', () => {
  it('exposes health', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  it('rejects session creation without an agent token', async () => {
    const response = await request(app).post('/sessions').send({ title: 'Case 42' });
    expect(response.status).toBe(401);
  });

  it('rejects invalid customer invites', async () => {
    const response = await request(app).post('/sessions/join').send({ token: 'x'.repeat(32), displayName: 'Customer' });
    expect(response.status).toBe(400);
  });
});

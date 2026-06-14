process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-with-32-characters';
process.env.INVITE_SECRET = process.env.INVITE_SECRET ?? 'test-invite-secret-with-32-chars';

import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { PrismaClient } from '../src/generated/prisma/client';

let app: Express;
let hasDb = false;

beforeAll(async () => {
  const { PrismaPg } = await import('@prisma/adapter-pg');
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const prisma = new PrismaClient({ adapter });
  try {
    await prisma.$connect();
    hasDb = true;
    await prisma.$disconnect();
  } catch {
    hasDb = false;
  }
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

  it.skipIf(!hasDb)('rejects invalid customer invites', async () => {
    const response = await request(app).post('/sessions/join').send({ token: 'x'.repeat(32), displayName: 'Customer' });
    expect(response.status).toBe(400);
  });
});

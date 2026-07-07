import bcrypt from 'bcryptjs';
import { PrismaClient } from './generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

async function main() {
  const email = process.env.SEED_AGENT_EMAIL;
  const password = process.env.SEED_AGENT_PASSWORD;
  if (!email || !password) return;
  if (process.env.NODE_ENV === 'production' && password === 'password123') throw new Error('SEED_AGENT_PASSWORD=password123 is blocked in production');
  await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, passwordHash: await bcrypt.hash(password, 12), role: 'AGENT' },
  });
}

main().finally(() => prisma.$disconnect());

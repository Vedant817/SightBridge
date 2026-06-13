import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const email = process.env.SEED_AGENT_EMAIL;
  const password = process.env.SEED_AGENT_PASSWORD;
  if (!email || !password) return;
  await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, passwordHash: await bcrypt.hash(password, 12), role: 'AGENT' },
  });
}

main().finally(() => prisma.$disconnect());

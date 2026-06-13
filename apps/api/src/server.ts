import express, { NextFunction, Request, Response } from 'express';
import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import jwt, { JwtPayload } from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import multer from 'multer';
import client from 'prom-client';
import pino from 'pino';
import { Server } from 'socket.io';
import { PrismaClient, Role, SessionStatus } from '@prisma/client';
import { chatSchema, createSessionSchema, joinSchema, loginSchema, uploadMimeTypes } from '@sightbridge/shared';

const prisma = new PrismaClient();
const log = pino({ name: 'sightbridge-api' });
const app = express();
const server = http.createServer(app);
const corsOrigin = process.env.CORS_ORIGIN ?? 'http://localhost:3000';
const jwtSecret = requiredEnv('JWT_SECRET');
const invitePepper = requiredEnv('INVITE_SECRET');
const storageRoot = process.env.LOCAL_STORAGE_DIR ?? '/data/sightbridge';
const reconnectGraceMs = Number(process.env.RECONNECT_GRACE_MS ?? 30_000);

const io = new Server(server, { cors: { origin: corsOrigin } });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.MAX_UPLOAD_BYTES ?? 10 * 1024 * 1024) },
  fileFilter: (_req, file, cb) => cb(null, uploadMimeTypes.includes(file.mimetype)),
});

app.use(helmet());
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '1mb' }));

const sensitiveLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });
const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });
const activeSessionsGauge = new client.Gauge({ name: 'sightbridge_active_sessions', help: 'Currently active support sessions' });
const connectedParticipantsGauge = new client.Gauge({ name: 'sightbridge_connected_participants', help: 'Participants currently marked joined' });
const totalSessionsCounter = new client.Counter({ name: 'sightbridge_sessions_created_total', help: 'Total created sessions' });
const sessionErrorsCounter = new client.Counter({ name: 'sightbridge_session_errors_total', help: 'Session domain errors' });
const reconnectCounter = new client.Counter({ name: 'sightbridge_reconnect_total', help: 'Participant reconnects' });
const activeRecordingsGauge = new client.Gauge({ name: 'sightbridge_active_recordings', help: 'Recordings currently active' });
registry.registerMetric(activeSessionsGauge);
registry.registerMetric(connectedParticipantsGauge);
registry.registerMetric(totalSessionsCounter);
registry.registerMetric(sessionErrorsCounter);
registry.registerMetric(reconnectCounter);
registry.registerMetric(activeRecordingsGauge);

type AuthUser = JwtPayload & { sub: string; role: Role; email?: string; sessionId?: string };
type AuthedRequest = Request & { user: AuthUser };

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.length < 16) throw new Error(`${name} must be set to a strong value`);
  return value;
}

function hashToken(token: string): string {
  return crypto.createHmac('sha256', invitePepper).update(token).digest('hex');
}

function signAgent(user: { id: string; role: Role; email: string }): string {
  return jwt.sign({ sub: user.id, role: user.role, email: user.email }, jwtSecret, { expiresIn: '8h' });
}

function signParticipant(participantId: string, role: Role, sessionId: string): string {
  return jwt.sign({ sub: participantId, role, sessionId }, jwtSecret, { expiresIn: '2h' });
}

function authenticate(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '') ?? (typeof req.query.token === 'string' ? req.query.token : undefined);
    if (!token) return res.status(401).json({ error: 'Missing bearer token' });
    (req as AuthedRequest).user = jwt.verify(token, jwtSecret) as AuthUser;
    next();
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

function requireAgent(req: Request, res: Response, next: NextFunction) {
  if ((req as AuthedRequest).user.role !== 'AGENT') return res.status(403).json({ error: 'Agent role required' });
  next();
}

async function recordEvent(sessionId: string, type: string, actorRole?: Role, metadata?: unknown) {
  await prisma.sessionEvent.create({ data: { sessionId, type, actorRole, metadata: metadata as object } });
}

async function assertActiveSession(sessionId: string) {
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.status !== SessionStatus.ACTIVE) {
    const error = new Error('Session is not active');
    (error as Error & { status?: number }).status = 409;
    throw error;
  }
  return session;
}

async function writeObject(folder: 'uploads' | 'recordings', bytes: Buffer, extension = '') {
  const id = `${crypto.randomUUID()}${extension}`;
  const dir = path.join(storageRoot, folder);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, id), bytes);
  return `${folder}/${id}`;
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'api' }));

app.get('/metrics', async (_req, res) => {
  activeSessionsGauge.set(await prisma.session.count({ where: { status: 'ACTIVE' } }));
  connectedParticipantsGauge.set(await prisma.sessionParticipant.count({ where: { status: 'JOINED' } }));
  activeRecordingsGauge.set(await prisma.recording.count({ where: { status: 'RECORDING' } }));
  res.setHeader('Content-Type', registry.contentType);
  res.end(await registry.metrics());
});

app.post('/auth/login', sensitiveLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) return res.status(401).json({ error: 'Invalid credentials' });
  return res.json({ token: signAgent(user), user: { id: user.id, email: user.email, role: user.role } });
});

app.post('/sessions', authenticate, requireAgent, sensitiveLimiter, async (req, res) => {
  const parsed = createSessionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const inviteToken = crypto.randomBytes(32).toString('base64url');
  const session = await prisma.session.create({
    data: {
      title: parsed.data.title,
      agentId: (req as AuthedRequest).user.sub,
      inviteTokenHash: hashToken(inviteToken),
      inviteExpiresAt: new Date(Date.now() + Number(process.env.INVITE_TTL_MS ?? 3_600_000)),
    },
  });
  totalSessionsCounter.inc();
  await prisma.sessionParticipant.create({
    data: { sessionId: session.id, role: 'AGENT', displayName: (req as AuthedRequest).user.email ?? 'Support agent', identityKey: `agent:${(req as AuthedRequest).user.sub}` },
  });
  await recordEvent(session.id, 'session.created', 'AGENT');
  io.emit('sessions:update');
  log.info({ sessionId: session.id, agentId: session.agentId }, 'session created');
  return res.status(201).json({ ...session, inviteUrl: `${corsOrigin}/join/${inviteToken}`, inviteToken });
});

app.post('/sessions/join', sensitiveLimiter, async (req, res) => {
  const parsed = joinSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const session = await prisma.session.findUnique({ where: { inviteTokenHash: hashToken(parsed.data.token) } });
  if (!session || session.status !== 'ACTIVE' || session.inviteExpiresAt < new Date() || session.inviteUsedAt) {
    sessionErrorsCounter.inc();
    return res.status(400).json({ error: 'Invalid, expired, reused, or ended invite' });
  }
  const identityKey = `invite:${hashToken(parsed.data.token)}`;
  const participant = await prisma.sessionParticipant.upsert({
    where: { sessionId_identityKey: { sessionId: session.id, identityKey } },
    update: { displayName: parsed.data.displayName, status: 'JOINED', leftAt: null, disconnectedAt: null },
    create: { sessionId: session.id, role: 'CUSTOMER', displayName: parsed.data.displayName, identityKey },
  });
  await prisma.session.update({ where: { id: session.id }, data: { inviteUsedAt: new Date() } });
  await recordEvent(session.id, 'participant.joined', 'CUSTOMER', { participantId: participant.id });
  return res.json({ sessionId: session.id, participantId: participant.id, token: signParticipant(participant.id, 'CUSTOMER', session.id) });
});

app.get('/sessions', authenticate, requireAgent, async (_req, res) => {
  return res.json(await prisma.session.findMany({ include: { participants: true, recordings: true }, orderBy: { createdAt: 'desc' } }));
});

app.get('/sessions/:id/history', authenticate, requireAgent, async (req, res) => {
  const session = await prisma.session.findUnique({
    where: { id: req.params.id },
    include: { participants: true, events: true, messages: { include: { attachments: true } }, recordings: true },
  });
  if (!session) return res.status(404).json({ error: 'Session not found' });
  return res.json(session);
});

app.post('/sessions/:id/end', authenticate, requireAgent, async (req, res) => {
  await assertActiveSession(req.params.id);
  await prisma.session.update({ where: { id: req.params.id }, data: { status: 'ENDED', endedAt: new Date() } });
  await prisma.sessionParticipant.updateMany({ where: { sessionId: req.params.id, status: { not: 'LEFT' } }, data: { status: 'LEFT', leftAt: new Date() } });
  await recordEvent(req.params.id, 'session.ended', 'AGENT');
  io.to(req.params.id).emit('session:end');
  io.emit('sessions:update');
  log.info({ sessionId: req.params.id }, 'session ended');
  return res.json({ ok: true });
});

app.post('/sessions/:id/upload', authenticate, upload.single('file'), async (req, res) => {
  const user = (req as AuthedRequest).user;
  if (!req.file) return res.status(400).json({ error: 'Invalid file' });
  await assertActiveSession(req.params.id);
  if (user.role === 'CUSTOMER' && user.sessionId !== req.params.id) return res.status(403).json({ error: 'Wrong session' });
  const storageKey = await writeObject('uploads', req.file.buffer, path.extname(req.file.originalname).slice(0, 12));
  const message = await prisma.chatMessage.create({
    data: {
      sessionId: req.params.id,
      senderRole: user.role,
      content: typeof req.body.content === 'string' && req.body.content.trim() ? req.body.content.trim() : 'Attachment',
      attachments: { create: { storageKey, originalName: path.basename(req.file.originalname).replace(/[^\w. -]/g, '_'), mimeType: req.file.mimetype, size: req.file.size } },
    },
    include: { attachments: true },
  });
  io.to(req.params.id).emit('chat:message', message);
  return res.json(message);
});


app.get('/sessions/:id/objects/:folder/:name', authenticate, async (req, res) => {
  const user = (req as AuthedRequest).user;
  if (user.role === 'CUSTOMER' && user.sessionId !== req.params.id) return res.status(403).json({ error: 'Wrong session' });
  if (!['uploads', 'recordings'].includes(req.params.folder)) return res.status(400).json({ error: 'Invalid object folder' });
  const safeName = path.basename(req.params.name);
  const filePath = path.join(storageRoot, req.params.folder, safeName);
  return res.download(filePath, safeName);
});

app.post('/sessions/:id/recordings/start', authenticate, requireAgent, async (req, res) => {
  await assertActiveSession(req.params.id);
  const recording = await prisma.recording.create({ data: { sessionId: req.params.id, status: 'RECORDING' } });
  await prisma.session.update({ where: { id: req.params.id }, data: { recordingStatus: 'RECORDING' } });
  await recordEvent(req.params.id, 'recording.started', 'AGENT', { recordingId: recording.id });
  io.to(req.params.id).emit('recording:status', 'RECORDING');
  return res.json(recording);
});

app.post('/sessions/:id/recordings/browser-upload', authenticate, requireAgent, upload.single('file'), async (req, res) => {
  if (!req.file || req.file.mimetype !== 'video/webm') return res.status(400).json({ error: 'A WebM recording file is required' });
  const storageKey = await writeObject('recordings', req.file.buffer, '.webm');
  const result = await prisma.recording.updateMany({ where: { sessionId: req.params.id, status: 'RECORDING' }, data: { status: 'READY', stoppedAt: new Date(), storageKey, size: req.file.size } });
  await prisma.session.update({ where: { id: req.params.id }, data: { recordingStatus: result.count ? 'READY' : 'FAILED' } });
  await recordEvent(req.params.id, result.count ? 'recording.ready' : 'recording.failed', 'AGENT', { storageKey });
  io.to(req.params.id).emit('recording:status', result.count ? 'READY' : 'FAILED');
  return res.json({ ok: result.count > 0, storageKey });
});

io.use((socket, next) => {
  try {
    socket.data.user = jwt.verify(String(socket.handshake.auth.token ?? ''), jwtSecret) as AuthUser;
    next();
  } catch {
    next(new Error('Unauthorized'));
  }
});

io.on('connection', (socket) => {
  const user = socket.data.user as AuthUser;
  socket.on('session:join', async ({ sessionId }: { sessionId: string }) => {
    if (user.role === 'CUSTOMER' && user.sessionId !== sessionId) return socket.emit('error', 'Wrong session');
    await assertActiveSession(sessionId);
    socket.join(sessionId);
    await prisma.sessionParticipant.updateMany({
      where: user.role === 'AGENT' ? { sessionId, identityKey: `agent:${user.sub}` } : { id: user.sub, sessionId },
      data: { socketId: socket.id, status: 'JOINED', disconnectedAt: null },
    });
    reconnectCounter.inc();
    io.to(sessionId).emit('presence:update');
    io.emit('sessions:update');
  });
  socket.on('chat:send', async (payload: { sessionId: string; content: string }) => {
    const parsed = chatSchema.safeParse(payload);
    if (!parsed.success) return socket.emit('error', 'Invalid chat message');
    if (user.role === 'CUSTOMER' && user.sessionId !== payload.sessionId) return socket.emit('error', 'Wrong session');
    await assertActiveSession(payload.sessionId);
    const message = await prisma.chatMessage.create({ data: { sessionId: payload.sessionId, senderRole: user.role, content: parsed.data.content } });
    io.to(payload.sessionId).emit('chat:message', message);
  });
  socket.on('disconnect', async () => {
    await prisma.sessionParticipant.updateMany({ where: { socketId: socket.id }, data: { status: 'DISCONNECTED', disconnectedAt: new Date() } });
    io.emit('sessions:update');
    setTimeout(async () => {
      await prisma.sessionParticipant.updateMany({ where: { socketId: socket.id, status: 'DISCONNECTED' }, data: { status: 'LEFT', leftAt: new Date() } });
      io.emit('sessions:update');
    }, reconnectGraceMs);
  });
});

app.use((error: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  log.error({ error }, 'request failed');
  return res.status(error.status ?? 500).json({ error: error.status ? error.message : 'Internal server error' });
});

if (require.main === module) server.listen(process.env.PORT ?? 4000, () => log.info('api listening'));
export default app;

import express from 'express';
import http from 'http';
import cors from 'cors';
import pino from 'pino';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import * as mediasoup from 'mediasoup';

const log = pino({ name: 'sightbridge-media' });
const app = express();
const corsOrigin = process.env.CORS_ORIGIN ?? 'http://localhost:3000';
const announcedIp = process.env.ANNOUNCED_IP;
const jwtSecret = process.env.JWT_SECRET;
const maxProducersPerRoom = Number(process.env.MAX_PRODUCERS_PER_ROOM ?? 8);
const maxConsumersPerSocket = Number(process.env.MAX_CONSUMERS_PER_SOCKET ?? 16);
const socketEventLimit = Number(process.env.MEDIA_SOCKET_EVENT_LIMIT_PER_MINUTE ?? 120);
const emptyRoomCleanupMs = Number(process.env.EMPTY_ROOM_CLEANUP_MS ?? 60_000);
const turnUrls = (process.env.TURN_URL ?? '').split(',').map((url) => url.trim()).filter(Boolean);
const iceServers = turnUrls.length ? [{ urls: turnUrls, username: process.env.TURN_USERNAME, credential: process.env.TURN_PASSWORD }] : undefined;

validateProductionConfig();

app.use(cors({ origin: corsOrigin }));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'media-server' }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: corsOrigin } });
let worker: mediasoup.types.Worker;

type RoomState = {
  router: mediasoup.types.Router;
  cleanupTimer?: NodeJS.Timeout;
  transports: Map<string, mediasoup.types.WebRtcTransport>;
  producers: Map<string, mediasoup.types.Producer>;
  consumers: Map<string, mediasoup.types.Consumer>;
};

const rooms = new Map<string, RoomState>();

function validateProductionConfig() {
  if (process.env.NODE_ENV !== 'production') return;
  if (!jwtSecret || jwtSecret.length < 16 || /localhost|127\.0\.0\.1/i.test(jwtSecret)) throw new Error('JWT_SECRET must be a production-grade secret');
  if (!announcedIp || ['127.0.0.1', 'localhost'].includes(announcedIp)) throw new Error('ANNOUNCED_IP must be set to a public routable address in production');
}

function closeRoom(roomId: string, room: RoomState) {
  for (const consumer of room.consumers.values()) consumer.close();
  for (const producer of room.producers.values()) producer.close();
  for (const transport of room.transports.values()) transport.close();
  room.router.close();
  rooms.delete(roomId);
  log.info({ roomId }, 'empty media room cleaned up');
}

function scheduleRoomCleanup(roomId: string) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  room.cleanupTimer = setTimeout(() => {
    const activeSockets = io.sockets.adapter.rooms.get(roomId)?.size ?? 0;
    const current = rooms.get(roomId);
    if (current && activeSockets === 0) closeRoom(roomId, current);
  }, emptyRoomCleanupMs);
  room.cleanupTimer.unref();
}


async function getRoom(roomId: string): Promise<RoomState> {
  if (!worker) {
    worker = await mediasoup.createWorker({ rtcMinPort: 40000, rtcMaxPort: 40100 });
    worker.on('died', () => {
      log.fatal('mediasoup worker died');
      process.exit(1);
    });
  }
  const existing = rooms.get(roomId);
  if (existing) return existing;
  const router = await worker.createRouter({
    mediaCodecs: [
      { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
      { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, parameters: { 'x-google-start-bitrate': 1000 } },
    ],
  });
  const room: RoomState = { router, transports: new Map(), producers: new Map(), consumers: new Map() };
  rooms.set(roomId, room);
  return room;
}

io.use((socket, next) => {
  if (!jwtSecret) return next(new Error('JWT_SECRET is required'));
  try {
    socket.data.user = jwt.verify(String(socket.handshake.auth.token ?? ''), jwtSecret) as { role: string; sessionId?: string };
    next();
  } catch {
    next(new Error('Unauthorized'));
  }
});

io.on('connection', (socket) => {
  const user = socket.data.user as { role: string; sessionId?: string };
  const ownedTransports = new Set<string>();
  const ownedProducers = new Set<string>();
  const ownedConsumers = new Set<string>();
  const joinedRooms = new Set<string>();
  let eventWindowStartedAt = Date.now();
  let eventCount = 0;

  function isRateLimited(callback: (response: unknown) => void) {
    const now = Date.now();
    if (now - eventWindowStartedAt > 60_000) {
      eventWindowStartedAt = now;
      eventCount = 0;
    }
    eventCount += 1;
    if (eventCount <= socketEventLimit) return false;
    callback({ error: 'rate limit exceeded' });
    return true;
  }

  socket.on('join-room', async ({ roomId }, callback) => {
    if (isRateLimited(callback)) return;
    if (user.role === 'CUSTOMER' && user.sessionId !== roomId) return callback({ error: 'wrong session' });
    const room = await getRoom(roomId);
    socket.join(roomId);
    joinedRooms.add(roomId);
    if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
    callback({ rtpCapabilities: room.router.rtpCapabilities, existingProducers: [...room.producers.keys()] });
  });

  socket.on('create-transport', async ({ roomId }, callback) => {
    if (isRateLimited(callback)) return;
    if (user.role === 'CUSTOMER' && user.sessionId !== roomId) return callback({ error: 'wrong session' });
    const room = await getRoom(roomId);
    const transport = await room.router.createWebRtcTransport({
      listenIps: [announcedIp ? { ip: '0.0.0.0', announcedIp } : { ip: '0.0.0.0' }],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
    });
    room.transports.set(transport.id, transport);
    ownedTransports.add(transport.id);
    callback({ id: transport.id, iceParameters: transport.iceParameters, iceCandidates: transport.iceCandidates, dtlsParameters: transport.dtlsParameters, iceServers });
  });

  socket.on('connect-transport', async ({ roomId, transportId, dtlsParameters }, callback) => {
    if (isRateLimited(callback)) return;
    if (user.role === 'CUSTOMER' && user.sessionId !== roomId) return callback({ error: 'wrong session' });
    const transport = (await getRoom(roomId)).transports.get(transportId);
    if (!transport) return callback({ error: 'transport not found' });
    await transport.connect({ dtlsParameters });
    callback({ ok: true });
  });

  socket.on('produce', async ({ roomId, transportId, kind, rtpParameters }, callback) => {
    if (isRateLimited(callback)) return;
    if (user.role === 'CUSTOMER' && user.sessionId !== roomId) return callback({ error: 'wrong session' });
    const room = await getRoom(roomId);
    const transport = room.transports.get(transportId);
    if (!transport) return callback({ error: 'transport not found' });
    if (room.producers.size >= maxProducersPerRoom) return callback({ error: 'room producer limit reached' });
    const producer = await transport.produce({ kind, rtpParameters });
    room.producers.set(producer.id, producer);
    ownedProducers.add(producer.id);
    producer.on('transportclose', () => room.producers.delete(producer.id));
    socket.to(roomId).emit('new-producer', { producerId: producer.id, kind });
    callback({ id: producer.id });
  });

  socket.on('consume', async ({ roomId, transportId, producerId, rtpCapabilities }, callback) => {
    if (isRateLimited(callback)) return;
    if (user.role === 'CUSTOMER' && user.sessionId !== roomId) return callback({ error: 'wrong session' });
    const room = await getRoom(roomId);
    const transport = room.transports.get(transportId);
    if (!transport) return callback({ error: 'transport not found' });
    if (ownedConsumers.size >= maxConsumersPerSocket) return callback({ error: 'socket consumer limit reached' });
    if (!room.router.canConsume({ producerId, rtpCapabilities })) return callback({ error: 'cannot consume this producer' });
    const consumer = await transport.consume({ producerId, rtpCapabilities, paused: false });
    room.consumers.set(consumer.id, consumer);
    ownedConsumers.add(consumer.id);
    consumer.on('transportclose', () => room.consumers.delete(consumer.id));
    callback({ id: consumer.id, producerId, kind: consumer.kind, rtpParameters: consumer.rtpParameters });
  });

  socket.on('disconnect', () => {
    for (const room of rooms.values()) {
      for (const id of ownedConsumers) room.consumers.get(id)?.close();
      for (const id of ownedProducers) room.producers.get(id)?.close();
      for (const id of ownedTransports) room.transports.get(id)?.close();
    }
    for (const roomId of joinedRooms) scheduleRoomCleanup(roomId);
    log.info({ socketId: socket.id }, 'media socket disconnected');
  });
});

server.listen(process.env.PORT ?? 5000, () => log.info('media server listening'));

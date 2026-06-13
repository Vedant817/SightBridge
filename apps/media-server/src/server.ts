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

app.use(cors({ origin: corsOrigin }));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'media-server' }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: corsOrigin } });
let worker: mediasoup.types.Worker;

type RoomState = {
  router: mediasoup.types.Router;
  transports: Map<string, mediasoup.types.WebRtcTransport>;
  producers: Map<string, mediasoup.types.Producer>;
  consumers: Map<string, mediasoup.types.Consumer>;
};

const rooms = new Map<string, RoomState>();

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
  const room = { router, transports: new Map(), producers: new Map(), consumers: new Map() };
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

  socket.on('join-room', async ({ roomId }, callback) => {
    if (user.role === 'CUSTOMER' && user.sessionId !== roomId) return callback({ error: 'wrong session' });
    const room = await getRoom(roomId);
    socket.join(roomId);
    callback({ rtpCapabilities: room.router.rtpCapabilities, existingProducers: [...room.producers.keys()] });
  });

  socket.on('create-transport', async ({ roomId }, callback) => {
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
    callback({ id: transport.id, iceParameters: transport.iceParameters, iceCandidates: transport.iceCandidates, dtlsParameters: transport.dtlsParameters });
  });

  socket.on('connect-transport', async ({ roomId, transportId, dtlsParameters }, callback) => {
    if (user.role === 'CUSTOMER' && user.sessionId !== roomId) return callback({ error: 'wrong session' });
    const transport = (await getRoom(roomId)).transports.get(transportId);
    if (!transport) return callback({ error: 'transport not found' });
    await transport.connect({ dtlsParameters });
    callback({ ok: true });
  });

  socket.on('produce', async ({ roomId, transportId, kind, rtpParameters }, callback) => {
    if (user.role === 'CUSTOMER' && user.sessionId !== roomId) return callback({ error: 'wrong session' });
    const room = await getRoom(roomId);
    const transport = room.transports.get(transportId);
    if (!transport) return callback({ error: 'transport not found' });
    const producer = await transport.produce({ kind, rtpParameters });
    room.producers.set(producer.id, producer);
    ownedProducers.add(producer.id);
    producer.on('transportclose', () => room.producers.delete(producer.id));
    socket.to(roomId).emit('new-producer', { producerId: producer.id, kind });
    callback({ id: producer.id });
  });

  socket.on('consume', async ({ roomId, transportId, producerId, rtpCapabilities }, callback) => {
    if (user.role === 'CUSTOMER' && user.sessionId !== roomId) return callback({ error: 'wrong session' });
    const room = await getRoom(roomId);
    const transport = room.transports.get(transportId);
    if (!transport) return callback({ error: 'transport not found' });
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
    log.info({ socketId: socket.id }, 'media socket disconnected');
  });
});

server.listen(process.env.PORT ?? 5000, () => log.info('media server listening'));

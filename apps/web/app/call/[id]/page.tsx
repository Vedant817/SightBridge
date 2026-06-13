'use client';

import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';
import { api, API, token } from '../../../lib/api';
import { currentRole } from '../../../lib/auth';

const MEDIA = process.env.NEXT_PUBLIC_MEDIA_URL ?? 'http://localhost:5000';

type ChatMessage = { id?: string; senderRole: string; content: string; attachments?: { originalName: string }[] };

export default function Call({ params }: { params: { id: string } }) {
  const localVideo = useRef<HTMLVideoElement>(null);
  const remoteVideo = useRef<HTMLVideoElement>(null);
  const mediaSocket = useRef<Socket | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const role = currentRole();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [recordingStatus, setRecordingStatus] = useState('IDLE');
  const [status, setStatus] = useState('Connecting…');
  const [error, setError] = useState('');

  useEffect(() => {
    let appSocket: Socket | undefined;
    let localStream: MediaStream | undefined;
    let device: mediasoupClient.Device | undefined;
    let sendTransport: mediasoupClient.types.Transport | undefined;
    let receiveTransport: mediasoupClient.types.Transport | undefined;
    const remoteStream = new MediaStream();

    async function connectCall() {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        if (localVideo.current) localVideo.current.srcObject = localStream;
        if (remoteVideo.current) remoteVideo.current.srcObject = remoteStream;

        appSocket = io(API, { auth: { token: token() } });
        appSocket.emit('session:join', { sessionId: params.id });
        appSocket.on('chat:message', (message: ChatMessage) => setMessages((current) => [...current, message]));
        appSocket.on('recording:status', setRecordingStatus);
        appSocket.on('session:end', () => setError('This support session has ended.'));

        const socket = io(MEDIA, { auth: { token: token() } });
        mediaSocket.current = socket;
        const routerInfo = await emitWithAck(socket, 'join-room', { roomId: params.id });
        device = new mediasoupClient.Device();
        await device.load({ routerRtpCapabilities: routerInfo.rtpCapabilities });

        sendTransport = await createTransport(socket, params.id, device, 'send');
        receiveTransport = await createTransport(socket, params.id, device, 'recv');

        for (const track of localStream.getTracks()) {
          await sendTransport.produce({ track });
        }

        async function consumeProducer(producerId: string) {
          if (!device || !receiveTransport) return;
          const consumerInfo = await emitWithAck(socket, 'consume', {
            roomId: params.id,
            transportId: receiveTransport.id,
            producerId,
            rtpCapabilities: device.rtpCapabilities,
          });
          if (consumerInfo.error) return setError(consumerInfo.error);
          const consumer = await receiveTransport.consume(consumerInfo);
          remoteStream.addTrack(consumer.track);
        }

        for (const producerId of routerInfo.existingProducers ?? []) await consumeProducer(producerId);
        socket.on('new-producer', ({ producerId }: { producerId: string }) => consumeProducer(producerId));

        setStatus('Connected through SightBridge SFU');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Camera, microphone, or network setup failed.');
        setStatus('Connection failed');
      }
    }

    connectCall();
    return () => {
      appSocket?.close();
      mediaSocket.current?.close();
      sendTransport?.close();
      receiveTransport?.close();
      localStream?.getTracks().forEach((track) => track.stop());
    };
  }, [params.id]);

  async function createTransport(socket: Socket, roomId: string, device: mediasoupClient.Device, direction: 'send' | 'recv') {
    const transportOptions = await emitWithAck(socket, 'create-transport', { roomId, direction });
    const transport = direction === 'send' ? device.createSendTransport(transportOptions) : device.createRecvTransport(transportOptions);
    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      emitWithAck(socket, 'connect-transport', { roomId, transportId: transport.id, dtlsParameters }).then(() => callback()).catch(errback);
    });
    if (direction === 'send') {
      transport.on('produce', ({ kind, rtpParameters }, callback, errback) => {
        emitWithAck(socket, 'produce', { roomId, transportId: transport.id, kind, rtpParameters }).then(({ id }) => callback({ id })).catch(errback);
      });
    }
    return transport;
  }

  function emitWithAck(socket: Socket, event: string, payload: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      socket.timeout(10_000).emit(event, payload, (err: Error | null, response: unknown) => (err ? reject(err) : resolve(response)));
    });
  }

  function toggle(kind: 'audio' | 'video') {
    const stream = localVideo.current?.srcObject as MediaStream | null;
    stream?.getTracks().filter((track) => track.kind === kind).forEach((track) => (track.enabled = !track.enabled));
  }

  function sendMessage() {
    if (!text.trim()) return;
    const socket = io(API, { auth: { token: token() } });
    socket.emit('chat:send', { sessionId: params.id, content: text.trim() });
    setText('');
    setTimeout(() => socket.close(), 500);
  }

  async function startRecording() {
    await api(`/sessions/${params.id}/recordings/start`, { method: 'POST' });
    const stream = localVideo.current?.srcObject as MediaStream | null;
    if (!stream) throw new Error('No local media stream is available to record.');
    chunks.current = [];
    recorder.current = new MediaRecorder(stream, { mimeType: 'video/webm' });
    recorder.current.ondataavailable = (event) => chunks.current.push(event.data);
    recorder.current.start();
    setRecordingStatus('RECORDING');
  }

  async function stopRecording() {
    if (!recorder.current) return;
    recorder.current.onstop = async () => {
      const form = new FormData();
      form.append('file', new Blob(chunks.current, { type: 'video/webm' }), 'recording.webm');
      await fetch(`${API}/sessions/${params.id}/recordings/browser-upload`, { method: 'POST', headers: { authorization: `Bearer ${token()}` }, body: form });
      setRecordingStatus('READY');
    };
    recorder.current.stop();
  }

  async function uploadFile(file: File) {
    const form = new FormData();
    form.append('file', file);
    const response = await fetch(`${API}/sessions/${params.id}/upload`, { method: 'POST', headers: { authorization: `Bearer ${token()}` }, body: form });
    if (!response.ok) setError((await response.json()).error ?? 'Upload failed');
  }

  async function endCall() {
    await api(`/sessions/${params.id}/end`, { method: 'POST' });
    location.href = `/history/${params.id}`;
  }

  return (
    <div>
      <h1>Active support call</h1>
      <p>{status}</p>
      {error && <p className="err">{error}</p>}
      <div className="grid">
        <section className="card">
          <video ref={localVideo} autoPlay playsInline muted className="video" aria-label="Local camera" />
          <video ref={remoteVideo} autoPlay playsInline className="video" aria-label="Remote participant" />
          <button onClick={() => toggle('audio')}>Mute / unmute microphone</button>
          <button onClick={() => toggle('video')}>Camera on / off</button>
          {role === 'AGENT' && <button onClick={startRecording}>Start recording</button>}
          {role === 'AGENT' && <button onClick={stopRecording}>Stop recording</button>}
          {role === 'AGENT' && <button onClick={endCall}>End call</button>}
          <p>Recording: {recordingStatus}</p>
        </section>
        <aside className="card">
          <h2>Chat</h2>
          {messages.map((message, index) => (
            <p key={message.id ?? index}><b>{message.senderRole}</b>: {message.content} {message.attachments?.map((attachment) => `📎 ${attachment.originalName}`).join(' ')}</p>
          ))}
          <input value={text} onChange={(event) => setText(event.target.value)} maxLength={2000} placeholder="Type a message" />
          <button onClick={sendMessage}>Send</button>
          <input type="file" onChange={(event) => event.target.files?.[0] && uploadFile(event.target.files[0])} />
        </aside>
      </div>
    </div>
  );
}

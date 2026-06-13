'use client';

import { useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { api, API, token } from '../../lib/api';

type LiveSession = {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  participants: { id: string; displayName: string; role: string; status: string }[];
};

export default function Admin() {
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [error, setError] = useState('');

  async function loadSessions() {
    const all = await api<LiveSession[]>('/sessions');
    setSessions(all.filter((session) => session.status === 'ACTIVE'));
  }

  useEffect(() => {
    let socket: Socket | undefined;
    loadSessions().catch((err) => setError(err.message));
    socket = io(API, { auth: { token: token() } });
    socket.on('sessions:update', () => loadSessions().catch((err) => setError(err.message)));
    socket.on('presence:update', () => loadSessions().catch((err) => setError(err.message)));
    socket.on('session:end', () => loadSessions().catch((err) => setError(err.message)));
    return () => {
      socket?.close();
    };
  }, []);

  async function forceEnd(sessionId: string) {
    await api(`/sessions/${sessionId}/end`, { method: 'POST' });
    await loadSessions();
  }

  return (
    <section className="card">
      <h1>Admin live sessions</h1>
      {error && <p className="err">{error}</p>}
      {sessions.length === 0 && <p>No active sessions.</p>}
      {sessions.map((session) => (
        <article key={session.id}>
          <b>{session.title}</b> — {session.participants.map((participant) => `${participant.displayName} (${participant.role}: ${participant.status})`).join(', ')}
          <button onClick={() => forceEnd(session.id)}>Force end</button>
        </article>
      ))}
    </section>
  );
}

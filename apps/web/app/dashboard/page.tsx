'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

type SessionSummary = {
  id: string;
  title: string;
  status: string;
  recordingStatus: string;
  createdAt: string;
  participants: { id: string; displayName: string; role: string; status: string }[];
};

export default function Dashboard() {
  const [title, setTitle] = useState('');
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [invite, setInvite] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function loadSessions() {
    setSessions(await api<SessionSummary[]>('/sessions'));
  }

  useEffect(() => { loadSessions().catch((err) => setError(err.message)); }, []);

  async function createSession() {
    if (!title.trim()) return setError('Enter a short case title before creating a session.');
    setLoading(true);
    setError('');
    try {
      const session = await api<{ inviteUrl: string }>('/sessions', { method: 'POST', body: JSON.stringify({ title: title.trim() }) });
      setInvite(session.inviteUrl);
      setTitle('');
      await loadSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to create session');
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <h1>Agent dashboard</h1>
      {error && <p className="err">{error}</p>}
      <section className="card">
        <h2>Create support session</h2>
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Case title, e.g. Router setup issue" maxLength={120} />
        <button onClick={createSession} disabled={loading}>{loading ? 'Creating…' : 'Create session'}</button>
        {invite && <p>Customer invite: <a href={invite}>{invite}</a></p>}
      </section>
      <section className="card">
        <h2>Recent sessions</h2>
        {sessions.map((session) => (
          <article key={session.id}>
            <b>{session.title}</b> — {session.status} — recording {session.recordingStatus} — {session.participants.length} participants{' '}
            <Link href={`/call/${session.id}`}>open</Link> <Link href={`/history/${session.id}`}>history</Link>
          </article>
        ))}
      </section>
      <Link href="/admin">Live admin</Link>
    </>
  );
}

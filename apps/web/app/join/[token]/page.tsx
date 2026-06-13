'use client';

import { useState } from 'react';
import { API } from '../../../lib/api';

export default function Join({ params }: { params: { token: string } }) {
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function join() {
    if (!displayName.trim()) return setError('Enter your name so the agent knows who joined.');
    setLoading(true);
    setError('');
    const response = await fetch(`${API}/sessions/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: params.token, displayName: displayName.trim() }),
    });
    const body = await response.json();
    setLoading(false);
    if (!response.ok) return setError(body.error ?? 'Invite link is invalid, expired, already used, or the call has ended.');
    localStorage.setItem('token', body.token);
    window.location.assign(`/call/${body.sessionId}`);
  }

  return (
    <div className="card">
      <h1>Join SightBridge support call</h1>
      <p>Enter your name, then allow camera and microphone access when your browser asks.</p>
      <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Your name" maxLength={80} />
      <button onClick={join} disabled={loading}>{loading ? 'Joining…' : 'Join call'}</button>
      {error && <p className="err">{error}</p>}
    </div>
  );
}

'use client';

import { useState } from 'react';
import { api } from '../lib/api';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  async function login() {
    try {
      const response = await api<{ token: string }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      localStorage.setItem('token', response.token);
      location.href = '/dashboard';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    }
  }

  return (
    <div className="card">
      <h1>SightBridge</h1>
      <p>A self-hosted real-time video support platform.</p>
      <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Agent email" />
      <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Password" />
      <button onClick={login}>Agent login</button>
      {error && <p className="err">{error}</p>}
    </div>
  );
}

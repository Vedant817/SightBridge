'use client';

import { useEffect, useState } from 'react';
import { api, API, token } from '../../../lib/api';

type History = {
  id: string;
  title: string;
  status: string;
  recordingStatus: string;
  participants: { id: string; displayName: string; role: string; status: string }[];
  messages: { id: string; senderRole: string; content: string; attachments: { id: string; originalName: string; storageKey: string }[] }[];
  recordings: { id: string; status: string; storageKey?: string }[];
  events: { id: string; createdAt: string; type: string }[];
};

function objectUrl(sessionId: string, storageKey: string) {
  const [folder, name] = storageKey.split('/');
  return `${API}/sessions/${sessionId}/objects/${folder}/${name}?token=${token()}`;
}

export default function History({ params }: { params: { id: string } }) {
  const [session, setSession] = useState<History | undefined>();
  useEffect(() => { api(`/sessions/${params.id}/history`).then(setSession); }, [params.id]);
  if (!session) return <p>Loading…</p>;
  return (
    <div className="card">
      <h1>{session.title}</h1>
      <p>Status {session.status}; recording {session.recordingStatus}</p>
      <h2>Participants</h2>
      {session.participants.map((participant) => <p key={participant.id}>{participant.displayName} — {participant.role} — {participant.status}</p>)}
      <h2>Chat</h2>
      {session.messages.map((message) => (
        <p key={message.id}>
          <b>{message.senderRole}</b>: {message.content}{' '}
          {message.attachments.map((attachment) => <a key={attachment.id} href={objectUrl(session.id, attachment.storageKey)}>📎 {attachment.originalName}</a>)}
        </p>
      ))}
      <h2>Recordings</h2>
      {session.recordings.map((recording) => <p key={recording.id}>{recording.status} {recording.storageKey && <a href={objectUrl(session.id, recording.storageKey)}>Download</a>}</p>)}
      <h2>Events</h2>
      {session.events.map((event) => <p key={event.id}>{event.createdAt} — {event.type}</p>)}
    </div>
  );
}

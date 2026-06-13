export const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export function token() {
  if (typeof localStorage === 'undefined') return '';
  return localStorage.getItem('token') ?? '';
}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type') && typeof init.body === 'string') headers.set('content-type', 'application/json');
  const authToken = token();
  if (authToken) headers.set('authorization', `Bearer ${authToken}`);
  const response = await fetch(`${API}${path}`, { ...init, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(typeof body.error === 'string' ? body.error : 'Request failed');
  }
  return response.json() as Promise<T>;
}

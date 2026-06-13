import { token } from './api';

export function currentRole(): 'AGENT' | 'CUSTOMER' | undefined {
  const raw = token();
  if (!raw) return undefined;
  try {
    const payload = JSON.parse(atob(raw.split('.')[1]));
    return payload.role;
  } catch {
    return undefined;
  }
}

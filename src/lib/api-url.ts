/// <reference types="vite/client" />
import { Capacitor } from '@capacitor/core';
import { demoTestRecipient } from './demo-handoff.js';
import { buildConfiguration } from './build-configuration.js';

const apiOrigin = buildConfiguration.apiOrigin;
let invitation = '';
const invitationListeners = new Set<(accepted: boolean) => void>();

function setInvitation(code: string) {
  if (invitation === code) return;
  invitation = code;
  for (const listener of invitationListeners) listener(hasNativeDemoInvitation());
}

export function watchNativeDemoInvitation(listener: (accepted: boolean) => void) {
  invitationListeners.add(listener);
  listener(hasNativeDemoInvitation());
  return () => { invitationListeners.delete(listener); };
}

export const nativeDemoAccessEnabled = () => !!demoTestRecipient && typeof window !== 'undefined'
  && Capacitor.isNativePlatform() && /^https:\/\/[a-zA-Z0-9.-]+(:[0-9]+)?$/.test(apiOrigin);

export function apiUrl(path: `/api/${string}`) {
  return `${apiOrigin}${path}`;
}

function nativeApiUrl(path: `/api/${string}`) {
  const url = new URL(apiUrl(path));
  if (url.origin !== apiOrigin || !url.pathname.startsWith('/api/') || url.hash
    || path.includes('\\') || path.includes('\r') || path.includes('\n')) throw new Error('demo_api_path_refused');
  return url.href;
}

/** One transport for all API calls; never replace Report Bearer authorization. */
export function apiFetch(path: `/api/${string}`, init?: RequestInit): Promise<Response> {
  if (!nativeDemoAccessEnabled()) return fetch(apiUrl(path), init);
  const headers = new Headers(init?.headers);
  const requestInvitation = invitation;
  if (requestInvitation) headers.set('X-Bor-Demo-Invitation', requestInvitation);
  return fetch(nativeApiUrl(path), { ...init, headers, credentials: 'omit', redirect: 'error' }).then(response => {
    if (response.status === 401 && invitation === requestInvitation) setInvitation('');
    return response;
  });
}

export const hasNativeDemoInvitation = () => nativeDemoAccessEnabled() && invitation !== '';
export function clearNativeDemoInvitation() { setInvitation(''); }

/** The operator supplies the code privately. No device storage or bundled secret is used. */
export async function connectNativeDemo(code: string) {
  if (!nativeDemoAccessEnabled()) throw new Error('demo_native_only');
  if (!/^[a-f0-9]{64}$/.test(code)) throw new Error('demo_invitation_invalid');
  const response = await fetch(nativeApiUrl('/api/ready'), {
    headers: { 'X-Bor-Demo-Invitation': code }, credentials: 'omit', redirect: 'error',
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* Status still determines the access failure. */ }
    throw new Error(response.status === 401 || response.status === 403 ? 'demo_invitation_refused' : 'demo_unavailable');
  }
  const ready = await response.json();
  if (ready.status !== 'ready') throw new Error('demo_unavailable');
  setInvitation(code);
}

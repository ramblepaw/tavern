import { api } from './api.js';

const urlBase64ToUint8Array = (b64) => {
  const raw = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

async function registration() {
  return (await navigator.serviceWorker.getRegistration()) || (await navigator.serviceWorker.register('/sw.js'));
}

/**
 * 'on' | 'off' | 'denied' | 'needs-install' (iPhone, not on the Home Screen yet) |
 * 'needs-https' | 'unsupported'
 */
export async function pushStatus() {
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return 'needs-https';
  if (!('PushManager' in window) || !('Notification' in window)) return isIOS() && !isStandalone() ? 'needs-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    return sub && Notification.permission === 'granted' ? 'on' : 'off';
  } catch {
    return 'off';
  }
}

/** Must be called from a tap (iOS only shows the permission prompt for a user gesture). */
export async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications were not allowed. You can change this in your device settings.');
  const reg = await registration();
  await navigator.serviceWorker.ready;
  const { key } = await api.get('/api/push/key');
  const sub =
    (await reg.pushManager.getSubscription()) ||
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) }));
  await api.post('/api/push/subscribe', { subscription: sub.toJSON() });
}

export async function disablePush() {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await api.post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
    }
  } catch {}
}

/** On sign-in: re-register an existing subscription so it belongs to whoever is signed in now. */
export async function syncPush() {
  try {
    if ((await pushStatus()) === 'on') {
      const sub = await (await navigator.serviceWorker.getRegistration()).pushManager.getSubscription();
      await api.post('/api/push/subscribe', { subscription: sub.toJSON() });
    }
  } catch {}
}

export const sendTestPush = () => api.post('/api/push/test');

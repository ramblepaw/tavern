// Minimal history-based router. Routes live in the URL hash so they survive reloads
// and work with the browser back button.
//   /chats   /chat/:id   /chat/:id/m/:messageId   /characters   /me   /user/:id   /search   /search/:chatId

let lastTab = 'chats';
const listeners = [];

export function parseRoute() {
  const parts = location.hash.replace(/^#/, '').split('/').filter(Boolean);
  const [a, b, c, d] = parts;
  const id = /^\d+$/.test(b || '') ? Number(b) : null;
  if (a === 'chat' && id) {
    const focus = c === 'm' && /^\d+$/.test(d || '') ? Number(d) : null;
    return { tab: (lastTab = 'chats'), detail: { type: 'chat', id, focus } };
  }
  if (a === 'user' && id) return { tab: lastTab, detail: { type: 'user', id } };
  if (a === 'search') return { tab: (lastTab = 'chats'), detail: null, search: { chatId: id } };
  if (a === 'characters' || a === 'me') return { tab: (lastTab = a), detail: null };
  return { tab: (lastTab = 'chats'), detail: null };
}

export function go(path, { replace = false } = {}) {
  const n = (history.state?.n ?? 0) + (replace ? 0 : 1);
  history[replace ? 'replaceState' : 'pushState']({ n }, '', `#${path}`);
  listeners.forEach((fn) => fn());
}

/** Go back one step if the app has navigated before, otherwise jump to `fallback`. */
export function back(fallback = '/chats') {
  if ((history.state?.n ?? 0) > 0) history.back();
  else go(fallback, { replace: true });
}

export function onRoute(fn) {
  listeners.push(fn);
}

window.addEventListener('popstate', () => listeners.forEach((fn) => fn()));

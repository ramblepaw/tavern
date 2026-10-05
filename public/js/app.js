import { api } from './api.js';
import { state, emit, on, upsertChat, removeChat, sortChats, totalUnread } from './state.js';
import { go, parseRoute, onRoute } from './nav.js';
import { h, clear, icon, toast } from './util.js';
import { closeAllSheets, closeTopSheet } from './sheets.js';
import { renderChatList, ChatView } from './chats.js';
import { renderCharactersTab, renderMeTab, renderUser } from './profile.js';
import { renderSearch } from './search.js';
import { syncPush, disablePush } from './push.js';

const appEl = document.getElementById('app');

// ------------------------------------------------------------------ boot

async function boot() {
  fitViewport();
  registerServiceWorker();
  let session;
  try {
    session = await api.get('/api/session');
  } catch (e) {
    appEl.replaceChildren(h('div', { class: 'splash' }, h('p', { class: 'error' }, e.message), h('button', { class: 'btn', onclick: () => location.reload() }, 'Retry')));
    return;
  }
  if (session.user) await startApp(session.user);
  else renderAuth(session);
}

async function startApp(me) {
  state.me = me;
  try {
    const [{ chats }, { characters }] = await Promise.all([api.get('/api/chats'), api.get('/api/characters')]);
    state.chats = chats;
    state.characters = characters;
  } catch (e) {
    toast(e.message, true);
  }
  sortChats();
  buildShell();
  connectWs();
  updateBadge();
  syncPush();
  if (!location.hash || location.hash.startsWith('#/join')) go('/chats', { replace: true });
  renderRoute();
}

async function logout() {
  // Stop notifications for this device before the session goes away.
  await disablePush();
  teardown();
  api.post('/api/logout').catch(() => {});
  renderAuth({ needsSetup: false });
}

function teardown() {
  closeAllSheets();
  state.view?.destroy();
  state.view = null;
  state.me = null;
  state.chats = [];
  state.characters = [];
  clearTimeout(reconnectTimer);
  if (state.ws) {
    state.ws.onclose = null;
    state.ws.close();
    state.ws = null;
  }
  updateBadge();
}

window.addEventListener('tavern:logout', logout);
window.addEventListener('tavern:unauthorized', () => {
  if (state.me) {
    teardown();
    renderAuth({ needsSetup: false });
    toast('You were signed out. Please sign in again.', true);
  }
});

// ------------------------------------------------------------------ auth screen

function renderAuth({ needsSetup, openRegistration }) {
  document.title = 'Tavern';
  const joinCode = (location.hash.match(/^#\/join\/([a-z0-9]+)/i) || [])[1] || '';
  let mode = needsSetup || joinCode ? 'register' : 'login';
  const needsInvite = !needsSetup && !openRegistration;

  const draw = () => {
    const err = h('p', { class: 'error', hidden: true });
    const username = h('input', { type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true, maxlength: 24 });
    const password = h('input', { type: 'password', autocomplete: mode === 'login' ? 'current-password' : 'new-password', required: true, minlength: mode === 'login' ? 1 : 8 });
    const display = h('input', { type: 'text', maxlength: 32, autocomplete: 'nickname', placeholder: 'What should people call you?' });
    const invite = h('input', { type: 'text', autocapitalize: 'none', spellcheck: 'false', autocomplete: 'off', value: joinCode, placeholder: 'Ask whoever runs this server' });
    const submit = h('button', { class: 'btn primary wide', type: 'submit' }, mode === 'login' ? 'Sign in' : needsSetup ? 'Create admin account' : 'Create account');

    const form = h('form', { class: 'stack', onsubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true;
      err.hidden = true;
      try {
        const body = { username: username.value.trim(), password: password.value };
        if (mode === 'register') Object.assign(body, { displayName: display.value, invite: invite.value });
        const { user } = await api.post(mode === 'login' ? '/api/login' : '/api/register', body);
        await startApp(user);
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
        submit.disabled = false;
      }
    } },
      h('label', null, 'Username', username),
      mode === 'register' && h('label', null, 'Display name (optional)', display),
      h('label', null, 'Password', password),
      mode === 'register' && needsInvite && h('label', null, 'Invite code', invite),
      err,
      submit,
    );

    appEl.replaceChildren(
      h('div', { class: 'auth' },
        h('div', { class: 'auth-card' },
          h('img', { class: 'auth-logo', src: '/icons/icon.svg', alt: '' }),
          h('h1', null, 'Tavern'),
          h('p', { class: 'muted center' }, needsSetup ? 'Welcome! Create the first account. It will be the server admin.' : 'Roleplay chat, hosted by you.'),
          form,
          !needsSetup && h('p', { class: 'muted center small' },
            mode === 'login' ? 'Have an invite? ' : 'Already have an account? ',
            h('button', { class: 'link', type: 'button', onclick: () => { mode = mode === 'login' ? 'register' : 'login'; draw(); } }, mode === 'login' ? 'Create an account' : 'Sign in'),
          ),
        ),
      ),
    );
  };
  draw();
}

// ------------------------------------------------------------------ shell & routing

let shell, sidebarBody, detailEl, tabButtons;
let mountedKey = null;

function buildShell() {
  sidebarBody = h('div', { class: 'sidebar-body' });
  detailEl = h('main', { class: 'detail' });
  const tab = (id, label, ic) =>
    h('button', { class: 'tab', 'data-tab': id, onclick: () => go(`/${id}`) }, h('span', { class: 'tab-ic' }, icon(ic, 24), h('span', { class: 'tab-badge', hidden: true })), h('span', null, label));
  tabButtons = [tab('chats', 'Chats', 'chat'), tab('characters', 'Characters', 'mask'), tab('me', 'You', 'user')];
  shell = h('div', { class: 'shell' },
    h('aside', { class: 'sidebar' }, sidebarBody, h('nav', { class: 'tabbar' }, tabButtons)),
    detailEl,
  );
  appEl.replaceChildren(shell);
  mountedKey = null;
}

function renderSidebar() {
  if (!state.me) return;
  const { tab, search } = parseRoute();
  // The search screen keeps its own state (typed text, focus), so don't rebuild it on every chat update.
  const mode = search ? `search:${search.chatId ?? 'all'}` : '';
  if (mode && sidebarBody.dataset.mode === mode) return;
  sidebarBody.dataset.mode = mode;
  const scroll = sidebarBody.scrollTop;
  if (search) {
    renderSearch(sidebarBody, search.chatId);
    return;
  }
  if (tab === 'chats') renderChatList(sidebarBody);
  else if (tab === 'characters') renderCharactersTab(sidebarBody);
  else renderMeTab(sidebarBody);
  sidebarBody.scrollTop = scroll;
}

function renderRoute() {
  if (!state.me) return;
  const { tab, detail } = parseRoute();
  shell.classList.toggle('has-detail', !!detail);
  for (const b of tabButtons) b.classList.toggle('active', b.dataset.tab === tab);
  renderSidebar();

  const key = detail ? `${detail.type}:${detail.id}:${detail.focus ?? ''}` : '';
  if (key === mountedKey) return;
  mountedKey = key;
  closeAllSheets();
  state.view?.destroy();
  state.view = null;
  clear(detailEl);
  if (detail?.type === 'chat') {
    state.view = new ChatView(detail.id, detail.focus);
    detailEl.append(state.view.el);
  } else if (detail?.type === 'user') {
    renderUser(detailEl, detail.id);
  } else {
    detailEl.append(h('div', { class: 'placeholder' }, icon('chat', 56), h('p', null, 'Pick a chat to start roleplaying')));
  }
  updateTitle();
  reportView();
}

onRoute(renderRoute);

// Tell the server which chat is on screen so it doesn't send a notification for what you're already reading.
function reportView() {
  if (state.ws?.readyState !== 1) return;
  const chatId = document.visibilityState === 'visible' ? state.view?.id ?? null : null;
  state.ws.send(JSON.stringify({ type: 'view', chatId }));
}

// Tapping a notification while the app is already open.
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type === 'navigate' && state.me && typeof e.data.path === 'string') go(e.data.path);
});

on('chats', () => {
  renderSidebar();
  updateBadge();
});
on('characters', () => {
  renderSidebar();
  state.view?.updatePersona();
});
on('me', () => {
  renderSidebar();
  state.view?.updatePersona();
});
on('refresh-chats', refreshChats);

async function refreshChats() {
  if (!state.me) return;
  try {
    const { chats } = await api.get('/api/chats');
    state.chats = chats;
    sortChats();
    emit('chats');
    state.view?.onChatUpdated();
  } catch {}
}

function updateTitle() {
  const n = totalUnread();
  document.title = n ? `(${n}) Tavern` : 'Tavern';
}

function updateBadge() {
  updateTitle();
  const n = state.me ? totalUnread() : 0;
  tabButtons?.[0]?.querySelector('.tab-badge') && Object.assign(tabButtons[0].querySelector('.tab-badge'), { hidden: !n, textContent: n > 99 ? '99+' : n });
  if ('setAppBadge' in navigator) (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
}

// ------------------------------------------------------------------ realtime

let reconnectTimer;
let attempts = 0;
let everConnected = false;

function connectWs() {
  if (!state.me || state.ws) return;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  state.ws = ws;
  ws.onmessage = (e) => {
    let ev;
    try {
      ev = JSON.parse(e.data);
    } catch {
      return;
    }
    handleEvent(ev);
  };
  ws.onclose = () => {
    if (state.ws === ws) state.ws = null;
    if (!state.me) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWs, Math.min(30_000, 1000 * 2 ** attempts++));
  };
  ws.onerror = () => ws.close();
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'ready':
      attempts = 0;
      reportView();
      if (everConnected) {
        refreshChats();
        state.view?.syncLatest();
      }
      everConnected = true;
      break;
    case 'message:new': {
      const m = ev.message;
      const chat = state.chats.find((c) => c.id === m.chatId);
      if (!chat) return refreshChats();
      const viewing = state.view?.id === m.chatId && document.visibilityState === 'visible';
      chat.last = {
        id: m.id,
        author: m.character?.name || m.author.displayName,
        text: m.body.slice(0, 200),
        hasImage: m.images.length > 0,
        createdAt: m.createdAt,
      };
      chat.updatedAt = m.createdAt;
      if (m.author.id !== state.me.id && !viewing) chat.unread++;
      sortChats();
      emit('chats');
      if (state.view?.id === m.chatId) state.view.addMessage(m);
      break;
    }
    case 'message:edit':
      if (state.view?.id === ev.message.chatId) state.view.updateMessage(ev.message);
      refreshChats();
      break;
    case 'message:delete':
      if (state.view?.id === ev.chatId) state.view.removeMessage(ev.id);
      refreshChats();
      break;
    case 'chat:changed':
      refreshChats();
      break;
    case 'chat:removed': {
      const wasViewing = state.view?.id === ev.chatId;
      removeChat(ev.chatId);
      if (wasViewing) {
        go('/chats', { replace: true });
        toast('That chat is no longer available.');
      }
      break;
    }
    case 'typing':
      if (state.view?.id === ev.chatId) state.view.onTyping(ev);
      break;
  }
}

// iOS suspends sockets when the app is backgrounded; reconnect and catch up when it returns.
document.addEventListener('visibilitychange', () => {
  if (!state.me) return;
  reportView();
  if (document.visibilityState !== 'visible') return;
  if (!state.ws || state.ws.readyState > 1) {
    clearTimeout(reconnectTimer);
    state.ws = null;
    connectWs();
  } else {
    refreshChats();
    state.view?.syncLatest();
  }
  state.view?.markRead();
});
window.addEventListener('online', () => {
  if (state.me && !state.ws) {
    clearTimeout(reconnectTimer);
    connectWs();
  }
});

// ------------------------------------------------------------------ viewport (iOS keyboard) & PWA

function fitViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  const apply = () => {
    root.style.setProperty('--app-h', `${vv.height}px`);
    root.style.setProperty('--app-top', `${vv.offsetTop}px`);
    // The on-screen keyboard shrinks the visual viewport; drop the home-indicator padding while it's open.
    root.classList.toggle('keyboard', window.innerHeight - vv.height > 120);
  };
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  apply();
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

boot();

export const state = {
  me: null,
  chats: [],
  characters: [],
  view: null, // the mounted ChatView, if any
  ws: null, // the live WebSocket, if connected
};

const bus = new EventTarget();
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));
export const on = (name, fn) => bus.addEventListener(name, (e) => fn(e.detail));

export function sortChats() {
  state.chats.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function upsertChat(chat) {
  const i = state.chats.findIndex((c) => c.id === chat.id);
  if (i >= 0) state.chats[i] = chat;
  else state.chats.push(chat);
  sortChats();
  emit('chats');
}

export function removeChat(id) {
  state.chats = state.chats.filter((c) => c.id !== id);
  emit('chats');
}

export const totalUnread = () => state.chats.reduce((n, c) => n + c.unread, 0);

export const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
export const isIOS = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

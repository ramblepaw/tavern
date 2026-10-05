import { api } from './api.js';
import { state } from './state.js';
import { go, back } from './nav.js';
import { h, clear, append, icon, listTime } from './util.js';
import { chatAvatar, chatTitle } from './chats.js';

// Keep the last search so coming back from a result shows it again.
let last = { scope: null, query: '', results: [], hasMore: false };

/** Turn a snippet with \u0001…\u0002 highlight markers into DOM nodes (never HTML). */
function highlight(snippet) {
  const out = [];
  const tidy = (s) => s.replace(/[*_~|]/g, '');
  let i = 0;
  for (const m of snippet.matchAll(/\u0001(.*?)\u0002/gs)) {
    if (m.index > i) out.push(tidy(snippet.slice(i, m.index)));
    out.push(h('mark', null, tidy(m[1])));
    i = m.index + m[0].length;
  }
  if (i < snippet.length) out.push(tidy(snippet.slice(i)));
  return out;
}

export function renderSearch(el, chatId) {
  const scope = chatId ?? 'all';
  if (last.scope !== scope) last = { scope, query: '', results: [], hasMore: false };
  const chat = chatId ? state.chats.find((c) => c.id === chatId) : null;

  const input = h('input', {
    type: 'search', placeholder: chat ? `Search in ${chatTitle(chat)}` : 'Search all your chats', value: last.query,
    autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', enterkeyhint: 'search', 'aria-label': 'Search messages',
  });
  const list = h('div', { class: 'list' });
  const status = h('p', { class: 'muted center pad' });
  const more = h('button', { class: 'btn small', hidden: true }, 'Show more');

  append(
    clear(el),
    h('header', { class: 'topbar' },
      h('button', { class: 'icon-btn', 'aria-label': 'Back', onclick: () => back('/chats') }, icon('back')),
      h('div', { class: 'grow search-field' }, input),
    ),
    chat && h('div', { class: 'search-scope' }, 'Only in this chat. ', h('button', { class: 'link', onclick: () => go('/search', { replace: true }) }, 'Search all chats')),
    list, status, h('div', { class: 'center pad' }, more),
  );

  let token = 0;
  async function run(append = false) {
    const q = input.value.trim();
    const mine = ++token;
    if (!q) {
      last = { scope, query: '', results: [], hasMore: false };
      return draw();
    }
    status.textContent = 'Searching…';
    try {
      const params = new URLSearchParams({ q });
      if (chatId) params.set('chat', chatId);
      if (append && last.results.length) params.set('before', last.results.at(-1).id);
      const { results, hasMore } = await api.get(`/api/search?${params}`);
      if (mine !== token) return;
      last = { scope, query: q, results: append ? [...last.results, ...results] : results, hasMore };
    } catch (e) {
      if (mine !== token) return;
      status.textContent = e.message;
      return;
    }
    draw();
  }

  function draw() {
    clear(list);
    const q = input.value.trim();
    status.textContent = !q ? 'Type to search your messages.' : last.results.length ? '' : 'No messages found.';
    more.hidden = !last.hasMore;
    for (const r of last.results) {
      const c = state.chats.find((x) => x.id === r.chatId);
      list.append(
        h('a', { class: 'row result', href: `#/chat/${r.chatId}/m/${r.id}`, onclick: (e) => {
          e.preventDefault();
          go(`/chat/${r.chatId}/m/${r.id}`);
        } },
          !chatId && c && chatAvatar(c, 40),
          h('div', { class: 'row-main' },
            h('div', { class: 'row-top' },
              h('span', { class: 'row-title' }, chatId ? r.author : `${c ? chatTitle(c) : 'Chat'} · ${r.author}`),
              h('time', { class: 'row-time' }, listTime(r.createdAt)),
            ),
            h('div', { class: 'result-snippet' }, highlight(r.snippet)),
          ),
        ),
      );
    }
  }

  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => run(), 250);
  });
  more.addEventListener('click', () => run(true));
  draw();
  if (!last.results.length) input.focus();
}

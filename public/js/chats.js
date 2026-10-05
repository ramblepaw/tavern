import { api } from './api.js';
import { state, emit, upsertChat, removeChat } from './state.js';
import { go, back, parseRoute } from './nav.js';
import { h, clear, avatarEl, icon, toast, listTime, timeShort, dateLong, sameDay, mediaUrl, debounce } from './util.js';
import { openSheet, confirmSheet, lightbox } from './sheets.js';
import { userPicker } from './components.js';
import { formatBody } from './format.js';
import { characterSheet } from './profile.js';

// ------------------------------------------------------------------ chat helpers

export const otherMember = (chat) => chat.members.find((m) => m.id !== state.me.id) || chat.members[0];
export const chatTitle = (chat) => (chat.isDm ? otherMember(chat).displayName : chat.name || 'Chat');

export function chatAvatar(chat, size) {
  if (chat.isDm) {
    const o = otherMember(chat);
    return avatarEl(o.avatar, o.displayName, o.color, size);
  }
  return avatarEl(null, chat.name, `hsl(${(chat.id * 67) % 360} 50% 45%)`, size);
}

const plain = (s) => s.replace(/[*_~|]/g, '').replace(/\s+/g, ' ').trim();

function previewText(chat) {
  if (!chat.last) return 'No messages yet';
  const text = plain(chat.last.text) || (chat.last.hasImage ? 'Photo' : '');
  return `${chat.last.author}: ${text}`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Copied');
}

// ------------------------------------------------------------------ chat list (sidebar tab)

export function renderChatList(el) {
  const active = parseRoute().detail;
  clear(el).append(
    h('header', { class: 'topbar' },
      h('h1', { class: 'grow' }, 'Chats'),
      h('button', { class: 'icon-btn accent', 'aria-label': 'Search messages', onclick: () => go('/search') }, icon('search', 22)),
      h('button', { class: 'icon-btn accent', 'aria-label': 'New chat', onclick: newChatSheet }, icon('plus', 22)),
    ),
  );
  if (!state.chats.length) {
    el.append(
      h('div', { class: 'empty' },
        icon('chat', 44),
        h('h3', null, 'No chats yet'),
        h('p', null, 'Start a conversation with a friend, or make a group chat for your next story.'),
        h('button', { class: 'btn primary', onclick: newChatSheet }, 'New chat'),
      ),
    );
    return;
  }
  el.append(
    h('div', { class: 'list' },
      state.chats.map((chat) =>
        h('a', {
          class: `row chat-row${active?.type === 'chat' && active.id === chat.id ? ' active' : ''}`,
          href: `#/chat/${chat.id}`,
          onclick: (e) => {
            e.preventDefault();
            go(`/chat/${chat.id}`);
          },
        },
          chatAvatar(chat, 52),
          h('div', { class: 'row-main' },
            h('div', { class: 'row-top' },
              h('span', { class: 'row-title' }, chatTitle(chat)),
              h('time', { class: 'row-time' }, listTime(chat.last?.createdAt ?? chat.updatedAt)),
            ),
            h('div', { class: 'row-top' },
              h('span', { class: 'row-preview' }, previewText(chat)),
              chat.unread > 0 && h('span', { class: 'badge' }, chat.unread > 99 ? '99+' : chat.unread),
            ),
          ),
        ),
      ),
    ),
  );
}

// ------------------------------------------------------------------ new chat

export function newChatSheet() {
  openSheet('New chat', (close) => {
    const picked = [];
    const chips = h('div', { class: 'chips' });
    const name = h('input', { type: 'text', maxlength: 60, placeholder: 'Group name (leave empty for a direct message)', autocomplete: 'off' });
    const desc = h('textarea', { rows: 2, maxlength: 500, placeholder: 'What’s this chat about? (optional)' });
    const err = h('p', { class: 'error', hidden: true });
    const create = h('button', { class: 'btn primary', type: 'submit' }, 'Start chat');

    const renderChips = () => {
      clear(chips);
      for (const u of picked) {
        chips.append(h('button', { type: 'button', class: 'chip', onclick: () => {
          picked.splice(picked.indexOf(u), 1);
          renderChips();
        } }, u.displayName, ' ✕'));
      }
      const group = picked.length > 1 || name.value.trim();
      desc.parentElement && (desc.parentElement.hidden = !group);
    };
    const picker = userPicker({ onPick: (u) => { picked.push(u); renderChips(); }, exclude: () => picked.map((u) => u.id) });
    name.addEventListener('input', renderChips);

    const form = h('form', { class: 'stack', onsubmit: async (e) => {
      e.preventDefault();
      err.hidden = true;
      if (!picked.length) {
        err.textContent = 'Pick at least one person first.';
        err.hidden = false;
        return;
      }
      create.disabled = true;
      try {
        const { chat } = await api.post('/api/chats', {
          members: picked.map((u) => u.username),
          name: name.value,
          description: desc.value,
        });
        upsertChat(chat);
        close();
        go(`/chat/${chat.id}`);
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
        create.disabled = false;
      }
    } },
      h('label', null, 'Who’s joining?', picker.el),
      chips,
      h('label', null, 'Name', name),
      h('label', { hidden: true }, 'Description', desc),
      err,
      h('div', { class: 'row-end' }, create),
    );
    return form;
  });
}

// ------------------------------------------------------------------ chat view

const FIVE_MIN = 5 * 60_000;

export class ChatView {
  constructor(chatId, focusId = null) {
    this.id = chatId;
    this.focusId = focusId; // message to scroll to (from a search result)
    this.detached = false; // true while showing an older window instead of the latest messages
    this.messages = [];
    this.hasMore = false;
    this.loadingOlder = false;
    this.loaded = false;
    this.stick = true;
    this.files = [];
    this.sending = false;
    this.typers = new Map();
    this.lastTypingSent = 0;
    this.personaId = localStorage.getItem(`persona:${chatId}`) || '';
    this.markRead = debounce(() => this._markRead(), 400);
    this.el = h('section', { class: 'chat' });
    this.build();
    this.load();
  }

  get chat() {
    return state.chats.find((c) => c.id === this.id);
  }

  // ---- construction

  build() {
    this.headAvatar = h('div', { class: 'head-avatar' });
    this.titleEl = h('div', { class: 'chat-title' });
    this.subEl = h('div', { class: 'chat-sub' });
    this.header = h('header', { class: 'topbar' },
      h('button', { class: 'icon-btn back-btn', 'aria-label': 'Back', onclick: () => back('/chats') }, icon('back')),
      h('button', { class: 'head-main', onclick: () => this.infoSheet() }, this.headAvatar, h('div', { class: 'grow' }, this.titleEl, this.subEl)),
      h('button', { class: 'icon-btn', 'aria-label': 'Search this chat', onclick: () => go(`/search/${this.id}`) }, icon('search')),
      h('button', { class: 'icon-btn', 'aria-label': 'Chat info', onclick: () => this.infoSheet() }, icon('info')),
    );

    this.topEl = h('div', { class: 'older' });
    this.list = h('div', { class: 'messages-inner' });
    this.scroller = h('div', { class: 'messages', onscroll: () => this.onScroll() }, this.topEl, this.list);
    this.jumpBtn = h('button', { class: 'jump', hidden: true, onclick: () => (this.detached ? this.jumpLatest() : this.scrollToBottom(true)) }, icon('down', 16), ' Latest');
    this.typingEl = h('div', { class: 'typing' });

    this.list.addEventListener('click', (e) => {
      const spoiler = e.target.closest('[data-spoiler]');
      if (spoiler) spoiler.classList.toggle('revealed');
    });
    // Images finishing loading can push content down; keep pinned to the bottom if we were.
    this.list.addEventListener('load', () => this.stick && this.scrollToBottom(), true);

    this.buildComposer();
    this.el.append(this.header, h('div', { class: 'messages-wrap' }, this.scroller, this.jumpBtn), this.typingEl, this.composer);
    this.updateHeader();
  }

  buildComposer() {
    this.input = h('textarea', {
      rows: 1, maxlength: 8000, enterkeyhint: 'enter', autocomplete: 'off', 'aria-label': 'Message',
      oninput: () => {
        this.autogrow();
        this.sendTyping();
        this.updateSendState();
        localStorage.setItem(`draft:${this.id}`, this.input.value);
      },
      onkeydown: (e) => {
        const desktop = matchMedia('(hover: hover) and (pointer: fine)').matches;
        if (e.key === 'Enter' && !e.shiftKey && desktop && !e.isComposing) {
          e.preventDefault();
          this.send();
        }
      },
    });
    this.input.value = localStorage.getItem(`draft:${this.id}`) || '';
    this.fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onchange: () => this.addFiles(this.fileInput.files) });
    this.previews = h('div', { class: 'previews', hidden: true });
    this.personaBtn = h('button', { class: 'persona-btn', type: 'button', onclick: () => this.personaSheet(), onpointerdown: (e) => e.preventDefault() });
    this.sendBtn = h('button', { class: 'send-btn', type: 'button', 'aria-label': 'Send', onclick: () => this.send(), onpointerdown: (e) => e.preventDefault() }, icon('send', 20));
    this.composer = h('div', { class: 'composer' },
      this.previews,
      h('div', { class: 'composer-row' },
        this.personaBtn,
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Attach pictures', onclick: () => this.fileInput.click(), onpointerdown: (e) => e.preventDefault() }, icon('image', 24)),
        this.input,
        this.sendBtn,
      ),
      this.fileInput,
    );
    this.updatePersona();
    this.autogrow();
    this.updateSendState();
  }

  destroy() {
    for (const t of this.typers.values()) clearTimeout(t.timer);
    this.files.forEach((f) => URL.revokeObjectURL(f.url));
    this.destroyed = true;
  }

  // ---- header

  updateHeader() {
    const chat = this.chat;
    clear(this.headAvatar);
    if (!chat) {
      this.titleEl.textContent = 'Loading…';
      this.subEl.textContent = '';
      return;
    }
    this.headAvatar.append(chatAvatar(chat, 38));
    this.titleEl.textContent = chatTitle(chat);
    this.baseSub = chat.isDm ? `@${otherMember(chat).username}` : chat.members.map((m) => m.displayName).join(', ');
    this.subEl.textContent = this.baseSub;
  }

  onChatUpdated() {
    this.updateHeader();
    this.updatePersona();
    this.infoRender?.();
  }

  // ---- loading & syncing

  async load() {
    try {
      const focus = this.focusId;
      const [{ chat }, page] = await Promise.all([
        api.get(`/api/chats/${this.id}`),
        api.get(`/api/chats/${this.id}/messages?${focus ? `around=${focus}` : 'limit=50'}`),
      ]);
      if (this.destroyed) return;
      upsertChat(chat);
      this.messages = page.messages;
      this.hasMore = page.hasMore;
      this.detached = !!page.hasNewer;
      this.loaded = true;
      this.renderAll();
      this.updateHeader();
      const target = focus && this.list.querySelector(`[data-id="${focus}"]`);
      if (target) {
        this.stick = false;
        target.scrollIntoView({ block: 'center' });
        target.classList.add('flash');
        this.jumpBtn.hidden = !this.detached;
      } else {
        if (focus) toast('That message no longer exists.', true);
        this.stick = true;
        this.scrollToBottom();
      }
      if (!this.detached) this.markRead();
    } catch (e) {
      if (this.destroyed) return;
      if (e.status === 404) {
        toast('That chat is no longer available.', true);
        go('/chats', { replace: true });
      } else {
        clear(this.list).append(h('div', { class: 'empty' }, h('p', { class: 'error' }, e.message), h('button', { class: 'btn', onclick: () => this.load() }, 'Try again')));
      }
    }
  }

  /** Leave a search-result window and show the newest messages again. */
  jumpLatest() {
    this.focusId = null;
    this.detached = false;
    this.jumpBtn.hidden = true;
    return this.load();
  }

  /** Catch up on anything missed while offline / backgrounded. */
  async syncLatest() {
    if (this.detached) return;
    if (!this.loaded) return this.load();
    try {
      const last = this.messages.at(-1)?.id ?? 0;
      const { messages } = await api.get(`/api/chats/${this.id}/messages?after=${last}`);
      messages.forEach((m) => this.addMessage(m));
      this.markRead();
    } catch {}
  }

  async loadOlder() {
    if (this.loadingOlder || !this.hasMore || !this.messages.length) return;
    this.loadingOlder = true;
    this.topEl.textContent = 'Loading earlier messages…';
    try {
      const { messages, hasMore } = await api.get(`/api/chats/${this.id}/messages?before=${this.messages[0].id}&limit=50`);
      const prevHeight = this.scroller.scrollHeight;
      this.messages = [...messages, ...this.messages];
      this.hasMore = hasMore;
      this.renderAll();
      this.scroller.scrollTop += this.scroller.scrollHeight - prevHeight;
    } catch (e) {
      toast(e.message, true);
    } finally {
      this.loadingOlder = false;
      this.topEl.textContent = '';
    }
  }

  async _markRead() {
    if (this.destroyed || this.detached || document.visibilityState !== 'visible') return;
    const chat = this.chat;
    try {
      await api.post(`/api/chats/${this.id}/read`);
      if (chat && chat.unread) {
        chat.unread = 0;
        emit('chats');
      }
    } catch {}
  }

  // ---- rendering messages

  renderAll() {
    clear(this.list);
    this.hasRP = this.messages.some((m) => m.character);
    this.topEl.textContent = '';
    if (this.hasMore) this.topEl.append(h('button', { class: 'btn small', onclick: () => this.loadOlder() }, 'Load earlier messages'));
    else if (this.loaded) this.topEl.append(h('p', { class: 'muted small center' }, this.messages.length ? 'This is the start of the chat.' : 'No messages yet. Say something!'));
    let prev = null;
    for (const m of this.messages) {
      this.list.append(...this.rowFor(m, prev));
      prev = m;
    }
    if (this.detached) {
      this.list.append(h('div', { class: 'center pad' }, h('button', { class: 'btn small', onclick: () => this.jumpLatest() }, 'Jump to latest messages')));
    }
  }

  rowFor(m, prev) {
    const out = [];
    const newDay = !prev || !sameDay(prev.createdAt, m.createdAt);
    if (newDay) out.push(h('div', { class: 'day' }, h('span', null, dateLong(m.createdAt))));
    const compact =
      !newDay && prev.author.id === m.author.id && (prev.character?.name ?? null) === (m.character?.name ?? null) &&
      m.createdAt - prev.createdAt < FIVE_MIN;
    out.push(this.messageEl(m, compact));
    return out;
  }

  messageEl(m, compact) {
    const who = m.character ? m.character.name : m.author.displayName;
    const colour = m.character ? m.character.color : m.author.color;
    const avatar = m.character ? m.character.avatar : m.author.avatar;
    const mine = m.author.id === state.me.id;
    const n = m.images.length;

    return h('article', { class: `msg${compact ? ' compact' : ''}${mine ? ' mine' : ''}`, 'data-id': m.id },
      compact
        ? h('div', { class: 'msg-gutter' }, h('time', null, timeShort(m.createdAt)))
        : h('button', { class: 'msg-avatar', 'aria-label': `${m.author.displayName}'s profile`, onclick: () => go(`/user/${m.author.id}`) }, avatarEl(avatar, who, colour, 40)),
      h('div', { class: 'msg-main' },
        !compact && h('div', { class: 'msg-head' },
          h('span', { class: 'msg-name', style: { color: colour } }, who),
          m.character
            ? h('span', { class: 'msg-by' }, `by ${m.author.displayName}`)
            : this.hasRP && h('span', { class: 'tag' }, 'OOC'),
          h('time', null, timeShort(m.createdAt)),
        ),
        m.body && h('div', { class: 'msg-body', html: formatBody(m.body) }),
        n > 0 && h('div', { class: `msg-images n${Math.min(n, 4)}` },
          m.images.map((img) =>
            h('button', {
              class: 'img-btn', 'aria-label': 'View picture',
              style: n === 1 ? { aspectRatio: `${img.w} / ${img.h}` } : {},
              onclick: () => lightbox(mediaUrl(img.file)),
            }, h('img', { src: mediaUrl(img.file), alt: 'Picture', loading: 'lazy' })),
          ),
        ),
        m.editedAt && h('span', { class: 'edited' }, 'edited'),
      ),
      h('button', { class: 'msg-more', 'aria-label': 'Message options', onclick: () => this.messageMenu(m) }, icon('more', 18)),
    );
  }

  addMessage(m) {
    if (this.messages.some((x) => x.id === m.id)) return;
    if (this.detached) {
      // We're looking at older history; don't splice new messages into the middle of it.
      this.jumpBtn.hidden = false;
      return;
    }
    const prev = this.messages.at(-1) || null;
    this.messages.push(m);
    const mine = m.author.id === state.me.id;
    const wasRP = this.hasRP;
    if (m.character && !wasRP) this.renderAll();
    else {
      if (!prev) this.renderAll();
      else this.list.append(...this.rowFor(m, prev));
    }
    if (mine || this.stick) this.scrollToBottom(true);
    else this.jumpBtn.hidden = false;
    const typer = this.typers.get(m.author.id);
    if (typer) {
      clearTimeout(typer.timer);
      this.typers.delete(m.author.id);
      this.updateTyping();
    }
    this.markRead();
  }

  updateMessage(m) {
    const i = this.messages.findIndex((x) => x.id === m.id);
    if (i < 0) return;
    this.messages[i] = m;
    this.renderAll();
  }

  removeMessage(id) {
    const before = this.messages.length;
    this.messages = this.messages.filter((m) => m.id !== id);
    if (this.messages.length !== before) this.renderAll();
  }

  // ---- scrolling

  onScroll() {
    const s = this.scroller;
    const fromBottom = s.scrollHeight - s.scrollTop - s.clientHeight;
    this.stick = fromBottom < 80;
    this.jumpBtn.hidden = !this.detached && fromBottom < 300;
    if (s.scrollTop < 120) this.loadOlder();
  }

  scrollToBottom(smooth = false) {
    this.scroller.scrollTo({ top: this.scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    this.stick = true;
    this.jumpBtn.hidden = !this.detached;
  }

  // ---- typing indicator

  sendTyping() {
    const now = Date.now();
    if (now - this.lastTypingSent < 3000 || !this.input.value || state.ws?.readyState !== 1) return;
    this.lastTypingSent = now;
    state.ws.send(JSON.stringify({ type: 'typing', chatId: this.id }));
  }

  onTyping({ userId, name }) {
    const old = this.typers.get(userId);
    if (old) clearTimeout(old.timer);
    this.typers.set(userId, {
      name,
      timer: setTimeout(() => {
        this.typers.delete(userId);
        this.updateTyping();
      }, 4500),
    });
    this.updateTyping();
  }

  updateTyping() {
    const names = [...this.typers.values()].map((t) => t.name);
    this.typingEl.textContent =
      names.length === 0 ? '' : names.length === 1 ? `${names[0]} is typing…` : names.length === 2 ? `${names[0]} and ${names[1]} are typing…` : 'Several people are typing…';
    if (names.length && this.stick) this.scrollToBottom();
  }

  // ---- composer

  autogrow() {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(this.input.scrollHeight, 150)}px`;
  }

  updateSendState() {
    this.sendBtn.disabled = this.sending || (!this.input.value.trim() && !this.files.length);
  }

  currentCharacter() {
    return state.characters.find((c) => String(c.id) === this.personaId) || null;
  }

  updatePersona() {
    const ch = this.currentCharacter();
    if (this.personaId && !ch) this.personaId = '';
    clear(this.personaBtn).append(
      ch ? avatarEl(ch.avatar, ch.name, ch.color, 34) : avatarEl(state.me.avatar, state.me.displayName, state.me.color, 34),
    );
    this.personaBtn.setAttribute('aria-label', ch ? `Posting as ${ch.name}. Change character` : 'Posting as yourself. Change character');
    this.input.placeholder = ch ? `Message as ${ch.name}` : state.characters.length ? 'Message (out of character)' : 'Message';
  }

  setPersona(id) {
    this.personaId = id ? String(id) : '';
    localStorage.setItem(`persona:${this.id}`, this.personaId);
    this.updatePersona();
  }

  personaSheet() {
    openSheet('Post as…', (close) => {
      const pick = (id) => () => {
        this.setPersona(id);
        close();
        this.input.focus();
      };
      const row = (active, avatar, title, sub, onclick) =>
        h('button', { class: `row${active ? ' active' : ''}`, onclick }, avatar,
          h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, title), h('div', { class: 'row-preview' }, sub)),
          active && h('span', { class: 'check' }, '✓'));
      return h('div', { class: 'stack' },
        h('div', { class: 'list' },
          row(!this.personaId, avatarEl(state.me.avatar, state.me.displayName, state.me.color, 44), state.me.displayName, 'You, out of character', pick('')),
          state.characters.map((c) => row(String(c.id) === this.personaId, avatarEl(c.avatar, c.name, c.color, 44), c.name, c.bio ? c.bio.split('\n')[0] : 'Character', pick(c.id))),
        ),
        h('button', { class: 'btn', onclick: () => { close(); characterSheet(); } }, icon('plus', 16), ' New character'),
      );
    });
  }

  addFiles(fileList) {
    for (const file of fileList) {
      if (this.files.length >= 4) {
        toast('You can attach up to 4 pictures per message.', true);
        break;
      }
      if (!file.type.startsWith('image/')) continue;
      this.files.push({ file, url: URL.createObjectURL(file) });
    }
    this.fileInput.value = '';
    this.renderPreviews();
  }

  renderPreviews() {
    clear(this.previews);
    this.previews.hidden = !this.files.length;
    for (const f of this.files) {
      this.previews.append(
        h('div', { class: 'preview' },
          h('img', { src: f.url, alt: '' }),
          h('button', { class: 'preview-x', type: 'button', 'aria-label': 'Remove picture', onclick: () => {
            URL.revokeObjectURL(f.url);
            this.files = this.files.filter((x) => x !== f);
            this.renderPreviews();
          } }, '✕'),
        ),
      );
    }
    this.updateSendState();
  }

  async send() {
    const body = this.input.value.trim();
    if (this.sending || (!body && !this.files.length)) return;
    this.sending = true;
    this.updateSendState();
    const fd = new FormData();
    fd.set('body', body);
    const ch = this.currentCharacter();
    if (ch) fd.set('characterId', ch.id);
    this.files.forEach((f) => fd.append('images', f.file));
    try {
      const { message } = await api.post(`/api/chats/${this.id}/messages`, fd);
      this.input.value = '';
      localStorage.removeItem(`draft:${this.id}`);
      this.files.forEach((f) => URL.revokeObjectURL(f.url));
      this.files = [];
      this.renderPreviews();
      this.autogrow();
      if (this.detached) await this.jumpLatest();
      else this.addMessage(message);
      this.input.focus();
    } catch (e) {
      toast(e.message, true);
    } finally {
      this.sending = false;
      this.updateSendState();
    }
  }

  // ---- message actions

  messageMenu(m) {
    openSheet('Message', (close) => {
      const mine = m.author.id === state.me.id;
      const canDelete = mine || this.chat?.ownerId === state.me.id;
      const item = (label, fn, danger) => h('button', { class: `row${danger ? ' danger-text' : ''}`, onclick: () => { close(); fn(); } }, h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, label)));
      return h('div', { class: 'list' },
        m.body && item('Copy text', () => copyText(m.body)),
        mine && item('Edit', () => this.editSheet(m)),
        canDelete && item('Delete', async () => {
          if (!(await confirmSheet('Delete message?', 'This removes it for everyone in the chat.', 'Delete', true))) return;
          try {
            await api.del(`/api/messages/${m.id}`);
            this.removeMessage(m.id);
            emit('refresh-chats');
          } catch (e) {
            toast(e.message, true);
          }
        }, true),
      );
    });
  }

  editSheet(m) {
    openSheet('Edit message', (close) => {
      const ta = h('textarea', { rows: 6, maxlength: 8000 }, m.body);
      const err = h('p', { class: 'error', hidden: true });
      return h('form', { class: 'stack', onsubmit: async (e) => {
        e.preventDefault();
        try {
          const { message } = await api.patch(`/api/messages/${m.id}`, { body: ta.value });
          this.updateMessage(message);
          close();
        } catch (ex) {
          err.textContent = ex.message;
          err.hidden = false;
        }
      } }, ta, err, h('div', { class: 'row-end' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save')));
    });
  }

  // ---- chat info

  infoSheet() {
    const chat = this.chat;
    if (!chat) return;
    openSheet(chat.isDm ? 'Direct message' : 'Chat info', (close) => {
      const body = h('div', { class: 'stack' });
      this.infoRender = () => render();
      const render = () => {
        const c = this.chat;
        if (!c) return close();
        const owner = c.ownerId === state.me.id;
        clear(body);

        if (!c.isDm) {
          if (owner) {
            const name = h('input', { type: 'text', maxlength: 60, value: c.name });
            const desc = h('textarea', { rows: 3, maxlength: 500, placeholder: 'Description, setting, rules…' }, c.description);
            body.append(h('form', { class: 'stack', onsubmit: async (e) => {
              e.preventDefault();
              try {
                const { chat: fresh } = await api.patch(`/api/chats/${c.id}`, { name: name.value, description: desc.value });
                upsertChat(fresh);
                toast('Saved');
              } catch (ex) {
                toast(ex.message, true);
              }
            } },
              h('label', null, 'Name', name),
              h('label', null, 'Description', desc),
              h('div', { class: 'row-end' }, h('button', { class: 'btn small', type: 'submit' }, 'Save changes')),
            ));
          } else if (c.description) body.append(h('p', { class: 'bio' }, c.description));
        }

        body.append(h('h3', { class: 'section-title' }, `People (${c.members.length})`));
        body.append(h('div', { class: 'list' }, c.members.map((u) =>
          h('div', { class: 'row' },
            h('button', { class: 'row-clickable', onclick: () => { close(); go(`/user/${u.id}`); } },
              avatarEl(u.avatar, u.displayName, u.color, 40),
              h('div', { class: 'row-main' },
                h('div', { class: 'row-title' }, u.displayName, u.id === c.ownerId && !c.isDm && h('span', { class: 'tag' }, 'Owner')),
                h('div', { class: 'row-preview' }, `@${u.username}`),
              ),
            ),
            owner && !c.isDm && u.id !== state.me.id && h('button', { class: 'btn small danger-text', onclick: async () => {
              if (!(await confirmSheet('Remove from chat?', `${u.displayName} will lose access to this chat.`, 'Remove', true))) return;
              try {
                await api.del(`/api/chats/${c.id}/members/${u.id}`);
                upsertChat((await api.get(`/api/chats/${c.id}`)).chat);
                render();
              } catch (ex) {
                toast(ex.message, true);
              }
            } }, 'Remove'),
          ),
        )));

        if (owner && !c.isDm) {
          body.append(
            h('label', null, 'Add someone',
              userPicker({
                exclude: () => c.members.map((m) => m.id),
                onPick: async (u) => {
                  try {
                    const { chat: fresh } = await api.post(`/api/chats/${c.id}/members`, { username: u.username });
                    upsertChat(fresh);
                    render();
                  } catch (ex) {
                    toast(ex.message, true);
                  }
                },
              }).el,
            ),
          );
        }

        body.append(
          h('div', { class: 'stack-sm' },
            h('button', { class: 'btn danger-text', onclick: async () => {
              const ok = await confirmSheet(c.isDm ? 'Remove this conversation?' : 'Leave chat?', c.isDm ? 'It will disappear from your list. The other person keeps their copy.' : 'You will no longer see this chat.', c.isDm ? 'Remove' : 'Leave', true);
              if (!ok) return;
              try {
                await api.del(`/api/chats/${c.id}/members/${state.me.id}`);
                close();
                removeChat(c.id);
                go('/chats', { replace: true });
              } catch (ex) {
                toast(ex.message, true);
              }
            } }, c.isDm ? 'Remove conversation' : 'Leave chat'),
            owner && !c.isDm && h('button', { class: 'btn danger-text', onclick: async () => {
              if (!(await confirmSheet('Delete chat for everyone?', 'All messages and pictures will be permanently deleted.', 'Delete', true))) return;
              try {
                await api.del(`/api/chats/${c.id}`);
                close();
                removeChat(c.id);
                go('/chats', { replace: true });
              } catch (ex) {
                toast(ex.message, true);
              }
            } }, 'Delete chat for everyone'),
          ),
        );
      };
      render();
      return body;
    }, { onClose: () => (this.infoRender = null) });
  }
}

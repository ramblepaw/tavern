import { api } from './api.js';
import { state, emit, upsertChat, isIOS, isStandalone } from './state.js';
import { go, back } from './nav.js';
import { h, clear, append, avatarEl, icon, toast } from './util.js';
import { openSheet, confirmSheet } from './sheets.js';
import { avatarPicker } from './components.js';
import { pushStatus, enablePush, disablePush, sendTestPush } from './push.js';

const headerEl = (title, action) =>
  h('header', { class: 'topbar' }, h('h1', { class: 'grow' }, title), action);

const plusBtn = (label, onclick) =>
  h('button', { class: 'icon-btn accent', 'aria-label': label, onclick }, icon('plus', 22));

const firstLine = (s) => (s || '').split('\n')[0];

// ------------------------------------------------------------------ characters

export function renderCharactersTab(el) {
  clear(el).append(headerEl('Characters', plusBtn('New character', () => characterSheet())));
  if (!state.characters.length) {
    el.append(
      h(
        'div',
        { class: 'empty' },
        icon('mask', 44),
        h('h3', null, 'No characters yet'),
        h('p', null, 'Characters let you post in chats as someone else, with their own name, picture and colour. Perfect for roleplay.'),
        h('button', { class: 'btn primary', onclick: () => characterSheet() }, 'Create a character'),
      ),
    );
    return;
  }
  el.append(
    h(
      'div',
      { class: 'list' },
      state.characters.map((c) =>
        h(
          'button',
          { class: 'row', onclick: () => characterSheet(c) },
          avatarEl(c.avatar, c.name, c.color, 48),
          h('div', { class: 'row-main' },
            h('div', { class: 'row-title', style: { color: c.color } }, c.name),
            h('div', { class: 'row-preview' }, firstLine(c.bio) || 'No description'),
          ),
        ),
      ),
    ),
  );
}

export function characterSheet(character = null) {
  return openSheet(character ? 'Edit character' : 'New character', (close) => {
    const pick = avatarPicker({ file: character?.avatar, name: character?.name || '?', color: character?.color || '#8b7cf6' });
    const name = h('input', { type: 'text', maxlength: 40, value: character?.name || '', placeholder: 'Character name', autocomplete: 'off', required: true });
    const bio = h('textarea', { rows: 4, maxlength: 1000, placeholder: 'Appearance, personality, backstory…' }, character?.bio || '');
    const colour = h('input', { type: 'color', value: character?.color || '#8b7cf6' });
    const err = h('p', { class: 'error', hidden: true });
    const save = h('button', { class: 'btn primary', type: 'submit' }, character ? 'Save' : 'Create');
    const sync = () => pick.setIdentity(name.value || '?', colour.value);
    name.addEventListener('input', sync);
    colour.addEventListener('input', sync);

    const form = h(
      'form',
      { class: 'stack', onsubmit: async (e) => {
        e.preventDefault();
        save.disabled = true;
        err.hidden = true;
        try {
          const fd = new FormData();
          fd.set('name', name.value);
          fd.set('bio', bio.value);
          fd.set('color', colour.value);
          pick.apply(fd);
          const { character: c } = character
            ? await api.patch(`/api/characters/${character.id}`, fd)
            : await api.post('/api/characters', fd);
          const i = state.characters.findIndex((x) => x.id === c.id);
          if (i >= 0) state.characters[i] = c;
          else state.characters.push(c);
          state.characters.sort((a, b) => a.name.localeCompare(b.name));
          emit('characters');
          close();
        } catch (ex) {
          err.textContent = ex.message;
          err.hidden = false;
          save.disabled = false;
        }
      } },
      pick.el,
      h('label', null, 'Name', name),
      h('label', null, 'About', bio),
      h('label', { class: 'inline' }, 'Name colour', colour),
      err,
      h('div', { class: 'row-end' },
        character && h('button', { type: 'button', class: 'btn danger-text', onclick: async () => {
          if (!(await confirmSheet('Delete character?', `${character.name} will be removed. Old messages posted as them stay in chats.`, 'Delete', true))) return;
          try {
            await api.del(`/api/characters/${character.id}`);
            state.characters = state.characters.filter((x) => x.id !== character.id);
            emit('characters');
            close();
          } catch (ex) {
            toast(ex.message, true);
          }
        } }, 'Delete'),
        save,
      ),
    );
    return form;
  });
}

// ------------------------------------------------------------------ me

export function renderMeTab(el) {
  const me = state.me;
  clear(el).append(headerEl('You'));
  const body = h('div', { class: 'scroll-pad stack' });
  body.append(
    h('div', { class: 'profile-card' },
      avatarEl(me.avatar, me.displayName, me.color, 88),
      h('h2', { style: { color: me.color } }, me.displayName),
      h('p', { class: 'muted' }, `@${me.username}`, me.pronouns && ` · ${me.pronouns}`),
      me.bio && h('p', { class: 'bio' }, me.bio),
      h('button', { class: 'btn', onclick: editProfileSheet }, 'Edit profile'),
    ),
  );

  if (isIOS() && !isStandalone()) {
    body.append(
      h('div', { class: 'note' },
        h('strong', null, 'Install on your iPhone'),
        h('p', null, 'In Safari, tap the Share button, then “Add to Home Screen”. Tavern will open full-screen like a normal app.'),
      ),
    );
  }

  body.append(
    h('div', { class: 'list card' },
      notificationsRow(),
      state.me.isAdmin && h('button', { class: 'row', onclick: inviteSheet }, h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, 'Invite people'), h('div', { class: 'row-preview' }, 'Create invite codes so friends can join'))),
      h('button', { class: 'row', onclick: passwordSheet }, h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, 'Change password'))),
      h('button', { class: 'row', onclick: () => window.dispatchEvent(new Event('tavern:logout')) }, h('div', { class: 'row-main' }, h('div', { class: 'row-title danger-text' }, 'Sign out'))),
    ),
  );
  el.append(body);
}

let lastPushStatus = null;

const PUSH_LABELS = {
  on: 'On for this device',
  off: 'Off. Tap to get alerts for new messages',
  denied: 'Blocked in your device settings',
  'needs-install': 'Add Tavern to your Home Screen first',
  'needs-https': 'Needs a secure (HTTPS) connection',
  unsupported: 'Not supported by this browser',
};

const PUSH_HELP = {
  'needs-install': 'On iPhone and iPad, notifications only work for apps on the Home Screen. In Safari tap Share, then “Add to Home Screen”, open Tavern from there, and come back to this screen. Requires iOS 16.4 or newer.',
  'needs-https': 'Browsers only allow notifications on secure (HTTPS) connections. Ask whoever runs this server to put it behind HTTPS. The README explains how.',
  denied: 'Notifications are blocked for Tavern. Turn them back on in your device’s settings (on iPhone: Settings → Notifications → Tavern), then reopen the app.',
  unsupported: 'This browser doesn’t support push notifications. Try Safari on iOS 16.4+, or a recent Chrome, Edge or Firefox.',
};

function notificationsRow() {
  const sub = h('div', { class: 'row-preview' }, lastPushStatus ? PUSH_LABELS[lastPushStatus] : 'Checking…');
  const row = h('button', { class: 'row' }, h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, 'Notifications'), sub));

  const refresh = async () => {
    lastPushStatus = await pushStatus();
    sub.textContent = PUSH_LABELS[lastPushStatus];
  };
  refresh();

  row.addEventListener('click', async () => {
    const status = lastPushStatus;
    if (status === 'off') {
      try {
        await enablePush();
        toast('Notifications are on');
      } catch (e) {
        toast(e.message, true);
      }
      refresh();
    } else if (status === 'on') {
      openSheet('Notifications', (close) =>
        h('div', { class: 'stack' },
          h('p', { class: 'muted' }, 'You’ll get an alert on this device when someone messages you and you’re not looking at that chat.'),
          h('button', { class: 'btn', onclick: async (e) => {
            e.currentTarget.disabled = true;
            try {
              const { sent, failed } = await sendTestPush();
              toast(sent ? 'Test sent. It should arrive in a moment.' : failed ? 'The push service rejected it. Try turning notifications off and on.' : 'No device is registered.', !sent);
            } catch (ex) {
              toast(ex.message, true);
            }
            e.currentTarget.disabled = false;
          } }, 'Send a test notification'),
          h('button', { class: 'btn danger-text', onclick: async () => {
            await disablePush();
            close();
            refresh();
            toast('Notifications are off for this device');
          } }, 'Turn off'),
        ),
      );
    } else if (PUSH_HELP[status]) {
      openSheet('Notifications', () => h('p', { class: 'muted' }, PUSH_HELP[status]));
    }
  });
  return row;
}

export function editProfileSheet() {
  const me = state.me;
  return openSheet('Edit profile', (close) => {
    const pick = avatarPicker({ file: me.avatar, name: me.displayName, color: me.color });
    const name = h('input', { type: 'text', maxlength: 32, value: me.displayName, required: true, autocomplete: 'off' });
    const pronouns = h('input', { type: 'text', maxlength: 40, value: me.pronouns, placeholder: 'e.g. they/them', autocomplete: 'off' });
    const bio = h('textarea', { rows: 4, maxlength: 1000, placeholder: 'Tell people about yourself, your favourite genres, what you’re looking to play…' }, me.bio);
    const colour = h('input', { type: 'color', value: me.color });
    const err = h('p', { class: 'error', hidden: true });
    const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
    const sync = () => pick.setIdentity(name.value || '?', colour.value);
    name.addEventListener('input', sync);
    colour.addEventListener('input', sync);
    return h('form', { class: 'stack', onsubmit: async (e) => {
      e.preventDefault();
      save.disabled = true;
      err.hidden = true;
      try {
        const fd = new FormData();
        fd.set('displayName', name.value);
        fd.set('pronouns', pronouns.value);
        fd.set('bio', bio.value);
        fd.set('color', colour.value);
        pick.apply(fd);
        state.me = (await api.patch('/api/me', fd)).user;
        emit('me');
        close();
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
        save.disabled = false;
      }
    } },
      pick.el,
      h('label', null, 'Display name', name),
      h('label', null, 'Pronouns (optional)', pronouns),
      h('label', null, 'About you', bio),
      h('label', { class: 'inline' }, 'Name colour', colour),
      err,
      h('div', { class: 'row-end' }, save),
    );
  });
}

function passwordSheet() {
  openSheet('Change password', (close) => {
    const cur = h('input', { type: 'password', autocomplete: 'current-password', required: true });
    const next = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8, required: true });
    const err = h('p', { class: 'error', hidden: true });
    return h('form', { class: 'stack', onsubmit: async (e) => {
      e.preventDefault();
      try {
        await api.post('/api/me/password', { current: cur.value, next: next.value });
        toast('Password changed. Other devices were signed out.');
        close();
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      }
    } },
      h('label', null, 'Current password', cur),
      h('label', null, 'New password (8+ characters)', next),
      err,
      h('div', { class: 'row-end' }, h('button', { class: 'btn primary', type: 'submit' }, 'Change password')),
    );
  });
}

function inviteSheet() {
  openSheet('Invite people', () => {
    const list = h('div', { class: 'list' });
    const load = async () => {
      const { invites } = await api.get('/api/admin/invites');
      clear(list);
      if (!invites.length) list.append(h('p', { class: 'muted pad' }, 'No invites yet. Create one and send the link to a friend.'));
      for (const i of invites) {
        const link = `${location.origin}/#/join/${i.code}`;
        list.append(
          h('div', { class: 'row invite' },
            h('div', { class: 'row-main' },
              h('div', { class: 'row-title mono' }, i.code),
              h('div', { class: 'row-preview' }, i.usedBy ? `Used by @${i.usedBy}` : 'Unused'),
            ),
            !i.usedBy && h('button', { class: 'btn small', onclick: async () => {
              try {
                await navigator.clipboard.writeText(link);
                toast('Invite link copied');
              } catch {
                prompt('Copy this invite link:', link);
              }
            } }, 'Copy link'),
            !i.usedBy && h('button', { class: 'btn small danger-text', onclick: async () => {
              await api.del(`/api/admin/invites/${i.code}`);
              load();
            } }, 'Revoke'),
          ),
        );
      }
    };
    load().catch((e) => toast(e.message, true));
    return h('div', { class: 'stack' },
      h('button', { class: 'btn primary', onclick: async () => {
        try {
          await api.post('/api/admin/invites');
          await load();
        } catch (e) {
          toast(e.message, true);
        }
      } }, 'Create invite'),
      list,
    );
  });
}

// ------------------------------------------------------------------ other people's profiles

export async function renderUser(el, id) {
  clear(el).append(
    h('header', { class: 'topbar' },
      h('button', { class: 'icon-btn back-btn', 'aria-label': 'Back', onclick: () => back('/chats') }, icon('back')),
      h('h1', { class: 'grow' }, 'Profile'),
    ),
  );
  const body = h('div', { class: 'scroll-pad stack' }, h('p', { class: 'muted center' }, 'Loading…'));
  el.append(body);
  try {
    const { user, characters } = await api.get(`/api/users/${id}`);
    const mine = user.id === state.me.id;
    append(
      clear(body),
      h('div', { class: 'profile-card' },
        avatarEl(user.avatar, user.displayName, user.color, 96),
        h('h2', { style: { color: user.color } }, user.displayName),
        h('p', { class: 'muted' }, `@${user.username}`, user.pronouns && ` · ${user.pronouns}`),
        user.bio && h('p', { class: 'bio' }, user.bio),
        mine
          ? h('button', { class: 'btn', onclick: editProfileSheet }, 'Edit profile')
          : h('button', { class: 'btn primary', onclick: async (e) => {
              e.currentTarget.disabled = true;
              try {
                const { chat } = await api.post('/api/chats', { members: [user.username] });
                upsertChat(chat);
                go(`/chat/${chat.id}`);
              } catch (ex) {
                toast(ex.message, true);
                e.currentTarget.disabled = false;
              }
            } }, 'Send message'),
      ),
      characters.length > 0 && h('h3', { class: 'section-title' }, `Characters (${characters.length})`),
      characters.length > 0 && h('div', { class: 'list card' },
        characters.map((c) =>
          h('div', { class: 'row static' },
            avatarEl(c.avatar, c.name, c.color, 48),
            h('div', { class: 'row-main' },
              h('div', { class: 'row-title', style: { color: c.color } }, c.name),
              c.bio && h('div', { class: 'row-preview wrap' }, c.bio),
            ),
          ),
        ),
      ),
    );
  } catch (e) {
    clear(body).append(h('p', { class: 'error center' }, e.message));
  }
}

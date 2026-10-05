import { api } from './api.js';
import { h, clear, avatarEl, debounce, icon } from './util.js';

/**
 * Avatar upload control. `apply(formData)` adds the chosen file / removal flag.
 * `setIdentity(name, color)` refreshes the initials placeholder.
 */
export function avatarPicker({ file, name, color }) {
  let chosen = null;
  let removed = false;
  let previewUrl = null;
  let ident = { name, color };
  const holder = h('div', { class: 'avatar-pick-preview' });
  const input = h('input', { type: 'file', accept: 'image/*', hidden: true });
  const removeBtn = h('button', { type: 'button', class: 'btn small', onclick: () => {
    chosen = null;
    removed = true;
    render();
  } }, 'Remove');

  function render() {
    clear(holder);
    if (chosen) holder.append(h('div', { class: 'avatar', style: { '--size': '88px' } }, h('img', { src: previewUrl, alt: '' })));
    else holder.append(avatarEl(removed ? null : file, ident.name, ident.color, 88));
    removeBtn.hidden = !(chosen || (file && !removed));
  }

  input.addEventListener('change', () => {
    const f = input.files[0];
    if (!f) return;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    chosen = f;
    removed = false;
    previewUrl = URL.createObjectURL(f);
    render();
  });
  render();

  return {
    el: h(
      'div',
      { class: 'avatar-pick' },
      holder,
      h('div', { class: 'stack-sm' },
        h('button', { type: 'button', class: 'btn small', onclick: () => input.click() }, icon('image', 16), ' Choose picture'),
        removeBtn,
      ),
      input,
    ),
    setIdentity(n, c) {
      ident = { name: n, color: c };
      if (!chosen) render();
    },
    apply(fd) {
      if (chosen) fd.set('avatar', chosen);
      else if (removed) fd.set('removeAvatar', '1');
    },
  };
}

/** Search-as-you-type user finder. Calls onPick(user) when one is tapped. */
export function userPicker({ onPick, exclude = () => [], placeholder = 'Search by username…' }) {
  const results = h('div', { class: 'picker-results' });
  const input = h('input', { type: 'search', placeholder, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' });
  const search = debounce(async () => {
    const q = input.value.trim();
    if (!q) return clear(results);
    try {
      const { users } = await api.get(`/api/users?q=${encodeURIComponent(q)}`);
      const skip = new Set(exclude());
      clear(results);
      const shown = users.filter((u) => !skip.has(u.id));
      if (!shown.length) results.append(h('p', { class: 'muted small pad' }, 'No one found with that name.'));
      for (const u of shown) {
        results.append(
          h('button', { type: 'button', class: 'row', onclick: () => {
            onPick(u);
            input.value = '';
            clear(results);
          } },
            avatarEl(u.avatar, u.displayName, u.color, 36),
            h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, u.displayName), h('div', { class: 'row-preview' }, `@${u.username}`)),
          ),
        );
      }
    } catch {
      clear(results);
    }
  }, 220);
  input.addEventListener('input', search);
  return { el: h('div', { class: 'picker' }, input, results), input };
}

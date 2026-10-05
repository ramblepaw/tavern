/** Tiny DOM helper: h('div', {class:'x', onclick: fn, style:{color:'red'}}, child, 'text', [more]) */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) el.style.setProperty(sk, sv);
        else el.style[sk] = sv;
      }
    } else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  return append(el, kids);
}

/** Like el.append(...kids) but skips null / false (so `cond && h(...)` is safe) and flattens arrays. */
export function append(el, ...kids) {
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export const clear = (el) => {
  el.replaceChildren();
  return el;
};

export const mediaUrl = (file) => (file ? `/media/${file}` : null);

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

/** Circle avatar: image if we have one, otherwise coloured initials. */
export function avatarEl(file, name, color, size = 40) {
  const el = h('div', { class: 'avatar', style: { '--size': `${size}px`, '--c': color || '#8b7cf6' } });
  if (file) el.append(h('img', { src: mediaUrl(file), alt: '', loading: 'lazy', draggable: 'false' }));
  else el.append(h('span', null, initials(name)));
  return el;
}

const timeFmt = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const shortDateFmt = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric' });

export const timeShort = (ms) => timeFmt.format(ms);
export const dateLong = (ms) => dateFmt.format(ms);
export const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

/** "3:42 PM", "Yesterday", "Mon", or "Oct 3" – for chat list rows. */
export function listTime(ms) {
  const now = Date.now();
  if (sameDay(ms, now)) return timeShort(ms);
  if (sameDay(ms, now - 86400_000)) return 'Yesterday';
  if (now - ms < 6 * 86400_000) return new Intl.DateTimeFormat([], { weekday: 'short' }).format(ms);
  return shortDateFmt.format(ms);
}

let toastTimer;
export function toast(message, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), 3500);
}

export const debounce = (fn, ms) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

// Small inline icons (stroke style) so we don't need an icon font.
const ICONS = {
  back: 'M15 18l-6-6 6-6',
  plus: 'M12 5v14M5 12h14',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z',
  image: 'M4 5h16a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1zm0 12l5-5 4 4 3-3 5 5M9 10a1 1 0 100-2 1 1 0 000 2',
  chat: 'M21 12a8 8 0 01-11.6 7.1L4 20l1-4.6A8 8 0 1121 12z',
  users: 'M16 20v-1a4 4 0 00-4-4H7a4 4 0 00-4 4v1M9.5 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7M21 20v-1a4 4 0 00-3-3.9M16 4.1a3.5 3.5 0 010 6.8',
  user: 'M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  info: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 16v-4M12 8h.01',
  close: 'M18 6L6 18M6 6l12 12',
  down: 'M12 5v14M19 12l-7 7-7-7',
  search: 'M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.35-4.35',
  mask: 'M3 8c0-1 1-2 2-2h14c1 0 2 1 2 2v3c0 5-4 9-9 9s-9-4-9-9V8zM8 11h.01M16 11h.01M9 15c1 1 5 1 6 0',
};
export function icon(name, size = 22) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

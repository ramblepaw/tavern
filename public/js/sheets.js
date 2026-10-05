import { h, icon } from './util.js';

const root = () => document.getElementById('sheet-root');
const stack = [];

/**
 * Bottom sheet on phones, centred dialog on desktop.
 * `build(close)` returns the body content.
 */
export function openSheet(title, build, { onClose } = {}) {
  const prevFocus = document.activeElement;
  const close = () => {
    const i = stack.indexOf(entry);
    if (i < 0) return;
    stack.splice(i, 1);
    backdrop.classList.add('closing');
    setTimeout(() => backdrop.remove(), 160);
    onClose?.();
    prevFocus?.focus?.();
  };
  const sheet = h(
    'div',
    { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h(
      'div',
      { class: 'sheet-head' },
      h('h2', null, title),
      h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, icon('close', 20)),
    ),
    h('div', { class: 'sheet-body' }, build(close)),
  );
  const backdrop = h('div', { class: 'backdrop', onclick: (e) => e.target === backdrop && close() }, sheet);
  const entry = { close };
  stack.push(entry);
  root().append(backdrop);
  sheet.querySelector('input, textarea')?.focus?.({ preventScroll: true });
  return { close, sheet };
}

export function closeTopSheet() {
  const top = stack[stack.length - 1];
  if (top) top.close();
  return !!top;
}

export function closeAllSheets() {
  [...stack].forEach((s) => s.close());
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeTopSheet();
});

/** Resolves true/false. */
export function confirmSheet(title, message, confirmLabel = 'Confirm', danger = false) {
  return new Promise((resolve) => {
    let answered = false;
    openSheet(
      title,
      (close) =>
        h(
          'div',
          { class: 'stack' },
          h('p', { class: 'muted' }, message),
          h(
            'div',
            { class: 'row-end' },
            h('button', { class: 'btn', onclick: close }, 'Cancel'),
            h(
              'button',
              {
                class: `btn ${danger ? 'danger' : 'primary'}`,
                onclick: () => {
                  answered = true;
                  resolve(true);
                  close();
                },
              },
              confirmLabel,
            ),
          ),
        ),
      { onClose: () => !answered && resolve(false) },
    );
  });
}

/** Full-screen image viewer. */
export function lightbox(src) {
  const close = () => el.remove();
  const el = h(
    'div',
    { class: 'lightbox', onclick: close },
    h('img', { src, alt: '' }),
    h('a', { class: 'btn lightbox-open', href: src, target: '_blank', rel: 'noopener', onclick: (e) => e.stopPropagation() }, 'Open original'),
    h('button', { class: 'icon-btn lightbox-close', 'aria-label': 'Close', onclick: close }, icon('close', 24)),
  );
  document.body.append(el);
}

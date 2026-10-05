const escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => escapeMap[c]);

/**
 * Roleplay-friendly formatting. Input is untrusted text; everything is HTML-escaped
 * first, so the only markup in the output is what this function adds.
 *
 *   *action* or _action_   italic        **bold**   ~~strike~~   ||spoiler||
 *   "speech" / “speech”    highlighted   ((ooc))    dimmed       links are clickable
 */
export function formatBody(text) {
  const links = [];
  let s = escapeHtml(text.replace(/\u0000/g, '')).replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (url) => {
    links.push(`<a href="${url}" target="_blank" rel="noopener noreferrer nofollow">${url}</a>`);
    return `\u0000${links.length - 1}\u0000`;
  });

  s = s
    .replace(/\(\((.+?)\)\)/gs, '<span class="ooc">(($1))</span>')
    .replace(/\|\|(.+?)\|\|/gs, '<span class="spoiler" data-spoiler>$1</span>')
    .replace(/\*\*(.+?)\*\*/gs, '<strong>$1</strong>')
    .replace(/(?<![\w*])\*(?![\s*])(.+?)(?<![\s*])\*(?![\w*])/gs, '<em>$1</em>')
    .replace(/(?<![\w])_(?![\s_])(.+?)(?<![\s_])_(?![\w])/gs, '<em>$1</em>')
    .replace(/~~(.+?)~~/gs, '<s>$1</s>')
    .replace(/&quot;(.+?)&quot;/gs, '<span class="speech">&quot;$1&quot;</span>')
    .replace(/“(.+?)”/gs, '<span class="speech">“$1”</span>');

  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => links[Number(i)]);
}

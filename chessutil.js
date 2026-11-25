// Single place that imports chess.js, so the version is pinned in one spot.
export { Chess } from 'https://cdn.jsdelivr.net/npm/chess.js@1/+esm';

export const winPct = (cp) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function uciToObj(uci) {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined };
}

// Tiny markdown renderer for AI output (headings, lists, bold, italic, code, paragraphs).
export function md(text) {
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  const out = [];
  let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) { close(); const l = Math.min(4, m[1].length + 2); out.push(`<h${l}>${inline(m[2])}</h${l}>`); }
    else if ((m = line.match(/^\s*[-*•]\s+(.*)/))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if (!line.trim()) { close(); }
    else { close(); out.push(`<p>${inline(line)}</p>`); }
  }
  close();
  return out.join('\n');
}

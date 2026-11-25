// Single place that imports chess.js, so the version is pinned in one spot.
import { Chess } from 'https://cdn.jsdelivr.net/npm/chess.js@1/+esm';
export { Chess };

export const winPct = (cp) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function uciToObj(uci) {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined };
}

export const PIECE_VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
export const PIECE_NAME = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

// Material balance, White minus Black, in pawns.
export function materialBalance(fen) {
  let s = 0;
  for (const ch of fen.split(' ')[0]) {
    const v = PIECE_VAL[ch.toLowerCase()];
    if (v) s += ch === ch.toUpperCase() ? v : -v;
  }
  return s;
}

// Play up to n UCI moves from fen. Returns the moves played (verbose) and fens after each.
export function playLine(fen, ucis = [], n = 99) {
  const c = new Chess(fen);
  const moves = [], fens = [];
  for (const u of ucis.slice(0, n)) {
    try { moves.push(c.move(uciToObj(u))); fens.push(c.fen()); } catch { break; }
  }
  return { moves, fens };
}

// "12. Nf3 Nc6 13. Bb5" style SAN string for a line.
export function lineToSan(fen, ucis, n = 6) {
  const { moves } = playLine(fen, ucis, n);
  const parts = fen.split(' ');
  let num = +parts[5], white = parts[1] === 'w';
  return moves.map((m, i) => {
    const s = white ? `${num}. ${m.san}` : i === 0 ? `${num}… ${m.san}` : m.san;
    if (!white) num++;
    white = !white;
    return s;
  }).join(' ');
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

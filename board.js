// Interactive chessboard: click or drag to move, right-click to draw arrows/circles,
// sliding move animations, move/capture sounds.
import { Chess } from './chessutil.js';
const PNAME = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };
const FILES = 'abcdefgh';
const NS = 'http://www.w3.org/2000/svg';
const ARROW_COLORS = { green: '#15781b', red: '#c0392b', blue: '#2f6fbf', yellow: '#e68f00', engine: '#5aa832', bad: '#d6453d', hint: '#3a86d8' };
// Colours for your own drawings (right-click). Shift = red, Ctrl = blue, Alt = yellow, plain = green.
const drawColor = (e) => (e.shiftKey ? 'red' : e.ctrlKey || e.metaKey ? 'blue' : e.altKey ? 'yellow' : 'green');

// ---------- sound (synthesised, no files needed) ----------
let actx = null;
export const soundSettings = { on: localStorage.getItem('cc_sound') !== 'off' };
export function setSound(on) { soundSettings.on = on; localStorage.setItem('cc_sound', on ? 'on' : 'off'); }
function playSound(kind) {
  if (!soundSettings.on) return;
  try {
    actx ??= new (window.AudioContext || window.webkitAudioContext)();
    const t = actx.currentTime;
    const knock = (when, freq, vol, len) => {
      const buf = actx.createBuffer(1, Math.floor(actx.sampleRate * len), actx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 4);
      const src = actx.createBufferSource(); src.buffer = buf;
      const f = actx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 1.2;
      const g = actx.createGain(); g.gain.value = vol;
      src.connect(f).connect(g).connect(actx.destination);
      src.start(t + when);
    };
    if (kind === 'capture') { knock(0, 900, 1.6, 0.09); knock(0.045, 600, 1.2, 0.1); }
    else if (kind === 'check') { knock(0, 1300, 1.2, 0.08); knock(0.06, 1500, 0.8, 0.08); }
    else knock(0, 700, 1.4, 0.08);
  } catch { /* audio not available */ }
}

function parseFen(fen) {
  const map = {};
  fen.split(' ')[0].split('/').forEach((row, ri) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) f += +ch;
      else { map[FILES[f] + (8 - ri)] = { type: ch.toLowerCase(), color: ch === ch.toUpperCase() ? 'w' : 'b' }; f++; }
    }
  });
  return map;
}

export class Board {
  constructor(el, { orientation = 'w', onMove = null, dests = () => [] } = {}) {
    this.el = el;
    this.uid = Board.count = (Board.count || 0) + 1;
    this.orientation = orientation;
    this.onMove = onMove;
    this.dests = dests;
    this.movable = null; // 'w' | 'b' | null
    this.fen = '8/8/8/8/8/8/8/8 w - - 0 1';
    this.pieces = {};
    this.sel = null;
    this.selDests = [];
    this.lastMove = null;
    this.arrows = [];       // set by the app (engine arrows etc.)
    this.drawn = [];        // drawn by you with right-click: {from,to,color} or {sq,color}
    this.marks = {};
    this.badge = null;
    el.classList.add('board', 'cg-wrap');
    el.innerHTML = '';
    this.grid = document.createElement('div');
    this.grid.className = 'grid';
    this.svg = document.createElementNS(NS, 'svg');
    this.svg.setAttribute('viewBox', '0 0 8 8');
    this.svg.classList.add('arrows');
    el.append(this.grid, this.svg);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    this.grid.addEventListener('pointerdown', (e) => this._down(e));
    this.grid.addEventListener('pointermove', (e) => this._move(e));
    this.grid.addEventListener('pointerup', (e) => this._up(e));
    this.grid.addEventListener('pointercancel', () => this._cancelDrag());
    this.render();
  }

  setPosition(fen, { lastMove = null, animate = true, sound = true } = {}) {
    const prev = this.pieces;
    this.fen = fen;
    this.pieces = parseFen(fen);
    try { this.check = new Chess(fen).inCheck(); } catch { this.check = false; }
    this.lastMove = lastMove;
    this.sel = null;
    this.selDests = [];
    this.arrows = [];
    this.drawn = [];
    this.marks = {};
    this.badge = null;
    this.render();
    // Is this position exactly "previous position + lastMove"? Then animate and play a sound.
    if (lastMove) {
      const moved = prev[lastMove.from], now = this.pieces[lastMove.to];
      const forward = moved && now && moved.color === now.color && !this.pieces[lastMove.from];
      if (forward) {
        const dropped = this.justDropped === lastMove.to;
        if (animate && !dropped) this._slide(lastMove.from, lastMove.to);
        if (sound) {
          const capture = !!prev[lastMove.to] || (moved.type === 'p' && lastMove.from[0] !== lastMove.to[0]);
          playSound(capture ? 'capture' : this.check ? 'check' : 'move');
        }
      }
    }
    this.justDropped = null;
  }
  setOrientation(o) { this.orientation = o; this.render(); }
  setBadge(b) { this.badge = b; this.render(); }
  setArrows(list) { this.arrows = list || []; this._drawArrows(); }
  mark(sq, cls, ms = 600) {
    this.marks[sq] = cls; this.render();
    if (ms) setTimeout(() => { delete this.marks[sq]; this.render(); }, ms);
  }
  turn() { return this.fen.split(' ')[1]; }

  _coords(sq) {
    const f = FILES.indexOf(sq[0]), r = +sq[1] - 1;
    return this.orientation === 'w' ? { col: f, row: 7 - r } : { col: 7 - f, row: r };
  }
  _sqEl(sq) { return this.grid.querySelector(`[data-sq="${sq}"]`); }

  _slide(from, to) {
    const pe = this._sqEl(to)?.querySelector('piece');
    if (!pe) return;
    const a = this._coords(from), b = this._coords(to);
    pe.style.transition = 'none';
    pe.style.transform = `translate(${(a.col - b.col) * 100}%, ${(a.row - b.row) * 100}%)`;
    pe.style.zIndex = '5';
    pe.getBoundingClientRect(); // flush
    requestAnimationFrame(() => {
      pe.style.transition = 'transform 170ms cubic-bezier(.25,.8,.35,1)';
      pe.style.transform = '';
      setTimeout(() => { pe.style.zIndex = ''; }, 200);
    });
  }

  render() {
    const g = this.grid;
    g.innerHTML = '';
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const f = this.orientation === 'w' ? col : 7 - col;
        const r = this.orientation === 'w' ? 7 - row : row;
        const sq = FILES[f] + (r + 1);
        const d = document.createElement('div');
        d.className = 'sq ' + ((f + r) % 2 ? 'light' : 'dark');
        d.dataset.sq = sq;
        if (this.lastMove && (this.lastMove.from === sq || this.lastMove.to === sq)) d.classList.add('last');
        if (this.sel === sq) d.classList.add('sel');
        if (this.selDests.includes(sq)) d.classList.add(this.pieces[sq] ? 'cap' : 'dest');
        if (this.marks[sq]) d.classList.add(this.marks[sq]);
        const p = this.pieces[sq];
        if (p && p.type === 'k' && this._inCheck(p.color)) d.classList.add('check');
        if (col === 0) d.insertAdjacentHTML('beforeend', `<span class="coord rank">${r + 1}</span>`);
        if (row === 7) d.insertAdjacentHTML('beforeend', `<span class="coord file">${FILES[f]}</span>`);
        if (p) {
          const s = document.createElement('piece');
          s.className = `${PNAME[p.type]} ${p.color === 'w' ? 'white' : 'black'}`;
          if (this.movable && p.color === this.movable && this.turn() === p.color) s.classList.add('movable');
          d.append(s);
        }
        if (this.badge && this.badge.sq === sq) {
          const b = document.createElement('span');
          b.className = 'badge';
          b.style.background = this.badge.color;
          b.textContent = this.badge.icon;
          d.append(b);
        }
        g.append(d);
      }
    }
    this._drawArrows();
  }
  // Light check detection, only for highlighting: is the side-to-move's king attacked?
  _inCheck(color) { return !!this.check && this.turn() === color; }

  _drawArrows() {
    const svg = this.svg;
    svg.innerHTML = '';
    const defs = document.createElementNS(NS, 'defs');
    for (const [name, c] of Object.entries(ARROW_COLORS)) {
      defs.insertAdjacentHTML('beforeend',
        `<marker id="ah-${this.uid}-${name}" viewBox="0 0 10 10" refX="4.2" refY="5" markerWidth="2.6" markerHeight="2.6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${c}"/></marker>`);
    }
    svg.append(defs);
    const all = [...this.arrows, ...this.drawn, ...(this.preview ? [this.preview] : [])];
    for (const a of all) {
      const color = a.color || 'green';
      const stroke = ARROW_COLORS[color] || color;
      if (a.sq) {
        const p = this._coords(a.sq);
        const c = document.createElementNS(NS, 'circle');
        Object.entries({ cx: p.col + 0.5, cy: p.row + 0.5, r: 0.44, fill: 'none', stroke, 'stroke-width': 0.075, opacity: 0.85 }).forEach(([k, v]) => c.setAttribute(k, v));
        svg.append(c);
        continue;
      }
      if (!a.from || !a.to || a.from === a.to) continue;
      const p = this._coords(a.from), q = this._coords(a.to);
      const x1 = p.col + 0.5, y1 = p.row + 0.5, x2 = q.col + 0.5, y2 = q.row + 0.5;
      const len = Math.hypot(x2 - x1, y2 - y1);
      const k = (len - 0.42) / len;
      const s = 0.18 / len; // start a little away from the centre
      const line = document.createElementNS(NS, 'line');
      Object.entries({
        x1: x1 + (x2 - x1) * s, y1: y1 + (y2 - y1) * s, x2: x1 + (x2 - x1) * k, y2: y1 + (y2 - y1) * k,
        stroke, 'stroke-width': 0.16, 'stroke-linecap': 'round', opacity: a.preview ? 0.55 : 0.82, 'marker-end': `url(#ah-${this.uid}-${color in ARROW_COLORS ? color : 'green'})`,
      }).forEach(([k2, v]) => line.setAttribute(k2, v));
      svg.append(line);
    }
  }

  _select(sq) {
    this.sel = sq;
    this.selDests = sq ? this.dests(sq) : [];
    this.render();
  }
  _sqAt(x, y) { return document.elementFromPoint(x, y)?.closest?.('.board .sq')?.dataset.sq || null; }

  _down(e) {
    const sq = e.target.closest('.sq')?.dataset.sq;
    if (!sq) return;
    // Right button: start drawing an arrow or circle. Never moves pieces.
    if (e.button === 2) {
      e.preventDefault();
      this.drawing = { from: sq, color: drawColor(e) };
      try { this.grid.setPointerCapture(e.pointerId); } catch {}
      return;
    }
    if (e.button !== 0) return;
    // Left click clears your drawings.
    if (this.drawn.length) { this.drawn = []; this._drawArrows(); }
    if (this.sel && sq !== this.sel && this.selDests.includes(sq)) { this._try(this.sel, sq); return; }
    const p = this.pieces[sq];
    if (p && this.movable && p.color === this.movable && this.turn() === p.color) {
      e.preventDefault();
      const wasSelected = this.sel === sq;
      this._select(sq);
      const pieceEl = this._sqEl(sq)?.querySelector('piece');
      this.drag = { from: sq, x: e.clientX, y: e.clientY, pieceEl, ghost: null, wasSelected };
      try { this.grid.setPointerCapture(e.pointerId); } catch {}
    } else {
      this._select(null);
    }
  }
  _move(e) {
    if (this.drawing) {
      const to = this._sqAt(e.clientX, e.clientY);
      this.preview = to && to !== this.drawing.from ? { from: this.drawing.from, to, color: this.drawing.color, preview: true } : null;
      this._drawArrows();
      return;
    }
    const d = this.drag;
    if (!d) return;
    if (!d.ghost && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 && d.pieceEl) {
      d.ghost = d.pieceEl.cloneNode(true);
      d.ghost.classList.add('ghost');
      const r = d.pieceEl.getBoundingClientRect();
      d.ghost.style.width = r.width + 'px';
      d.ghost.style.height = r.height + 'px';
      d.ghostWrap = document.createElement('div');
      d.ghostWrap.className = 'cg-wrap ghost-wrap';
      d.ghostWrap.append(d.ghost);
      document.body.append(d.ghostWrap);
      d.pieceEl.style.opacity = '0.3';
    }
    if (d.ghost) {
      d.ghost.style.left = e.clientX + 'px';
      d.ghost.style.top = e.clientY + 'px';
      const over = this._sqAt(e.clientX, e.clientY);
      if (over !== d.over) {
        if (d.over) this._sqEl(d.over)?.classList.remove('hover');
        if (over && this.selDests.includes(over)) this._sqEl(over)?.classList.add('hover');
        d.over = over;
      }
    }
  }
  _up(e) {
    if (this.drawing) {
      const to = this._sqAt(e.clientX, e.clientY);
      const { from, color } = this.drawing;
      this.drawing = null; this.preview = null;
      if (to) {
        const same = (a) => (to === from ? a.sq === from : a.from === from && a.to === to);
        const i = this.drawn.findIndex(same);
        if (i >= 0) {
          const old = this.drawn.splice(i, 1)[0];
          if (old.color !== color) this.drawn.push(to === from ? { sq: from, color } : { from, to, color });
        } else this.drawn.push(to === from ? { sq: from, color } : { from, to, color });
      }
      this._drawArrows();
      return;
    }
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    const to = this._sqAt(e.clientX, e.clientY);
    d.ghostWrap?.remove();
    if (d.ghost && to && to !== d.from && this.selDests.includes(to)) { this.justDropped = to; this._try(d.from, to); }
    else {
      if (d.pieceEl) d.pieceEl.style.opacity = '';
      if (d.over) this._sqEl(d.over)?.classList.remove('hover');
      // Clicking an already-selected piece again deselects it.
      if (!d.ghost && d.wasSelected) this._select(null);
    }
  }
  _cancelDrag() {
    this.drawing = null; this.preview = null;
    if (this.drag) { this.drag.ghostWrap?.remove(); this.drag = null; this.render(); }
  }
  _try(from, to) {
    this.sel = null; this.selDests = [];
    const ok = this.onMove ? this.onMove(from, to) : false;
    if (ok === false) { this.justDropped = null; this.render(); }
  }
}

// Minimal interactive chessboard: click or drag to move, arrows, highlights.
const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const FILES = 'abcdefgh';
const NS = 'http://www.w3.org/2000/svg';
const ARROW_COLORS = { green: '#3fb950', red: '#f85149', blue: '#58a6ff', yellow: '#e3b341' };

function parseFen(fen) {
  const map = {};
  const rows = fen.split(' ')[0].split('/');
  rows.forEach((row, ri) => {
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
    this.arrows = [];
    this.marks = {};
    el.classList.add('board');
    el.innerHTML = '';
    this.grid = document.createElement('div');
    this.grid.className = 'grid';
    this.svg = document.createElementNS(NS, 'svg');
    this.svg.setAttribute('viewBox', '0 0 8 8');
    this.svg.classList.add('arrows');
    el.append(this.grid, this.svg);
    this.grid.addEventListener('pointerdown', (e) => this._down(e));
    this.grid.addEventListener('pointermove', (e) => this._move(e));
    this.grid.addEventListener('pointerup', (e) => this._up(e));
    this.grid.addEventListener('pointercancel', () => this._cancelDrag());
    this.render();
  }

  setPosition(fen, { lastMove = null } = {}) {
    this.fen = fen;
    this.pieces = parseFen(fen);
    this.lastMove = lastMove;
    this.sel = null;
    this.selDests = [];
    this.arrows = [];
    this.marks = {};
    this.render();
  }
  setOrientation(o) { this.orientation = o; this.render(); }
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
        if (col === 0) d.insertAdjacentHTML('beforeend', `<span class="coord rank">${r + 1}</span>`);
        if (row === 7) d.insertAdjacentHTML('beforeend', `<span class="coord file">${FILES[f]}</span>`);
        const p = this.pieces[sq];
        if (p) {
          const s = document.createElement('span');
          s.className = 'piece ' + p.color;
          s.textContent = GLYPH[p.type] + '︎';
          d.append(s);
        }
        g.append(d);
      }
    }
    this._drawArrows();
  }

  _drawArrows() {
    const svg = this.svg;
    svg.innerHTML = '';
    const defs = document.createElementNS(NS, 'defs');
    for (const [name, c] of Object.entries(ARROW_COLORS)) {
      defs.insertAdjacentHTML('beforeend',
        `<marker id="ah-${this.uid}-${name}"viewBox="0 0 10 10" refX="5" refY="5" markerWidth="3.2" markerHeight="3.2" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${c}"/></marker>`);
    }
    svg.append(defs);
    for (const a of this.arrows) {
      const p = this._coords(a.from), q = this._coords(a.to);
      const x1 = p.col + 0.5, y1 = p.row + 0.5, x2 = q.col + 0.5, y2 = q.row + 0.5;
      const len = Math.hypot(x2 - x1, y2 - y1) || 1;
      const k = (len - 0.35) / len;
      const line = document.createElementNS(NS, 'line');
      const color = a.color || 'green';
      Object.entries({ x1, y1, x2: x1 + (x2 - x1) * k, y2: y1 + (y2 - y1) * k, stroke: ARROW_COLORS[color] || color, 'stroke-width': 0.17, 'stroke-linecap': 'round', opacity: 0.85, 'marker-end': `url(#ah-${this.uid}-${color})` })
        .forEach(([k2, v]) => line.setAttribute(k2, v));
      svg.append(line);
    }
  }

  _select(sq) {
    this.sel = sq;
    this.selDests = sq ? this.dests(sq) : [];
    this.render();
  }
  _sqAt(x, y) { return document.elementFromPoint(x, y)?.closest?.('.sq')?.dataset.sq || null; }

  _down(e) {
    const sq = e.target.closest('.sq')?.dataset.sq;
    if (!sq) return;
    if (this.sel && sq !== this.sel && this.selDests.includes(sq)) { this._try(this.sel, sq); return; }
    const p = this.pieces[sq];
    if (p && this.movable && p.color === this.movable && this.turn() === p.color) {
      e.preventDefault();
      this._select(sq);
      const pieceEl = this.grid.querySelector(`[data-sq="${sq}"] .piece`);
      this.drag = { from: sq, x: e.clientX, y: e.clientY, pieceEl, ghost: null };
      this.grid.setPointerCapture(e.pointerId);
    } else {
      this._select(null);
    }
  }
  _move(e) {
    const d = this.drag;
    if (!d) return;
    if (!d.ghost && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 && d.pieceEl) {
      d.ghost = d.pieceEl.cloneNode(true);
      d.ghost.classList.add('ghost');
      d.ghost.style.fontSize = getComputedStyle(d.pieceEl).fontSize;
      document.body.append(d.ghost);
      d.pieceEl.style.opacity = '0.25';
    }
    if (d.ghost) { d.ghost.style.left = e.clientX + 'px'; d.ghost.style.top = e.clientY + 'px'; }
  }
  _up(e) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    const to = this._sqAt(e.clientX, e.clientY);
    d.ghost?.remove();
    if (d.ghost && to && to !== d.from && this.selDests.includes(to)) this._try(d.from, to);
    else if (d.pieceEl) d.pieceEl.style.opacity = '';
  }
  _cancelDrag() { if (this.drag) { this.drag.ghost?.remove(); this.drag = null; this.render(); } }
  _try(from, to) {
    this.sel = null; this.selDests = [];
    const ok = this.onMove ? this.onMove(from, to) : false;
    if (ok === false) this.render();
  }
}

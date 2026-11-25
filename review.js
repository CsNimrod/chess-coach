// chess.com-style Game Review: eval bar, eval graph, move classifications and coach comments.
import { Chess, esc, md, winPct } from './chessutil.js';
import { Board } from './board.js';
import { CLASSES, isError } from './analysis.js';
import { explainMove, explainPrompt, fmtEval } from './explain.js';

const $ = (id) => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const icon = (cls, small) => { const C = CLASSES[cls]; return C ? `<span class="cls-icon${small ? ' sm' : ''}" style="background:${C.color}" title="${C.label}">${C.icon}</span>` : ''; };

export function createReview({ getEngine, askAI, aiSettings }) {
  let g = null, k = 0, retry = null, busy = false;
  const board = new Board($('reviewBoard'), {
    dests: (sq) => { if (!retry) return []; try { return new Chess(retry.fen).moves({ square: sq, verbose: true }).map((m) => m.to); } catch { return []; } },
    onMove: onRetryMove,
  });

  function open(game) {
    g = game; k = 0; retry = null;
    $('reviewEmpty').hidden = true;
    $('review').hidden = false;
    board.setOrientation(g.userColor);
    $('evalBar').classList.toggle('flip', g.userColor === 'b');
    const top = g.userColor === 'w' ? 'black' : 'white', bot = g.userColor === 'w' ? 'white' : 'black';
    const plate = (c) => `<span class="pdot ${c}"></span><b>${esc(g[c].name)}</b> <span class="muted">(${g[c].rating})</span>`;
    $('pTop').innerHTML = plate(top);
    $('pBottom').innerHTML = plate(bot);
    $('rTitle').innerHTML = `<div class="rt-open">${esc(g.opening)}</div><div class="muted small">${new Date(g.endTime * 1000).toLocaleDateString()} · ${esc(g.timeClass)}${g.practice ? '' : ` · <a href="${esc(g.url)}" target="_blank" rel="noopener">chess.com ↗</a>`}</div>`;
    $('rAccs').innerHTML = ['white', 'black'].map((c) => `<div class="acc ${c}"><div class="acc-name">${esc(g[c].name)}</div><div class="acc-val">${(c === 'white' ? g.accuracyW : g.accuracyB).toFixed(1)}</div><div class="muted small">accuracy</div></div>`).join('');
    renderMoves();
    renderSummary();
    show(0);
  }

  // ---------- move list ----------
  function renderMoves() {
    const rows = [];
    for (let i = 0; i < g.moves.length; i++) {
      const m = g.moves[i];
      if (m.color === 'w' || i === 0) rows.push({ no: m.moveNo, w: null, b: null });
      rows[rows.length - 1][m.color] = i;
    }
    const cell = (i) => {
      if (i == null) return '<td></td>';
      const a = g.analysis[i];
      return `<td class="mv" data-i="${i}">${a ? icon(a.cls, true) : ''}<span>${esc(g.moves[i].san)}</span></td>`;
    };
    $('rMoves').innerHTML = `<table>${rows.map((r) => `<tr><td class="no">${r.no}.</td>${cell(r.w)}${cell(r.b)}</tr>`).join('')}</table>`;
    $('rMoves').querySelectorAll('.mv').forEach((el) => el.addEventListener('click', () => show(+el.dataset.i + 1)));
  }

  function renderSummary() {
    const order = ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'miss', 'blunder'];
    const cnt = { w: {}, b: {} };
    g.analysis.forEach((a) => { if (a) cnt[a.color][a.cls] = (cnt[a.color][a.cls] || 0) + 1; });
    $('rSummary').innerHTML = `<table class="sumtab">${order.map((c) => `<tr><td class="n">${cnt.w[c] || 0}</td><td class="lbl">${icon(c)}<span style="color:${CLASSES[c].color}">${CLASSES[c].label}</span></td><td class="n">${cnt.b[c] || 0}</td></tr>`).join('')}</table>`;
  }

  // ---------- eval graph ----------
  function renderGraph() {
    const svg = $('graph');
    const n = g.fens.length - 1 || 1, W = 600, H = 80;
    const pts = g.evals.map((e, i) => [(i / n) * W, H * (1 - winPct(e.cp) / 100)]);
    const line = pts.map((p) => p.join(',')).join(' ');
    const dots = g.analysis.map((a, i) => (a && (isError(a.cls) || a.cls === 'brilliant' || a.cls === 'great'))
      ? `<circle cx="${pts[i + 1][0]}" cy="${pts[i + 1][1]}" r="3.2" fill="${CLASSES[a.cls].color}" stroke="#0006" stroke-width="1"/>` : '').join('');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.innerHTML = `<rect width="${W}" height="${H}" fill="#403d39"/>
      <polygon points="0,${H} ${line} ${W},${H}" fill="#f1f1f1"/>
      <line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" stroke="#888" stroke-width="0.6" stroke-dasharray="3 3"/>
      <line x1="${(k / n) * W}" y1="0" x2="${(k / n) * W}" y2="${H}" stroke="#81b64c" stroke-width="2"/>${dots}`;
  }
  $('graph').addEventListener('click', (e) => {
    if (!g) return;
    const r = $('graph').getBoundingClientRect();
    show(Math.round(((e.clientX - r.left) / r.width) * (g.fens.length - 1)));
  });

  // ---------- main view ----------
  function setEvalBar(e) {
    const w = e.mate != null ? (e.mate > 0 || (e.mate === 0 && e.cp > 0) ? 100 : 0) : winPct(e.cp);
    $('evalFill').style.height = w + '%';
    const txt = e.mate != null ? (e.mate === 0 ? '#' : 'M' + Math.abs(e.mate)) : Math.abs(e.cp / 100).toFixed(1);
    const num = $('evalNum');
    num.textContent = txt;
    num.className = (e.cp >= 0) ? 'whiteadv' : 'blackadv';
  }

  function show(nk) {
    if (!g) return;
    retry = null; board.movable = null;
    k = Math.max(0, Math.min(g.moves.length, nk));
    const i = k - 1;
    const m = g.moves[i];
    board.setPosition(g.fens[k], { lastMove: m ? { from: m.uci.slice(0, 2), to: m.uci.slice(2, 4) } : null });
    setEvalBar(g.evals[k]);
    $('rMoves').querySelectorAll('.mv').forEach((el) => el.classList.toggle('cur', +el.dataset.i === i));
    $('rMoves').querySelector('.mv.cur')?.scrollIntoView({ block: 'nearest' });
    renderGraph();
    if (i < 0) {
      $('coach').innerHTML = `<div class="coach-head"><span class="coach-avatar">♞</span><div><b>Let's review this game.</b><div class="muted small">Use ← → or the buttons. Coloured dots on the graph mark big moments.</div></div></div>${g.note ? `<div class="coach-body"><p>${esc(g.note)}</p></div>` : ''}`;
      return;
    }
    const ex = explainMove(g, i);
    if (!ex) return;
    board.setBadge({ sq: m.uci.slice(2, 4), icon: ex.C.icon, color: ex.C.color });
    if (ex.best) board.setArrows([{ from: ex.best.uci.slice(0, 2), to: ex.best.uci.slice(2, 4), color: 'green' }]);
    const mover = m.color === g.userColor ? '' : ` <span class="muted small">(${m.color === 'w' ? 'White' : 'Black'})</span>`;
    $('coach').innerHTML = `
      <div class="coach-head" style="--c:${ex.C.color}">
        ${icon(ex.cls)}
        <div class="coach-title"><b style="color:${ex.C.color}">${esc(ex.headline)}</b>${mover}</div>
        <span class="coach-eval ${g.evals[k].cp >= 0 ? 'w' : 'b'}">${esc(ex.evalText)}</span>
      </div>
      <div class="coach-body">${ex.reasons.map((r) => `<p>${esc(r)}</p>`).join('')}
        ${ex.best ? `<p class="bestline">${icon('best', true)} Best was <b>${esc(ex.best.san)}</b> <span class="muted">${esc(ex.best.line)}</span></p>` : ''}
        <div id="aiExplain" class="md small"></div>
      </div>
      <div class="coach-actions">
        ${ex.best ? '<button id="cRetry">↺ Retry</button>' : ''}
        <button id="cAI">✦ Explain with AI</button>
      </div>`;
    $('cRetry')?.addEventListener('click', () => startRetry(i));
    $('cAI').addEventListener('click', async () => {
      const box = $('aiExplain');
      box.textContent = 'Thinking…';
      try { box.innerHTML = md(await askAI(aiSettings(), explainPrompt(g, i, ex))); }
      catch (e) { box.innerHTML = `<span class="c-blunder">${esc(e.message)}</span>`; }
    });
  }

  // ---------- retry a move ----------
  function startRetry(i) {
    const a = g.analysis[i];
    retry = { i, fen: a.fen, done: false };
    board.setPosition(a.fen);
    board.movable = a.color;
    setEvalBar(g.evals[i]);
    $('coach').innerHTML = `<div class="coach-head"><span class="coach-avatar">↺</span><div><b>Find a better move for ${a.color === 'w' ? 'White' : 'Black'}</b><div class="muted small">You played ${esc(a.san)} here.</div></div></div>
      <div id="retryMsg" class="coach-body"></div>
      <div class="coach-actions"><button id="rShow">Show best</button><button id="rBack">Back</button></div>`;
    $('rShow').onclick = () => { board.setArrows([{ from: a.best.slice(0, 2), to: a.best.slice(2, 4), color: 'green' }]); $('retryMsg').innerHTML = `<p>Best was <b>${esc(a.bestSan)}</b>.</p>`; };
    $('rBack').onclick = () => show(i + 1);
  }
  function onRetryMove(from, to) {
    if (!retry || retry.done || busy) return false;
    const a = g.analysis[retry.i];
    let mv;
    const c = new Chess(retry.fen);
    try { mv = c.move({ from, to, promotion: 'q' }); } catch { return false; }
    board.setPosition(c.fen(), { lastMove: mv });
    const uci = mv.from + mv.to + (mv.promotion || '');
    const win = () => { retry.done = true; board.movable = null; board.setBadge({ sq: mv.to, icon: CLASSES.best.icon, color: CLASSES.best.color }); };
    if (uci.slice(0, 4) === a.best.slice(0, 4)) { win(); $('retryMsg').innerHTML = `<p class="ok">✓ ${esc(mv.san)} is the best move!</p>`; return true; }
    busy = true;
    $('retryMsg').innerHTML = '<p class="muted">Checking…</p>';
    getEngine().evaluate(c.fen(), {}).then((ev) => {
      busy = false;
      const cp = ev.mate != null ? (ev.mate > 0 ? 10000 : -10000) : ev.cp;
      const w = winPct(-cp);
      if (a.wB - w <= 4) { win(); $('retryMsg').innerHTML = `<p class="ok">✓ ${esc(mv.san)} works too! (Engine's top choice: ${esc(a.bestSan)})</p>`; }
      else {
        $('retryMsg').innerHTML = `<p class="bad">✗ ${esc(mv.san)} isn't it. Win chance would be ${w.toFixed(0)}%. Try again.</p>`;
        setTimeout(() => { if (retry && !retry.done) board.setPosition(retry.fen); }, 700);
      }
    });
    return true;
  }

  // ---------- controls ----------
  $('rFirst').onclick = () => show(0);
  $('rPrev').onclick = () => show(k - 1);
  $('rNext').onclick = () => show(k + 1);
  $('rLast').onclick = () => show(g.moves.length);
  $('rNextErr').onclick = () => {
    const n = g.userMoves.find((m) => m.i + 1 > k && isError(m.cls)) || g.userMoves.find((m) => m.i + 1 > k && m.cls === 'inaccuracy');
    if (n) show(n.i + 1);
  };
  document.addEventListener('keydown', (e) => {
    if (!g || $('tab-review').classList.contains('active') === false || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
    if (e.key === 'ArrowLeft') { show(k - 1); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { show(k + 1); e.preventDefault(); }
    else if (e.key === 'Home') show(0);
    else if (e.key === 'End') show(g.moves.length);
  });

  return { open, get game() { return g; } };
}

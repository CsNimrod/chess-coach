import { Chess, esc, md, uciToObj, winPct } from './chessutil.js';
import { Board } from './board.js';
import { Engine, sharedEngine, poolSize } from './engine.js';
import { fetchGames, analyzeGame, classifyGame, aggregate, worstMistakes, quickFindings, buildPrompt, Cancelled, TACTICAL } from './analysis.js';
import { askAI, PROVIDERS } from './ai.js';
import { OPENINGS, lineKey, parseMoves } from './openings.js';

const $ = (id) => document.getElementById(id);
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn('save failed', k, e); } };

// ---------------- settings ----------------
const settings = Object.assign({ provider: 'gemini', keys: {}, models: {}, depth: 16, username: '' }, load('cc_settings', {}));
const saveSettings = () => save('cc_settings', settings);

// ---------------- tabs ----------------
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
function showTab(name) {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
  if (name === 'puzzles') puzzles.enter();
}

// helpers to give a Board legal destinations from a FEN
const destsFor = (getFen) => (sq) => { try { return new Chess(getFen()).moves({ square: sq, verbose: true }).map((m) => m.to); } catch { return []; } };
function tryMove(fen, from, to) {
  try { const c = new Chess(fen); const m = c.move({ from, to, promotion: 'q' }); return { c, m }; } catch { return null; }
}
const fmtEval = (e) => (e.mate != null ? (e.mate === 0 ? 'mate' : `#${e.mate}`) : (e.cp > 0 ? '+' : '') + (e.cp / 100).toFixed(1));

// =====================================================================
// ANALYZE
// =====================================================================
let games = load('cc_last_games', []);
let stats = null;
let cancelled = false;

$('username').value = settings.username || '';
$('username').addEventListener('keydown', (e) => { if (e.key === 'Enter') runAnalysis(); });
$('analyzeBtn').addEventListener('click', runAnalysis);
$('cancelBtn').addEventListener('click', () => { cancelled = true; $('progressText').textContent = 'Stopping…'; });

function setProgress(frac, text) {
  $('progress').hidden = false;
  $('progressFill').style.width = (100 * frac).toFixed(1) + '%';
  if (text) $('progressText').textContent = text;
}
function showError(msg) { $('error').hidden = !msg; $('error').textContent = msg || ''; }

async function runAnalysis() {
  const username = $('username').value.trim();
  if (!username) { showError('Enter your chess.com username.'); return; }
  showError('');
  settings.username = username; saveSettings();
  const count = Math.max(1, Math.min(200, +$('gameCount').value || 15));
  cancelled = false;
  $('analyzeBtn').disabled = true; $('cancelBtn').hidden = false;
  const pool = [];
  try {
    setProgress(0, 'Contacting chess.com…');
    const list = await fetchGames(username, { count, timeClass: $('timeClass').value }, (t) => setProgress(0, t));
    if (!list.length) throw new Error('No standard chess games found for that filter.');
    const depth = settings.depth;
    const total = list.reduce((s, g) => s + g.fens.length, 0);
    let done = 0, finished = 0;
    const t0 = Date.now();
    const n = Math.min(poolSize(), list.length);
    setProgress(0, `Loading Stockfish (${n} engine${n > 1 ? 's' : ''})…`);
    for (let i = 0; i < n; i++) pool.push(new Engine());
    await Promise.all(pool.map((e) => e.ready));
    const tick = (k) => {
      done += k;
      const el = (Date.now() - t0) / 1000;
      const eta = done > 20 ? Math.round((el / done) * (total - done)) : null;
      setProgress(done / total, `Analyzing with Stockfish depth ${depth}: game ${Math.min(finished + 1, list.length)}/${list.length} · ${done}/${total} positions${eta != null ? ` · ~${eta > 90 ? Math.round(eta / 60) + ' min' : eta + 's'} left` : ''}`);
    };
    let next = 0;
    const results = [];
    await Promise.all(pool.map(async (eng) => {
      while (next < list.length && !cancelled) {
        const g = list[next++];
        try { results.push(classifyGame(await analyzeGame(g, eng, depth, tick, () => cancelled))); finished++; }
        catch (e) { if (!(e instanceof Cancelled)) console.error(e); }
      }
    }));
    if (!results.length) throw new Error(cancelled ? 'Stopped before any game finished.' : 'Analysis failed.');
    results.sort((a, b) => b.endTime - a.endTime);
    games = results;
    save('cc_last_games', games.map(({ userMoves, ...g }) => g));
    setProgress(1, `Done: analyzed ${games.length} game${games.length > 1 ? 's' : ''}${cancelled ? ' (stopped early)' : ''}.`);
    renderResults();
  } catch (e) {
    showError(e.message || String(e));
    $('progress').hidden = true;
  } finally {
    pool.forEach((e) => e.terminate());
    $('analyzeBtn').disabled = false; $('cancelBtn').hidden = true;
  }
}

function renderResults() {
  if (!games.length) return;
  games.forEach((g) => { if (!g.userMoves) classifyGame(g); });
  stats = aggregate(games);
  const s = stats;
  $('results').hidden = false;
  const card = (v, k) => `<div class="stat"><div class="v">${v}</div><div class="k">${k}</div></div>`;
  $('summary').innerHTML = [
    card(s.games, 'games analyzed'),
    card(`${s.wins}/${s.draws}/${s.losses}`, 'wins / draws / losses'),
    card(s.avgAccuracy.toFixed(1) + '%', 'average accuracy'),
    card(`<span class="c-blunder">${(s.blunders / s.games).toFixed(1)}</span>`, 'blunders per game'),
    card(`<span class="c-mistake">${(s.mistakes / s.games).toFixed(1)}</span>`, 'mistakes per game'),
    card(s.avgRating || '–', 'average rating'),
  ].join('');

  const f = quickFindings(s);
  $('findings').innerHTML = f.length ? f.map((x) => `<li>${md(x).replace(/^<p>|<\/p>$/g, '')}</li>`).join('') : '<li>Not enough mistakes to find patterns. Nice!</li>';

  const tags = Object.entries(s.tags).sort((a, b) => b[1] - a[1]);
  const max = tags[0]?.[1] || 1;
  $('tagChart').innerHTML = tags.length
    ? tags.map(([t, c]) => `<div class="hbar"><span>${esc(t)}</span><div class="track"><div class="fill" style="width:${(100 * c) / max}%;background:${TACTICAL.includes(t) ? 'var(--blun)' : 'var(--mist)'}"></div></div><span>${c}</span></div>`).join('')
    : '<p class="muted">No mistakes or blunders found.</p>';

  $('phaseTable').innerHTML = `<table><tr><th>Phase</th><th>Accuracy</th><th>Mistakes + blunders</th><th>Per game</th></tr>${
    Object.entries(s.phase).map(([k, p]) => `<tr><td>${k}</td><td>${p.acc != null ? p.acc.toFixed(1) + '%' : '–'}</td><td>${p.errors}</td><td>${(p.errors / s.games).toFixed(1)}</td></tr>`).join('')}</table>
    <p class="muted small">Time trouble: ${s.timeTroubleErrors} of ${s.totalErrors} mistakes happened with under 10% of your clock left.
    ${s.winningGames ? `Winning positions converted: ${s.converted}/${s.winningGames}.` : ''}</p>`;

  $('openingTable').innerHTML = `<table><tr><th>Opening</th><th>Games</th><th>Score</th><th>Accuracy</th><th>Opening mistakes</th><th></th></tr>${
    s.openings.map((o) => {
      const grp = OPENINGS.find((g) => g.match.some((k) => o.name.toLowerCase().includes(k.toLowerCase())));
      return `<tr><td>${esc(o.name)}</td><td>${o.games}</td><td>${o.scorePct.toFixed(0)}%</td><td>${o.acc.toFixed(0)}%</td><td>${o.openingErrors}</td><td>${grp ? `<button class="small" data-drill="${grp.id}">Drill</button>` : ''}</td></tr>`;
    }).join('')}</table>`;
  $('openingTable').querySelectorAll('[data-drill]').forEach((b) => b.addEventListener('click', () => { showTab('openings'); drill.selectGroup(b.dataset.drill); }));

  $('gameList').innerHTML = `<table><tr><th>Date</th><th>Color</th><th>Opponent</th><th>Result</th><th>Opening</th><th>Accuracy</th><th>B / M / I</th></tr>${
    games.map((g, idx) => `<tr class="click" data-g="${idx}"><td>${new Date(g.endTime * 1000).toLocaleDateString()}</td><td>${g.userColor === 'w' ? '⚪' : '⚫'}</td><td>${esc(g.opp.name)} (${g.opp.rating})</td>
      <td><span class="pill ${g.result}">${g.result}</span></td><td>${esc(g.opening)}</td><td>${g.accuracy.toFixed(0)}%</td>
      <td><span class="c-blunder">${g.counts.blunder}</span> / <span class="c-mistake">${g.counts.mistake}</span> / <span class="c-inaccuracy">${g.counts.inaccuracy}</span></td></tr>`).join('')}</table>`;
  $('gameList').querySelectorAll('[data-g]').forEach((tr) => tr.addEventListener('click', () => viewer.open(games[+tr.dataset.g])));
  puzzles.rebuild();
}

$('aiBtn').addEventListener('click', async () => {
  if (!stats) return;
  const out = $('aiOut');
  $('aiBtn').disabled = true;
  out.classList.add('muted');
  out.textContent = 'Asking the AI coach… (this can take 10–30 seconds)';
  try {
    const text = await askAI({ provider: settings.provider, key: settings.keys[settings.provider], model: settings.models[settings.provider] }, buildPrompt(stats, worstMistakes(games, 15)));
    out.classList.remove('muted');
    out.innerHTML = md(text);
    save('cc_last_ai', text);
  } catch (e) {
    out.innerHTML = `<span class="c-blunder">${esc(e.message)}</span>`;
  } finally { $('aiBtn').disabled = false; }
});

// =====================================================================
// GAME VIEWER
// =====================================================================
const viewer = (() => {
  let g = null, k = 0;
  const board = new Board($('viewerBoard'));
  const umAt = (i) => g.userMoves.find((m) => m.i === i);
  function open(game) {
    g = game; k = 0;
    $('viewer').hidden = false;
    board.setOrientation(g.userColor);
    $('viewerTitle').textContent = `${g.me.name} vs ${g.opp.name} · ${g.opening} · ${g.result}`;
    $('viewerLink').href = g.url;
    const html = g.moves.map((m, i) => {
      const u = m.color === g.userColor ? umAt(i) : null;
      const cls = u && u.cls !== 'good' ? `c-${u.cls}` : '';
      return `${m.color === 'w' ? `<span class="n">${m.moveNo}.</span>` : i === 0 ? `<span class="n">${m.moveNo}…</span>` : ''}<span class="m ${cls}" data-i="${i}">${esc(m.san)}</span>`;
    }).join('');
    $('viewerMoves').innerHTML = html;
    $('viewerMoves').querySelectorAll('.m').forEach((el) => el.addEventListener('click', () => {
      const i = +el.dataset.i; const u = umAt(i);
      show(u && u.cls !== 'good' ? i : i + 1);
    }));
    const firstErr = g.userMoves.find((m) => m.cls === 'blunder' || m.cls === 'mistake');
    show(0);
    if (firstErr) $('viewerInfo').innerHTML += `<div class="small muted">Press “Next mistake” to jump to your errors.</div>`;
  }
  function show(nk) {
    k = Math.max(0, Math.min(g.moves.length, nk));
    const prev = g.moves[k - 1];
    board.setPosition(g.fens[k], { lastMove: prev ? { from: prev.uci.slice(0, 2), to: prev.uci.slice(2, 4) } : null });
    $('viewerMoves').querySelectorAll('.m').forEach((el) => el.classList.toggle('cur', +el.dataset.i === k - 1));
    const cur = $('viewerMoves').querySelector('.m.cur'); cur?.scrollIntoView({ block: 'nearest' });
    const e = g.evals[k];
    let info = `<div>Eval: <b>${fmtEval(e)}</b> <span class="muted small">(White's view)</span></div>`;
    const u = umAt(k);
    if (u && u.cls !== 'good') {
      board.setArrows([{ from: u.uci.slice(0, 2), to: u.uci.slice(2, 4), color: 'red' }, ...(u.best ? [{ from: u.best.slice(0, 2), to: u.best.slice(2, 4), color: 'green' }] : [])]);
      info = `<div><b class="c-${u.cls}">${u.cls[0].toUpperCase() + u.cls.slice(1)}</b> coming up: you played <b>${esc(u.san)}</b> (red). Best was <b>${esc(u.bestSan || '?')}</b> (green).</div>
        <div class="small muted">Your win chance went ${u.wB.toFixed(0)}% → ${u.wA.toFixed(0)}%${u.clock != null ? ` · ${Math.round(u.clock)}s on clock` : ''}</div>
        ${u.tags.length ? `<div class="small">${u.tags.map((t) => `<span class="pill">${esc(t)}</span>`).join(' ')}</div>` : ''}`;
    }
    $('viewerInfo').innerHTML = info;
  }
  function nextErr() {
    const n = g.userMoves.find((m) => m.i > k && (m.cls === 'blunder' || m.cls === 'mistake')) || g.userMoves.find((m) => m.i > k && m.cls === 'inaccuracy');
    if (n) show(n.i);
  }
  $('vFirst').onclick = () => show(0);
  $('vPrev').onclick = () => show(k - 1);
  $('vNext').onclick = () => show(k + 1);
  $('vLast').onclick = () => show(g.moves.length);
  $('vNextErr').onclick = nextErr;
  $('viewerClose').onclick = () => { $('viewer').hidden = true; };
  $('viewer').addEventListener('click', (e) => { if (e.target.id === 'viewer') $('viewer').hidden = true; });
  document.addEventListener('keydown', (e) => {
    if ($('viewer').hidden) return;
    if (e.key === 'ArrowLeft') show(k - 1);
    else if (e.key === 'ArrowRight') show(k + 1);
    else if (e.key === 'Escape') $('viewer').hidden = true;
  });
  return { open };
})();

// =====================================================================
// PUZZLES FROM YOUR MISTAKES
// =====================================================================
const puzzles = (() => {
  let list = [], idx = 0, cur = null, fen = null, busy = false, solvedThis = false, tries = 0;
  const score = load('cc_puzzle_score', { solved: 0, seen: 0 });
  const board = new Board($('puzzleBoard'), { dests: destsFor(() => fen), onMove });
  board.setPosition(new Chess().fen());

  function rebuild() {
    const f = $('puzzleFilter').value;
    list = [];
    for (const g of games) for (const m of g.userMoves || []) {
      if (!(m.cls === 'blunder' || m.cls === 'mistake') || !m.best) continue;
      if (f === 'blunder' && m.cls !== 'blunder') continue;
      if (f === 'tactic' && !m.tags.some((t) => TACTICAL.includes(t))) continue;
      list.push({ ...m, game: g });
    }
    list.sort(() => Math.random() - 0.5);
    idx = 0; cur = null;
    $('puzzleCount').textContent = `${list.length} positions`;
  }
  function enter() { if (!cur) next(); }
  function next() {
    if (!list.length) {
      $('puzzleInfo').innerHTML = games.length ? 'No mistakes match this filter.' : 'Analyze your games on the <b>Analyze</b> tab first. Your mistakes become puzzles here.';
      board.movable = null; return;
    }
    cur = list[idx++ % list.length];
    fen = cur.fen; solvedThis = false; tries = 0;
    const c = cur.game.userColor;
    board.setOrientation(c);
    board.setPosition(fen);
    board.movable = c;
    $('puzzleStatus').className = 'status'; $('puzzleStatus').textContent = `${c === 'w' ? 'White' : 'Black'} to move. Find the best move.`;
    $('puzzleInfo').innerHTML = `From your game vs <b>${esc(cur.game.opp.name)}</b> (${esc(cur.game.family)}), move ${cur.moveNo}.<br>
      <span class="small muted">You played ${esc(cur.san)} here: a ${cur.cls} that dropped your win chance ${cur.wB.toFixed(0)}% → ${cur.wA.toFixed(0)}%. ${cur.tags.filter((t) => TACTICAL.includes(t)).join(', ')}</span>`;
  }
  function finish(ok, text) {
    solvedThis = true; board.movable = null;
    score.seen++; if (ok) score.solved++; save('cc_puzzle_score', score);
    $('puzzleStatus').className = 'status ' + (ok ? 'ok' : 'bad');
    $('puzzleStatus').textContent = text;
    $('puzzleScore').textContent = `Solved ${score.solved} of ${score.seen} overall`;
  }
  function onMove(from, to) {
    if (busy || solvedThis) return false;
    const r = tryMove(fen, from, to);
    if (!r) return false;
    const uci = r.m.from + r.m.to + (r.m.promotion || '');
    board.setPosition(r.c.fen(), { lastMove: r.m });
    if (uci === cur.best || uci.slice(0, 4) === cur.best.slice(0, 4)) { board.mark(to, 'right', 0); finish(tries === 0, tries === 0 ? `Correct! ${cur.bestSan} was the move.` : `Got it: ${cur.bestSan}.`); return true; }
    busy = true;
    $('puzzleStatus').className = 'status'; $('puzzleStatus').textContent = 'Checking with Stockfish…';
    sharedEngine().evaluate(r.c.fen(), { depth: settings.depth }).then((ev) => {
      busy = false;
      const cp = ev.mate != null ? (ev.mate > 0 ? 10000 : -10000) : ev.cp; // opponent's view
      const w = winPct(-cp);
      if (cur.wB - w <= 4) { board.mark(to, 'right', 0); finish(tries === 0, `Good move! ${r.m.san} works too (engine's top choice: ${cur.bestSan}).`); }
      else {
        tries++;
        board.mark(to, 'wrong', 700);
        $('puzzleStatus').className = 'status bad';
        $('puzzleStatus').textContent = `${r.m.san} isn't it (win chance would be ${w.toFixed(0)}%). Try again.`;
        setTimeout(() => { if (!solvedThis) board.setPosition(fen); }, 700);
      }
    });
    return true;
  }
  $('puzzleNext').onclick = next;
  $('puzzleReveal').onclick = () => {
    if (!cur) return;
    board.setPosition(fen);
    board.setArrows([{ from: cur.best.slice(0, 2), to: cur.best.slice(2, 4), color: 'green' }, { from: cur.uci.slice(0, 2), to: cur.uci.slice(2, 4), color: 'red' }]);
    if (!solvedThis) finish(false, `Answer: ${cur.bestSan} (green). You played ${cur.san} (red).`);
  };
  $('puzzleHint').onclick = () => { if (cur && !solvedThis) { tries++; board.mark(cur.best.slice(0, 2), 'hint', 1500); } };
  $('puzzleFilter').onchange = () => { rebuild(); next(); };
  $('puzzleScore').textContent = score.seen ? `Solved ${score.solved} of ${score.seen} overall` : '';
  return { rebuild, enter };
})();

// =====================================================================
// OPENING DRILLS
// =====================================================================
const drill = (() => {
  const custom = load('cc_custom_lines', []);
  const stats = load('cc_drill_stats', {});
  const groups = () => (custom.length ? [...OPENINGS, { id: 'custom', name: 'My own lines', side: custom[0].side, desc: 'Lines you added yourself.', match: [], lines: custom }] : OPENINGS);

  // Validate every line with chess.js once; trim anything illegal.
  for (const g of OPENINGS) for (const l of g.lines) {
    const c = new Chess(); const arr = parseMoves(l.moves); const ok = [];
    for (const san of arr) { try { ok.push(c.move(san).san); } catch { console.error(`Illegal move "${san}" in ${g.name} / ${l.name}`); break; } }
    l.san = ok;
  }
  custom.forEach((l) => { l.san = l.san || parseMoves(l.moves); });

  let st = null; // {g, li, line, side, ply, chess, errors, plyErrors, mode, done}
  const board = new Board($('drillBoard'), { dests: destsFor(() => st?.chess.fen() || new Chess().fen()), onMove });
  board.setPosition(new Chess().fen());

  const sel = $('drillGroup');
  function fillGroups() { sel.innerHTML = groups().map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join(''); }
  const group = () => groups().find((g) => g.id === sel.value) || groups()[0];
  function fillLines() {
    const g = group();
    $('drillDesc').textContent = g.desc;
    $('drillLine').innerHTML = `<option value="auto">Auto: weakest line first</option>` + g.lines.map((l, i) => `<option value="${i}">${esc(l.name)}</option>`).join('');
    $('drillSide').value = g.side;
    renderMastery();
  }
  function selectGroup(id) { sel.value = id; fillLines(); start(); }
  sel.onchange = () => { fillLines(); start(); };
  $('drillLine').onchange = () => { const g = group(); const li = +$('drillLine').value; if (g.id === 'custom' && !isNaN(li)) $('drillSide').value = g.lines[li].side; start(); };
  $('drillSide').onchange = () => start(st?.li);
  $('drillMode').onchange = () => start(st?.li);

  function pickLine() {
    const g = group();
    const v = $('drillLine').value;
    if (v !== 'auto') return +v;
    const side = $('drillSide').value;
    const scored = g.lines.map((l, i) => ({ i, s: stats[lineKey(g.id, i) + side] || { streak: 0, last: 0 } }));
    scored.sort((a, b) => a.s.streak - b.s.streak || a.s.last - b.s.last || Math.random() - 0.5);
    return scored.find((x) => x.i !== st?.li)?.i ?? scored[0].i;
  }

  function start(li) {
    const g = group();
    li = li ?? pickLine();
    const line = g.lines[li];
    st = { g, li, line, side: $('drillSide').value, ply: 0, chess: new Chess(), errors: 0, plyErrors: 0, mode: $('drillMode').value, done: false };
    board.setOrientation(st.side);
    board.setPosition(st.chess.fen());
    board.movable = st.side;
    status(`${line.name}. ${st.mode === 'learn' ? 'Follow the blue arrows.' : 'Play the book moves from memory.'}`);
    renderMoves();
    setTimeout(autoplay, 300);
  }
  function status(t, cls = '') { $('drillStatus').className = 'status ' + cls; $('drillStatus').textContent = t; }
  function expected() { return st.line.san[st.ply]; }
  function userTurn() { return st.chess.turn() === st.side; }
  function autoplay() {
    if (!st || st.done) return;
    if (st.ply >= st.line.san.length) return complete();
    if (!userTurn()) {
      const m = st.chess.move(expected());
      st.ply++;
      board.setPosition(st.chess.fen(), { lastMove: m });
      renderMoves();
      if (st.ply >= st.line.san.length) return complete();
    }
    if (st.mode === 'learn') showArrow();
  }
  function showArrow() {
    const c = new Chess(st.chess.fen());
    const m = c.move(expected());
    board.setArrows([{ from: m.from, to: m.to, color: 'blue' }]);
  }
  const norm = (s) => s.replace(/[+#!?]/g, '');
  function onMove(from, to) {
    if (!st || st.done || !userTurn()) return false;
    const r = tryMove(st.chess.fen(), from, to);
    if (!r) return false;
    if (norm(r.m.san) === norm(expected())) {
      st.chess.move(r.m.san);
      st.ply++; st.plyErrors = 0;
      board.setPosition(st.chess.fen(), { lastMove: r.m });
      board.mark(to, 'right', 400);
      status(`✓ ${r.m.san}`, 'ok');
      renderMoves();
      setTimeout(autoplay, 350);
    } else {
      st.errors++; st.plyErrors++;
      board.mark(from, 'wrong', 500); board.mark(to, 'wrong', 500);
      status(`✗ ${r.m.san} isn't the book move here. Try again.`, 'bad');
      if (st.plyErrors >= 2) showArrow();
      return false;
    }
    return true;
  }
  function complete() {
    st.done = true; board.movable = null; board.setArrows([]);
    const key = lineKey(st.g.id, st.li) + st.side;
    const s = (stats[key] ||= { attempts: 0, clean: 0, streak: 0, last: 0 });
    if (st.mode === 'test') {
      s.attempts++;
      if (st.errors === 0) { s.clean++; s.streak++; } else s.streak = 0;
      s.last = Date.now();
      save('cc_drill_stats', stats);
    }
    status(st.errors === 0 ? `Line complete, no mistakes! ${st.mode === 'learn' ? 'Switch to Test mode to lock it in.' : ''}` : `Line complete with ${st.errors} mistake${st.errors > 1 ? 's' : ''}. Repeat it!`, st.errors ? 'bad' : 'ok');
    renderMastery();
  }
  function renderMoves() {
    const san = st.line.san;
    $('drillMoves').innerHTML = san.map((m, i) => {
      const num = i % 2 === 0 ? `<span class="n">${i / 2 + 1}.</span>` : '';
      const shown = i < st.ply || st.mode === 'learn';
      return `${num}<span class="m ${i === st.ply - 1 ? 'cur' : ''} ${i >= st.ply ? 'pending' : ''}">${shown ? esc(m) : '…'}</span>`;
    }).join('');
  }
  function renderMastery() {
    const g = group(); const side = $('drillSide').value;
    $('drillMastery').innerHTML = g.lines.map((l, i) => {
      const s = stats[lineKey(g.id, i) + side] || { attempts: 0, clean: 0, streak: 0 };
      const n = Math.min(5, s.streak);
      return `<div class="mastery"><span>${esc(l.name)}</span><span class="dots" title="clean runs in a row">${'●'.repeat(n)}${'○'.repeat(5 - n)}</span><span class="muted">${s.clean}/${s.attempts}</span></div>`;
    }).join('') + '<p class="muted small">Mastery counts Test-mode runs. 5 clean runs in a row = learned.</p>';
  }
  $('drillStart').onclick = () => start(st && $('drillLine').value !== 'auto' ? st.li : undefined);
  $('drillNext').onclick = () => { $('drillLine').value = 'auto'; start(); };
  $('drillHint').onclick = () => { if (st && !st.done && userTurn()) { st.errors++; showArrow(); } };
  $('customAdd').onclick = () => {
    const name = $('customName').value.trim() || 'My line';
    const arr = parseMoves($('customMoves').value);
    const c = new Chess(); const san = [];
    for (const m of arr) { try { san.push(c.move(m).san); } catch { $('customMsg').innerHTML = `<span class="c-blunder">Illegal move: ${esc(m)}</span>`; return; } }
    if (san.length < 2) { $('customMsg').innerHTML = '<span class="c-blunder">Enter at least 2 moves.</span>'; return; }
    custom.push({ name, moves: san.join(' '), san, side: $('customSide').value });
    save('cc_custom_lines', custom.map(({ san: _s, ...l }) => l));
    $('customMsg').innerHTML = '<span style="color:var(--good)">Added to "My own lines".</span>';
    fillGroups(); selectGroup('custom');
  };

  fillGroups(); fillLines(); start();
  return { selectGroup };
})();

// =====================================================================
// SETTINGS UI
// =====================================================================
(function settingsUI() {
  const prov = $('aiProvider');
  prov.innerHTML = Object.entries(PROVIDERS).map(([k, p]) => `<option value="${k}">${p.label}</option>`).join('');
  function sync() {
    const p = PROVIDERS[settings.provider];
    prov.value = settings.provider;
    $('aiKeyRow').hidden = !p.needsKey;
    $('aiKey').value = settings.keys[settings.provider] || '';
    $('aiModel').value = settings.models[settings.provider] || p.model;
    $('aiKeyHelp').innerHTML = p.needsKey
      ? `Get a free key at <a href="${p.keyUrl}" target="_blank" rel="noopener">${p.keyUrl.replace('https://', '')}</a> (no credit card needed).`
      : `Install <a href="${p.keyUrl}" target="_blank" rel="noopener">Ollama</a>, run <code>ollama pull ${p.model}</code>, and keep it running. Everything stays on your PC.`;
  }
  prov.onchange = () => { settings.provider = prov.value; saveSettings(); sync(); };
  $('aiKey').oninput = () => { settings.keys[settings.provider] = $('aiKey').value.trim(); saveSettings(); };
  $('aiModel').oninput = () => { settings.models[settings.provider] = $('aiModel').value.trim(); saveSettings(); };
  $('depth').value = settings.depth;
  $('depth').onchange = () => { settings.depth = Math.max(6, Math.min(24, +$('depth').value || 16)); $('depth').value = settings.depth; saveSettings(); };
  $('cores').textContent = poolSize();
  $('clearCache').onclick = () => {
    let n = 0;
    for (const k of Object.keys(localStorage)) if (k.startsWith('cc_ev_') || k === 'cc_last_games') { localStorage.removeItem(k); n++; }
    $('cacheMsg').textContent = `Cleared ${n} cached item${n === 1 ? '' : 's'}.`;
  };
  sync();
})();

// restore last session
if (games.length) {
  renderResults();
  const ai = load('cc_last_ai', null);
  if (ai) { $('aiOut').classList.remove('muted'); $('aiOut').innerHTML = md(ai); }
}

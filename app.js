import { Chess, esc, md, uciToObj, winPct } from './chessutil.js';
import { Board, soundSettings, setSound } from './board.js';
import { Engine, sharedEngine, poolSize } from './engine.js';
import { fetchGames, analyzeGame, classifyGame, aggregate, worstMistakes, quickFindings, buildPrompt, Cancelled, TACTICAL, CLASSES, isError } from './analysis.js';
import { askAI, PROVIDERS } from './ai.js';
import { OPENINGS, lineKey, parseMoves } from './openings.js';
import { createReview } from './review.js';
import { lichessToken, connectLichess, finishLichessLogin, disconnectLichess, bandsFor, explore, pickMove } from './explorer.js';

const $ = (id) => document.getElementById(id);
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn('save failed', k, e); } };

// ---------------- settings ----------------
const settings = Object.assign({ provider: 'gemini', keys: {}, models: {}, depth: 16, username: '' }, load('cc_settings', {}));
const saveSettings = () => save('cc_settings', settings);
document.documentElement.dataset.board = settings.boardTheme || 'brown';

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
    for (let i = 0; i < n; i++) pool.push(new Engine({ multipv: 2 }));
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
    save('cc_last_games', games.map(({ userMoves, analysis, ...g }) => g));
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

  drill.setRating(s.avgRating);
  const f = quickFindings(s);
  $('findings').innerHTML = f.length ? f.map((x) => `<li>${md(x).replace(/^<p>|<\/p>$/g, '')}</li>`).join('') : '<li>Not enough mistakes to find patterns. Nice!</li>';

  const tags = Object.entries(s.tags).sort((a, b) => b[1] - a[1]);
  const max = tags[0]?.[1] || 1;
  $('tagChart').innerHTML = tags.length
    ? tags.map(([t, c]) => `<div class="hbar"><span>${esc(t)}</span><div class="track"><div class="fill" style="width:${(100 * c) / max}%;background:${TACTICAL.includes(t) ? 'var(--blun)' : 'var(--mist)'}"></div></div><span>${c}</span></div>`).join('')
    : '<p class="muted">No mistakes or blunders found.</p>';

  const order = ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'miss', 'blunder'];
  const totalMoves = order.reduce((a, c) => a + (s.classes[c] || 0), 0) || 1;
  const cmax = Math.max(1, ...order.map((c) => s.classes[c] || 0));
  $('classChart').innerHTML = order.map((c) => {
    const n = s.classes[c] || 0, C = CLASSES[c];
    return `<div class="hbar"><span class="lbl"><span class="cls-icon sm" style="background:${C.color}">${C.icon}</span>${C.label}</span><div class="track"><div class="fill" style="width:${(100 * n) / cmax}%;background:${C.color}"></div></div><span title="${((100 * n) / totalMoves).toFixed(0)}% of your moves">${n}</span></div>`;
  }).join('');

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
    games.map((g, idx) => `<tr class="click" data-g="${idx}" title="Open Game Review"><td>${new Date(g.endTime * 1000).toLocaleDateString()}</td><td>${g.userColor === 'w' ? '⚪' : '⚫'}</td><td>${esc(g.opp.name)} (${g.opp.rating})</td>
      <td><span class="pill ${g.result}">${g.result}</span></td><td>${esc(g.opening)}</td><td>${g.accuracy.toFixed(0)}%</td>
      <td><span class="c-blunder">${g.counts.blunder}</span> / <span class="c-mistake">${g.counts.mistake + g.counts.miss}</span> / <span class="c-inaccuracy">${g.counts.inaccuracy}</span></td></tr>`).join('')}</table>`;
  $('gameList').querySelectorAll('[data-g]').forEach((tr) => tr.addEventListener('click', () => { review.open(games[+tr.dataset.g]); showTab('review'); window.scrollTo(0, 0); }));
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
// GAME REVIEW
// =====================================================================
const review = createReview({
  getEngine: sharedEngine,
  askAI,
  aiSettings: () => ({ provider: settings.provider, key: settings.keys[settings.provider], model: settings.models[settings.provider] }),
});

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
      if (!isError(m.cls) || !m.best) continue;
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
    renderRealBox();
    if ($('drillMode').value === 'real') return realStart();
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
    if (st?.real) return realOnMove(from, to);
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
    if (st.real) {
      const n0 = 1;
      $('drillMoves').innerHTML = st.hist.map((m, i) => `${i % 2 === 0 ? `<span class="n">${n0 + i / 2}.</span>` : ''}<span class="m ${i === st.hist.length - 1 ? 'cur' : ''}">${esc(m)}</span>`).join('') || '<span class="muted small">No moves yet</span>';
      return;
    }
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
  // ------------------------------------------------------------------
  // Real-opponent mode: the bot plays what Lichess players at your rating play.
  // ------------------------------------------------------------------
  let xData = null; // explorer data for the current position
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const realParams = () => ({ ...bandsFor($('realRating').value), speeds: $('realSpeeds').value });
  const toCp = (r) => (r.mate != null ? (r.mate > 0 ? 10000 - r.mate * 10 : -10000 - r.mate * 10) : r.cp);

  function renderRealBox() {
    const isReal = $('drillMode').value === 'real';
    $('realBox').hidden = !isReal;
    $('explorerBox').hidden = !isReal;
    $('realFeedback').hidden = true;
    $('drillLine').disabled = isReal;
    $('realFinish').hidden = !isReal;
    if (!isReal) return;
    const p = realParams();
    $('realBand').textContent = `Your rating ≈ ${p.est} on Lichess, so the bot plays what Lichess players rated ${p.label} play (${$('realSpeeds').selectedOptions[0].text}). Your ${group().name} lines are used as your repertoire.`;
    $('lichessConn').innerHTML = lichessToken()
      ? `<div class="conn"><span><span class="dot"></span>Connected to the Lichess games database</span><button id="lxOut">Disconnect</button></div>`
      : `<div class="conn"><span>This uses millions of real games from Lichess. Log in with a free Lichess account to use it (read-only, no permissions).</span><button id="lxIn" class="primary">Connect Lichess</button></div>`;
    $('lxIn')?.addEventListener('click', () => { sessionStorage.setItem('cc_after_login', 'real'); connectLichess(); });
    $('lxOut')?.addEventListener('click', async () => { await disconnectLichess(); start(); });
  }

  function bookNext() {
    const lines = st.g.lines.filter((l) => !l.side || l.side === st.side).map((l) => l.san);
    const next = new Set();
    for (const s of lines) if (s.length > st.hist.length && st.hist.every((m, i) => norm(m) === norm(s[i]))) next.add(s[st.hist.length]);
    return [...next];
  }
  function feedback(html) {
    st.feedback.unshift(html);
    $('realFeedback').hidden = false;
    $('realFeedback').innerHTML = st.feedback.slice(0, 4).map((h, i) => `<div class="fb" style="opacity:${1 - i * 0.22}">${h}</div>`).join('');
  }
  function renderExplorer(d) {
    $('explorerTotal').textContent = `(${d.total.toLocaleString()} games)`;
    $('explorerOpening').textContent = d.opening ? `${d.opening.eco} · ${d.opening.name}` : '';
    $('explorerMoves').innerHTML = d.moves.slice(0, 8).map((m) => {
      const w = (100 * m.white) / m.games, dr = (100 * m.draws) / m.games, b = Math.max(0, 100 - w - dr);
      const seg = (cls, v) => `<span class="${cls}" style="width:${v}%">${v >= 14 ? v.toFixed(0) + '%' : ''}</span>`;
      return `<div class="xrow"><b>${esc(m.san)}</b><span>${m.pct.toFixed(0)}%</span><div class="wdl">${seg('w', w)}${seg('d', dr)}${seg('b', b)}</div></div>`;
    }).join('') || '<p class="muted small">No games in this position.</p>';
  }
  const scoreFor = (m, side) => (100 * ((side === 'w' ? m.white : m.black) + m.draws / 2)) / m.games;

  function realStart() {
    const g = group();
    st = { real: true, g, side: $('drillSide').value, chess: new Chess(), hist: [], errors: 0, outAt: null, youLeftAt: null, openingName: null, done: false, maxPly: 24, feedback: [] };
    xData = null;
    board.setOrientation(st.side);
    board.setPosition(st.chess.fen());
    board.movable = null;
    renderMoves();
    $('explorerMoves').innerHTML = '';
    if (!lichessToken()) { status('Connect Lichess above to start.'); return; }
    status(`Playing ${g.name} vs real opponents. Loading…`);
    realTurn();
  }

  async function realTurn() {
    const my = st;
    if (my.done) return;
    if (my.hist.length >= my.maxPly) return realComplete('You got through the opening.');
    let d;
    try { d = await explore(my.chess.fen(), realParams()); }
    catch (e) { if (st === my) { status(e.message, 'bad'); if (e.code === 'auth') renderRealBox(); } return; }
    if (st !== my) return;
    xData = d;
    if (d.opening?.name) my.openingName = d.opening.name;
    renderExplorer(d);
    if (!userTurn()) {
      if (d.total < 8 || !d.moves.length) return realComplete(`Players at your level almost never reach this position (${d.total} games), so the opening phase is over.`);
      board.movable = null;
      status('Opponent is thinking…');
      await sleep(500);
      if (st !== my || my.done) return;
      const pick = pickMove(d, $('realPick').value);
      const book = bookNext();
      const mv = my.chess.move(pick.san);
      my.hist.push(mv.san);
      board.setPosition(my.chess.fen(), { lastMove: mv });
      renderMoves();
      const offBook = book.length && !book.some((b) => norm(b) === norm(mv.san));
      if (offBook && my.outAt == null) my.outAt = my.hist.length;
      feedback(`<span>🧑 Opponent played <b>${esc(mv.san)}</b>, chosen by ${pick.pct.toFixed(0)}% of players at your level.${offBook ? ' <b class="c-mistake">⚠ Your lines don\'t cover this.</b>' : ''}</span>`);
      return realTurn();
    }
    board.movable = my.side;
    status('Your move.');
  }

  // During a real-opponent game nothing interrupts you: any move is allowed,
  // and grading happens only when you analyze the finished game.
  function realOnMove(from, to) {
    if (!st || st.done || !userTurn()) return false;
    const r = tryMove(st.chess.fen(), from, to);
    if (!r) return false;
    const book = bookNext();
    if (book.length && !book.some((b) => norm(b) === norm(r.m.san)) && st.youLeftAt == null) st.youLeftAt = st.hist.length + 1;
    st.chess.move(r.m.san);
    st.hist.push(r.m.san);
    board.setPosition(st.chess.fen(), { lastMove: r.m });
    renderMoves();
    setTimeout(realTurn, 250);
    return true;
  }

  function realComplete(msg) {
    st.done = true;
    board.movable = null;
    const my = st;
    const hist = st.hist.slice(), side = st.side, gname = st.g.name;
    status(msg, 'ok');
    feedback(`<span>🏁 Game over. <button id="realAnalyze" class="primary">📊 Analyze game</button> <button id="realSave">💾 Save line</button></span>`);
    $('realSave').onclick = () => {
      custom.push({ name: `${gname}: ${hist.slice(0, 8).join(' ')}…`, moves: hist.join(' '), san: hist, side });
      save('cc_custom_lines', custom.map(({ san: _s, ...l }) => l));
      $('realSave').replaceWith(Object.assign(document.createElement('b'), { textContent: 'Saved ✓', className: 'ok' }));
      const cur = sel.value; fillGroups(); sel.value = cur;
    };
    $('realAnalyze').onclick = () => analyzeReal(my);
  }

  let reviewEngine = null;
  async function analyzeReal(game0) {
    const btn = $('realAnalyze');
    if (btn) btn.disabled = true;
    const p = realParams();
    const c = new Chess();
    const fens = [c.fen()];
    const moves = game0.hist.map((san) => {
      const color = c.turn(), moveNo = +c.fen().split(' ')[5];
      const mv = c.move(san);
      fens.push(c.fen());
      return { san: mv.san, uci: mv.from + mv.to + (mv.promotion || ''), color, moveNo, clock: null };
    });
    const me = { name: settings.username || 'You', rating: +$('realRating').value || '' };
    const opp = { name: `Lichess ${p.label} players`, rating: p.label };
    const moveOf = (ply) => `move ${Math.ceil(ply / 2)}`;
    const notes = [];
    if (game0.youLeftAt != null) notes.push(`You left your ${game0.g.name} prep on ${moveOf(game0.youLeftAt)}.`);
    if (game0.outAt != null) notes.push(`Your opponent left your prep on ${moveOf(game0.outAt)}.`);
    if (!notes.length) notes.push('You stayed in your prep the whole way.');
    const game = {
      url: 'practice:' + game0.side + ':' + game0.hist.join(' '), practice: true, note: notes.join(' '),
      endTime: Date.now() / 1000, timeClass: 'practice vs ' + p.label, timeControl: '', base: null,
      userColor: game0.side, me, opp,
      white: game0.side === 'w' ? me : opp, black: game0.side === 'w' ? opp : me,
      result: 'draw', opening: game0.openingName || game0.g.name, family: game0.g.name, fens, moves,
    };
    const total = fens.length;
    let done = 0;
    status(`Analyzing with Stockfish… 0/${total}`);
    try {
      reviewEngine ??= new Engine({ multipv: 2 });
      await reviewEngine.ready;
      await analyzeGame(game, reviewEngine, settings.depth, (k) => { done += k; status(`Analyzing with Stockfish… ${done}/${total}`); }, () => false);
      classifyGame(game);
      status('Analysis ready.', 'ok');
      review.open(game);
      showTab('review');
      window.scrollTo(0, 0);
    } catch (e) {
      status('Analysis failed: ' + e.message, 'bad');
      if (btn) btn.disabled = false;
    }
  }

  $('realRating').value = settings.rating || 1200;
  $('realRating').onchange = () => { settings.rating = +$('realRating').value || 1200; settings.ratingByUser = true; saveSettings(); start(); };
  $('realSpeeds').onchange = () => start();
  $('realPick').onchange = () => renderRealBox();

  $('drillStart').onclick = () => start(st && !st.real && $('drillLine').value !== 'auto' ? st.li : undefined);
  $('drillNext').onclick = () => { $('drillLine').value = 'auto'; start(); };
  $('realFinish').onclick = () => {
    if (!st?.real || !st.hist.length) return;
    const my = st;
    if (!my.done) realComplete('Game ended.');
    analyzeReal(my);
  };
  $('drillHint').onclick = async () => {
    if (!st || st.done || !userTurn()) return;
    st.errors++;
    if (!st.real) return showArrow();
    const book = bookNext();
    if (book.length) { const m = new Chess(st.chess.fen()).move(book[0]); board.setArrows([{ from: m.from, to: m.to, color: 'blue' }]); return; }
    const b = await sharedEngine().evaluate(st.chess.fen(), { depth: 14 });
    if (b.best) board.setArrows([{ from: b.best.slice(0, 2), to: b.best.slice(2, 4), color: 'blue' }]);
  };
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
  return { selectGroup, enterReal: () => { $('drillMode').value = 'real'; start(); }, setRating: (r) => { if (!settings.ratingByUser && r) { $('realRating').value = r; settings.rating = r; saveSettings(); } } };
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
  $('boardTheme').value = settings.boardTheme || 'brown';
  $('boardTheme').onchange = () => { settings.boardTheme = $('boardTheme').value; saveSettings(); document.documentElement.dataset.board = settings.boardTheme; };
  $('soundOn').checked = soundSettings.on;
  $('soundOn').onchange = () => setSound($('soundOn').checked);
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

// coming back from the Lichess login page?
finishLichessLogin().then((justLoggedIn) => {
  if (justLoggedIn || sessionStorage.getItem('cc_after_login')) {
    sessionStorage.removeItem('cc_after_login');
    showTab('openings');
    drill.enterReal();
  }
}).catch((e) => {
  sessionStorage.removeItem('cc_after_login');
  showTab('openings');
  drill.enterReal();
  $('drillStatus').className = 'status bad';
  $('drillStatus').textContent = e.message;
});

// restore last session
if (games.length) {
  renderResults();
  const ai = load('cc_last_ai', null);
  if (ai) { $('aiOut').classList.remove('muted'); $('aiOut').innerHTML = md(ai); }
}

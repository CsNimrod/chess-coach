import { Chess, winPct, uciToObj, materialBalance, playLine } from './chessutil.js';
import { OPENINGS, parseMoves } from './openings.js';

const DRAWS = ['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient'];
export const TACTICAL = ['Missed tactic', 'Hung material', 'Missed mate', 'Allowed mate'];

// chess.com-style move classes, best first.
export const CLASSES = {
  brilliant: { label: 'Brilliant', icon: '!!', color: '#1baca6' },
  great: { label: 'Great', icon: '!', color: '#5c8bb0' },
  best: { label: 'Best', icon: '★', color: '#81b64c' },
  excellent: { label: 'Excellent', icon: '👍', color: '#96bc4b' },
  good: { label: 'Good', icon: '✓', color: '#97af8b' },
  book: { label: 'Book', icon: '📖', color: '#a88865' },
  forced: { label: 'Forced', icon: '→', color: '#97af8b' },
  inaccuracy: { label: 'Inaccuracy', icon: '?!', color: '#f7c045' },
  mistake: { label: 'Mistake', icon: '?', color: '#ffa459' },
  miss: { label: 'Miss', icon: '✕', color: '#ff7769' },
  blunder: { label: 'Blunder', icon: '??', color: '#fa412d' },
};
export const isError = (cls) => cls === 'mistake' || cls === 'blunder' || cls === 'miss';

// Known book move sequences, from the drill repertoire.
const BOOK = new Set();
for (const g of OPENINGS) for (const l of g.lines) {
  const arr = parseMoves(l.moves);
  for (let i = 1; i <= arr.length; i++) BOOK.add(arr.slice(0, i).join(' '));
}

function nonPawnMaterial(fen) {
  let s = 0;
  for (const ch of fen.split(' ')[0]) { const l = ch.toLowerCase(); if ('nbrq'.includes(l)) s += { n: 3, b: 3, r: 5, q: 9 }[l]; }
  return s; // 62 at the start
}
function openingFromUrl(eco) {
  if (!eco || !eco.includes('/openings/')) return 'Unknown opening';
  const name = decodeURIComponent(eco.split('/openings/')[1]).replace(/-\d+\..*$/, '').replace(/\.\.\..*$/, '');
  return name.replace(/-/g, ' ').trim() || 'Unknown opening';
}
function openingFamily(name) {
  const m = name.match(/^(.*?\b(Defense|Defence|Game|Opening|Gambit|Attack|System|Countergambit))\b/);
  return m ? m[1] : name.split(' ').slice(0, 2).join(' ');
}

// ---------- chess.com ----------
export async function fetchGames(username, { count, timeClass }, status) {
  const u = username.trim().toLowerCase();
  const r = await fetch(`https://api.chess.com/pub/player/${encodeURIComponent(u)}/games/archives`);
  if (r.status === 404) throw new Error(`No chess.com user called "${username}"`);
  if (!r.ok) throw new Error('chess.com API error ' + r.status);
  const { archives = [] } = await r.json();
  const raw = [];
  for (let i = archives.length - 1; i >= 0 && raw.length < count; i--) {
    status(`Downloading games from ${archives[i].split('/').slice(-2).join('-')}…`);
    const m = await (await fetch(archives[i])).json();
    const gs = (m.games || [])
      .filter((g) => g.rules === 'chess' && g.pgn && (timeClass === 'all' || g.time_class === timeClass))
      .sort((a, b) => b.end_time - a.end_time);
    for (const g of gs) { if (raw.length >= count) break; raw.push(g); }
  }
  return raw.map((g) => parseGame(g, u)).filter((g) => g && g.moves.length >= 4);
}

export function parseGame(g, u) {
  try {
    const userColor = g.white.username.toLowerCase() === u ? 'w' : 'b';
    const me = userColor === 'w' ? g.white : g.black;
    const opp = userColor === 'w' ? g.black : g.white;
    const fenHdr = g.pgn.match(/\[FEN "([^"]+)"\]/);
    const c = new Chess();
    c.loadPgn(g.pgn);
    const hist = c.history({ verbose: true });
    const r = fenHdr ? new Chess(fenHdr[1]) : new Chess();
    const clocks = [...g.pgn.matchAll(/\[%clk (\d+):(\d+):(\d+(?:\.\d+)?)\]/g)].map((m) => +m[1] * 3600 + +m[2] * 60 + +m[3]);
    const fens = [r.fen()];
    const moves = hist.map((h, i) => {
      const color = r.turn();
      const moveNo = +r.fen().split(' ')[5];
      const mv = r.move(h.san);
      fens.push(r.fen());
      return { san: mv.san, uci: mv.from + mv.to + (mv.promotion || ''), color, moveNo, clock: clocks[i] ?? null };
    });
    const result = me.result === 'win' ? 'win' : DRAWS.includes(me.result) ? 'draw' : 'loss';
    const tc = String(g.time_control || '');
    const opening = openingFromUrl(g.eco);
    return {
      url: g.url, endTime: g.end_time, timeClass: g.time_class, timeControl: tc,
      base: tc.includes('/') ? null : +tc.split('+')[0] || null,
      userColor, me: { name: me.username, rating: me.rating }, opp: { name: opp.username, rating: opp.rating },
      white: { name: g.white.username, rating: g.white.rating }, black: { name: g.black.username, rating: g.black.rating },
      result, howEnded: result === 'win' ? opp.result : me.result,
      opening, family: openingFamily(opening), fens, moves,
    };
  } catch (e) {
    console.warn('Could not parse game', g.url, e);
    return null;
  }
}

// ---------- engine pass ----------
const toCp = (cp, mate) => (mate != null ? (mate > 0 ? 10000 - mate * 10 : -10000 - mate * 10) : cp);

async function evalFen(engine, fen, depth) {
  const c = new Chess(fen);
  const s = c.turn() === 'w' ? 1 : -1;
  if (c.isCheckmate()) return { cp: -10000 * s, mate: 0, best: null, pv: [] };
  if (c.isStalemate() || c.isInsufficientMaterial()) return { cp: 0, mate: null, best: null, pv: [] };
  const r = await engine.evaluate(fen, { depth });
  const out = { cp: toCp(r.cp, r.mate) * s, mate: r.mate != null ? r.mate * s : null, best: r.best, pv: r.pv.slice(0, 10) };
  if (r.second) out.cp2 = toCp(r.second.cp, r.second.mate) * s;
  return out; // everything from White's point of view
}

export class Cancelled extends Error {}

export async function analyzeGame(game, engine, depth, onPos, isCancelled) {
  const key = `cc_ev3_${engine.name || 'sf'}_${depth}_${game.url}`;
  const cached = localStorage.getItem(key);
  if (cached) {
    try { const ev = JSON.parse(cached); if (ev.length === game.fens.length) { game.evals = ev; onPos(ev.length); return game; } } catch {}
  }
  const evals = [];
  for (const fen of game.fens) {
    if (isCancelled()) throw new Cancelled();
    evals.push(await evalFen(engine, fen, depth));
    onPos(1);
  }
  game.evals = evals;
  try { localStorage.setItem(key, JSON.stringify(evals)); } catch { /* storage full: skip cache */ }
  return game;
}

// ---------- classification ----------
// Material change for the side that moves first, after playing `ucis` from fen.
// Measured after an even number of plies so the other side has had its reply.
function materialSwing(fen, ucis) {
  const sign = fen.split(' ')[1] === 'w' ? 1 : -1;
  const before = materialBalance(fen) * sign;
  const { fens } = playLine(fen, ucis, 6);
  if (!fens.length) return { at2: 0, at4: 0, plies: 0 };
  const at = (k) => materialBalance(fens[Math.min(k, fens.length) - 1]) * sign - before;
  // last even ply (up to 6) so the trade sequence is finished
  const evenEnd = fens.length >= 2 ? fens.length - (fens.length % 2) : fens.length;
  const evens = [];
  for (let k = 2; k <= evenEnd; k += 2) evens.push(at(k));
  return { at2: at(Math.min(2, fens.length)), at4: at(evenEnd), plies: evenEnd, worstEven: evens.length ? Math.max(...evens) : at(1) };
}
export { materialSwing };

export function classifyGame(game) {
  const out = [];
  const sanSoFar = [];
  game.moves.forEach((m, i) => {
    sanSoFar.push(m.san);
    const eb = game.evals[i], ea = game.evals[i + 1];
    if (!eb || !ea) { out.push(null); return; }
    const sign = m.color === 'w' ? 1 : -1;
    const fen = game.fens[i];
    const wB = winPct(eb.cp * sign), wA = winPct(ea.cp * sign);
    const isBest = eb.best === m.uci;
    let drop = isBest ? 0 : Math.max(0, wB - wA);
    const acc = Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * drop) - 3.1669));
    const np = nonPawnMaterial(fen);
    const phase = np <= 26 ? 'endgame' : m.moveNo <= 12 ? 'opening' : 'middlegame';
    const legal = new Chess(fen).moves().length;
    const prev = out[i - 1];

    let cls;
    if (legal === 1) cls = 'forced';
    else if (drop >= 15) cls = 'blunder';
    else if (drop >= 10) cls = 'mistake';
    else if (drop >= 5) cls = 'inaccuracy';
    else if ((BOOK.has(sanSoFar.join(' ')) || m.moveNo <= 4) && drop < 3 && phase === 'opening') cls = 'book';
    else if (isBest) cls = 'best';
    else if (drop < 2) cls = 'excellent';
    else cls = 'good';

    // Miss: the opponent just erred and you didn't punish it.
    if ((cls === 'mistake' || cls === 'inaccuracy') && prev && isError(prev.cls) && wB >= 60) cls = 'miss';

    // Was the opponent's last move a capture? (then we're mid-trade, not sacrificing)
    const prevMove = game.moves[i - 1];
    let prevWasCapture = false;
    if (prevMove) try { prevWasCapture = !!new Chess(game.fens[i - 1]).move(uciToObj(prevMove.uci)).captured; } catch {}
    const prevErr = prev && isError(prev.cls);

    // Brilliant: a real sacrifice (a piece or more) on the best line, and you stay fine.
    let sac = null;
    const isCapture = /x/.test(m.san);
    if (cls === 'best' && !prevWasCapture && wB < 97 && wA >= 50) {
      const sw = materialSwing(fen, [m.uci, ...(ea.pv || [])]);
      // still down material after every reply in the line (not just a trade in progress)
      if (sw.plies >= 2 && sw.at2 <= -3 && sw.worstEven <= -2) { cls = 'brilliant'; sac = -sw.at4; }
    }
    // Great: a quiet move or check that is the only good option (second-best is much worse).
    // Plain captures, recaptures and punishing a blunder are just "Best".
    if (cls === 'best' && eb.cp2 != null && !prevErr && !isCapture) {
      const w2 = winPct(eb.cp2 * sign);
      if (wB - w2 >= 12 && wB < 95) cls = 'great';
    }

    const tags = [];
    if (isError(cls)) {
      let bestMove = null;
      if (eb.best) try { bestMove = new Chess(fen).move(uciToObj(eb.best)); } catch {}
      const bestSw = eb.best ? materialSwing(fen, [eb.best, ...(eb.pv || []).slice(1)]) : { at4: 0 };
      const playSw = materialSwing(fen, [m.uci, ...(ea.pv || [])]);
      if (playSw.at4 <= -2) tags.push('Hung material');
      if ((bestMove && (bestMove.captured || /[+#]/.test(bestMove.san)) && bestSw.at4 - playSw.at4 >= 2) || cls === 'miss') tags.push('Missed tactic');
      if (eb.mate != null && eb.mate * sign > 0 && !(ea.mate != null && ea.mate * sign > 0)) tags.push('Missed mate');
      if (ea.mate != null && ea.mate * sign < 0 && !(eb.mate != null && eb.mate * sign < 0)) tags.push('Allowed mate');
      if (wB >= 75 && wA <= 55) tags.push('Threw away a winning position');
      if (m.clock != null && game.base && m.clock <= Math.max(10, game.base * 0.1)) tags.push('Time trouble');
      if (phase === 'opening') tags.push('Opening error');
      if (phase === 'endgame') tags.push('Endgame technique');
      if (!tags.some((t) => TACTICAL.includes(t))) tags.push('Positional / quiet-move error');
    }
    let bestSan = null;
    if (eb.best) try { bestSan = new Chess(fen).move(uciToObj(eb.best)).san; } catch {}
    out.push({ i, color: m.color, moveNo: m.moveNo, san: m.san, uci: m.uci, best: eb.best, bestSan, fen, wB, wA, drop, acc, cls, phase, tags, clock: m.clock, sac });
  });
  game.analysis = out;
  const side = (c) => out.filter((x) => x && x.color === c && x.cls !== 'forced' && x.cls !== 'book');
  const accOf = (arr) => (arr.length ? arr.reduce((s, x) => s + x.acc, 0) / arr.length : 100);
  game.accuracyW = accOf(side('w'));
  game.accuracyB = accOf(side('b'));
  game.userMoves = out.filter((x) => x && x.color === game.userColor);
  game.accuracy = game.userColor === 'w' ? game.accuracyW : game.accuracyB;
  game.counts = { blunder: 0, mistake: 0, miss: 0, inaccuracy: 0 };
  game.userMoves.forEach((x) => { if (game.counts[x.cls] != null) game.counts[x.cls]++; });
  game.hadWinning = game.userMoves.some((x) => x.wB >= 85);
  return game;
}

// ---------- aggregation ----------
export function aggregate(games) {
  const s = {
    games: games.length, wins: 0, draws: 0, losses: 0, avgAccuracy: 0,
    blunders: 0, mistakes: 0, misses: 0, inaccuracies: 0, tags: {}, classes: {},
    phase: { opening: { moves: 0, acc: 0, errors: 0 }, middlegame: { moves: 0, acc: 0, errors: 0 }, endgame: { moves: 0, acc: 0, errors: 0 } },
    color: { w: { games: 0, score: 0, acc: 0 }, b: { games: 0, score: 0, acc: 0 } },
    timeTroubleErrors: 0, totalErrors: 0, winningGames: 0, converted: 0,
    firstErrorMoves: [], openings: {}, timeClasses: {}, avgRating: 0,
  };
  for (const g of games) {
    const score = g.result === 'win' ? 1 : g.result === 'draw' ? 0.5 : 0;
    s[g.result === 'win' ? 'wins' : g.result === 'draw' ? 'draws' : 'losses']++;
    s.avgAccuracy += g.accuracy;
    s.avgRating += g.me.rating || 0;
    s.blunders += g.counts.blunder; s.mistakes += g.counts.mistake; s.misses += g.counts.miss; s.inaccuracies += g.counts.inaccuracy;
    const c = s.color[g.userColor]; c.games++; c.score += score; c.acc += g.accuracy;
    s.timeClasses[g.timeClass] = (s.timeClasses[g.timeClass] || 0) + 1;
    if (g.hadWinning) { s.winningGames++; if (g.result === 'win') s.converted++; }
    const o = (s.openings[g.family] ||= { name: g.family, games: 0, score: 0, acc: 0, openingErrors: 0, asWhite: 0 });
    o.games++; o.score += score; o.acc += g.accuracy; if (g.userColor === 'w') o.asWhite++;
    let first = null;
    for (const m of g.userMoves) {
      s.classes[m.cls] = (s.classes[m.cls] || 0) + 1;
      const p = s.phase[m.phase]; p.moves++; p.acc += m.acc;
      if (isError(m.cls)) {
        p.errors++; s.totalErrors++;
        if (first == null) first = m.moveNo;
        if (m.phase === 'opening') o.openingErrors++;
        if (m.tags.includes('Time trouble')) s.timeTroubleErrors++;
        for (const t of m.tags) s.tags[t] = (s.tags[t] || 0) + 1;
      }
    }
    if (first != null) s.firstErrorMoves.push(first);
  }
  const n = games.length || 1;
  s.avgAccuracy /= n; s.avgRating = Math.round(s.avgRating / n);
  for (const p of Object.values(s.phase)) p.acc = p.moves ? p.acc / p.moves : null;
  for (const c of Object.values(s.color)) c.acc = c.games ? c.acc / c.games : null;
  s.openings = Object.values(s.openings).map((o) => ({ ...o, acc: o.acc / o.games, scorePct: (100 * o.score) / o.games })).sort((a, b) => b.games - a.games);
  s.avgFirstError = s.firstErrorMoves.length ? s.firstErrorMoves.reduce((a, b) => a + b, 0) / s.firstErrorMoves.length : null;
  return s;
}

export function worstMistakes(games, limit = 15) {
  const all = [];
  for (const g of games) for (const m of g.userMoves) if (isError(m.cls)) all.push({ ...m, game: g });
  return all.sort((a, b) => b.drop - a.drop).slice(0, limit);
}

// Rule-based findings (works with no AI at all)
export function quickFindings(s) {
  const out = [];
  const per = (x) => (x / Math.max(1, s.games)).toFixed(1);
  const tags = Object.entries(s.tags).filter(([t]) => !['Opening error', 'Endgame technique'].includes(t)).sort((a, b) => b[1] - a[1]);
  if (tags[0]) out.push(`Your most common error type is **${tags[0][0]}** (${tags[0][1]} times, ${per(tags[0][1])} per game).`);
  if (tags[1]) out.push(`Second most common: **${tags[1][0]}** (${tags[1][1]} times).`);
  const ph = Object.entries(s.phase).filter(([, p]) => p.moves > 10).sort((a, b) => a[1].acc - b[1].acc);
  if (ph.length > 1) out.push(`Your weakest phase is the **${ph[0][0]}** (${ph[0][1].acc.toFixed(0)}% accuracy vs ${ph[ph.length - 1][1].acc.toFixed(0)}% in the ${ph[ph.length - 1][0]}).`);
  if (s.misses >= 2) out.push(`You **missed ${s.misses} chances to punish your opponent's mistakes**. When they blunder, slow down and look for captures and checks.`);
  if (s.totalErrors && s.timeTroubleErrors / s.totalErrors >= 0.2) out.push(`**${Math.round((100 * s.timeTroubleErrors) / s.totalErrors)}% of your mistakes happen in time trouble.** Spend less time early, or play a slower time control.`);
  if (s.winningGames >= 3) {
    const rate = (100 * s.converted) / s.winningGames;
    if (rate < 75) out.push(`You reached a clearly winning position in ${s.winningGames} games but only won ${s.converted} (${rate.toFixed(0)}%). **Converting won positions** is a big source of lost points.`);
  }
  const { w, b } = s.color;
  if (w.games >= 3 && b.games >= 3) {
    const ws = (100 * w.score) / w.games, bs = (100 * b.score) / b.games;
    if (Math.abs(ws - bs) >= 15) out.push(`You score ${ws.toFixed(0)}% as White and ${bs.toFixed(0)}% as Black. Your **${ws < bs ? 'White' : 'Black'} repertoire** needs work.`);
  }
  const badOpening = s.openings.filter((o) => o.games >= 2).sort((a, b) => a.scorePct - b.scorePct)[0];
  if (badOpening && badOpening.scorePct < 40) out.push(`Worst opening: **${badOpening.name}**: ${badOpening.scorePct.toFixed(0)}% score over ${badOpening.games} games.`);
  if (s.avgFirstError) out.push(`On average your first real mistake comes on move **${s.avgFirstError.toFixed(0)}**.`);
  return out;
}

export function buildPrompt(s, worst) {
  const data = {
    games: s.games, avgRating: s.avgRating, record: `${s.wins}W ${s.draws}D ${s.losses}L`,
    avgAccuracyPct: +s.avgAccuracy.toFixed(1),
    perGame: { blunders: +(s.blunders / s.games).toFixed(2), mistakes: +(s.mistakes / s.games).toFixed(2), missedPunishments: +(s.misses / s.games).toFixed(2), inaccuracies: +(s.inaccuracies / s.games).toFixed(2) },
    errorTagCounts: s.tags,
    accuracyByPhase: Object.fromEntries(Object.entries(s.phase).map(([k, v]) => [k, { accuracy: v.acc && +v.acc.toFixed(1), mistakesAndBlunders: v.errors, moves: v.moves }])),
    byColor: Object.fromEntries(Object.entries(s.color).map(([k, v]) => [k === 'w' ? 'white' : 'black', { games: v.games, scorePct: v.games ? +((100 * v.score) / v.games).toFixed(0) : null }])),
    errorsInTimeTrouble: s.timeTroubleErrors, totalMistakesAndBlunders: s.totalErrors,
    winningPositionsReached: s.winningGames, winningPositionsConverted: s.converted,
    avgMoveOfFirstMistake: s.avgFirstError && +s.avgFirstError.toFixed(1),
    openings: s.openings.slice(0, 10).map((o) => ({ name: o.name, games: o.games, scorePct: +o.scorePct.toFixed(0), openingPhaseErrors: o.openingErrors, timesAsWhite: o.asWhite })),
    timeControls: s.timeClasses,
  };
  const ex = worst.map((m) =>
    `- Move ${m.moveNo} as ${m.game.userColor === 'w' ? 'White' : 'Black'} (${m.cls}, ${m.phase}, ${m.game.family}, ${m.game.timeClass}${m.clock != null ? `, ${Math.round(m.clock)}s left` : ''}): played ${m.san}, engine best ${m.bestSan || '?'}; win chance ${m.wB.toFixed(0)}% -> ${m.wA.toFixed(0)}%. Tags: ${m.tags.join(', ') || 'none'}. FEN: ${m.fen}`).join('\n');
  return `You are an experienced, direct chess coach. Below is Stockfish-based data from one player's recent online games, plus their worst individual mistakes. Find the weaknesses that are CONSISTENT and recurring, not one-off accidents. Back every claim with numbers or move examples from the data. Avoid generic advice like "calculate more" unless you make it concrete (e.g. a specific checklist).

Respond in markdown with exactly these sections:
## Your 3 biggest recurring problems
For each: a bold one-line name, the evidence, the likely root cause, and one concrete habit or exercise to fix it.
## Openings
Which openings are costing points and what to do (drill, switch, or study a specific idea).
## What you already do well
1-2 bullets.
## 2-week training plan
Short daily plan, max 7 bullets.

AGGREGATE DATA (JSON):
${JSON.stringify(data, null, 1)}

WORST MISTAKES:
${ex}`;
}

import { Chess, winPct, uciToObj } from './chessutil.js';

const VAL = { n: 3, b: 3, r: 5, q: 9 };
const DRAWS = ['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient'];
export const TACTICAL = ['Missed tactic', 'Hung piece / allowed tactic', 'Missed mate', 'Allowed mate'];

function nonPawnMaterial(fen) {
  let s = 0;
  for (const ch of fen.split(' ')[0]) s += VAL[ch.toLowerCase()] || 0;
  return s; // 62 at the start
}

function openingFromUrl(eco) {
  if (!eco || !eco.includes('/openings/')) return 'Unknown opening';
  let name = decodeURIComponent(eco.split('/openings/')[1]).replace(/-\d+\..*$/, '').replace(/\.\.\..*$/, '');
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
      result, howEnded: result === 'win' ? opp.result : me.result,
      opening, family: openingFamily(opening), fens, moves,
    };
  } catch (e) {
    console.warn('Could not parse game', g.url, e);
    return null;
  }
}

// ---------- engine pass ----------
async function evalFen(engine, fen, depth) {
  const c = new Chess(fen);
  const s = c.turn() === 'w' ? 1 : -1;
  if (c.isCheckmate()) return { cp: -10000 * s, mate: 0, best: null };
  if (c.isStalemate() || c.isInsufficientMaterial()) return { cp: 0, mate: null, best: null };
  const r = await engine.evaluate(fen, { depth });
  let cp = r.cp;
  if (r.mate != null) cp = r.mate > 0 ? 10000 - r.mate * 10 : -10000 - r.mate * 10;
  return { cp: cp * s, mate: r.mate != null ? r.mate * s : null, best: r.best }; // white POV
}

export class Cancelled extends Error {}

export async function analyzeGame(game, engine, depth, onPos, isCancelled) {
  const key = `cc_ev_${engine.name || 'sf'}_${depth}_${game.url}`;
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
  try { localStorage.setItem(key, JSON.stringify(evals)); } catch { /* storage full: just skip cache */ }
  return game;
}

// ---------- classification ----------
export function classifyGame(game) {
  const sign = game.userColor === 'w' ? 1 : -1;
  const um = [];
  game.moves.forEach((m, i) => {
    if (m.color !== game.userColor) return;
    const eb = game.evals[i], ea = game.evals[i + 1];
    if (!eb || !ea) return;
    const wB = winPct(eb.cp * sign), wA = winPct(ea.cp * sign);
    let drop = Math.max(0, wB - wA);
    if (eb.best === m.uci) drop = 0;
    const acc = Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * drop) - 3.1669));
    const cls = drop >= 15 ? 'blunder' : drop >= 10 ? 'mistake' : drop >= 5 ? 'inaccuracy' : 'good';
    const fen = game.fens[i];
    const np = nonPawnMaterial(fen);
    const phase = np <= 26 ? 'endgame' : m.moveNo <= 12 ? 'opening' : 'middlegame';
    const tags = [];
    let bestSan = null;
    if (eb.best) {
      try {
        const bm = new Chess(fen).move(uciToObj(eb.best));
        bestSan = bm.san;
        if ((cls === 'blunder' || cls === 'mistake') && (bm.captured || /[+#]/.test(bm.san))) tags.push('Missed tactic');
      } catch {}
    }
    if (cls === 'blunder' || cls === 'mistake') {
      if (ea.best) {
        try { if (new Chess(game.fens[i + 1]).move(uciToObj(ea.best)).captured) tags.push('Hung piece / allowed tactic'); } catch {}
      }
      if (eb.mate != null && eb.mate * sign > 0 && !(ea.mate != null && ea.mate * sign > 0)) tags.push('Missed mate');
      if (ea.mate != null && ea.mate * sign < 0 && !(eb.mate != null && eb.mate * sign < 0)) tags.push('Allowed mate');
      if (wB >= 75 && wA <= 55) tags.push('Threw away a winning position');
      if (m.clock != null && game.base && m.clock <= Math.max(10, game.base * 0.1)) tags.push('Time trouble');
      if (phase === 'opening') tags.push('Opening error');
      if (phase === 'endgame') tags.push('Endgame technique');
      if (!tags.some((t) => TACTICAL.includes(t))) tags.push('Positional / quiet-move error');
    }
    um.push({ i, moveNo: m.moveNo, san: m.san, uci: m.uci, best: eb.best, bestSan, fen, wB, wA, drop, acc, cls, phase, tags, clock: m.clock });
  });
  game.userMoves = um;
  game.accuracy = um.length ? um.reduce((s, x) => s + x.acc, 0) / um.length : 0;
  game.counts = { blunder: 0, mistake: 0, inaccuracy: 0 };
  um.forEach((x) => { if (game.counts[x.cls] != null) game.counts[x.cls]++; });
  game.hadWinning = um.some((x) => x.wB >= 85);
  return game;
}

// ---------- aggregation ----------
export function aggregate(games) {
  const s = {
    games: games.length, wins: 0, draws: 0, losses: 0, avgAccuracy: 0,
    blunders: 0, mistakes: 0, inaccuracies: 0, tags: {},
    phase: { opening: { moves: 0, acc: 0, errors: 0 }, middlegame: { moves: 0, acc: 0, errors: 0 }, endgame: { moves: 0, acc: 0, errors: 0 } },
    color: { w: { games: 0, score: 0, acc: 0 }, b: { games: 0, score: 0, acc: 0 } },
    timeTroubleErrors: 0, totalErrors: 0, winningGames: 0, converted: 0,
    firstErrorMoves: [], openings: {}, timeClasses: {},
    avgRating: 0,
  };
  for (const g of games) {
    const score = g.result === 'win' ? 1 : g.result === 'draw' ? 0.5 : 0;
    s[g.result === 'win' ? 'wins' : g.result === 'draw' ? 'draws' : 'losses']++;
    s.avgAccuracy += g.accuracy;
    s.avgRating += g.me.rating || 0;
    s.blunders += g.counts.blunder; s.mistakes += g.counts.mistake; s.inaccuracies += g.counts.inaccuracy;
    const c = s.color[g.userColor]; c.games++; c.score += score; c.acc += g.accuracy;
    s.timeClasses[g.timeClass] = (s.timeClasses[g.timeClass] || 0) + 1;
    if (g.hadWinning) { s.winningGames++; if (g.result === 'win') s.converted++; }
    const o = (s.openings[g.family] ||= { name: g.family, games: 0, score: 0, acc: 0, openingErrors: 0, asWhite: 0 });
    o.games++; o.score += score; o.acc += g.accuracy; if (g.userColor === 'w') o.asWhite++;
    let first = null;
    for (const m of g.userMoves) {
      const p = s.phase[m.phase]; p.moves++; p.acc += m.acc;
      if (m.cls === 'blunder' || m.cls === 'mistake') {
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
  for (const c of Object.values(s.color)) { c.acc = c.games ? c.acc / c.games : null; }
  s.openings = Object.values(s.openings).map((o) => ({ ...o, acc: o.acc / o.games, scorePct: (100 * o.score) / o.games })).sort((a, b) => b.games - a.games);
  s.avgFirstError = s.firstErrorMoves.length ? s.firstErrorMoves.reduce((a, b) => a + b, 0) / s.firstErrorMoves.length : null;
  return s;
}

export function worstMistakes(games, limit = 15) {
  const all = [];
  for (const g of games) for (const m of g.userMoves) if (m.cls === 'blunder' || m.cls === 'mistake') all.push({ ...m, game: g });
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
    perGame: { blunders: +(s.blunders / s.games).toFixed(2), mistakes: +(s.mistakes / s.games).toFixed(2), inaccuracies: +(s.inaccuracies / s.games).toFixed(2) },
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
    `- Move ${m.moveNo} as ${m.game.userColor === 'w' ? 'White' : 'Black'} (${m.phase}, ${m.game.family}, ${m.game.timeClass}${m.clock != null ? `, ${Math.round(m.clock)}s left` : ''}): played ${m.san}, engine best ${m.bestSan || '?'}; win chance ${m.wB.toFixed(0)}% -> ${m.wA.toFixed(0)}%. Tags: ${m.tags.join(', ') || 'none'}. FEN: ${m.fen}`).join('\n');
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

// Play full games against Stockfish bots that stick to a chosen opening.
import { Chess, esc } from './chessutil.js';
import { Board } from './board.js';
import { Engine } from './engine.js';
import { OPENINGS, parseMoves } from './openings.js';
import { lichessToken, explore, pickMove, bandsFor } from './explorer.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

// Ready-made opponents. `opening` is an OPENINGS id, or 'any' (plays like real players / engine).
export const BOTS = [
  { id: 'pip', name: 'Pip', elo: 500, emoji: '🐣', opening: 'any', bio: 'Just learned how the pieces move. Leaves things hanging.' },
  { id: 'rosa', name: 'Rosa', elo: 900, emoji: '🌹', opening: 'italian', bio: 'Loves the Italian Game and early attacks on f7.' },
  { id: 'leo', name: 'Leo', elo: 1200, emoji: '🦁', opening: 'london', bio: 'Plays the London System. Every. Single. Game.' },
  { id: 'mira', name: 'Mira', elo: 1500, emoji: '🌙', opening: 'caro', bio: 'Solid Caro-Kann player who grinds out endgames.' },
  { id: 'viktor', name: 'Viktor', elo: 1800, emoji: '⚔️', opening: 'sicilian', bio: 'Sharp Sicilian Najdorf. Always plays for a win.' },
  { id: 'helga', name: 'Helga', elo: 2100, emoji: '🏰', opening: 'qg', bio: "Queen's Gambit and slow positional squeezes." },
  { id: 'atlas', name: 'Atlas', elo: 2500, emoji: '🗿', opening: 'ruy', bio: 'Ruy Lopez specialist. Very hard to beat.' },
  { id: 'fish', name: 'Stockfish', elo: 3000, emoji: '🐟', opening: 'any', bio: 'Close to full strength. Good luck.' },
];

const START_COUNT = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const PNAME = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };
const toCp = (l) => (l.mate != null ? (l.mate > 0 ? 10000 - l.mate * 10 : -10000 - l.mate * 10) : l.cp);
const fmtClock = (ms) => {
  ms = Math.max(0, ms);
  const s = Math.floor(ms / 1000);
  return s < 20 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.${Math.floor((ms % 1000) / 100)}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function createPlay({ analyzeMoves, toast, settings, saveSettings }) {
  let G = null;
  let engine = null;
  let openEngine = null;
  let cfg = Object.assign({ elo: 1200, opening: 'london', color: 'w', time: '600+0', takebacks: true, botId: 'leo' }, settings.play || {});
  const history = JSON.parse(localStorage.getItem('cc_bot_games') || '[]');

  const board = new Board($('playBoard'), {
    dests: (sq) => (G && !G.over && G.chess.turn() === G.userColor ? G.chess.moves({ square: sq, verbose: true }).map((m) => m.to) : []),
    onMove: userMove,
  });
  board.setPosition(new Chess().fen());

  // ---------- opening books ----------
  const customGroup = () => {
    const c = JSON.parse(localStorage.getItem('cc_custom_lines') || '[]');
    return c.length ? { id: 'custom', name: 'My own lines', lines: c.map((l) => ({ ...l, san: parseMoves(l.moves) })) } : null;
  };
  const groups = () => [...OPENINGS, ...(customGroup() ? [customGroup()] : [])];
  const lineSans = (g) => g.lines.map((l) => l.san || parseMoves(l.moves));
  const norm = (s) => s.replace(/[+#!?]/g, '');

  function bookMove() {
    if (G.opening === 'any') return null;
    const g = groups().find((x) => x.id === G.opening);
    if (!g) return null;
    const next = [];
    for (const s of lineSans(g)) {
      if (s.length > G.sans.length && G.sans.every((m, i) => norm(m) === norm(s[i]))) next.push(s[G.sans.length]);
    }
    return next.length ? next[Math.floor(Math.random() * next.length)] : null;
  }
  function openingName() {
    let best = null;
    for (const g of groups()) g.lines.forEach((l) => {
      const s = l.san || parseMoves(l.moves);
      let k = 0;
      while (k < s.length && k < G.sans.length && norm(s[k]) === norm(G.sans[k])) k++;
      if (k >= 2 && (!best || k > best.k)) best = { k, name: `${g.name}: ${l.name}` };
    });
    return best?.name || G.xOpening || '';
  }

  // ---------- setup screen ----------
  function renderSetup() {
    $('botGrid').innerHTML = BOTS.map((b) => {
      const g = OPENINGS.find((o) => o.id === b.opening);
      return `<button class="botcard ${cfg.botId === b.id ? 'on' : ''}" data-bot="${b.id}">
        <span class="bot-emoji">${b.emoji}</span>
        <span class="bot-name">${esc(b.name)} <span class="bot-elo">${b.elo}</span></span>
        <span class="bot-open">${g ? esc(g.name) : 'Any opening'}</span>
      </button>`;
    }).join('');
    $('botGrid').querySelectorAll('[data-bot]').forEach((el) => el.addEventListener('click', () => {
      const b = BOTS.find((x) => x.id === el.dataset.bot);
      Object.assign(cfg, { botId: b.id, elo: b.elo, opening: b.opening });
      syncCfg();
    }));
    $('botOpening').innerHTML = `<option value="any">Anything: plays like real players at its rating</option>` +
      groups().map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
    syncCfg();
    renderHistory();
  }
  function syncCfg() {
    $('botElo').value = cfg.elo;
    $('botEloVal').textContent = cfg.elo;
    $('botOpening').value = groups().some((g) => g.id === cfg.opening) ? cfg.opening : 'any';
    $('playColor').value = cfg.color;
    $('playTime').value = cfg.time;
    $('playTakebacks').checked = cfg.takebacks;
    const bot = BOTS.find((b) => b.id === cfg.botId);
    const custom = !bot || bot.elo !== cfg.elo || bot.opening !== cfg.opening;
    $('botGrid').querySelectorAll('[data-bot]').forEach((el) => el.classList.toggle('on', !custom && el.dataset.bot === cfg.botId));
    $('botBio').innerHTML = custom
      ? `<b>🤖 Custom bot</b> · ${cfg.elo} · ${cfg.opening === 'any' ? 'any opening' : esc(groups().find((g) => g.id === cfg.opening)?.name || '')}`
      : `<b>${bot.emoji} ${esc(bot.name)}</b> · ${bot.elo} · ${esc(bot.bio)}`;
    const anyNote = cfg.opening === 'any' && !lichessToken() && cfg.elo < 3000;
    $('botNote').hidden = !anyNote;
    settings.play = cfg; saveSettings();
    renderBars();
  }
  $('botElo').addEventListener('input', () => { cfg.elo = +$('botElo').value; syncCfg(); });
  $('botOpening').addEventListener('change', () => { cfg.opening = $('botOpening').value; syncCfg(); });
  $('playColor').addEventListener('change', () => { cfg.color = $('playColor').value; syncCfg(); });
  $('playTime').addEventListener('change', () => { cfg.time = $('playTime').value; syncCfg(); });
  $('playTakebacks').addEventListener('change', () => { cfg.takebacks = $('playTakebacks').checked; syncCfg(); });
  $('playStart').addEventListener('click', () => start());

  function botProfile() {
    const bot = BOTS.find((b) => b.id === cfg.botId);
    const custom = !bot || bot.elo !== cfg.elo || bot.opening !== cfg.opening;
    return custom ? { name: 'Custom bot', emoji: '🤖', elo: cfg.elo } : bot;
  }

  // ---------- game ----------
  async function start() {
    const userColor = cfg.color === 'r' ? (Math.random() < 0.5 ? 'w' : 'b') : cfg.color;
    const [base, inc] = cfg.time === '0' ? [0, 0] : cfg.time.split('+').map(Number);
    const bot = botProfile();
    G = {
      chess: new Chess(), userColor, botColor: userColor === 'w' ? 'b' : 'w', bot, elo: cfg.elo, opening: cfg.opening,
      tc: base ? { base: base * 1000, inc: inc * 1000 } : null, clock: { w: base * 1000, b: base * 1000 },
      turnStart: performance.now(), sans: [], over: false, botEval: 0, losingStreak: 0, xOpening: null, takebacks: cfg.takebacks,
    };
    $('playSetup').hidden = true;
    $('playGame').hidden = false;
    $('playOver').hidden = true;
    $('botInfo').innerHTML = `<span class="bot-emoji big">${bot.emoji}</span><div><b>${esc(bot.name)}</b> <span class="muted">(${bot.elo})</span><div class="muted small">${G.opening === 'any' ? 'Any opening' : 'Plays the ' + esc(groups().find((g) => g.id === G.opening)?.name || '')} · ${G.tc ? `${base / 60}+${inc}` : 'No clock'}</div></div>`;
    board.setOrientation(userColor);
    board.setPosition(G.chess.fen());
    renderAll();
    status(userColor === 'w' ? 'Your move. You have White.' : `${bot.name} has White.`);
    // configure the engine for this bot's strength
    engine ??= new Engine();
    const elo = G.elo;
    await engine.configure(elo >= 3000 ? { MultiPV: 1, UCI_LimitStrength: false }
      : elo >= 1350 ? { MultiPV: 1, UCI_LimitStrength: true, UCI_Elo: Math.min(3190, elo) }
      : { MultiPV: 6, UCI_LimitStrength: false });
    clearInterval(G.timer);
    G.timer = setInterval(tick, 100);
    if (G.chess.turn() === G.botColor) botMove();
    else board.movable = G.userColor, board.render();
  }

  function status(t, cls = '') { $('playStatus').className = 'status ' + cls; $('playStatus').textContent = t; }

  function tick() {
    if (!G || G.over || !G.tc) return;
    const turn = G.chess.turn();
    const left = G.clock[turn] - (performance.now() - G.turnStart);
    renderClocks(turn, left);
    if (left <= 0) {
      G.clock[turn] = 0;
      const winner = turn === 'w' ? 'b' : 'w';
      // timeout vs a lone king (or king + minor) is a draw
      const onlyMinor = !G.chess.board().flat().some((p) => p && p.color === winner && 'qrp'.includes(p.type)) &&
        G.chess.board().flat().filter((p) => p && p.color === winner && 'nb'.includes(p.type)).length <= 1;
      gameOver(onlyMinor ? null : winner, 'timeout');
    }
  }
  function spendClock(color) {
    if (!G.tc) return;
    const now = performance.now();
    G.clock[color] = Math.max(0, G.clock[color] - (now - G.turnStart)) + G.tc.inc;
    G.turnStart = now;
  }

  function applyMove(m) {
    const mover = G.chess.turn();
    spendClock(mover);
    const mv = G.chess.move(m);
    G.sans.push(mv.san);
    board.setPosition(G.chess.fen(), { lastMove: mv });
    renderAll();
    return checkEnd(mv);
  }

  function checkEnd() {
    const c = G.chess;
    if (c.isCheckmate()) return gameOver(c.turn() === 'w' ? 'b' : 'w', 'checkmate'), true;
    if (c.isStalemate()) return gameOver(null, 'stalemate'), true;
    if (c.isInsufficientMaterial()) return gameOver(null, 'insufficient material'), true;
    if (c.isThreefoldRepetition()) return gameOver(null, 'repetition'), true;
    if (c.isDraw()) return gameOver(null, '50-move rule'), true;
    return false;
  }

  async function userMove(from, to) {
    if (!G || G.over || G.chess.turn() !== G.userColor) return false;
    const legal = G.chess.moves({ square: from, verbose: true }).filter((m) => m.to === to);
    if (!legal.length) return false;
    let promotion;
    if (legal.some((m) => m.promotion)) {
      promotion = await board.askPromotion(to, G.userColor);
      if (!promotion) { board.render(); return false; }
    }
    board.movable = null;
    if (applyMove({ from, to, promotion })) return true;
    botMove();
    return true;
  }

  async function engineMove(fen, thinkMs) {
    const elo = G.elo;
    if (elo >= 1350) {
      const r = await engine.evaluate(fen, { depth: null, movetime: Math.max(150, Math.min(thinkMs, 2500)) });
      G.botEval = toCp(r);
      return r.best;
    }
    // Weak bots: look at the top 6 moves at low depth and sometimes pick a worse one (or blunder).
    const depth = elo < 600 ? 2 : elo < 900 ? 4 : elo < 1100 ? 6 : 8;
    const r = await engine.evaluate(fen, { depth, movetime: 1500 });
    const lines = (r.lines || []).filter((l) => l.pv?.length);
    G.botEval = lines.length ? toCp(lines[0]) : 0;
    const blunder = elo < 600 ? 0.14 : elo < 900 ? 0.08 : elo < 1100 ? 0.045 : 0.025;
    if (Math.random() < blunder) {
      const ms = new Chess(fen).moves({ verbose: true });
      const m = ms[Math.floor(Math.random() * ms.length)];
      return m.from + m.to + (m.promotion || '');
    }
    if (!lines.length) return r.best;
    const temp = elo < 600 ? 260 : elo < 900 ? 160 : elo < 1100 ? 90 : 55;
    const top = toCp(lines[0]);
    // never throw away a forced mate for itself if it has one in 1
    if (lines[0].mate === 1) return lines[0].pv[0];
    const w = lines.map((l) => Math.exp((Math.max(-2000, toCp(l)) - top) / temp));
    let x = Math.random() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < lines.length; i++) { x -= w[i]; if (x <= 0) return lines[i].pv[0]; }
    return lines[0].pv[0];
  }

  async function botMove() {
    const my = G;
    if (!my || my.over) return;
    status(`${my.bot.name} is thinking…`);
    renderClocks(my.chess.turn());
    const t0 = performance.now();
    const fen = my.chess.fen();
    // how long a human-ish bot "thinks"
    let think;
    if (my.tc) {
      const left = my.clock[my.botColor];
      think = Math.min(left / 35 + my.tc.inc * 0.7, left / 8) * rand(0.55, 1.35);
      if (my.sans.length < 10) think *= 0.5;
      think = Math.max(250, Math.min(think, 6000));
    } else think = rand(500, 1500);

    let move = null;
    const book = bookMove();
    if (book) move = book;
    if (!move && my.elo < 3000 && lichessToken() && my.sans.length < 24) {
      try {
        const d = await explore(fen, { bands: bandsFor(my.elo).bands, speeds: 'blitz,rapid' });
        if (d.opening?.name) my.xOpening = d.opening.name;
        if (d.total >= 30) move = pickMove(d, 'weighted')?.san || null;
      } catch { /* fall back to the engine */ }
    }
    if (G !== my || my.over) return;
    // Out of book early on: play principled opening moves (random among the near-best ones),
    // because Stockfish's strength limit makes odd choices in the opening.
    if (!move && my.sans.length < 16 && my.elo >= 1350) {
      openEngine ??= new Engine({ multipv: 3 });
      const r = await openEngine.evaluate(fen, { depth: 12, movetime: 700 });
      const top = r.lines?.length ? toCp(r.lines[0]) : 0;
      const ok = (r.lines || []).filter((l) => l.pv?.length && toCp(l) >= top - (my.elo >= 2200 ? 15 : 35));
      if (ok.length) { move = ok[Math.floor(Math.random() * ok.length)].pv[0]; my.botEval = top; }
    }
    if (G !== my || my.over) return;
    if (!move) move = await engineMove(fen, think * 0.8);
    if (G !== my || my.over) return;
    const spent = performance.now() - t0;
    if (spent < think) await sleep(think - spent);
    if (G !== my || my.over) return;

    // resign when hopelessly lost for a while (not the weakest bots: they play on)
    if (my.elo >= 800 && my.botEval <= -900) my.losingStreak++; else my.losingStreak = 0;
    if (my.losingStreak >= 3 && my.sans.length > 20) return gameOver(my.userColor, 'resignation');

    const m = typeof move === 'string' && /^[a-h][1-8][a-h][1-8]/.test(move)
      ? { from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] || undefined } : move;
    let ended;
    try { ended = applyMove(m); } catch { ended = applyMove(new Chess(fen).moves()[0]); }
    if (ended) return;
    board.movable = my.userColor;
    board.render();
    status(my.chess.inCheck() ? 'Check! Your move.' : 'Your move.');
  }

  function gameOver(winner, reason) {
    if (G.over) return;
    G.over = true;
    clearInterval(G.timer);
    board.movable = null;
    board.render();
    const you = winner === G.userColor, draw = winner === null;
    const result = draw ? 'draw' : you ? 'win' : 'loss';
    G.result = result; G.reason = reason;
    const title = draw ? '½–½ Draw' : you ? '🎉 You won!' : `${G.bot.emoji} ${G.bot.name} won`;
    const how = { checkmate: 'by checkmate', resignation: 'by resignation', timeout: 'on time', stalemate: 'by stalemate', repetition: 'by repetition', 'insufficient material': 'by insufficient material', '50-move rule': 'by the 50-move rule', agreement: 'by agreement' }[reason] || reason;
    status(`${draw ? 'Draw' : you ? 'You won' : 'You lost'} ${how}.`, you ? 'ok' : draw ? '' : 'bad');
    $('playOver').hidden = false;
    $('playOver').innerHTML = `<div class="go-title ${result}">${title}</div><div class="muted">${how} · ${Math.ceil(G.sans.length / 2)} moves</div>
      <div class="row center"><button id="goReview" class="primary">📊 Game Review</button><button id="goRematch">↻ Rematch</button><button id="goNew">New opponent</button></div>`;
    $('goReview').onclick = () => reviewGame(G);
    $('goRematch').onclick = () => start();
    $('goNew').onclick = () => backToSetup();
    toast(title);
    if (G.sans.length >= 2) {
      history.unshift({ id: Date.now(), date: Date.now(), bot: { name: G.bot.name, emoji: G.bot.emoji, elo: G.elo }, userColor: G.userColor, sans: G.sans.slice(), result, reason, opening: openingName(), tc: cfg.time });
      history.length = Math.min(history.length, 50);
      localStorage.setItem('cc_bot_games', JSON.stringify(history));
    }
  }

  function reviewGame(g) {
    const me = { name: settings.username || 'You', rating: '' };
    const bot = { name: `${g.bot.emoji} ${g.bot.name}`, rating: g.bot.elo ?? g.elo };
    analyzeMoves({
      sans: g.sans, userColor: g.userColor,
      white: g.userColor === 'w' ? me : bot, black: g.userColor === 'w' ? bot : me,
      opening: (g === G ? openingName() : g.opening) || 'Bot game',
      family: 'Bot game', timeClass: `vs ${g.bot.name} (${g.bot.elo ?? g.elo})`,
      note: `${g.result === 'win' ? 'You won' : g.result === 'loss' ? 'You lost' : 'Draw'} ${g.reason ? 'by ' + g.reason : ''} against ${g.bot.name}.`,
      key: 'bot:' + (g.id || Date.now()) + ':' + g.sans.join(' '),
      onStatus: (t) => toast(t, 1200),
    });
  }

  function backToSetup() {
    if (G && !G.over) return;
    $('playGame').hidden = true;
    $('playSetup').hidden = false;
    renderSetup();
  }

  // ---------- controls ----------
  $('pResign').onclick = () => { if (G && !G.over && confirm('Resign this game?')) gameOver(G.botColor, 'resignation'); };
  $('pDraw').onclick = () => {
    if (!G || G.over) return;
    if (G.sans.length < 20) return toast(`${G.bot.name}: "Too early for a draw. Let's play!"`);
    const e = G.botEval;
    if (e <= 40) { toast(`${G.bot.name} accepts the draw.`); gameOver(null, 'agreement'); }
    else toast(`${G.bot.name} declines. It thinks it's better.`);
  };
  $('pTakeback').onclick = () => {
    if (!G || G.over) return;
    if (!G.takebacks) return toast('Takebacks are off for this game.');
    if (G.chess.turn() !== G.userColor) return toast('Wait for the bot to move.');
    const n = G.sans.length >= 2 ? 2 : 0;
    if (!n || (G.userColor === 'b' && G.sans.length < 3)) return toast('Nothing to take back yet.');
    for (let i = 0; i < n; i++) { G.chess.undo(); G.sans.pop(); }
    const h = G.chess.history({ verbose: true }).pop();
    board.setPosition(G.chess.fen(), { lastMove: h ? { from: h.from, to: h.to } : null, animate: false, sound: false });
    board.movable = G.userColor; board.render();
    renderAll();
    status('Move taken back. Your move.');
  };
  $('pFlip').onclick = () => board.setOrientation(board.orientation === 'w' ? 'b' : 'w');
  $('pNew').onclick = () => {
    if (G && !G.over && G.sans.length >= 2 && !confirm('Leave this game? It will count as a resignation.')) return;
    if (G && !G.over) gameOver(G.botColor, 'resignation');
    backToSetup();
  };

  // ---------- rendering ----------
  function material() {
    const count = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
    for (const p of G ? G.chess.board().flat() : []) if (p && p.type !== 'k') count[p.color][p.type]++;
    const captured = { w: [], b: [] }; // pieces each side has captured
    let score = { w: 0, b: 0 };
    for (const c of ['w', 'b']) {
      const opp = c === 'w' ? 'b' : 'w';
      for (const t of ['q', 'r', 'b', 'n', 'p']) {
        const missing = Math.max(0, START_COUNT[t] - count[opp][t]);
        for (let i = 0; i < missing; i++) captured[c].push(t);
        score[c] += count[c][t] * VAL[t];
      }
    }
    return { captured, diff: score.w - score.b };
  }
  function bar(color, isTop) {
    const isUser = G ? color === G.userColor : color === cfg.color;
    const bot = G ? G.bot : botProfile();
    const name = isUser ? esc(settings.username || 'You') : esc(bot.name);
    const rating = isUser ? '' : `<span class="muted">(${G ? G.elo : cfg.elo})</span>`;
    const mat = G ? material() : { captured: { w: [], b: [] }, diff: 0 };
    const adv = color === 'w' ? mat.diff : -mat.diff;
    const caps = mat.captured[color].map((t) => `<span class="mini"><piece class="${PNAME[t]} ${color === 'w' ? 'black' : 'white'}"></piece></span>`).join('');
    const clock = G?.tc ? `<span class="clock" id="clock-${color}">${fmtClock(G.clock[color])}</span>` : '';
    return `<div class="pb-left"><span class="pb-avatar ${isUser ? 'me' : ''}">${isUser ? '🙂' : bot.emoji}</span><div><div><b>${name}</b> ${rating}</div><div class="caps cg-wrap">${caps}${adv > 0 ? `<span class="adv">+${adv}</span>` : ''}</div></div></div>${clock}`;
  }
  function renderBars() {
    const bottom = G ? G.userColor : (cfg.color === 'b' ? 'b' : 'w');
    const top = bottom === 'w' ? 'b' : 'w';
    const flipped = board.orientation !== bottom;
    $('pbTop').innerHTML = bar(flipped ? bottom : top, true);
    $('pbBottom').innerHTML = bar(flipped ? top : bottom, false);
    if (G) renderClocks(G.chess.turn());
  }
  function renderClocks(turn, leftActive) {
    if (!G?.tc) return;
    for (const c of ['w', 'b']) {
      const el = $('clock-' + c);
      if (!el) continue;
      const ms = c === turn && !G.over ? (leftActive ?? G.clock[c] - (performance.now() - G.turnStart)) : G.clock[c];
      el.textContent = fmtClock(ms);
      el.classList.toggle('active', c === turn && !G.over);
      el.classList.toggle('low', ms < 20000);
    }
  }
  function renderMoves() {
    const rows = [];
    G.sans.forEach((s, i) => { if (i % 2 === 0) rows.push([s]); else rows[rows.length - 1].push(s); });
    $('playMoves').innerHTML = rows.length
      ? `<table>${rows.map((r, i) => `<tr><td class="no">${i + 1}.</td><td class="mv ${i * 2 === G.sans.length - 1 ? 'cur' : ''}">${esc(r[0])}</td><td class="mv ${i * 2 + 1 === G.sans.length - 1 ? 'cur' : ''}">${esc(r[1] || '')}</td></tr>`).join('')}</table>`
      : '<p class="muted small" style="padding:8px">No moves yet.</p>';
    $('playMoves').scrollTop = 1e6;
    const on = openingName();
    $('playOpening').textContent = on ? '📖 ' + on : '';
  }
  function renderAll() { renderBars(); renderMoves(); }

  function renderHistory() {
    if (!history.length) { $('playHistory').innerHTML = '<p class="muted small">Your finished games will show up here.</p>'; return; }
    $('playHistory').innerHTML = history.slice(0, 12).map((h, i) => `<div class="hist">
      <span class="pill ${h.result}">${h.result}</span>
      <span>${h.bot.emoji} <b>${esc(h.bot.name)}</b> <span class="muted">(${h.bot.elo})</span></span>
      <span class="muted small">${h.userColor === 'w' ? '⚪' : '⚫'} ${Math.ceil(h.sans.length / 2)} moves · ${esc(h.reason || '')}</span>
      <button class="small" data-h="${i}">Review</button></div>`).join('');
    $('playHistory').querySelectorAll('[data-h]').forEach((b) => b.addEventListener('click', () => reviewGame(history[+b.dataset.h])));
  }

  renderSetup();
  return { renderSetup, get active() { return !!G && !G.over; } };
}

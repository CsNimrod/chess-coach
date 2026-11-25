// Turns engine data into a short, human "why" for each move, like a coach's comment.
import { Chess, winPct, playLine, lineToSan, PIECE_VAL, PIECE_NAME, uciToObj } from './chessutil.js';
import { CLASSES, isError, materialSwing } from './analysis.js';

export function fmtEval(e) {
  if (!e) return '0.0';
  if (e.mate != null) return e.mate === 0 ? '#' : (e.mate > 0 ? '+' : '-') + 'M' + Math.abs(e.mate);
  return (e.cp > 0 ? '+' : '') + (e.cp / 100).toFixed(1);
}

function matWord(n) {
  n = Math.round(n);
  return ({ 1: 'a pawn', 2: 'two pawns', 3: 'a piece', 4: 'a piece and a pawn', 5: 'a rook', 6: 'a rook and a pawn', 8: 'about a queen', 9: 'the queen' })[n]
    || (n >= 10 ? 'a lot of material' : n === 7 ? 'a piece and two pawns' : 'material');
}

// What can `color` win here? If it's the other side's turn, we pretend `color` moves again (a threat).
function threats(fen, color) {
  const parts = fen.split(' ');
  let c;
  if (parts[1] === color) c = new Chess(fen);
  else {
    if (new Chess(fen).inCheck()) return null;
    parts[1] = color; parts[3] = '-';
    try { c = new Chess(parts.join(' ')); } catch { return null; }
  }
  let best = null;
  for (const m of c.moves({ verbose: true })) {
    const t = new Chess(c.fen());
    t.move(m.san);
    if (t.isCheckmate()) return { type: 'mate', san: m.san };
    if (!m.captured) continue;
    const defended = t.moves({ verbose: true }).some((x) => x.to === m.to);
    const gain = PIECE_VAL[m.captured] - (defended ? PIECE_VAL[m.piece] : 0);
    if (gain >= 2 && (!best || gain > best.gain)) best = { type: 'win', san: m.san, piece: PIECE_NAME[m.captured], sq: m.to, gain };
  }
  return best;
}

const sideName = (c) => (c === 'w' ? 'White' : 'Black');

export function explainMove(game, i) {
  const a = game.analysis[i];
  if (!a) return null;
  const m = game.moves[i];
  const eb = game.evals[i], ea = game.evals[i + 1];
  const isUser = m.color === game.userColor;
  const you = isUser ? 'you' : sideName(m.color);
  const your = isUser ? 'your' : `${sideName(m.color)}'s`;
  const them = isUser ? 'your opponent' : sideName(m.color === 'w' ? 'b' : 'w');
  const lose = isUser ? 'lose' : 'loses';
  // Was the previous move a capture on the square we now capture on? Then this is a recapture.
  const prevMove = game.moves[i - 1];
  let prevCaptured = null;
  if (prevMove) try { prevCaptured = new Chess(game.fens[i - 1]).move(uciToObj(prevMove.uci)).captured || null; } catch {}
  const isRecapture = !!(prevCaptured && prevMove.uci.slice(2, 4) === m.uci.slice(2, 4));
  const sign = m.color === 'w' ? 1 : -1;
  const san = m.san;
  const C = CLASSES[a.cls];

  const mv = new Chess(a.fen).move(uciToObj(m.uci));
  const afterFen = game.fens[i + 1];
  const after = new Chess(afterFen);
  const replyPv = ea.pv || [];
  const playedLine = [m.uci, ...replyPv];
  const sw = materialSwing(a.fen, playedLine);
  const bestPv = eb.pv && eb.pv[0] === eb.best ? eb.pv : eb.best ? [eb.best] : [];
  const bestSw = bestPv.length ? materialSwing(a.fen, bestPv) : { at2: 0, at4: 0 };
  const isBest = eb.best === m.uci;
  const myMateAfter = ea.mate != null && ea.mate * sign > 0 ? ea.mate * sign : null;
  const theirMateAfter = ea.mate != null && ea.mate * sign < 0 ? -ea.mate * sign : null;
  const myMateBefore = eb.mate != null && eb.mate * sign > 0 ? eb.mate * sign : null;
  const theirMateBefore = eb.mate != null && eb.mate * sign < 0;
  const reasons = [];

  const headline = {
    brilliant: `${san} is brilliant!`, great: `${san} is a great move`, best: `${san} is the best move`,
    excellent: `${san} is excellent`, good: `${san} is good`, book: `${san} is a book move`, forced: `${san} was the only legal move`,
    inaccuracy: `${san} is an inaccuracy`, mistake: `${san} is a mistake`, miss: `${san} is a miss`, blunder: `${san} is a blunder`,
  }[a.cls];

  if (after.isCheckmate()) {
    return { cls: a.cls, C, headline: `${san} is checkmate!`, reasons: ['Game over.'], best: null, evalText: '#' };
  }

  if (!isError(a.cls) && a.cls !== 'inaccuracy') {
    // ---------- why it's good ----------
    if (myMateAfter) reasons.push(`It forces mate in ${myMateAfter}: ${lineToSan(a.fen, playedLine, Math.min(9, myMateAfter * 2 - 1))}.`);
    if (a.cls === 'brilliant') reasons.push(`It sacrifices ${matWord(a.sac || 3)}, but ${them} can't take advantage. The follow-up is too strong: ${lineToSan(a.fen, playedLine, 5)}.`);
    if (a.cls === 'great') reasons.push(`It's the only move that ${a.wA >= 60 ? 'keeps the advantage' : 'holds the position together'}. Every other move is clearly worse.`);
    if (!myMateAfter && a.cls !== 'brilliant') {
      // net gain counts material the opponent just took as already lost
      const net = sw.at4 - (isRecapture ? PIECE_VAL[prevCaptured] : 0);
      if (net >= 2) reasons.push(`It wins ${matWord(net)}: ${lineToSan(a.fen, playedLine, sw.plies)}.`);
      else if (isRecapture) reasons.push(`It recaptures, restoring the material balance.`);
      else if (mv.captured && replyPv[0]?.slice(2, 4) === mv.to && Math.abs(net) <= 1) {
        reasons.push(mv.captured === mv.piece ? `It trades ${PIECE_NAME[mv.captured]}s.` : `It exchanges pieces on ${mv.to}.`);
      }
      else if (mv.captured) reasons.push(`It takes the ${PIECE_NAME[mv.captured]} on ${mv.to}.`);
    }
    if (mv.flags.includes('k') || mv.flags.includes('q')) reasons.push('Castling gets the king to safety and brings the rook into play.');
    if (mv.promotion) reasons.push(`It promotes to a ${PIECE_NAME[mv.promotion]}.`);
    if (a.phase === 'opening' && 'nb'.includes(mv.piece) && /[18]/.test(mv.from[1])) reasons.push('It develops a piece toward the center.');
    if (a.phase === 'opening' && mv.piece === 'p' && ['d4', 'e4', 'd5', 'e5', 'c4', 'c5'].includes(mv.to)) reasons.push('It fights for the center.');
    if (mv.san.includes('+') && !myMateAfter) reasons.push('It comes with check, so the opponent has to respond.');
    const t = threats(afterFen, m.color);
    if (t?.type === 'mate') reasons.push(`It threatens ${t.san} with checkmate.`);
    else if (t?.type === 'win' && sw.at4 < 2) reasons.push(`It threatens ${t.san}, winning the ${t.piece} on ${t.sq}.`);
    if (a.cls === 'book') reasons.unshift(`This is standard opening theory${game.opening && game.opening !== 'Unknown opening' ? ` (${game.opening})` : ''}.`);
    if (!reasons.length) {
      if (theirMateBefore) reasons.push('The position was already lost, but this is the most stubborn try.');
      else reasons.push(a.wA >= 65 ? `${your[0].toUpperCase() + your.slice(1)} advantage is preserved (${fmtEval(ea)}).` : a.wA <= 35 ? `It's the best practical try in a difficult position (${fmtEval(ea)}).` : `It keeps the position balanced (${fmtEval(ea)}).`);
    }
    if (!isBest && eb.best && a.cls !== 'book') reasons.push(`The engine slightly preferred ${a.bestSan}.`);
  } else {
    // ---------- why it's bad ----------
    if (theirMateAfter && !theirMateBefore) {
      reasons.push(`This allows mate in ${theirMateAfter}: ${lineToSan(afterFen, replyPv, Math.min(9, theirMateAfter * 2 - 1))}.`);
    } else if (myMateBefore && !myMateAfter) {
      reasons.push(`${you[0].toUpperCase() + you.slice(1)} had a forced mate in ${myMateBefore} starting with ${a.bestSan}: ${lineToSan(a.fen, bestPv, Math.min(9, myMateBefore * 2 - 1))}.`);
    } else if (sw.at4 <= -2) {
      const r = playLine(afterFen, replyPv, 1).moves[0];
      const loss = matWord(-sw.at4);
      if (r?.captured && r.to === mv.to) reasons.push(`It hangs ${your} ${PIECE_NAME[mv.piece]}: ${them} can just take it with ${r.san}.`);
      else if (r?.captured) reasons.push(`It leaves ${your} ${PIECE_NAME[r.captured]} on ${r.to} undefended. After ${r.san}, ${you} ${lose} ${loss}.`);
      else if (r) {
        const t = threats(playLine(afterFen, replyPv, 1).fens[0], m.color === 'w' ? 'b' : 'w');
        reasons.push(`After ${r.san}${t?.type === 'win' ? `, ${them} attacks two things at once and` : ','} ${you} ${lose} ${loss}: ${lineToSan(afterFen, replyPv, Math.max(2, (sw.plies || 4) - 1))}.`);
      }
    }
    if (!reasons.length && replyPv.length >= 2 && !myMateBefore) {
      // Look at the end of the opponent's best line: is something of ours about to fall?
      const k = Math.min(4, replyPv.length - (replyPv.length % 2));
      const pl = playLine(afterFen, replyPv, k);
      const oppColor = m.color === 'w' ? 'b' : 'w';
      const t = pl.fens.length === k ? threats(pl.fens[k - 1], oppColor) : null;
      const lastTo = pl.moves[k - 1]?.to;
      if (t?.type === 'mate') reasons.push(`After ${lineToSan(afterFen, replyPv, k)}, ${them} threatens ${t.san}.`);
      else if (t?.type === 'win' && t.sq !== lastTo) reasons.push(`After ${lineToSan(afterFen, replyPv, k)}, ${them} wins the ${t.piece} on ${t.sq} with ${t.san}.`);
    }
    if (a.cls === 'miss') {
      const prev = game.analysis[i - 1];
      reasons.push(`${them[0].toUpperCase() + them.slice(1)}'s last move ${prev?.san ? `(${prev.san}) ` : ''}was a ${prev ? CLASSES[prev.cls].label.toLowerCase() : 'mistake'}, but this doesn't punish it.`);
    }
    if (!myMateBefore && bestSw.at4 >= 2 && bestSw.at4 - sw.at4 >= 2) {
      reasons.push(`${a.bestSan} wins ${matWord(bestSw.at4)}: ${lineToSan(a.fen, bestPv, 5)}.`);
    }
    if (a.phase === 'opening') {
      const prevOwn = game.moves.slice(0, i).filter((x) => x.color === m.color);
      const undeveloped = (a.fen.split(' ')[0].split('/')[m.color === 'w' ? 7 : 0].match(m.color === 'w' ? /[NB]/g : /[nb]/g) || []).length;
      if (mv.piece === 'q' && m.moveNo <= 8) reasons.push('Bringing the queen out early lets the opponent develop while attacking it.');
      else if (mv.piece === 'k' && !mv.flags.includes('k') && !mv.flags.includes('q')) reasons.push('Moving the king gives up the right to castle and leaves it in the center.');
      else if (prevOwn.some((x) => x.uci.slice(2, 4) === mv.from) && undeveloped >= 2 && mv.piece !== 'p') reasons.push('Moving the same piece twice in the opening leaves other pieces undeveloped.');
    }
    const kingSq = after.board().flat().find((p) => p && p.type === 'k' && p.color === m.color)?.square;
    if (mv.piece === 'p' && kingSq && 'fgh'.includes(mv.from[0]) && 'gh'.includes(kingSq[0]) && !reasons.length) {
      reasons.push(`It loosens the pawns in front of ${your} king.`);
    }
    if (!reasons.length) {
      const r = playLine(afterFen, replyPv, 1).moves[0];
      reasons.push(`The evaluation drops from ${fmtEval(eb)} to ${fmtEval(ea)}.${r ? ` ${them[0].toUpperCase() + them.slice(1)}'s best reply is ${r.san}: ${lineToSan(afterFen, replyPv, 4)}.` : ''}`);
    }
    if (a.wB >= 75 && a.wA <= 55) reasons.push(`${you === 'you' ? 'You were' : you + ' was'} winning before this move.`);
    if (a.tags?.includes('Time trouble')) reasons.push(`Only ${Math.round(a.clock)}s were left on the clock.`);
  }

  const best = !isBest && eb.best && a.cls !== 'book' ? { san: a.bestSan, uci: eb.best, line: lineToSan(a.fen, bestPv, 6) } : null;
  return { cls: a.cls, C, headline, reasons, best, evalText: fmtEval(ea), winBefore: a.wB, winAfter: a.wA };
}

export function explainPrompt(game, i, ex) {
  const a = game.analysis[i];
  const eb = game.evals[i], ea = game.evals[i + 1];
  return `You are a friendly chess coach. Explain in 2-4 short sentences, in plain language for a club player, WHY this move is ${a.cls}. Mention the concrete idea (tactic, threat, weakness, plan). Do not invent moves that are not in the lines given.

Position (FEN, before the move): ${a.fen}
Side to move: ${a.color === 'w' ? 'White' : 'Black'}
Move played: ${a.san} (classified as ${a.cls})
Engine eval before: ${fmtEval(eb)}, after: ${fmtEval(ea)} (White's view)
Win chance for the mover: ${a.wB.toFixed(0)}% -> ${a.wA.toFixed(0)}%
Engine best move: ${a.bestSan || '?'}; best line: ${eb.pv?.length ? lineToSan(a.fen, eb.pv, 8) : '?'}
Opponent's best reply after the played move: ${ea.pv?.length ? lineToSan(game.fens[i + 1], ea.pv, 8) : '?'}
Automatic notes: ${ex.reasons.join(' ')}`;
}

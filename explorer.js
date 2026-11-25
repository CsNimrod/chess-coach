// Lichess opening explorer: what real players at a given rating play in a position.
// The explorer needs a (free) Lichess login. We use OAuth with PKCE, which works from
// a static site with no secret. The token has no scopes (read-only public data).
const TOKEN_KEY = 'cc_lichess_token';
const CLIENT_ID = 'chess-coach';
const BANDS = [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500];

export const lichessToken = () => localStorage.getItem(TOKEN_KEY);
export const setLichessToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));
const redirectUri = () => location.origin + location.pathname;

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function connectLichess() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(12)));
  sessionStorage.setItem('cc_pkce', JSON.stringify({ verifier, state }));
  const q = new URLSearchParams({
    response_type: 'code', client_id: CLIENT_ID, redirect_uri: redirectUri(),
    code_challenge_method: 'S256', code_challenge: challenge, state,
  });
  location.href = 'https://lichess.org/oauth?' + q;
}

// Call on page load. Returns true if we just finished a Lichess login.
export async function finishLichessLogin() {
  const p = new URLSearchParams(location.search);
  const code = p.get('code');
  if (!code && !p.get('error')) return false;
  history.replaceState(null, '', redirectUri() + location.hash);
  const saved = JSON.parse(sessionStorage.getItem('cc_pkce') || 'null');
  sessionStorage.removeItem('cc_pkce');
  if (!code || !saved || saved.state !== p.get('state')) throw new Error('Lichess login was cancelled or expired. Try again.');
  const r = await fetch('https://lichess.org/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: saved.verifier, redirect_uri: redirectUri(), client_id: CLIENT_ID }),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error('Lichess login failed: ' + (j.error_description || j.error || r.status));
  setLichessToken(j.access_token);
  return true;
}

export async function disconnectLichess() {
  const t = lichessToken();
  setLichessToken(null);
  if (t) try { await fetch('https://lichess.org/api/token', { method: 'DELETE', headers: { Authorization: 'Bearer ' + t } }); } catch {}
}

// chess.com ratings run lower than Lichess ones. Rough conversion for blitz/rapid.
export function toLichess(chesscom) {
  const r = +chesscom || 1200;
  return Math.round(r + (r < 1200 ? 300 : r < 1800 ? 200 : r < 2200 ? 100 : 0));
}
// Two neighbouring Lichess rating bands around the estimate, for enough games.
export function bandsFor(chesscom) {
  const est = toLichess(chesscom);
  const bandOf = (x) => BANDS.filter((b) => b <= x).pop() ?? 0;
  const set = [...new Set([bandOf(est - 100), bandOf(est + 100)])];
  const hi = BANDS[BANDS.indexOf(set[set.length - 1]) + 1];
  return { est, bands: set, label: hi ? `${set[0]}–${hi - 1}` : `${set[0]}+` };
}

const cache = new Map();
export async function explore(fen, { bands, speeds }) {
  const t = lichessToken();
  if (!t) throw Object.assign(new Error('Connect your Lichess account first.'), { code: 'auth' });
  const q = new URLSearchParams({ variant: 'standard', fen, speeds, ratings: bands.join(','), moves: '12', topGames: '0', recentGames: '0' });
  const key = q.toString();
  if (cache.has(key)) return cache.get(key);
  const r = await fetch('https://explorer.lichess.ovh/lichess?' + q, { headers: { Authorization: 'Bearer ' + t } });
  if (r.status === 401) { setLichessToken(null); throw Object.assign(new Error('Your Lichess login expired. Connect again.'), { code: 'auth' }); }
  if (r.status === 429) throw new Error('Lichess is rate-limiting requests. Wait a minute and try again.');
  if (!r.ok) throw new Error('Opening explorer error ' + r.status);
  const j = await r.json();
  const total = j.white + j.draws + j.black;
  const moves = (j.moves || []).map((m) => {
    const n = m.white + m.draws + m.black;
    return { ...m, games: n, pct: total ? (100 * n) / total : 0 };
  });
  const out = { total, moves, opening: j.opening };
  cache.set(key, out);
  return out;
}

// Pick a reply like a real opponent would: weighted by popularity (ignoring <2% oddities), or the top move.
export function pickMove(data, style) {
  const ms = data.moves.filter((m) => m.pct >= 2);
  if (!ms.length) return data.moves[0] || null;
  if (style === 'top') return ms[0];
  let x = Math.random() * ms.reduce((s, m) => s + m.games, 0);
  for (const m of ms) { x -= m.games; if (x <= 0) return m; }
  return ms[0];
}

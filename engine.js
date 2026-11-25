// Stockfish running in Web Workers, loaded from a CDN (no install needed).
// First choice: Stockfish 18 NNUE (WASM, ~7 MB). Fallback: Stockfish 10 (pure JS, weaker).
const SF18 = 'https://unpkg.com/stockfish@18.0.8/bin/stockfish-18-lite-single';
const SOURCES = [
  { js: SF18 + '.js', hash: '#' + encodeURIComponent(SF18 + '.wasm'), name: 'Stockfish 18 NNUE' },
  { js: 'https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.js', hash: '', name: 'Stockfish 10' },
  { js: 'https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js', hash: '', name: 'Stockfish 10' },
];
export let engineName = '';

let workerUrlPromise = null;
function workerUrl() {
  if (!workerUrlPromise) {
    workerUrlPromise = (async () => {
      let lastErr;
      for (const s of SOURCES) {
        try {
          if (s.hash && typeof WebAssembly !== 'object') continue;
          const r = await fetch(s.js);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const src = await r.text();
          engineName = s.name;
          return URL.createObjectURL(new Blob([src], { type: 'application/javascript' })) + s.hash;
        } catch (e) { lastErr = e; }
      }
      workerUrlPromise = null;
      throw new Error('Could not load Stockfish (' + lastErr + ')');
    })();
  }
  return workerUrlPromise;
}

export class Engine {
  constructor({ multipv = 1 } = {}) {
    this.multipv = multipv;
    this.listeners = new Set();
    this.queue = Promise.resolve();
    this.ready = this._init();
  }
  async _init() {
    this.w = new Worker(await workerUrl());
    this.w.onmessage = (e) => { const line = String(e.data); for (const l of [...this.listeners]) l(line); };
    await this._waitFor('uci', (l) => l === 'uciok');
    this.send('setoption name Hash value 16');
    if (this.multipv > 1) this.send('setoption name MultiPV value ' + this.multipv);
    await this._waitFor('isready', (l) => l === 'readyok');
    this.name = engineName.replace(/\s+/g, '');
  }
  send(c) { this.w.postMessage(c); }
  _waitFor(cmd, done) {
    return new Promise((res) => {
      const f = (l) => { if (done(l)) { this.listeners.delete(f); res(); } };
      this.listeners.add(f);
      this.send(cmd);
    });
  }
  // Returns score from the side-to-move's point of view:
  // {cp, mate, best, pv, second: {cp, mate, pv} | null}
  evaluate(fen, { depth = 16, movetime = 2000 } = {}) {
    const job = async () => {
      await this.ready;
      return new Promise((res) => {
        const lines = {};
        const f = (l) => {
          if (l.startsWith('info') && l.includes(' score ') && !l.includes('bound')) {
            const m = l.match(/score (cp|mate) (-?\d+)/);
            const mp = l.match(/ multipv (\d+)/);
            const pv = l.match(/ pv (.+)$/);
            const k = mp ? +mp[1] : 1;
            if (m && pv) lines[k] = { cp: m[1] === 'cp' ? +m[2] : null, mate: m[1] === 'mate' ? +m[2] : null, pv: pv[1].split(' ') };
          } else if (l.startsWith('bestmove')) {
            this.listeners.delete(f);
            const bm = l.split(' ')[1];
            const first = lines[1] || { cp: 0, mate: null, pv: [] };
            res({ ...first, best: !bm || bm === '(none)' ? null : bm, second: lines[2] || null });
          }
        };
        this.listeners.add(f);
        this.send('position fen ' + fen);
        this.send(`go depth ${depth} movetime ${movetime}`);
      });
    };
    const p = this.queue.then(job);
    this.queue = p.catch(() => {});
    return p;
  }
  terminate() { this.w?.terminate(); }
}

let shared = null;
export const sharedEngine = () => (shared ??= new Engine());

export function poolSize() {
  const c = navigator.hardwareConcurrency || 2;
  return Math.max(1, Math.min(4, c - 1));
}

// Thin UCI wrapper around Stockfish running in a Web Worker.
// Tries the WebAssembly build first and falls back to the pure-JS build.

const BUILDS = ['vendor/stockfish/stockfish.js', 'vendor/stockfish/stockfish-asm.js'];
const MATE = 100000;

export class Engine {
  constructor(base = new URL('../', import.meta.url)) {
    this.base = base;
    this.listeners = new Set();
    this.queue = Promise.resolve();
    this.ready = this.boot();
  }

  async boot() {
    let lastError = null;
    for (const path of BUILDS) {
      try {
        await this.load(new URL(path, this.base).href);
        this.build = path;
        return;
      } catch (err) {
        lastError = err;
        if (this.worker) this.worker.terminate();
      }
    }
    throw lastError || new Error('Engine failed to start');
  }

  load(url) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Engine took too long to start')), 20000);
      try {
        this.worker = new Worker(url);
      } catch (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }
      this.worker.onmessage = (e) => {
        const line = typeof e.data === 'string' ? e.data : '';
        for (const l of [...this.listeners]) l(line);
      };
      this.worker.onerror = (e) => {
        clearTimeout(timer);
        e.preventDefault && e.preventDefault();
        reject(new Error(e.message || 'Engine failed to load'));
      };
      this.until('uci', (l) => l === 'uciok')
        .then(() => this.until('isready', (l) => l === 'readyok'))
        .then(() => { clearTimeout(timer); resolve(); });
    });
  }

  send(cmd) {
    this.worker.postMessage(cmd);
  }

  until(cmd, done, onLine) {
    return new Promise((resolve) => {
      const f = (l) => {
        if (onLine) onLine(l);
        if (done(l)) {
          this.listeners.delete(f);
          resolve(l);
        }
      };
      this.listeners.add(f);
      this.send(cmd);
    });
  }

  // Search a position. `elo` limits playing strength (null = full strength).
  // Returns { bestmove, score, lines } with score in centipawns from the side
  // to move's point of view (mates map to ±100000 minus distance).
  search(fen, { movetime = 500, depth = null, elo = null, multipv = 1 } = {}) {
    const run = async () => {
      await this.ready;
      this.send(`setoption name MultiPV value ${multipv}`);
      this.send(`setoption name UCI_LimitStrength value ${elo ? 'true' : 'false'}`);
      if (elo) this.send(`setoption name UCI_Elo value ${elo}`);
      await this.until('isready', (l) => l === 'readyok');
      this.send(`position fen ${fen}`);
      const lines = new Map();
      const go = depth ? `go depth ${depth}` : `go movetime ${movetime}`;
      const done = await this.until(go, (l) => l.startsWith('bestmove'), (l) => {
        if (!l.startsWith('info') || !l.includes(' pv ')) return;
        const pv = l.split(' pv ')[1].trim().split(' ');
        const mpv = Number((l.match(/ multipv (\d+)/) || [0, 1])[1]);
        const cp = l.match(/ score cp (-?\d+)/);
        const mate = l.match(/ score mate (-?\d+)/);
        const score = cp ? Number(cp[1]) : mate ? Math.sign(Number(mate[1]) || -1) * (MATE - Math.abs(Number(mate[1]))) : 0;
        lines.set(mpv, { score, mate: mate ? Number(mate[1]) : null, pv });
      });
      const bestmove = done.split(' ')[1];
      const sorted = [...lines.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
      const top = sorted[0] || { score: 0, mate: null, pv: [bestmove] };
      return { bestmove: bestmove === '(none)' ? null : bestmove, score: top.score, mate: top.mate, pv: top.pv, lines: sorted };
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  stop() {
    if (this.worker) this.worker.terminate();
  }
}

export const isMateScore = (s) => Math.abs(s) > MATE / 2;

export function formatScore(cp) {
  if (isMateScore(cp)) {
    const n = MATE - Math.abs(cp);
    return (cp > 0 ? '#' : '#-') + n;
  }
  const p = cp / 100;
  return (p > 0 ? '+' : '') + p.toFixed(1);
}

// Convert a UCI move ("e2e4", "e7e8q") to a chess.js move object.
export const uciToMove = (u) => ({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });

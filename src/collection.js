// Your game collection: importing, analysing (in a worker pool) and
// remembering games in the browser. The UI listens through `onChange`.

import { analyzeGame, slimGame, ANALYSIS_VERSION, gameReport, detectUserColor } from './insights.js';
import { compactPgn, gameKey } from './import.js';
import { library } from './library.js';

export const WINDOW = 40; // plies with every alternative ranked
export const OPENING_MOVES = 12;

// ---------- analysis workers ----------
const POOL_SIZE = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
const pool = [];
const pending = new Map();
for (let i = 0; i < POOL_SIZE; i++) {
  try {
    const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    const slot = { w, busy: 0, dead: false };
    w.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      slot.busy--;
      e.data.error ? p.reject(new Error(e.data.error)) : p.resolve(e.data.game);
    };
    w.onerror = () => {
      slot.dead = true;
      for (const [id, p] of pending) {
        if (p.slot !== slot) continue;
        pending.delete(id);
        p.reject(new Error('Worker failed'));
      }
    };
    pool.push(slot);
  } catch {
    break;
  }
}
const liveWorkers = () => pool.filter((s) => !s.dead);
const analyseHere = (pgn) => new Promise((resolve, reject) => setTimeout(() => {
  try { resolve(slimGame(analyzeGame(pgn, { window: WINDOW }))); } catch (err) { reject(err); }
}, 0));

function runAnalysis(id, pgn) {
  const live = liveWorkers();
  if (!live.length) return analyseHere(pgn);
  const slot = live.reduce((a, b) => (b.busy < a.busy ? b : a));
  slot.busy++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, slot });
    slot.w.postMessage({ id, pgn, window: WINDOW });
  }).catch((err) => {
    if (/Worker|module/i.test(err.message)) return analyseHere(pgn);
    throw err;
  });
}

function readHeaders(pgn) {
  const h = {};
  for (const m of pgn.matchAll(/\[(\w+)\s+"([^"]*)"\]/g)) h[m[1]] = m[2];
  return h;
}

const record = (g) => ({ key: g.key, pgn: g.pgn, userColor: g.userColor, colorKnown: g.colorKnown, added: g.added, game: g.game, engine: g.engine || null, version: ANALYSIS_VERSION });

function throttle(fn, ms) {
  let timer = null;
  return () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; fn(); }, ms);
  };
}

let nextId = 1;

export class Collection {
  constructor({ username = () => '', onChange = () => {}, onProgress = () => {} } = {}) {
    this.games = []; // newest first
    this.username = username;
    this.onChange = onChange;
    this.onProgress = onProgress;
    this.job = null;
    this.storageFull = false;
  }

  get busy() {
    return !!this.job;
  }

  get hasOwnGames() {
    return this.games.some((g) => !g.sample);
  }

  make(pgn, { userColor = null, sample = false } = {}) {
    const compact = compactPgn(pgn);
    const headers = readHeaders(compact);
    const detected = detectUserColor(headers, this.username());
    return {
      id: nextId++, key: gameKey(headers, compact), pgn: compact, headers, added: 0,
      userColor: userColor || detected || 'w', colorKnown: !!(userColor || detected), sample,
      game: null, report: null, error: null,
    };
  }

  // Add games (skipping ones already here) and analyse them.
  async add(pgns, { userColor = null, persist = true, sample = false } = {}) {
    if (!sample) this.games = this.games.filter((g) => !g.sample);
    const known = new Set(this.games.map((g) => g.key));
    const base = Date.now() * 1000;
    const added = [];
    pgns.forEach((pgn, i) => {
      const g = this.make(pgn, { userColor, sample });
      if (known.has(g.key)) return;
      known.add(g.key);
      g.added = base + pgns.length - i; // keep the given order (newest first)
      added.push(g);
    });
    this.games = added.concat(this.games);
    this.onChange();
    const result = await this.analyse(added, { persist });
    return { ...result, added, skipped: pgns.length - added.length };
  }

  async analyse(list, { persist = true } = {}) {
    const me = { cancelled: false };
    this.job = me;
    let next = 0;
    let done = 0;
    let failed = 0;
    const batch = [];
    const flush = async () => {
      if (!persist || !batch.length) return;
      if (!(await library.put(batch.splice(0).map(record)))) this.storageFull = true;
    };
    const refresh = throttle(() => this.onChange(), 700);
    const run = async () => {
      while (next < list.length && !me.cancelled) {
        const g = list[next++];
        try {
          g.game = await runAnalysis(g.id, g.pgn);
          g.report = gameReport(g.game, g.userColor, { openingMoves: OPENING_MOVES });
          if (!g.sample) batch.push(g);
        } catch (err) {
          g.error = err.message;
          failed++;
        }
        done++;
        if (list.length > 1) this.onProgress(`Analysed ${done} of ${list.length} games…`);
        if (batch.length >= 25) await flush();
        refresh();
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, liveWorkers().length) }, run));
    await flush();
    if (me.cancelled) {
      const drop = new Set(list.filter((g) => !g.game && !g.error));
      this.games = this.games.filter((g) => !drop.has(g));
    }
    if (this.job === me) this.job = null;
    this.onChange();
    return { analysed: done - failed, failed, cancelled: me.cancelled };
  }

  // Save a game after adding to it (for example an engine check).
  save(g) {
    if (!g.sample && g.game) library.put([record(g)]);
  }

  cancel() {
    if (this.job) this.job.cancelled = true;
  }

  setUserColor(g, c, { persist = true } = {}) {
    g.userColor = c;
    g.colorKnown = true;
    if (g.game) g.report = gameReport(g.game, c, { openingMoves: OPENING_MOVES });
    if (persist && !g.sample && g.game) library.put([record(g)]);
  }

  // Re-read which side you played after the username changes.
  redetect() {
    const changed = [];
    for (const g of this.games) {
      const c = detectUserColor(g.headers, this.username());
      if (c && (c !== g.userColor || !g.colorKnown)) {
        this.setUserColor(g, c, { persist: false });
        changed.push(g);
      }
    }
    library.put(changed.filter((g) => !g.sample && g.game).map(record));
    if (changed.length) this.onChange();
  }

  async clear() {
    this.cancel();
    this.games = [];
    await library.clear();
    this.onChange();
  }

  // Load saved games; returns false when there were none.
  async load() {
    const records = (await library.all()).sort((x, y) => y.added - x.added);
    if (!records.length) return false;
    const stale = [];
    for (const r of records) {
      const g = this.make(r.pgn);
      Object.assign(g, { key: r.key, added: r.added, userColor: r.userColor, colorKnown: r.colorKnown, engine: r.engine || null });
      if (r.version === ANALYSIS_VERSION && r.game) {
        g.game = r.game;
        g.report = gameReport(g.game, g.userColor, { openingMoves: OPENING_MOVES });
      } else {
        stale.push(g);
      }
      this.games.push(g);
    }
    this.onChange();
    if (stale.length) {
      this.onProgress(`Updating the analysis of ${stale.length} saved games…`);
      await this.analyse(stale);
      this.onProgress('');
    }
    return true;
  }
}

// Over-the-board move capture from a camera.
//
// No piece recognition is needed: we know the starting position, so after
// each move we only need to know which squares changed. The board's four
// corners give a homography from board coordinates to image pixels; each
// square is summarised by the colour and texture of its centre; when the
// picture settles after a hand has moved, the legal move whose squares best
// match the changes is the move that was played.

const SQ = (f, r) => r * 8 + f; // file 0-7 (a-h), rank 0-7 (1-8)
const NAME = (i) => 'abcdefgh'[i & 7] + ((i >> 3) + 1);
const IDX = (s) => (s.charCodeAt(1) - 49) * 8 + (s.charCodeAt(0) - 97);

// ---------- homography ----------
// Solve for H mapping src points to dst points (4 pairs).
export function homography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solve(A, b);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) throw new Error('Corners are degenerate');
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export function project(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

// Corners are the outer corners of a8, h8, h1, a1 in image pixels.
// Board coordinates: x = file (0 at a-side edge, 8 at h-side), y = 8 at rank-1 edge.
export function boardHomography(corners) {
  return homography([[0, 0], [8, 0], [8, 8], [0, 8]], corners);
}

// Image position of a point inside a square (u, v in 0..1 across the square).
export function squarePoint(H, sq, u = 0.5, v = 0.5) {
  const f = sq & 7;
  const r = sq >> 3;
  return project(H, f + u, 7 - r + v);
}

// ---------- sampling ----------
const GRID = 5; // samples per side within the square's central area
const INSET = 0.22;

// Per-square signature: mean R, G, B and luminance spread.
// img: { data: Uint8ClampedArray RGBA, width, height }
export function sampleSquares(img, H) {
  const out = new Float32Array(64 * 4);
  const { data, width, height } = img;
  for (let sq = 0; sq < 64; sq++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    const lum = [];
    for (let i = 0; i < GRID; i++) {
      for (let j = 0; j < GRID; j++) {
        const u = INSET + ((1 - 2 * INSET) * (i + 0.5)) / GRID;
        const v = INSET + ((1 - 2 * INSET) * (j + 0.5)) / GRID;
        const [x, y] = squarePoint(H, sq, u, v);
        const px = Math.round(x);
        const py = Math.round(y);
        if (px < 0 || py < 0 || px >= width || py >= height) continue;
        const k = (py * width + px) * 4;
        r += data[k];
        g += data[k + 1];
        b += data[k + 2];
        lum.push(0.299 * data[k] + 0.587 * data[k + 1] + 0.114 * data[k + 2]);
        n++;
      }
    }
    if (!n) continue;
    const mean = lum.reduce((s, x) => s + x, 0) / n;
    const spread = Math.sqrt(lum.reduce((s, x) => s + (x - mean) ** 2, 0) / n);
    out.set([r / n, g / n, b / n, spread], sq * 4);
  }
  return out;
}

// How different each square looks between two signatures.
export function squareDiffs(a, b) {
  const d = new Float32Array(64);
  for (let sq = 0; sq < 64; sq++) {
    const k = sq * 4;
    const colour = Math.hypot(a[k] - b[k], a[k + 1] - b[k + 1], a[k + 2] - b[k + 2]);
    d[sq] = colour + 1.5 * Math.abs(a[k + 3] - b[k + 3]);
  }
  return d;
}

// ---------- move inference ----------
// Squares whose contents change when a move is played.
export function changedSquares(move) {
  const s = [IDX(move.from), IDX(move.to)];
  const rank = move.color === 'w' ? '1' : '8';
  if (move.flags.includes('k')) s.push(IDX('h' + rank), IDX('f' + rank));
  if (move.flags.includes('q')) s.push(IDX('a' + rank), IDX('d' + rank));
  if (move.flags.includes('e')) s.push(IDX(move.to[0] + move.from[1]));
  return s;
}

// Rank legal moves by how well their squares explain the observed changes.
// moves: chess.js verbose moves; diffs: squareDiffs(baseline, now); noise: typical idle diff.
export function rankCandidates(moves, diffs, noise = 6) {
  const threshold = Math.max(18, noise * 4);
  const seen = new Map();
  for (const m of moves) {
    const key = m.from + m.to; // promotions share squares; we assume a queen
    if (seen.has(key) && m.promotion !== 'q') continue;
    const squares = changedSquares(m);
    const set = new Set(squares);
    const inside = squares.map((s) => diffs[s]);
    const weakest = Math.min(...inside);
    const others = [];
    for (let i = 0; i < 64; i++) if (!set.has(i)) others.push(diffs[i]);
    others.sort((x, y) => y - x);
    const stray = others.slice(0, squares.length).reduce((s, x) => s + x, 0) / squares.length;
    // Every changed square must clearly change; nothing else should.
    const score = (weakest - Math.max(threshold * 0.5, stray)) / threshold + inside.reduce((s, x) => s + x, 0) / squares.length / threshold / 4;
    seen.set(key, { move: m, score, weakest, stray, squares: squares.map(NAME) });
  }
  return [...seen.values()].sort((a, b) => b.score - a.score);
}

// ---------- tracker ----------
// Feeds on per-frame signatures and reports moves once the board is still.
export class Tracker {
  constructor({ settleMs = 700, motionThreshold = 14 } = {}) {
    this.settleMs = settleMs;
    this.motionThreshold = motionThreshold;
    this.baseline = null;
    this.prev = null;
    this.stableSince = null;
    this.noise = 6;
    this.pendingHandled = false;
  }

  reset(signature) {
    this.baseline = signature;
    this.prev = signature;
    this.stableSince = null;
    this.pendingHandled = false;
  }

  // Returns { state: 'moving' | 'still' | 'changed', diffs? }.
  feed(signature, now) {
    if (!this.baseline) {
      this.reset(signature);
      return { state: 'still' };
    }
    const motion = this.prev ? squareDiffs(this.prev, signature) : null;
    this.prev = signature;
    const moving = motion && Math.max(...motion) > Math.max(this.motionThreshold, this.noise * 3);
    if (moving) {
      this.stableSince = null;
      this.pendingHandled = false;
      return { state: 'moving' };
    }
    if (this.stableSince === null) this.stableSince = now;
    if (now - this.stableSince < this.settleMs) return { state: 'moving' };
    const diffs = squareDiffs(this.baseline, signature);
    const sorted = [...diffs].sort((a, b) => a - b);
    const idle = sorted[Math.floor(sorted.length / 2)];
    const changed = sorted[sorted.length - 2] > Math.max(18, idle * 4); // at least two squares
    if (!changed) {
      // Track slow lighting changes while nothing happens.
      this.noise = 0.9 * this.noise + 0.1 * Math.max(2, idle);
      this.baseline = signature;
      return { state: 'still' };
    }
    if (this.pendingHandled) return { state: 'still' };
    this.pendingHandled = true;
    return { state: 'changed', diffs };
  }

  accept(signature) {
    this.reset(signature);
  }
}

export const squareName = NAME;
export const squareIndex = IDX;
export { SQ };

// ---------- piece-colour reading ----------
// Instead of watching for change, read every square as empty, white piece or
// black piece. The starting position labels all 64 squares, so the app learns
// what each of the six cases (light or dark square x empty, white, black)
// looks like on this board, in this light. Each frame is then read square by
// square, and the legal move whose resulting board matches the reading is the
// move that was played. After every move the colours are learnt again.

export const OCC = ['e', 'w', 'b'];
const NF = 6; // features per square
// Squared distances (in standard deviations, summed over features): a square
// this far from every learnt case is covered; a reading this much worse than
// the best one is a disagreement.
const UNKNOWN = 150;
const WRONG = 9;
const READ_GRID = 6;
const READ_INSET = 0.25;
const lumOf = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
export const isLight = (sq) => ((sq & 7) + (sq >> 3)) % 2 === 1;

// Occupancy by square index (a1 = 0): 'e', 'w' or 'b'.
export function occupancy(chess) {
  const out = new Array(64).fill('e');
  chess.board().forEach((row, i) => row.forEach((p, f) => { if (p) out[(7 - i) * 8 + f] = p.color; }));
  return out;
}

function quantile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
}

// Per-square features, normalised for exposure: mean luminance, spread, two
// chroma terms and the 10th and 90th percentile luminance (dark or bright
// piece pixels against the square).
// Tall pieces lean, in the picture, over the square behind them (the one
// further up the image). Each square is read from its far side, which a
// piece in front can't cover.
function farSide(H) {
  const [cx, cy] = project(H, 4, 4);
  const dirs = [[0, -1], [0, 1], [-1, 0], [1, 0]];
  let best = dirs[0];
  let up = -Infinity;
  for (const d of dirs) {
    const [x, y] = project(H, 4 + d[0] * 0.5, 4 + d[1] * 0.5);
    const len = Math.hypot(x - cx, y - cy) || 1;
    const score = (cy - y) / len;
    if (score > up) { up = score; best = d; }
  }
  return best;
}

export function readFeatures(img, H) {
  const { data, width, height } = img;
  const raw = [];
  const [ux, uy] = farSide(H);
  const SHIFT = 0.15;
  for (let sq = 0; sq < 64; sq++) {
    const lum = [];
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < READ_GRID; i++) {
      for (let j = 0; j < READ_GRID; j++) {
        const u = READ_INSET + ((1 - 2 * READ_INSET) * (i + 0.5)) / READ_GRID + ux * SHIFT;
        const v = READ_INSET + ((1 - 2 * READ_INSET) * (j + 0.5)) / READ_GRID + uy * SHIFT;
        const [x, y] = squarePoint(H, sq, u, v);
        const px = Math.round(x);
        const py = Math.round(y);
        if (px < 0 || py < 0 || px >= width || py >= height) continue;
        const k = (py * width + px) * 4;
        r += data[k];
        g += data[k + 1];
        b += data[k + 2];
        lum.push(lumOf(data[k], data[k + 1], data[k + 2]));
      }
    }
    lum.sort((x, y) => x - y);
    const n = lum.length || 1;
    const mean = lum.reduce((s, x) => s + x, 0) / n;
    raw.push({ n: lum.length, mean, sd: Math.sqrt(lum.reduce((s, x) => s + (x - mean) ** 2, 0) / n), cr: (r - g) / n, cb: (b - g) / n, q10: quantile(lum, 0.1), q90: quantile(lum, 0.9) });
  }
  const feat = new Float32Array(64 * NF);
  const valid = new Uint8Array(64);
  raw.forEach((q, sq) => {
    valid[sq] = q.n > READ_GRID * READ_GRID * 0.6 ? 1 : 0;
    feat.set([q.mean, q.sd, q.cr, q.cb, q.q10, q.q90], sq * NF);
  });
  return { feat, valid };
}

// Exposure changes scale every feature together. Measure it on squares that
// are empty (in the position we believe is on the board), against what the
// reader learnt for empty squares, and undo it.
function normalise({ feat, valid }, occ, model) {
  let scale = 1;
  if (model) {
    const ratios = [];
    for (let sq = 0; sq < 64; sq++) {
      const ref = model[isLight(sq) ? 1 : 0][0];
      const lum = feat[sq * NF];
      if (occ[sq] === 'e' && valid[sq] && ref && lum > 1) ratios.push(ref.mu[0] / lum);
    }
    if (ratios.length >= 4) scale = quantile(ratios.sort((a, b) => a - b), 0.5);
  }
  const out = new Float32Array(feat.length);
  for (let i = 0; i < feat.length; i++) out[i] = feat[i] * scale;
  return { feat: out, valid, scale };
}

// Work out which corner is which from a board set up in the starting
// position: the pieces fill two ranks at each end, and White's are lighter.
// taps: four image points in any order. Returns corners as a8, h8, h1, a1.
export function orientCorners(img, taps) {
  const c = taps.reduce((a, [x, y]) => [a[0] + x / 4, a[1] + y / 4], [0, 0]);
  const ring = [...taps].sort((p, q) => Math.atan2(p[1] - c[1], p[0] - c[0]) - Math.atan2(q[1] - c[1], q[0] - c[0]));
  const start = ring.reduce((best, p, i) => (p[0] + p[1] < ring[best][0] + ring[best][1] ? i : best), 0);
  const quad = [0, 1, 2, 3].map((i) => ring[(start + i) % 4]);
  const hyps = [];
  for (let k = 0; k < 4; k++) {
    const corners = [0, 1, 2, 3].map((i) => quad[(i + k) % 4]);
    let H;
    try { H = boardHomography(corners); } catch { continue; }
    const { feat } = readFeatures(img, H);
    const at = (sq, i) => feat[sq * NF + i];
    const occupied = (sq) => (sq >> 3) <= 1 || (sq >> 3) >= 6;
    // Reference colour of an empty square of each colour.
    const ref = [false, true].map((light) => {
      const xs = [];
      for (let sq = 0; sq < 64; sq++) if (!occupied(sq) && isLight(sq) === light) xs.push(at(sq, 0));
      return quantile(xs.sort((a, b) => a - b), 0.5);
    });
    const busy = (sq) => Math.abs(at(sq, 0) - ref[isLight(sq) ? 1 : 0]) + at(sq, 1) + (at(sq, 5) - at(sq, 4)) / 2;
    const occ = [];
    const emp = [];
    for (let sq = 0; sq < 64; sq++) (occupied(sq) ? occ : emp).push(busy(sq));
    const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const sd = Math.sqrt((occ.concat(emp).reduce((s, x) => s + (x - mean(occ.concat(emp))) ** 2, 0)) / 64) || 1;
    const sep = (mean(occ) - mean(emp)) / sd;
    // Which end is White: brighter pieces relative to their squares.
    let white = 0;
    for (let sq = 0; sq < 64; sq++) {
      if (!occupied(sq)) continue;
      const d = at(sq, 0) - ref[isLight(sq) ? 1 : 0];
      white += (sq >> 3) <= 1 ? d : -d;
    }
    hyps.push({ corners, sep, white });
  }
  hyps.sort((a, b) => b.sep - a.sep || b.white - a.white);
  // The top two share an occupancy pattern; pick the one with White at the bottom.
  const pair = hyps.filter((h) => Math.abs(h.sep - hyps[0].sep) < 1e-6);
  const best = pair.sort((a, b) => b.white - a.white)[0];
  return { corners: best.corners, separation: best.sep };
}

export class BoardReader {
  constructor() {
    this.model = null; // per square colour: per occupant { mu, sd }
  }

  // Learn the six appearances from a frame whose contents are known.
  // blend < 1 mixes with what was learnt before (lighting drift).
  train(features, occ, blend = 1) {
    const { feat, valid } = normalise(features, occ, this.model);
    const model = [0, 1].map((t) => {
      const classes = OCC.map((o) => {
        const rows = [];
        for (let sq = 0; sq < 64; sq++) if (valid[sq] && (isLight(sq) ? 1 : 0) === t && occ[sq] === o) rows.push(feat.subarray(sq * NF, sq * NF + NF));
        if (!rows.length) return null;
        const mu = new Float32Array(NF);
        for (const r of rows) for (let i = 0; i < NF; i++) mu[i] += r[i] / rows.length;
        const sd = new Float32Array(NF);
        for (const r of rows) for (let i = 0; i < NF; i++) sd[i] += (r[i] - mu[i]) ** 2 / rows.length;
        for (let i = 0; i < NF; i++) sd[i] = Math.max(4, Math.sqrt(sd[i]));
        return { mu, sd, n: rows.length };
      });
      return classes;
    });
    if (this.model && blend < 1) {
      model.forEach((classes, t) => classes.forEach((c, o) => {
        const old = this.model[t][o];
        if (!c) { model[t][o] = old; return; }
        if (!old) return;
        for (let i = 0; i < NF; i++) {
          c.mu[i] = blend * c.mu[i] + (1 - blend) * old.mu[i];
          c.sd[i] = blend * c.sd[i] + (1 - blend) * old.sd[i];
        }
      }));
    }
    this.model = model;
  }

  // How well the learnt appearances separate: the smallest gap between two
  // cases on the same square colour, in standard deviations.
  separation() {
    let worst = Infinity;
    for (const classes of this.model) {
      for (let a = 0; a < 3; a++) {
        for (let b = a + 1; b < 3; b++) {
          const A = classes[a];
          const B = classes[b];
          if (!A || !B) continue;
          let d = 0;
          for (let i = 0; i < NF; i++) d += ((A.mu[i] - B.mu[i]) / Math.max(A.sd[i], B.sd[i])) ** 2;
          worst = Math.min(worst, Math.sqrt(d));
        }
      }
    }
    return worst;
  }

  // Distance of every square to each occupant (64 x 3), and the best reading.
  // occ: the position believed to be on the board, for exposure.
  read(features, occ) {
    const { feat, valid } = normalise(features, occ, this.model);
    const dist = new Float32Array(64 * 3);
    const labels = new Array(64);
    const unknown = new Uint8Array(64);
    for (let sq = 0; sq < 64; sq++) {
      const classes = this.model[isLight(sq) ? 1 : 0];
      let best = 0;
      for (let o = 0; o < 3; o++) {
        const c = classes[o];
        let d = 0;
        if (c) for (let i = 0; i < NF; i++) d += ((feat[sq * NF + i] - c.mu[i]) / c.sd[i]) ** 2;
        else d = 1e6;
        dist[sq * 3 + o] = d;
        if (dist[sq * 3 + o] < dist[sq * 3 + best]) best = o;
      }
      labels[sq] = OCC[best];
      // Nothing like any learnt case: a hand, a shadow or a glare.
      unknown[sq] = !valid[sq] || dist[sq * 3 + best] > UNKNOWN ? 1 : 0;
    }
    return { dist, labels, unknown };
  }

  // Cost of believing the board holds occ: summed excess distance over the
  // best reading, and how many squares clearly disagree.
  static cost(reading, occ) {
    let cost = 0;
    let wrong = 0;
    for (let sq = 0; sq < 64; sq++) {
      if (reading.unknown[sq]) continue;
      const o = OCC.indexOf(occ[sq]);
      let min = Infinity;
      for (let k = 0; k < 3; k++) min = Math.min(min, reading.dist[sq * 3 + k]);
      const excess = Math.min(UNKNOWN, reading.dist[sq * 3 + o] - min);
      cost += excess;
      if (excess > WRONG) wrong++;
    }
    return { cost, wrong };
  }
}

// Occupancy after a move, without needing a chess engine.
export function occupancyAfter(occ, move) {
  const out = [...occ];
  const from = IDX(move.from);
  const to = IDX(move.to);
  out[to] = out[from];
  out[from] = 'e';
  const rank = move.color === 'w' ? '1' : '8';
  if (move.flags.includes('k')) { out[IDX('f' + rank)] = move.color; out[IDX('h' + rank)] = 'e'; }
  if (move.flags.includes('q')) { out[IDX('d' + rank)] = move.color; out[IDX('a' + rank)] = 'e'; }
  if (move.flags.includes('e')) out[IDX(move.to[0] + move.from[1])] = 'e';
  return out;
}

// Rank the legal moves (and "nothing happened") against a reading.
export function rankByReading(reading, occ, moves) {
  const seen = new Map();
  for (const m of moves) {
    const key = m.from + m.to;
    if (seen.has(key) && m.promotion !== 'q') continue;
    seen.set(key, { move: m, ...BoardReader.cost(reading, occupancyAfter(occ, m)) });
  }
  const ranked = [...seen.values()].sort((a, b) => a.cost - b.cost);
  return { none: BoardReader.cost(reading, occ), ranked };
}

// Decides when a reading is a settled move.
export class MoveWatcher {
  constructor({ stableReads = 3, askAfterMs = 2500 } = {}) {
    this.stableReads = stableReads;
    this.askAfterMs = askAfterMs;
    this.reset();
  }

  reset() {
    this.lastKey = null;
    this.count = 0;
    this.unclearSince = null;
  }

  // Returns { state: 'blocked' | 'still' | 'waiting' | 'move' | 'ask', move?, candidates? }
  feed(reading, occ, moves, now) {
    const blocked = reading.unknown.reduce((s, x) => s + x, 0) >= 3;
    if (blocked) { this.reset(); return { state: 'blocked' }; }
    const { none, ranked } = rankByReading(reading, occ, moves);
    const [top, second] = ranked;
    let key = 'none';
    let clear = false;
    if (top && none.wrong >= 1 && top.cost + 2 * WRONG < none.cost) {
      key = top.move.from + top.move.to;
      // Clearly better than staying put and than the runner-up.
      clear = top.wrong <= 1 && (!second || second.cost - top.cost > 2 * WRONG);
    } else if (none.wrong <= 1) {
      this.reset();
      return { state: 'still' };
    }
    if (key === this.lastKey) this.count++;
    else { this.lastKey = key; this.count = 1; }
    if (this.count < this.stableReads) return { state: 'waiting' };
    if (clear) { this.reset(); return { state: 'move', move: top.move }; }
    this.unclearSince ??= now;
    if (now - this.unclearSince < this.askAfterMs) return { state: 'waiting' };
    this.unclearSince = null;
    this.count = 0;
    return { state: 'ask', candidates: ranked.slice(0, 4).map((c) => ({ ...c, score: -c.cost })) };
  }
}

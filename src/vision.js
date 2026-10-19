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
// Squares squashed to under this along the view (see readFeatures' aspect):
// the camera is low enough for tall pieces to hide the squares behind them.
export const LOW_CAMERA = 0.8;
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
  // How squarely the camera looks at the board: about 1 from straight above,
  // smaller the lower the camera (squares squashed along the view).
  const [cx, cy] = project(H, 4, 4);
  const [ax, ay] = project(H, 4 + ux * 0.5, 4 + uy * 0.5);
  const [bx, by] = project(H, 4 + Math.abs(uy) * 0.5, 4 + Math.abs(ux) * 0.5);
  const aspect = Math.hypot(ax - cx, ay - cy) / (Math.hypot(bx - cx, by - cy) || 1);
  return { feat, valid, far: [ux, uy], aspect };
}

// Light is rarely even across a board (a window, a lamp), and exposure
// changes from frame to frame. Both scale a square's features together, so
// measure the scale on squares that are empty (in the position we believe is
// on the board) against what they should look like, fit a smooth field across
// the board to those, and undo it square by square.
function normalise({ feat, valid, far, aspect }, occ, model, emptyRef) {
  // What an empty square should look like: its own remembered look, else the
  // learnt empty square of its colour, else (first frame) the median of this
  // frame's empty squares of that colour.
  const typeRef = [0, 1].map((t) => {
    if (model && model[t][0]) return model[t][0].mu[0];
    const xs = [];
    for (let sq = 0; sq < 64; sq++) if (occ[sq] === 'e' && valid[sq] && (isLight(sq) ? 1 : 0) === t) xs.push(feat[sq * NF]);
    return xs.length ? quantile(xs.sort((a, b) => a - b), 0.5) : null;
  });
  const pts = [];
  for (let sq = 0; sq < 64; sq++) {
    const lum = feat[sq * NF];
    if (occ[sq] !== 'e' || !valid[sq] || lum <= 1) continue;
    const ref = emptyRef && emptyRef[sq] ? emptyRef[sq][0] : typeRef[isLight(sq) ? 1 : 0];
    if (ref) pts.push({ x: (sq & 7) - 3.5, y: (sq >> 3) - 3.5, r: ref / lum });
  }
  const field = fitField(pts);
  const out = new Float32Array(feat.length);
  for (let sq = 0; sq < 64; sq++) {
    const k = field((sq & 7) - 3.5, (sq >> 3) - 3.5);
    for (let i = 0; i < NF; i++) out[sq * NF + i] = feat[sq * NF + i] * k;
  }
  return { feat: out, valid, far, aspect };
}

// Smooth scale across the board, r = a + b x + c y + d xy, fitted to the
// empty squares (with one pass dropping outliers, e.g. a hand or a shadow).
// Too few squares: one scale for the whole board.
function fitField(pts) {
  const median = pts.length ? quantile(pts.map((p) => p.r).sort((a, b) => a - b), 0.5) : 1;
  if (pts.length < 10) return () => median;
  const solve4 = (ps) => {
    const N = new Array(4).fill(0).map(() => new Array(4).fill(0));
    const b = new Array(4).fill(0);
    for (const p of ps) {
      const row = [1, p.x, p.y, p.x * p.y];
      for (let i = 0; i < 4; i++) { b[i] += row[i] * p.r; for (let j = 0; j < 4; j++) N[i][j] += row[i] * row[j]; }
    }
    for (let i = 0; i < 4; i++) N[i][i] += 1e-6;
    try { return solve(N, b); } catch { return null; }
  };
  let c = solve4(pts);
  if (!c) return () => median;
  const at = (x, y) => c[0] + c[1] * x + c[2] * y + c[3] * x * y;
  const res = pts.map((p) => Math.abs(p.r - at(p.x, p.y)));
  const tol = Math.max(0.03, 2.5 * quantile([...res].sort((a, b) => a - b), 0.5));
  const kept = pts.filter((p, i) => res[i] < tol);
  if (kept.length >= 10) c = solve4(kept) || c;
  // Keep the field sensible even where there are no empty squares to go by.
  return (x, y) => Math.max(median * 0.6, Math.min(median * 1.6, at(x, y)));
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
    // Each square's own look when empty, learnt whenever it is known to be
    // empty: wood grain, printed letters or a scuff then can't pass for a piece.
    this.emptyRef = new Array(64).fill(null);
  }

  // Learn the six appearances from a frame whose contents are known.
  // blend < 1 mixes with what was learnt before (lighting drift).
  train(features, occ, blend = 1) {
    const { feat, valid } = normalise(features, occ, this.model, this.emptyRef);
    // How every square looked in this known position, to tell later which
    // squares a move changed.
    this.lastLook = feat.slice();
    this.lastValid = valid.slice();
    for (let sq = 0; sq < 64; sq++) {
      if (occ[sq] !== 'e' || !valid[sq]) continue;
      const now = feat.slice(sq * NF, sq * NF + NF);
      const old = this.emptyRef[sq];
      if (old && blend < 1) for (let i = 0; i < NF; i++) now[i] = blend * now[i] + (1 - blend) * old[i];
      this.emptyRef[sq] = now;
    }
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
    const { feat, valid, far, aspect } = normalise(features, occ, this.model, this.emptyRef);
    const dist = new Float32Array(64 * 3);
    const labels = new Array(64);
    const unknown = new Uint8Array(64);
    const change = changeSince(feat, valid, this.lastLook, this.lastValid);
    for (let sq = 0; sq < 64; sq++) {
      const classes = this.model[isLight(sq) ? 1 : 0];
      let best = 0;
      for (let o = 0; o < 3; o++) {
        const c = classes[o];
        let d = 0;
        if (c) for (let i = 0; i < NF; i++) d += ((feat[sq * NF + i] - c.mu[i]) / c.sd[i]) ** 2;
        else d = 1e6;
        // Empty: also compare with the square's own empty look.
        const own = o === 0 && this.emptyRef[sq];
        if (own && c) {
          let e = 0;
          for (let i = 0; i < NF; i++) e += ((feat[sq * NF + i] - own[i]) / c.sd[i]) ** 2;
          d = Math.min(d, e);
        }
        dist[sq * 3 + o] = d;
        if (dist[sq * 3 + o] < dist[sq * 3 + best]) best = o;
      }
      labels[sq] = OCC[best];
      // Nothing like any learnt case: a hand, a shadow or a glare.
      unknown[sq] = !valid[sq] || dist[sq * 3 + best] > UNKNOWN ? 1 : 0;
    }
    return { dist, labels, unknown, change, far, aspect };
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

// How much each square changed since the last known position, feature by
// feature, in units of how much that feature moved this frame across all
// squares (most squares didn't change, so that is the noise). Used only to
// choose between moves the colours can't tell apart, e.g. a cream piece
// landing on one cream square or another.
function changeSince(feat, valid, last, lastValid) {
  const change = new Float32Array(64);
  if (!last) return change;
  const noise = new Float32Array(NF);
  for (let i = 0; i < NF; i++) {
    const xs = [];
    for (let sq = 0; sq < 64; sq++) if (valid[sq] && lastValid[sq]) xs.push(Math.abs(feat[sq * NF + i] - last[sq * NF + i]));
    noise[i] = Math.max(1.5, xs.length ? quantile(xs.sort((a, b) => a - b), 0.5) : 1.5);
  }
  for (let sq = 0; sq < 64; sq++) {
    if (!valid[sq] || !lastValid[sq]) continue;
    let d = 0;
    for (let i = 0; i < NF; i++) d += ((feat[sq * NF + i] - last[sq * NF + i]) / noise[i]) ** 2;
    change[sq] = Math.sqrt(d / NF);
  }
  return change;
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
    const after = occupancyAfter(occ, m);
    // How strongly the squares this move changes did change.
    let moved = 0;
    if (reading.change) for (let sq = 0; sq < 64; sq++) if (after[sq] !== occ[sq]) moved += reading.change[sq];
    seen.set(key, { move: m, moved, ...BoardReader.cost(reading, after) });
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
    // Moves the colours can't tell apart (within a margin of the best): the
    // one whose squares actually changed wins, if clearly.
    if (top && second && second.cost - top.cost <= 2 * WRONG) {
      const close = ranked.filter((c) => c.cost - top.cost <= 2 * WRONG).sort((a, b) => b.moved - a.moved);
      if (close.length > 1 && close[0].moved > 1.6 * close[1].moved && close[0].moved > 4) {
        ranked.splice(ranked.indexOf(close[0]), 1);
        ranked.unshift(close[0]);
        ranked[0].decided = true;
      }
    }
    const best = ranked[0];
    const next = ranked[1];
    // A move's squares changed strongly, far more than any other move's: that
    // counts even when the colours can't tell it from nothing happening (a
    // black piece onto a dark square, say).
    const strong = best && best.moved >= 20 && (!next || best.moved > 2 * next.moved) && best.cost <= none.cost + WRONG;
    const likely = best && ((none.wrong >= 1 && best.cost + 2 * WRONG < none.cost) || strong);
    // Squares of one move changed clearly, even if not enough to be sure:
    // don't call the board still, so it asks rather than miss the move.
    const hint = best && best.moved >= 12 && (!next || best.moved > 2 * next.moved);
    if (!likely && !hint && none.wrong <= 1) {
      this.reset();
      return { state: 'still' };
    }
    // Something changed. Is it clearly one move?
    let key = 'unclear';
    let clear = false;
    if (likely) {
      key = best.move.from + best.move.to;
      clear = best.wrong <= 1 && (best.decided || strong || !next || next.cost - best.cost > 2 * WRONG);
      // From a low camera a tall piece covers the square behind it, so two
      // moves to squares one behind the other (e5 or e6) can look alike. With
      // the camera low, always ask; otherwise only take one far ahead.
      const twin = ranked.slice(1, 4).find((c) => behindEachOther(best.move, c.move, reading.far) && c.cost - best.cost < 8 * WRONG);
      if (clear && twin && (reading.aspect < LOW_CAMERA || twin.cost - best.cost < 4 * WRONG)) clear = false;
    }
    if (key === this.lastKey) this.count++;
    else { this.lastKey = key; this.count = 1; }
    // However the candidates shuffle, don't keep the player waiting: ask.
    this.unclearSince ??= now;
    if (clear && this.count >= this.stableReads) { this.reset(); return { state: 'move', move: best.move }; }
    if (now - this.unclearSince < this.askAfterMs) return { state: 'waiting' };
    this.reset();
    return { state: 'ask', candidates: ranked.slice(0, 4).map((c) => ({ ...c, score: -c.cost })) };
  }
}

// Same piece, landing on squares one behind the other as the camera sees it.
function behindEachOther(a, b, far) {
  if (!far || a.from !== b.from) return false;
  const [ux, uy] = far;
  const df = b.to.charCodeAt(0) - a.to.charCodeAt(0);
  const dr = b.to.charCodeAt(1) - a.to.charCodeAt(1);
  // In board terms, "away from the camera" is file +ux, rank -uy.
  return Math.abs(df) === Math.abs(ux) && Math.abs(dr) === Math.abs(uy) && (df === ux && dr === -uy || df === -ux && dr === uy);
}

// ---------- following the board ----------
// Once the corners are set, the board is followed from frame to frame, so the
// phone can be held in a hand. Each frame: a coarse match of the whole board
// (unique, so it can't slip by a square) finds how far it moved, then small
// patches around the grid crossings are matched nearby and a homography is
// fitted to the ones that still match (a hand or a moved piece hides some).

export function toGray(img) {
  const { data, width, height } = img;
  const g = new Float32Array(width * height);
  for (let i = 0, k = 0; i < g.length; i++, k += 4) g[i] = 0.299 * data[k] + 0.587 * data[k + 1] + 0.114 * data[k + 2];
  return { g, width, height };
}

// Least-squares homography from n >= 4 point pairs.
export function fitHomography(src, dst, weights = null) {
  const N = new Array(8).fill(0).map(() => new Array(8).fill(0));
  const r = new Array(8).fill(0);
  const add = (row, b, w) => {
    for (let i = 0; i < 8; i++) {
      r[i] += w * row[i] * b;
      for (let j = 0; j < 8; j++) N[i][j] += w * row[i] * row[j];
    }
  };
  src.forEach(([x, y], i) => {
    const [u, v] = dst[i];
    const w = weights ? weights[i] : 1;
    add([x, y, 1, 0, 0, 0, -u * x, -u * y], u, w);
    add([0, 0, 0, x, y, 1, -v * x, -v * y], v, w);
  });
  const h = solve(N, r);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}


const mul3 = (A, B) => [
  A[0] * B[0] + A[1] * B[3] + A[2] * B[6], A[0] * B[1] + A[1] * B[4] + A[2] * B[7], A[0] * B[2] + A[1] * B[5] + A[2] * B[8],
  A[3] * B[0] + A[4] * B[3] + A[5] * B[6], A[3] * B[1] + A[4] * B[4] + A[5] * B[7], A[3] * B[2] + A[4] * B[5] + A[5] * B[8],
  A[6] * B[0] + A[7] * B[3] + A[8] * B[6], A[6] * B[1] + A[7] * B[4] + A[8] * B[7], A[6] * B[2] + A[7] * B[5] + A[8] * B[8],
];

// Image transform: scale s and turn a about (cx, cy), then shift (tx, ty).
const similarity = (s, a, cx, cy, tx, ty) => {
  const c = s * Math.cos(a);
  const n = s * Math.sin(a);
  return [c, -n, cx + tx - c * cx + n * cy, n, c, cy + ty - n * cx - c * cy, 0, 0, 1];
};

// Patches are laid out in board squares, not pixels, so they grow, shrink and
// turn with the board as the camera moves.
const PATCH = 6;
const PATCH_SPAN = 0.22; // squares either side of a crossing

export class GridTracker {
  // img: RGBA frame; corners: a8, h8, h1, a1 in its pixels.
  constructor(img, corners) {
    this.reset(img, corners);
  }

  // Start again from known corners (e.g. after finding the board again).
  reset(img, corners) {
    this.H = boardHomography(corners);
    this.locked = true;
    this.lost = 0;
    this.refresh(img);
  }

  // Take the current frame as the new reference (after a move, when locked).
  refresh(img) {
    const gray = toGray(img);
    this.sinceRefresh = 0;
    this.offsets = [];
    for (let a = 0; a < PATCH; a++) for (let b = 0; b < PATCH; b++) {
      this.offsets.push([-PATCH_SPAN + (2 * PATCH_SPAN * (a + 0.5)) / PATCH, -PATCH_SPAN + (2 * PATCH_SPAN * (b + 0.5)) / PATCH]);
    }
    // Grid crossings, including the outer edge.
    this.points = [];
    for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) {
      const pts = this.patchPoints(this.H, i, j);
      const vals = new Float32Array(this.offsets.length);
      let inside = true;
      for (let k = 0; k < vals.length && inside; k++) {
        const v = pixel(gray, pts[2 * k], pts[2 * k + 1]);
        if (v === null) inside = false; else vals[k] = v;
      }
      if (inside) this.points.push({ b: [i, j], patch: normalise1(vals) });
    }
    // Coarse template: the whole board (and a little of its surroundings) in
    // board coordinates.
    const N = 40;
    const bpts = [];
    const ref = [];
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const bx = -0.25 + (8.5 * (i + 0.5)) / N;
      const by = -0.25 + (8.5 * (j + 0.5)) / N;
      const [x, y] = project(this.H, bx, by);
      const v = pixel(gray, x, y);
      if (v === null) continue;
      bpts.push([bx, by]);
      ref.push(v);
    }
    this.coarse = { bpts, ref: Float32Array.from(ref) };
  }

  // Image positions of a crossing's patch samples under H.
  patchPoints(H, i, j) {
    const out = new Float32Array(this.offsets.length * 2);
    this.offsets.forEach(([du, dv], k) => {
      const [x, y] = project(H, i + du, j + dv);
      out[2 * k] = x;
      out[2 * k + 1] = y;
    });
    return out;
  }

  // Correlation of reference values with the frame at points shifted by
  // (dx, dy). Points outside the frame are left out; too few gives -2.
  static correlate(gray, ref, pts, dx, dy, need) {
    const { g, width, height } = gray;
    let n = 0;
    let sa = 0;
    let sb = 0;
    let saa = 0;
    let sbb = 0;
    let sab = 0;
    for (let k = 0; k < ref.length; k++) {
      const x = Math.round(pts[2 * k] + dx);
      const y = Math.round(pts[2 * k + 1] + dy);
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const a = ref[k];
      const b = g[y * width + x];
      n++;
      sa += a;
      sb += b;
      saa += a * a;
      sbb += b * b;
      sab += a * b;
    }
    if (n < ref.length * need) return -2;
    const cov = sab - (sa * sb) / n;
    const va = saa - (sa * sa) / n;
    const vb = sbb - (sb * sb) / n;
    return va > 1e-6 && vb > 1e-6 ? cov / Math.sqrt(va * vb) : -2;
  }

  // How the board moved since the last frame, as a whole: a shift first, then
  // a little bigger, smaller or turned (the camera moving back, in or round).
  // Returns { score, S } with S the image transform from the last fit.
  coarseMove(gray, wide = false) {
    const { bpts, ref } = this.coarse;
    const base = new Float32Array(bpts.length * 2);
    let cx = 0;
    let cy = 0;
    bpts.forEach(([bx, by], k) => {
      const [x, y] = project(this.H, bx, by);
      base[2 * k] = x;
      base[2 * k + 1] = y;
      cx += x / bpts.length;
      cy += y / bpts.length;
    });
    const at = (S) => {
      const pts = new Float32Array(base.length);
      for (let k = 0; k < base.length; k += 2) {
        const x = base[k];
        const y = base[k + 1];
        pts[k] = S[0] * x + S[1] * y + S[2];
        pts[k + 1] = S[3] * x + S[4] * y + S[5];
      }
      return GridTracker.correlate(gray, ref, pts, 0, 0, 0.6);
    };
    let best = { score: -Infinity, s: 1, a: 0, tx: 0, ty: 0 };
    const tryAt = (s, a, tx, ty) => {
      const score = at(similarity(s, a, cx, cy, tx, ty));
      if (score > best.score) best = { score, s, a, tx, ty };
    };
    // Shift (searched wider on a jolt, or once the board has been lost).
    const R = wide || this.lost > 2 ? 120 : 32;
    const step = wide || this.lost > 2 ? 6 : 4;
    // On a jolt the board may also have turned or changed size, so the wide
    // search tries a few of those as it shifts.
    const sizes = wide ? [0.9, 1, 1.1] : [1];
    const turns = wide ? [-0.1, 0, 0.1] : [0];
    for (const s0 of sizes) for (const a0 of turns) {
      const S = similarity(s0, a0, cx, cy, 0, 0);
      const pts = s0 === 1 && a0 === 0 ? base : base.map((v, k) => (k % 2 ? S[3] * base[k - 1] + S[4] * v + S[5] : S[0] * v + S[1] * base[k + 1] + S[2]));
      for (let ty = -R; ty <= R; ty += step) for (let tx = -R; tx <= R; tx += step) {
        const score = GridTracker.correlate(gray, ref, pts, tx, ty, 0.6);
        if (score > best.score) best = { score, s: s0, a: a0, tx, ty };
      }
    }
    // Size and turn, then the shift again, narrowing three times.
    for (let round = 0; round < 3; round++) {
      const c = best;
      const ds = [0.08, 0.04, 0.02][round];
      const da = [0.07, 0.035, 0.015][round];
      for (const s of [c.s * (1 - ds), c.s, c.s * (1 + ds)]) for (const a of [c.a - da, c.a, c.a + da]) tryAt(s, a, c.tx, c.ty);
      const d = best;
      for (let ty = -3; ty <= 3; ty++) for (let tx = -3; tx <= 3; tx++) tryAt(d.s, d.a, d.tx + tx, d.ty + ty);
    }
    return { score: best.score, S: similarity(best.s, best.a, cx, cy, best.tx, best.ty) };
  }

  // Follow the board into a new frame. Returns { H, locked, matched }.
  track(img) {
    const gray = toGray(img);
    let coarse = this.coarseMove(gray);
    // A jolt bigger than the usual window: look again, wider.
    if (coarse.score < 0.5 && this.lost <= 2) coarse = this.coarseMove(gray, true);
    if (coarse.score < 0.5) return this.miss();
    const pred = mul3(coarse.S, this.H);
    const [ax, ay] = project(pred, 0, 0);
    const [bx, by] = project(pred, 8, 8);
    const sqPx = Math.hypot(bx - ax, by - ay) / (8 * Math.SQRT2);
    const R = Math.max(3, Math.round(sqPx * 0.18));
    const src = [];
    const dst = [];
    const w = [];
    for (const p of this.points) {
      const pts = this.patchPoints(pred, p.b[0], p.b[1]);
      const m = GridTracker.peak(gray, p.patch, pts, R);
      if (m && m.score > 0.75) {
        const [x, y] = project(pred, p.b[0], p.b[1]);
        src.push(p.b);
        dst.push([x + m.dx, y + m.dy]);
        w.push(m.score);
      }
    }
    if (src.length < 10) return this.miss();
    // Fit, drop the worst matches, fit again.
    let H = fitHomography(src, dst, w);
    for (let pass = 0; pass < 2; pass++) {
      const tol = Math.max(2.5, sqPx * 0.08);
      const keep = src.map((b, i) => { const [x, y] = project(H, b[0], b[1]); return Math.hypot(x - dst[i][0], y - dst[i][1]) < tol; });
      if (keep.filter(Boolean).length < 10) break;
      H = fitHomography(src.filter((_, i) => keep[i]), dst.filter((_, i) => keep[i]), w.filter((_, i) => keep[i]));
    }
    this.H = H;
    this.locked = true;
    this.lost = 0;
    // A clean view (nearly every crossing matched, so no hand in the way):
    // take it as the new reference now and then, so slow changes don't build up.
    if (++this.sinceRefresh > 12 && src.length >= 0.85 * this.points.length) this.refresh(img);
    return { H, locked: true, matched: src.length };
  }

  miss() {
    this.lost++;
    if (this.lost > 2) this.locked = false;
    return { H: this.H, locked: this.locked, matched: 0 };
  }

  // Best shift (within R pixels) of a patch's points: every other pixel first,
  // then the neighbours of the best, then a sub-pixel peak.
  static peak(gray, ref, pts, R) {
    let best = { score: -Infinity, dx: 0, dy: 0 };
    const at = (dx, dy) => GridTracker.correlate(gray, ref, pts, dx, dy, 1);
    for (let dy = -R; dy <= R; dy += 2) for (let dx = -R; dx <= R; dx += 2) {
      const sc = at(dx, dy);
      if (sc > best.score) best = { score: sc, dx, dy };
    }
    const c = best;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const sc = at(c.dx + dx, c.dy + dy);
      if (sc > best.score) best = { score: sc, dx: c.dx + dx, dy: c.dy + dy };
    }
    if (best.score < -1) return null;
    const sub = (a, b, c2) => (a < -1 || c2 < -1 ? 0 : Math.max(-0.5, Math.min(0.5, (a - c2) / (2 * (a - 2 * b + c2) || 1))));
    const ox = sub(at(best.dx - 1, best.dy), best.score, at(best.dx + 1, best.dy));
    const oy = sub(at(best.dx, best.dy - 1), best.score, at(best.dx, best.dy + 1));
    return { score: best.score, dx: best.dx + ox, dy: best.dy + oy };
  }
}

function pixel(gray, x, y) {
  const px = Math.round(x);
  const py = Math.round(y);
  return px < 0 || py < 0 || px >= gray.width || py >= gray.height ? null : gray.g[py * gray.width + px];
}

function normalise1(v) {
  let m = 0;
  for (const x of v) m += x;
  m /= v.length;
  let s = 0;
  for (let i = 0; i < v.length; i++) { v[i] -= m; s += v[i] * v[i]; }
  s = Math.sqrt(s) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= s;
  return v;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

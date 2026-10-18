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

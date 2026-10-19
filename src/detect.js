// Finds the board in a frame without any taps, using what we know: it is a
// checkerboard, and the pieces are in their starting squares.
//
// 1. Grid crossings (where four squares meet in an X) are found with the
//    ChESS corner response (Bennett & Lasenby, 2014).
// 2. Starting from strong crossings, neighbours are joined into a lattice.
// 3. The lattice covers the empty middle of the board; every placement of
//    the full 8x8 board around it is tried, and the pieces pick the right
//    one (two full ranks at each end, White's lighter).
// 4. The grid is refined on every crossing that can be found.

import { orientCorners, boardHomography, fitHomography, project, toGray } from './vision.js';

const RING = 16;

function ringOffsets(r) {
  const out = [];
  for (let n = 0; n < RING; n++) {
    const a = (2 * Math.PI * n) / RING;
    out.push([Math.round(r * Math.cos(a)), Math.round(r * Math.sin(a))]);
  }
  return out;
}

// ChESS response at every pixel (max over two ring sizes). Positive means an X.
export function crossingResponse(gray, radii = [5, 8]) {
  const { g, width, height } = gray;
  const R = new Float32Array(width * height);
  const rings = radii.map(ringOffsets);
  const pad = Math.max(...radii) + 1;
  const I = new Float32Array(RING);
  for (let y = pad; y < height - pad; y++) {
    for (let x = pad; x < width - pad; x++) {
      const c = y * width + x;
      const local = (g[c] + g[c - 1] + g[c + 1] + g[c - width] + g[c + width]) / 5;
      let best = -Infinity;
      for (const ring of rings) {
        let mean = 0;
        for (let n = 0; n < RING; n++) { I[n] = g[c + ring[n][1] * width + ring[n][0]]; mean += I[n]; }
        mean /= RING;
        let sum = 0;
        for (let n = 0; n < 4; n++) sum += Math.abs(I[n] + I[n + 8] - I[n + 4] - I[n + 12]);
        let diff = 0;
        for (let n = 0; n < 8; n++) diff += Math.abs(I[n] - I[n + 8]);
        const v = sum - diff - 16 * Math.abs(mean - local) / 4;
        if (v > best) best = v;
      }
      R[c] = best;
    }
  }
  return R;
}

// Local maxima of the response, strongest first.
export function crossingPoints(gray, R, max = 300) {
  const { width, height } = gray;
  let top = 0;
  for (const v of R) if (v > top) top = v;
  const thr = Math.max(20, top * 0.15);
  const pts = [];
  const N = 3;
  for (let y = N; y < height - N; y++) {
    for (let x = N; x < width - N; x++) {
      const v = R[y * width + x];
      if (v < thr) continue;
      let isMax = true;
      for (let dy = -N; dy <= N && isMax; dy++) for (let dx = -N; dx <= N; dx++) {
        if ((dx || dy) && R[(y + dy) * width + x + dx] > v) { isMax = false; break; }
      }
      if (!isMax) continue;
      // Sub-pixel peak.
      const at = (dx, dy) => R[(y + dy) * width + x + dx];
      const sub = (a, b, c) => Math.max(-0.5, Math.min(0.5, (a - c) / (2 * (a - 2 * b + c) || 1)));
      pts.push({ x: x + sub(at(-1, 0), v, at(1, 0)), y: y + sub(at(0, -1), v, at(0, 1)), v });
    }
  }
  return pts.sort((a, b) => b.v - a.v).slice(0, max);
}

// Join crossings into a lattice from a seed. Returns [{ i, j, x, y }].
function growLattice(pts, seed) {
  const near = (x, y, tol, used) => {
    let best = null;
    let bd = tol;
    for (const p of pts) {
      if (used.has(p)) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  };
  // Lattice directions from the seed's nearest neighbours.
  const others = pts.filter((p) => p !== seed).map((p) => ({ p, d: Math.hypot(p.x - seed.x, p.y - seed.y) })).filter((o) => o.d > 6).sort((a, b) => a.d - b.d);
  if (others.length < 3) return [];
  const u = [others[0].p.x - seed.x, others[0].p.y - seed.y];
  const lu = Math.hypot(...u);
  const vCand = others.slice(1, 8).find((o) => {
    const w = [o.p.x - seed.x, o.p.y - seed.y];
    const cos = Math.abs(u[0] * w[0] + u[1] * w[1]) / (lu * o.d);
    return cos < 0.45 && o.d < lu * 1.8 && o.d > lu / 1.8;
  });
  if (!vCand) return [];
  const v = [vCand.p.x - seed.x, vCand.p.y - seed.y];
  const used = new Set([seed]);
  const nodes = [{ i: 0, j: 0, x: seed.x, y: seed.y, u, v }];
  const key = new Map([['0,0', nodes[0]]]);
  for (let q = 0; q < nodes.length; q++) {
    const n = nodes[q];
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = `${n.i + di},${n.j + dj}`;
      if (key.has(k)) continue;
      const step = di ? [n.u[0] * di, n.u[1] * di] : [n.v[0] * dj, n.v[1] * dj];
      const tol = 0.28 * Math.min(Math.hypot(...n.u), Math.hypot(...n.v));
      const p = near(n.x + step[0], n.y + step[1], tol, used);
      if (!p) continue;
      used.add(p);
      const moved = [(p.x - n.x) * (di || dj), (p.y - n.y) * (di || dj)];
      const m = { i: n.i + di, j: n.j + dj, x: p.x, y: p.y, u: di ? moved : n.u, v: dj ? moved : n.v };
      key.set(k, m);
      nodes.push(m);
    }
  }
  return nodes;
}

// Fit the lattice to the image, dropping misplaced points with a tightening
// tolerance so a few wrong ones can't drag the fit.
function fitLattice(nodes) {
  let keep = nodes;
  let H = null;
  for (const tol of [12, 6, 3, 3]) {
    if (keep.length < 8) return null;
    H = fitHomography(keep.map((n) => [n.i, n.j]), keep.map((n) => [n.x, n.y]));
    keep = keep.filter((n) => { const [x, y] = project(H, n.i, n.j); return Math.hypot(x - n.x, y - n.y) < tol; });
  }
  return keep.length >= 8 ? { H, nodes: keep } : null;
}

// Snap each inner crossing to the nearest response peak and refit.
function refine(H, pts) {
  const src = [];
  const dst = [];
  for (let i = 1; i <= 7; i++) for (let j = 1; j <= 7; j++) {
    const [x, y] = project(H, i, j);
    const [x2, y2] = project(H, i + 1, j);
    const tol = 0.25 * Math.hypot(x2 - x, y2 - y);
    let best = null;
    let bd = tol;
    for (const p of pts) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) { bd = d; best = p; }
    }
    if (best) { src.push([i, j]); dst.push([best.x, best.y]); }
  }
  return src.length >= 12 ? fitHomography(src, dst) : H;
}

// Find the board. img: RGBA frame. Returns { corners (a8, h8, h1, a1), separation, crossings } or null.
export function detectBoard(img) {
  const gray = toGray(img);
  const R = crossingResponse(gray);
  const pts = crossingPoints(gray, R);
  if (pts.length < 12) return null;
  // Grow from the strongest few seeds; keep the biggest consistent lattice.
  let best = null;
  for (const seed of pts.slice(0, 60)) {
    const nodes = growLattice(pts, seed);
    if (nodes.length < 12) continue;
    const fit = fitLattice(nodes);
    if (fit && (!best || fit.nodes.length > best.nodes.length)) best = fit;
    if (best && best.nodes.length >= 30) break;
  }
  if (!best) return null;
  // Real crossings are all inside the board (lines 1 to 7): if the lattice is
  // wider, its outermost row or column with fewer points is spurious.
  let nodes = best.nodes;
  const span = (key) => { const v = nodes.map((n) => n[key]); return [Math.min(...v), Math.max(...v)]; };
  for (let guard = 0; guard < 6; guard++) {
    const [i0, i1] = span('i');
    const [j0, j1] = span('j');
    if (i1 - i0 <= 6 && j1 - j0 <= 6) break;
    const key = i1 - i0 > 6 ? 'i' : 'j';
    const [lo, hi] = key === 'i' ? [i0, i1] : [j0, j1];
    const nLo = nodes.filter((n) => n[key] === lo).length;
    const nHi = nodes.filter((n) => n[key] === hi).length;
    nodes = nodes.filter((n) => n[key] !== (nLo < nHi ? lo : hi));
  }
  const refit = fitLattice(nodes);
  if (!refit) return null;
  best = refit;
  const [i0, i1] = span('i');
  const [j0, j1] = span('j');
  if (i1 - i0 > 6 || j1 - j0 > 6) return null;
  // Try every placement of the 8x8 board around the lattice; the pieces decide.
  const hyps = [];
  for (let oi = 1; oi + (i1 - i0) <= 7; oi++) {
    for (let oj = 1; oj + (j1 - j0) <= 7; oj++) {
      // board corner (bx, by) -> lattice (bx - oi + i0, by - oj + j0)
      const quad = [[0, 0], [8, 0], [8, 8], [0, 8]].map(([bx, by]) => project(best.H, bx - oi + i0, by - oj + j0));
      if (quad.some(([x, y]) => x < -4 || y < -4 || x > img.width + 4 || y > img.height + 4)) continue;
      try {
        const o = orientCorners(img, quad);
        hyps.push(o);
      } catch { /* degenerate */ }
    }
  }
  if (!hyps.length) return null;
  hyps.sort((a, b) => b.separation - a.separation);
  const top = hyps[0];
  const margin = hyps[1] ? top.separation - hyps[1].separation : top.separation;
  if (top.separation < 1.2 || margin < 0.25) return null;
  const H = refine(boardHomography(top.corners), pts);
  const corners = [[0, 0], [8, 0], [8, 8], [0, 8]].map(([x, y]) => project(H, x, y));
  return { corners, separation: top.separation, margin, crossings: best.nodes.length };
}

// Finds the board in a frame without any taps.
//
// 1. Grid crossings (where four squares meet in an X) are found with the
//    ChESS corner response (Bennett & Lasenby, 2014).
// 2. Starting from strong crossings, neighbours are joined into a lattice.
// 3. Every placement of the full 8x8 board around the lattice is tried; the
//    board's edge picks the right one (inside it the squares alternate light
//    and dark, just outside they don't), so no pieces are needed.
// 4. Which corner is a1: the pieces if they're in their starting squares,
//    otherwise the dark corner nearest the camera.
// 5. The grid is refined on every crossing that can be found.

import { orientCorners, boardHomography, fitHomography, project, toGray, readFeatures, BoardReader } from './vision.js';

const RING = 16;

function ringOffsets(r) {
  const out = [];
  for (let n = 0; n < RING; n++) {
    const a = (2 * Math.PI * n) / RING;
    out.push([Math.round(r * Math.cos(a)), Math.round(r * Math.sin(a))]);
  }
  return out;
}

// ChESS response (max over two ring sizes); positive means an X. Over the
// whole image, or with lazy, as a lookup worked out only where asked.
export function crossingResponse(gray, radii = [5, 8], lazy = false) {
  const { g, width, height } = gray;
  // Ring samples as flat offsets into the image.
  const rings = radii.map((r) => Int32Array.from(ringOffsets(r), ([dx, dy]) => dy * width + dx));
  const pad = Math.max(...radii) + 1;
  const I = new Float32Array(RING);
  const at = (c) => {
    const local = (g[c] + g[c - 1] + g[c + 1] + g[c - width] + g[c + width]) * 0.2;
    let best = -Infinity;
    for (let q = 0; q < rings.length; q++) {
      const ring = rings[q];
      let mean = 0;
      for (let n = 0; n < RING; n++) { const v = g[c + ring[n]]; I[n] = v; mean += v; }
      mean *= 1 / RING;
      const sum = Math.abs(I[0] + I[8] - I[4] - I[12]) + Math.abs(I[1] + I[9] - I[5] - I[13])
        + Math.abs(I[2] + I[10] - I[6] - I[14]) + Math.abs(I[3] + I[11] - I[7] - I[15]);
      const diff = Math.abs(I[0] - I[8]) + Math.abs(I[1] - I[9]) + Math.abs(I[2] - I[10]) + Math.abs(I[3] - I[11])
        + Math.abs(I[4] - I[12]) + Math.abs(I[5] - I[13]) + Math.abs(I[6] - I[14]) + Math.abs(I[7] - I[15]);
      const v = sum - diff - 4 * Math.abs(mean - local);
      if (v > best) best = v;
    }
    return best;
  };
  if (lazy) {
    const memo = new Map();
    return {
      get: (x, y) => {
        if (x < pad || y < pad || x >= width - pad || y >= height - pad) return -Infinity;
        const c = y * width + x;
        let v = memo.get(c);
        if (v === undefined) { v = at(c); memo.set(c, v); }
        return v;
      },
    };
  }
  const R = new Float32Array(width * height);
  for (let y = pad; y < height - pad; y++) {
    const row = y * width;
    for (let x = pad; x < width - pad; x++) R[row + x] = at(row + x);
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

// Half-size grey image (2x2 averages), for a quick first search.
function halve(gray) {
  const { g, width, height } = gray;
  const w = width >> 1;
  const h = height >> 1;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = 2 * y * width + 2 * x;
    out[y * w + x] = (g[k] + g[k + 1] + g[k + width] + g[k + width + 1]) / 4;
  }
  return { g: out, width: w, height: h };
}

// Crossings: found on the half-size image (a quarter of the work), then each
// one sharpened on the full image.
function findCrossings(gray) {
  const small = halve(gray);
  const coarse = crossingPoints(small, crossingResponse(small, [4]));
  const full = crossingResponse(gray, [5, 8], true);
  return coarse.map((p) => {
    const cx = Math.round(p.x * 2 + 0.5);
    const cy = Math.round(p.y * 2 + 0.5);
    let best = { v: -Infinity, x: cx, y: cy };
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const v = full.get(cx + dx, cy + dy);
      if (v > best.v) best = { v, x: cx + dx, y: cy + dy };
    }
    const at = (dx, dy) => full.get(best.x + dx, best.y + dy);
    const sub = (a, b, c) => (a === -Infinity || c === -Infinity ? 0 : Math.max(-0.5, Math.min(0.5, (a - c) / (2 * (a - 2 * b + c) || 1))));
    return { x: best.x + sub(at(-1, 0), best.v, at(1, 0)), y: best.y + sub(at(0, -1), best.v, at(0, 1)), v: p.v };
  });
}

// Find the board. img: RGBA frame. Returns { corners (a8, h8, h1, a1), byPieces,
// crossings } or null. info, if given, is filled in with how far it got
// ({ crossings, lattice }), for telling the user what to fix.
export function detectBoard(img, info = {}) {
  const gray = toGray(img);
  const pts = findCrossings(gray);
  info.crossings = pts.length;
  info.lattice = 0;
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
  info.lattice = best.nodes.length;
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
  // Try every placement of the 8x8 board around the lattice. The board's own
  // edge decides: inside it the squares alternate light and dark, just
  // outside they don't. This needs no pieces in any particular place.
  const lum = squareLum(gray, best.H);
  const hyps = [];
  for (let oi = 1; oi + (i1 - i0) <= 7; oi++) {
    for (let oj = 1; oj + (j1 - j0) <= 7; oj++) {
      const toLat = (bx, by) => [bx - oi + i0, by - oj + j0];
      const quad = [[0, 0], [8, 0], [8, 8], [0, 8]].map(([bx, by]) => project(best.H, ...toLat(bx, by)));
      if (quad.some(([x, y]) => x < -0.15 * img.width || y < -0.15 * img.height || x > 1.15 * img.width || y > 1.15 * img.height)) continue;
      hyps.push({ oi, oj, quad, edge: edgeScore(lum, i0 - oi, j0 - oj) });
    }
  }
  if (!hyps.length) return null;
  // The edge always counts; pieces in their starting squares count too (only
  // worth checking for the few placements the edge already likes).
  hyps.sort((a, b) => b.edge - a.edge);
  hyps.forEach((h, k) => {
    h.pieces = null;
    if (k < 4) try { h.pieces = orientCorners(img, h.quad); } catch { /* degenerate */ }
    h.sep = h.pieces ? Math.max(0, h.pieces.separation) : 0;
    h.score = h.edge + h.sep;
  });
  hyps.sort((a, b) => b.score - a.score);
  const top = hyps[0];
  const margin = hyps[1] ? top.score - hyps[1].score : top.score;
  if (top.score < 0.6 || margin < 0.3) return null;
  // Which corner is a1: from the pieces if they're set up, else a1 is the dark
  // corner nearest the camera.
  // The pieces only count if they agree with the squares (a1 is dark), so
  // shading on an empty board can't pass for pieces.
  const oriented = top.pieces;
  const colour = orientByColour(top.quad, gray);
  let corners = colour.corners;
  let byPieces = false;
  if (oriented && oriented.separation >= 1.2 && colour.parityOk(oriented.corners)) {
    corners = oriented.corners;
    byPieces = true;
  }
  const H = refine(boardHomography(corners), pts);
  return {
    corners: [[0, 0], [8, 0], [8, 8], [0, 8]].map(([x, y]) => project(H, x, y)),
    byPieces,
    score: top.score,
    margin,
    crossings: best.nodes.length,
  };
}

// Colour of each lattice cell, read near its four corners (pieces stand in the
// middle, so the corners show the square). lum.get(i, j) is the cell whose
// top-left crossing is lattice (i, j); null when out of view.
function squareLum(gray, H) {
  const { g, width, height } = gray;
  const cache = new Map();
  const at = (u, v) => {
    const [x, y] = project(H, u, v);
    const px = Math.round(x);
    const py = Math.round(y);
    return px < 0 || py < 0 || px >= width || py >= height ? null : g[py * width + px];
  };
  return {
    get(i, j) {
      const k = `${i},${j}`;
      if (cache.has(k)) return cache.get(k);
      const vals = [];
      for (const [a, b] of [[0.14, 0.14], [0.86, 0.14], [0.14, 0.86], [0.86, 0.86], [0.3, 0.14], [0.7, 0.86]]) {
        const v = at(i + a, j + b);
        if (v !== null) vals.push(v);
      }
      vals.sort((x, y) => x - y);
      const out = vals.length >= 4 ? vals[Math.floor(vals.length / 2)] : null;
      cache.set(k, out);
      return out;
    },
  };
}

// How well a placement explains the board's edge. di, dj: lattice cell of board
// square (0, 0) minus (0, 0), i.e. board file f is lattice cell f + di.
function edgeScore(lum, di, dj) {
  // Alternation along a row or column of cells: mean |difference| between neighbours.
  const alt = (cells) => {
    const v = cells.map(([i, j]) => lum.get(i, j));
    let s = 0;
    let n = 0;
    for (let k = 1; k < v.length; k++) if (v[k] !== null && v[k - 1] !== null) { s += Math.abs(v[k] - v[k - 1]); n++; }
    return n >= 4 ? s / n : null;
  };
  const line = (fixed, isRow) => Array.from({ length: 8 }, (_, k) => (isRow ? [k + di, fixed + dj] : [fixed + di, k + dj]));
  // Contrast scale: alternation across the middle of the board.
  const mid = [alt(line(3, true)), alt(line(4, true)), alt(line(3, false)), alt(line(4, false))].filter((x) => x !== null);
  const scale = mid.length ? mid.reduce((a, b) => a + b, 0) / mid.length : 0;
  if (scale < 4) return -Infinity;
  let score = 0;
  for (const [inside, outside, isRow] of [[0, -1, true], [7, 8, true], [0, -1, false], [7, 8, false]]) {
    const a = alt(line(inside, isRow));
    const b = alt(line(outside, isRow));
    if (a === null) { score -= 0.5; continue; } // the board's own edge row out of view
    score += (a - (b === null ? scale * 0.5 : b)) / scale;
  }
  return score / 4;
}

// Without pieces to go by: a1 is a dark square, and White usually sits nearest
// the camera (the bottom of the picture).
function orientByColour(quad, gray) {
  const { g, width, height } = gray;
  const c = quad.reduce((a, [x, y]) => [a[0] + x / 4, a[1] + y / 4], [0, 0]);
  const ring = [...quad].sort((p, q) => Math.atan2(p[1] - c[1], p[0] - c[0]) - Math.atan2(q[1] - c[1], q[0] - c[0]));
  // Colour of a corner square, read near its corners (clear of any piece).
  const cell = (H, f, r) => {
    const vals = [];
    for (const [a, b] of [[0.14, 0.14], [0.86, 0.14], [0.14, 0.86], [0.86, 0.86]]) {
      const [x, y] = project(H, f + a, r + b);
      const px = Math.round(x);
      const py = Math.round(y);
      if (px >= 0 && py >= 0 && px < width && py < height) vals.push(g[py * width + px]);
    }
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
  };
  const options = [0, 1, 2, 3].map((k) => {
    const corners = [0, 1, 2, 3].map((i) => ring[(i + k) % 4]); // a8, h8, h1, a1
    const H = boardHomography(corners);
    // Light squares are those with (file + row from the top) even, a8 first.
    // Compare every square with its neighbours, so uneven light can't fool it.
    const lum = [];
    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) lum.push(cell(H, f, r));
    let score = 0;
    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
      const nb = [[f - 1, r], [f + 1, r], [f, r - 1], [f, r + 1]].filter(([a, b]) => a >= 0 && b >= 0 && a < 8 && b < 8).map(([a, b]) => lum[b * 8 + a]);
      const d = lum[r * 8 + f] - nb.reduce((x, y) => x + y, 0) / nb.length;
      score += (f + r) % 2 === 0 ? d : -d;
    }
    return { corners, ok: score > 0, near: corners[2][1] + corners[3][1] };
  });
  const valid = options.filter((o) => o.ok);
  const same = (a, b) => a.every(([x, y], i) => Math.hypot(x - b[i][0], y - b[i][1]) < 1e-6);
  return {
    corners: (valid.length ? valid : options).sort((a, b) => b.near - a.near)[0].corners,
    // Does a corner order put a1 on a dark square?
    parityOk: (corners) => valid.some((o) => same(o.corners, corners) || same(o.corners, [2, 3, 0, 1].map((i) => corners[i]))),
  };
}

// Find the board again after losing it (the camera moved a lot), mid-game.
// Of the four ways round, keep the one whose reading best matches the position
// we know is on the board. reader: a trained BoardReader; occ: occupancy.
export function relocate(img, reader, occ) {
  const found = detectBoard(img);
  if (!found) return null;
  let best = null;
  for (let k = 0; k < 4; k++) {
    const corners = [0, 1, 2, 3].map((i) => found.corners[(i + k) % 4]);
    const reading = reader.read(readFeatures(img, boardHomography(corners)), occ);
    const { cost, wrong } = BoardReader.cost(reading, occ);
    if (!best || cost < best.cost) best = { corners, cost, wrong };
  }
  return best.wrong <= 4 ? best.corners : null;
}

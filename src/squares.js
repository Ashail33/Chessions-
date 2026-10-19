// Square cut-outs for the piece model: each square with a margin round it
// and, above it, the part of the picture a tall piece on it reaches into.
// Every cut-out is turned so the side of the board away from the camera is
// at the top, so the model sees every board the same way round.

import { project } from './vision.js';

export const PATCH_W = 24; // across the square
export const PATCH_H = 32; // along the view, far side at the top
// In square units: across from -0.2 to 1.2, along from 0.9 beyond the far
// edge to 0.15 short of the near one.
const ACROSS = [-0.2, 1.2];
const ALONG = [-0.9, 1.15];

// Which way is "away from the camera" on the board, as a unit step (board
// x = file, y = row from the top): the board direction that runs up the picture.
export function awayFromCamera(H) {
  const [cx, cy] = project(H, 4, 4);
  let best = [0, -1];
  let up = -Infinity;
  for (const d of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
    const [x, y] = project(H, 4 + d[0] * 0.5, 4 + d[1] * 0.5);
    const score = (cy - y) / (Math.hypot(x - cx, y - cy) || 1);
    if (score > up) { up = score; best = d; }
  }
  return best;
}

// Board point (file, row from the top) of patch position (a across, b along
// from the far edge) of a square.
function boardPoint(f, r, a, b, far) {
  const [ux, uy] = far;
  if (uy < 0) return [f + a, r + b];
  if (uy > 0) return [f + 1 - a, r + 1 - b];
  if (ux < 0) return [f + b, r + 1 - a];
  return [f + 1 - b, r + a];
}

// Cut-outs of all 64 squares as RGB bytes, 64 x PATCH_H x PATCH_W x 3, square
// index a1 = 0 (file + 8 * rank), sampled bilinearly from the frame.
export function squarePatches(img, H, far = awayFromCamera(H)) {
  const { data, width, height } = img;
  const out = new Uint8ClampedArray(64 * PATCH_H * PATCH_W * 3);
  for (let sq = 0; sq < 64; sq++) {
    const f = sq & 7;
    const r = 7 - (sq >> 3);
    for (let j = 0; j < PATCH_H; j++) {
      const b = ALONG[0] + ((ALONG[1] - ALONG[0]) * (j + 0.5)) / PATCH_H;
      for (let i = 0; i < PATCH_W; i++) {
        const a = ACROSS[0] + ((ACROSS[1] - ACROSS[0]) * (i + 0.5)) / PATCH_W;
        const [bx, by] = boardPoint(f, r, a, b, far);
        const [x, y] = project(H, bx, by);
        const o = ((sq * PATCH_H + j) * PATCH_W + i) * 3;
        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        if (x0 < 0 || y0 < 0 || x0 + 1 >= width || y0 + 1 >= height) continue;
        const fx = x - x0;
        const fy = y - y0;
        for (let c = 0; c < 3; c++) {
          const p00 = data[(y0 * width + x0) * 4 + c];
          const p10 = data[(y0 * width + x0 + 1) * 4 + c];
          const p01 = data[((y0 + 1) * width + x0) * 4 + c];
          const p11 = data[((y0 + 1) * width + x0 + 1) * 4 + c];
          out[o + c] = (p00 * (1 - fx) + p10 * fx) * (1 - fy) + (p01 * (1 - fx) + p11 * fx) * fy;
        }
      }
    }
  }
  return out;
}

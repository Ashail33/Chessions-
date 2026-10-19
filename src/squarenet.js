// A small trained model that looks at each square's cut-out (see squares.js)
// and says empty, white piece or black piece. It was trained on a few hundred
// real board photos (scripts/squarenet), so it knows what pieces look like in
// general, where the colour reading only knows what this board looked like at
// the start. The two are combined in BoardReader.read.
//
// Three 3x3 convolutions (each followed by ReLU and 2x2 max pooling), then two
// dense layers: about 14 thousand weights, run here in plain JavaScript.

import { squarePatches, PATCH_W, PATCH_H } from './squares.js';
import { SHAPES, WEIGHTS } from './squarenet-weights.js';

let net = null;

function load() {
  if (net) return net;
  const bin = atob(WEIGHTS);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const all = new Float32Array(bytes.buffer);
  let at = 0;
  net = {};
  for (const [name, shape] of Object.entries(SHAPES)) {
    const n = shape.reduce((a, b) => a * b, 1);
    net[name] = all.subarray(at, at + n);
    net[name].shape = shape;
    at += n;
  }
  return net;
}

// 3x3 convolution with zero padding, then ReLU and 2x2 max pooling.
// x: C x (H+2) x (W+2), zero border. Returns K x (H/2+2) x (W/2+2), zero
// border, ready for the next block.
function convBlock(x, C, H, W, w, bias) {
  const K = bias.length;
  const P = W + 2;
  const conv = new Float32Array(H * W);
  const h = H >> 1;
  const wd = W >> 1;
  const Q = wd + 2;
  const out = new Float32Array(K * (h + 2) * Q);
  for (let k = 0; k < K; k++) {
    conv.fill(bias[k]);
    for (let c = 0; c < C; c++) {
      const base = c * (H + 2) * P;
      const o = (k * C + c) * 9;
      const w0 = w[o], w1 = w[o + 1], w2 = w[o + 2], w3 = w[o + 3], w4 = w[o + 4];
      const w5 = w[o + 5], w6 = w[o + 6], w7 = w[o + 7], w8 = w[o + 8];
      for (let y = 0; y < H; y++) {
        let a = base + y * P;
        let b = a + P;
        let d = b + P;
        const row = y * W;
        for (let i = 0; i < W; i++, a++, b++, d++) {
          conv[row + i] += w0 * x[a] + w1 * x[a + 1] + w2 * x[a + 2] + w3 * x[b] + w4 * x[b + 1] + w5 * x[b + 2] + w6 * x[d] + w7 * x[d + 1] + w8 * x[d + 2];
        }
      }
    }
    for (let y = 0; y < h; y++) {
      for (let i = 0; i < wd; i++) {
        const j = 2 * y * W + 2 * i;
        const m = Math.max(conv[j], conv[j + 1], conv[j + W], conv[j + W + 1]);
        out[(k * (h + 2) + y + 1) * Q + i + 1] = m > 0 ? m : 0;
      }
    }
  }
  return out;
}

// Drop the zero border: K x (H+2) x (W+2) to K x H x W.
function unpad(x, K, H, W) {
  const out = new Float32Array(K * H * W);
  for (let k = 0; k < K; k++) for (let y = 0; y < H; y++) for (let i = 0; i < W; i++) out[(k * H + y) * W + i] = x[(k * (H + 2) + y + 1) * (W + 2) + i + 1];
  return out;
}

function dense(x, w, bias, relu) {
  const n = bias.length;
  const m = x.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = bias[i];
    for (let j = 0; j < m; j++) s += w[i * m + j] * x[j];
    out[i] = relu && s < 0 ? 0 : s;
  }
  return out;
}

// Log-probabilities of empty, white, black for each square (64 x 3, a1 = 0),
// from cut-outs as made by squarePatches.
export function classifyPatches(patches) {
  const n = load();
  const per = PATCH_H * PATCH_W;
  // Normalise each colour channel over the whole board, as in training: this
  // takes out exposure and white balance, and leaves pieces against squares.
  const mean = [0, 0, 0];
  const sq2 = [0, 0, 0];
  for (let i = 0; i < patches.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      const v = patches[i + c] / 255;
      mean[c] += v;
      sq2[c] += v * v;
    }
  }
  const count = patches.length / 3;
  const sd = [0, 1, 2].map((c) => {
    mean[c] /= count;
    return Math.sqrt(Math.max(0, sq2[c] / count - mean[c] * mean[c])) + 1e-3;
  });
  const out = new Float32Array(64 * 3);
  const P = PATCH_W + 2;
  const x = new Float32Array(3 * (PATCH_H + 2) * P);
  for (let sq = 0; sq < 64; sq++) {
    for (let y = 0; y < PATCH_H; y++) {
      for (let i = 0; i < PATCH_W; i++) {
        const src = (sq * per + y * PATCH_W + i) * 3;
        for (let c = 0; c < 3; c++) x[(c * (PATCH_H + 2) + y + 1) * P + i + 1] = (patches[src + c] / 255 - mean[c]) / sd[c];
      }
    }
    let h = convBlock(x, 3, PATCH_H, PATCH_W, n['c1.weight'], n['c1.bias']);
    h = convBlock(h, n['c1.bias'].length, PATCH_H / 2, PATCH_W / 2, n['c2.weight'], n['c2.bias']);
    h = convBlock(h, n['c2.bias'].length, PATCH_H / 4, PATCH_W / 4, n['c3.weight'], n['c3.bias']);
    h = dense(unpad(h, n['c3.bias'].length, PATCH_H / 8, PATCH_W / 8), n['f1.weight'], n['f1.bias'], true);
    const z = dense(h, n['f2.weight'], n['f2.bias'], false);
    const top = Math.max(z[0], z[1], z[2]);
    const lse = top + Math.log(Math.exp(z[0] - top) + Math.exp(z[1] - top) + Math.exp(z[2] - top));
    for (let k = 0; k < 3; k++) out[sq * 3 + k] = z[k] - lse;
  }
  return out;
}

export function classifySquares(img, H) {
  return classifyPatches(squarePatches(img, H));
}

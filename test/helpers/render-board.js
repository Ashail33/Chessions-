// Renders a chess position as a camera-like RGBA image: board seen in
// perspective, pieces as discs, pixel noise, and an optional hand.
import { homography, project } from '../../src/vision.js';

export const CORNERS = [[90, 40], [410, 52], [455, 372], [36, 360]]; // a8, h8, h1, a1

// realistic: no outlines, cream pieces close to the light squares, pieces
// off-centre and tall (leaning into the square behind), camera shake of
// `shake` pixels and exposure drift.
// harsh: what a real phone sees more of: a wooden border round the squares,
// taller pieces (more of the square behind hidden), uneven light, blur and
// sensor noise.
export function renderPosition(chess, { width = 480, height = 400, hand = null, seed = 1, light = 1, realistic = false, shake = 0, corners = CORNERS, clutter = false, harsh = false } = {}) {
  if (harsh) realistic = true;
  const lean = harsh ? 1.15 : 0.75;
  let s0 = seed * 7919 + 13;
  const jit = () => ((s0 = (s0 * 16807) % 2147483647) / 2147483647 - 0.5) * 2 * shake;
  const dx0 = jit();
  const dy0 = jit();
  const cs = corners.map(([x, y]) => [x + dx0, y + dy0]);
  const toBoard = homography(cs, [[0, 0], [8, 0], [8, 8], [0, 8]]);
  const data = new Uint8ClampedArray(width * height * 4);
  const grid = chess.board(); // rank 8 first
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 10;
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      let c = [70, 60, 55]; // table
      // A cluttered table: wood grain stripes and a few bright objects with corners.
      if (clutter) {
        const stripe = Math.floor((px + py * 0.3) / 9) % 2;
        c = stripe ? [92, 74, 60] : [64, 52, 44];
        if (px > 6 && px < 60 && py > 300 && py < 380) c = (Math.floor(px / 12) + Math.floor(py / 12)) % 2 ? [230, 230, 230] : [30, 30, 30];
        if (px > 420 && px < 476 && py > 10 && py < 70) c = [200, 40, 40];
      }
      const [bx, by] = project(toBoard, px, py);
      if (harsh && bx >= -0.45 && bx < 8.45 && by >= -0.45 && by < 8.45 && !(bx >= 0 && bx < 8 && by >= 0 && by < 8)) c = [120, 82, 50]; // wooden border
      if (bx >= 0 && bx < 8 && by >= 0 && by < 8) {
        const f = Math.floor(bx);
        const rFromTop = Math.floor(by);
        c = (f + rFromTop) % 2 === 0 ? [215, 205, 180] : [120, 145, 110];
        const piece = grid[rFromTop][f];
        if (realistic) {
          // Check this square's piece and the one in front of it (a tall piece leans back).
          for (const [rr, behind] of [[rFromTop, 0], [rFromTop + 1, 1], [rFromTop + 2, 2]]) {
            const pc = rr < 8 ? grid[rr][f] : null;
            if (!pc) continue;
            const h = ((rr * 8 + f) * 2654435761) % 1000 / 1000;
            const ox = (h - 0.5) * 0.24;
            const oy = (((h * 7) % 1) - 0.5) * 0.2;
            const px0 = bx - f - 0.5 - ox;
            const py0 = by - rr - 0.5 - oy;
            // base disc plus a body stretching up the image
            const inBase = Math.hypot(px0, py0) < 0.3;
            const inBody = Math.abs(px0) < 0.17 && py0 < 0 && py0 > -lean;
            if ((behind === 0 && (inBase || inBody)) || (behind > 0 && inBody)) {
              const shade = 1 - 0.18 * Math.max(0, px0 / 0.3);
              c = pc.color === 'w' ? [232 * shade, 222 * shade, 196 * shade] : [58 * shade, 50 * shade, 46 * shade];
            }
          }
        } else if (piece) {
          const dx = bx - f - 0.5;
          const dy = by - rFromTop - 0.5;
          const d = Math.hypot(dx, dy);
          if (d < 0.33) c = piece.color === 'w' ? (d > 0.27 ? [60, 60, 60] : [245, 242, 235]) : (d > 0.27 ? [200, 200, 200] : [35, 32, 30]);
        }
      }
      if (hand && px >= hand[0] && px < hand[2] && py >= hand[1] && py < hand[3]) c = [190, 150, 125];
      const k = (py * width + px) * 4;
      // Uneven light: brighter towards one corner.
      const shade = harsh ? light * (0.75 + 0.45 * (px / width) * (1 - 0.5 * py / height)) : light;
      const n = harsh ? 2.2 : 1;
      data[k] = c[0] * shade + rnd() * n;
      data[k + 1] = c[1] * shade + rnd() * n;
      data[k + 2] = c[2] * shade + rnd() * n;
      data[k + 3] = 255;
    }
  }
  if (harsh) blur(data, width, height);
  return { data, width, height };
}

// 3x3 box blur, like a slightly soft camera.
function blur(data, width, height) {
  const src = new Uint8ClampedArray(data);
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) for (let ch = 0; ch < 3; ch++) {
    let sum = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += src[((y + dy) * width + x + dx) * 4 + ch];
    data[(y * width + x) * 4 + ch] = sum / 9;
  }
}

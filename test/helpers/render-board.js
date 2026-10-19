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
// wood: each square its own grain and shade, and pieces casting shadows on
// the squares beside them (what a real wooden board under a lamp looks like).
// overhead: the camera looks straight down, so a piece is a round footprint in
// the middle of its square (a base with a smaller, lighter or darker top),
// nothing leaning over its neighbours.
export function renderPosition(chess, { width = 480, height = 400, hand = null, seed = 1, light = 1, realistic = false, shake = 0, corners = CORNERS, clutter = false, harsh = false, wood = false, overhead = false } = {}) {
  if (wood) harsh = true;
  if (harsh) realistic = true;
  // How far a piece's top reaches up the picture, in squares: its height
  // times how low the camera is. The camera's angle comes from how squashed
  // the board is (about 1 from straight above).
  const [tl, tr, br, bl] = corners;
  const across = (Math.hypot(tr[0] - tl[0], tr[1] - tl[1]) + Math.hypot(br[0] - bl[0], br[1] - bl[1])) / 2;
  const depth = (Math.hypot(bl[0] - tl[0], bl[1] - tl[1]) + Math.hypot(br[0] - tr[0], br[1] - tr[1])) / 2;
  const sinA = Math.min(1, depth / across);
  const tilt = Math.sqrt(Math.max(0, 1 - sinA * sinA)) / sinA;
  const HEIGHT = { p: 0.7, n: 0.9, b: 0.95, r: 0.8, q: 1.2, k: 1.4 };
  const leanOf = (pc) => (harsh ? HEIGHT[pc.type] * tilt + 0.1 : 0.75);
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
        if (wood) {
          // Per-square shade and grain, fixed for the square.
          const h = (((rFromTop * 8 + f) * 2654435761) >>> 0) / 4294967296;
          const tint = 0.9 + 0.2 * h;
          const ang = h * 6.28;
          const u = (bx - f) * Math.cos(ang) + (by - rFromTop) * Math.sin(ang);
          const grain = 1 + 0.07 * Math.sin(u * 40 + h * 20) + 0.04 * Math.sin(u * 97);
          c = c.map((v) => v * tint * grain);
          // Shadow from a piece on the square to the left (light from the right).
          const left = f > 0 ? grid[rFromTop][f - 1] : null;
          if (left && Math.hypot(bx - f - 0.1, by - rFromTop - 0.5) < 0.38) c = c.map((v) => v * 0.72);
        }
        const piece = grid[rFromTop][f];
        if (overhead) {
          const pc = grid[rFromTop][f];
          if (pc) {
            const h = ((rFromTop * 8 + f) * 2654435761) % 1000 / 1000;
            const d = Math.hypot(bx - f - 0.5 - (h - 0.5) * 0.16, by - rFromTop - 0.5 - (((h * 7) % 1) - 0.5) * 0.16);
            if (d < 0.36) {
              const top = d < 0.18;
              c = pc.color === 'w' ? (top ? [240, 232, 210] : [222, 212, 186]) : (top ? [70, 62, 58] : [48, 42, 38]);
            }
          }
        } else if (realistic) {
          // Check this square's piece and the one in front of it (a tall piece leans back).
          for (const [rr, behind] of [[rFromTop, 0], [rFromTop + 1, 1], [rFromTop + 2, 2], [rFromTop + 3, 3]]) {
            const pc = rr < 8 ? grid[rr][f] : null;
            if (!pc) continue;
            const h = ((rr * 8 + f) * 2654435761) % 1000 / 1000;
            const ox = (h - 0.5) * 0.24;
            const oy = (((h * 7) % 1) - 0.5) * 0.2;
            const px0 = bx - f - 0.5 - ox;
            const py0 = by - rr - 0.5 - oy;
            // base disc plus a body stretching up the image
            const inBase = Math.hypot(px0, py0) < 0.3;
            const inBody = Math.abs(px0) < 0.17 && py0 < 0 && py0 > -leanOf(pc);
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

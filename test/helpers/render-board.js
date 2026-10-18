// Renders a chess position as a camera-like RGBA image: board seen in
// perspective, pieces as discs, pixel noise, and an optional hand.
import { homography, project } from '../../src/vision.js';

export const CORNERS = [[90, 40], [410, 52], [455, 372], [36, 360]]; // a8, h8, h1, a1

export function renderPosition(chess, { width = 480, height = 400, hand = null, seed = 1, light = 1 } = {}) {
  const toBoard = homography(CORNERS, [[0, 0], [8, 0], [8, 8], [0, 8]]);
  const data = new Uint8ClampedArray(width * height * 4);
  const grid = chess.board(); // rank 8 first
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 10;
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      let c = [70, 60, 55]; // table
      const [bx, by] = project(toBoard, px, py);
      if (bx >= 0 && bx < 8 && by >= 0 && by < 8) {
        const f = Math.floor(bx);
        const rFromTop = Math.floor(by);
        c = (f + rFromTop) % 2 === 0 ? [215, 205, 180] : [120, 145, 110];
        const piece = grid[rFromTop][f];
        if (piece) {
          const dx = bx - f - 0.5;
          const dy = by - rFromTop - 0.5;
          const d = Math.hypot(dx, dy);
          if (d < 0.33) c = piece.color === 'w' ? (d > 0.27 ? [60, 60, 60] : [245, 242, 235]) : (d > 0.27 ? [200, 200, 200] : [35, 32, 30]);
        }
      }
      if (hand && px >= hand[0] && px < hand[2] && py >= hand[1] && py < hand[3]) c = [190, 150, 125];
      const k = (py * width + px) * 4;
      data[k] = c[0] * light + rnd();
      data[k + 1] = c[1] * light + rnd();
      data[k + 2] = c[2] * light + rnd();
      data[k + 3] = 255;
    }
  }
  return { data, width, height };
}

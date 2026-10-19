import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../vendor/chess.js';
import { detectBoard } from '../src/detect.js';
import { renderPosition, CORNERS } from './helpers/render-board.js';

const err = (a, b) => Math.max(...a.map(([x, y], i) => Math.hypot(x - b[i][0], y - b[i][1])));
const turn = (cs, ang, tx = 0, ty = 0, s = 1) => {
  const cx = 245;
  const cy = 206;
  return cs.map(([x, y]) => { const dx = (x - cx) * s; const dy = (y - cy) * s; return [cx + tx + dx * Math.cos(ang) - dy * Math.sin(ang), cy + ty + dx * Math.sin(ang) + dy * Math.cos(ang)]; });
};

test('finds the board in the starting position without taps', () => {
  const cases = [
    ['as rendered', CORNERS],
    ['turned and moved', turn(CORNERS, 0.12, -10, 6, 0.9)],
    ['smaller, turned the other way', turn(CORNERS, -0.2, 8, -4, 0.8)],
    ['from Black’s side', [CORNERS[2], CORNERS[3], CORNERS[0], CORNERS[1]]],
    ['steep angle', [[150, 70], [330, 70], [455, 385], [25, 385]]],
    ['cluttered table', CORNERS, { clutter: true }],
    ['cluttered, turned, dim', turn(CORNERS, 0.15, 0, 0, 0.85), { clutter: true, light: 0.75 }],
  ];
  for (const [name, corners, extra = {}] of cases) {
    const img = renderPosition(new Chess(), { realistic: true, corners, seed: 3, ...extra });
    const t0 = performance.now();
    const found = detectBoard(img);
    const ms = performance.now() - t0;
    assert.ok(found, `${name}: not found`);
    const e = err(found.corners, corners);
    assert.ok(e < 3, `${name}: corner error ${e.toFixed(2)}px`);
    console.log(`${name}: error ${e.toFixed(2)}px, ${found.crossings} crossings, ${ms.toFixed(0)}ms`);
  }
});

test('finds nothing when there is no board', () => {
  const img = renderPosition(new Chess(), { realistic: true, corners: [[-900, -900], [-800, -900], [-800, -800], [-900, -800]] });
  assert.equal(detectBoard(img), null);
});

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

// Random phone views: any side, low angles, a wooden border, uneven light, blur.
function views(n, seed0) {
  let seed = seed0;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: n }, () => {
    const size = 220 + rnd() * 200;
    const tilt = 0.25 + rnd() * 0.55;
    const cx = 320 + (rnd() - 0.5) * 120;
    const cy = 240 + (rnd() - 0.5) * 60;
    const ang = (rnd() - 0.5) * 0.7;
    const far = size * (1 - tilt * 0.6);
    const h = size * (1 - tilt * 0.45);
    const q = [[-far / 2, -h / 2], [far / 2, -h / 2], [size / 2, h / 2], [-size / 2, h / 2]].map(([x, y]) => [cx + x * Math.cos(ang) - y * Math.sin(ang), cy + x * Math.sin(ang) + y * Math.cos(ang)]);
    const rot = Math.floor(rnd() * 4);
    return { corners: [0, 1, 2, 3].map((i) => q[(i + rot) % 4]), clutter: rnd() > 0.5, light: 0.6 + rnd() * 0.5 };
  });
}
const empty = { board: () => Array.from({ length: 8 }, () => new Array(8).fill(null)) };
const midgame = new Chess('r1bq1rk1/pp2bppp/2n1pn2/3p4/2PP4/2N1PN2/PP3PPP/R2QKB1R w KQ - 0 9');

for (const [name, pos, exact] of [['set up', null, true], ['empty', empty, false], ['mid-game', midgame, false]]) {
  test(`finds the board from a phone, ${name}`, () => {
    let hits = 0;
    const list = views(12, name.length * 31 + 5);
    list.forEach((v, k) => {
      const img = renderPosition(pos || new Chess(), { width: 640, height: 480, corners: v.corners, harsh: true, clutter: v.clutter, light: v.light, seed: k + 1 });
      const r = detectBoard(img);
      if (!r) return;
      const errAt = (rot) => Math.max(...r.corners.map(([x, y], i) => Math.hypot(x - v.corners[(i + rot) % 4][0], y - v.corners[(i + rot) % 4][1])));
      // Never the wrong place. With pieces set up, also the right way round;
      // otherwise at most half a turn out (White's side can't be told).
      const e = exact ? errAt(0) : Math.min(errAt(0), errAt(2));
      assert.ok(e < 5, `view ${k}: ${e.toFixed(0)}px`);
      hits++;
    });
    assert.ok(hits >= 11, `found ${hits} of ${list.length}`);
  });
}

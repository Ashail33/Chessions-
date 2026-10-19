import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { Chess } from '../vendor/chess.js';
import { classifyPatches } from '../src/squarenet.js';
import { boardHomography, readFeatures, BoardReader, occupancy } from '../src/vision.js';
import { renderPosition, CORNERS } from './helpers/render-board.js';
import { standIn } from './helpers/stand-in.js';

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url);

test('the square model reads real photos it never saw in training', () => {
  const { PATCH_W, PATCH_H, labels } = JSON.parse(readFileSync(fixture('real-squares.json'), 'utf8'));
  const all = gunzipSync(readFileSync(fixture('real-squares.bin.gz')));
  const size = 64 * PATCH_H * PATCH_W * 3;
  let right = 0;
  let n = 0;
  labels.forEach((label, b) => {
    const lp = classifyPatches(all.subarray(b * size, (b + 1) * size));
    label.forEach((y, sq) => {
      if (y < 0) return;
      const row = [0, 1, 2].map((k) => lp[sq * 3 + k]);
      n++;
      if (row.indexOf(Math.max(...row)) === y) right++;
    });
  });
  assert.ok(right / n >= 0.98, `${right} of ${n} squares right`);
});

test('the model is trusted only as far as it reads the known position right', () => {
  const chess = new Chess();
  const H = boardHomography(CORNERS);
  const f = readFeatures(renderPosition(chess, { realistic: true }), H);
  const reader = new BoardReader();
  reader.train({ ...f, net: standIn(occupancy(chess), 0) }, occupancy(chess));
  assert.equal(reader.netTrust, 1);
  reader.train({ ...f, net: standIn(occupancy(chess), 0.3) }, occupancy(chess));
  assert.equal(reader.netTrust, 0);
});

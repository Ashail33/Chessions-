import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../vendor/chess.js';
import { boardHomography, readFeatures, BoardReader, MoveWatcher, occupancy, squareIndex } from '../src/vision.js';
import { renderPosition, CORNERS } from './helpers/render-board.js';

const H = boardHomography(CORNERS);

test('a move changes its own two squares, and little else', () => {
  const chess = new Chess();
  for (const san of ['e4', 'e5', 'Nf3']) chess.move(san);
  const reader = new BoardReader();
  reader.train(readFeatures(renderPosition(chess, { wood: true, seed: 2 }), H), occupancy(chess));
  const occ = occupancy(chess);
  chess.move('Nc6');
  const r = reader.read(readFeatures(renderPosition(chess, { wood: true, seed: 3, shake: 1 }), H), occ);
  const from = squareIndex('b8');
  const to = squareIndex('c6');
  assert.ok(r.pct[from] > 0.35 && r.pct[to] > 0.35, `b8 ${r.pct[from]}, c6 ${r.pct[to]}`);
  // A dark piece left b8 and arrived on c6: the square got brighter and darker.
  assert.ok(r.shift[from] > 0 && r.shift[to] < 0, `b8 ${r.shift[from]}, c6 ${r.shift[to]}`);
  // Away from the move (not next to b8 or c6) nothing much changed.
  const near = (sq, c) => Math.abs((sq & 7) - (c & 7)) <= 1 && Math.abs((sq >> 3) - (c >> 3)) <= 1;
  for (let sq = 0; sq < 64; sq++) if (!near(sq, from) && !near(sq, to)) assert.ok(r.pct[sq] < 0.25, `square ${sq}: ${r.pct[sq]}`);
});

test('a shadow on a still board is light, not a move', () => {
  const chess = new Chess();
  chess.move('e4');
  const reader = new BoardReader();
  reader.train(readFeatures(renderPosition(chess, { realistic: true, seed: 3 }), H), occupancy(chess));
  const watcher = new MoveWatcher();
  let relit = 0;
  for (let i = 0; i < 10; i++) {
    const img = renderPosition(chess, { realistic: true, seed: 4 + i, shake: 1 });
    // A soft shadow over the left of the picture: someone leaning in.
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const f = 1 - 0.15 * Math.min(1, Math.max(0, (200 - x) / 60));
        const o = (y * img.width + x) * 4;
        for (let c = 0; c < 3; c++) img.data[o + c] *= f;
      }
    }
    const r = watcher.feed(reader.read(readFeatures(img, H), occupancy(chess)), occupancy(chess), chess.moves({ verbose: true }), i * 160);
    assert.notEqual(r.state, 'move');
    assert.notEqual(r.state, 'ask');
    if (r.relight) relit++;
  }
  assert.ok(relit >= 5, `${relit} frames read as a change of light`);
});

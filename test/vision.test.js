import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../vendor/chess.js';
import { homography, project, boardHomography, sampleSquares, squareDiffs, rankCandidates, Tracker, changedSquares } from '../src/vision.js';
import { renderPosition, CORNERS } from './helpers/render-board.js';

test('homography maps the four corners exactly', () => {
  const H = boardHomography(CORNERS);
  const back = [[0, 0], [8, 0], [8, 8], [0, 8]].map(([x, y]) => project(H, x, y));
  back.forEach(([x, y], i) => {
    assert.ok(Math.abs(x - CORNERS[i][0]) < 1e-6 && Math.abs(y - CORNERS[i][1]) < 1e-6);
  });
  assert.throws(() => homography([[0, 0], [0, 0], [0, 0], [0, 0]], CORNERS));
});

test('changed squares for special moves', () => {
  const c = new Chess('r3k2r/8/8/3pP3/8/8/8/R3K2R w KQkq d6 0 1');
  const find = (san) => c.moves({ verbose: true }).find((m) => m.san === san);
  assert.equal(changedSquares(find('O-O')).length, 4);
  assert.equal(changedSquares(find('O-O-O')).length, 4);
  assert.equal(changedSquares(find('exd6')).length, 3);
});

// Simulate a game in front of the camera: still frames, a hand, the new position.
async function playThrough(sans, opts = {}) {
  const H = boardHomography(CORNERS);
  const chess = new Chess();
  const tracker = new Tracker({ settleMs: 500 });
  let t = 0;
  let seed = 1;
  const frame = (o = {}) => sampleSquares(renderPosition(chess, { seed: seed++, ...opts, ...o }), H);
  for (let i = 0; i < 4; i++) tracker.feed(frame(), (t += 200));
  const detected = [];
  for (const san of sans) {
    tracker.feed(frame({ hand: [150, 120, 330, 300] }), (t += 200));
    tracker.feed(frame({ hand: [160, 100, 340, 280] }), (t += 200));
    chess.move(san);
    let event = null;
    for (let i = 0; i < 6 && !event; i++) {
      const sig = frame();
      const r = tracker.feed(sig, (t += 200));
      if (r.state === 'changed') {
        chess.undo();
        const best = rankCandidates(chess.moves({ verbose: true }), r.diffs, tracker.noise)[0];
        chess.move(san);
        event = best.move.san;
        tracker.accept(sig);
      }
    }
    detected.push(event);
  }
  return detected;
}

test('detects a game played in front of the camera', async () => {
  const line = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O', 'Nf6', 'd3', 'O-O', 'Bxf7+', 'Rxf7'];
  assert.deepEqual(await playThrough(line), line);
});

test('detects en passant and handles dimmer light', async () => {
  const line = ['e4', 'a6', 'e5', 'd5', 'exd6'];
  assert.deepEqual(await playThrough(line, { light: 0.8 }), line);
});

test('a still board reports no change', () => {
  const H = boardHomography(CORNERS);
  const c = new Chess();
  const a = sampleSquares(renderPosition(c, { seed: 1 }), H);
  const b = sampleSquares(renderPosition(c, { seed: 2 }), H);
  assert.ok(Math.max(...squareDiffs(a, b)) < 10);
});

test('a hand resting over the board matches no legal move', () => {
  const H = boardHomography(CORNERS);
  const c = new Chess();
  c.move('e4');
  const base = sampleSquares(renderPosition(c, { seed: 3 }), H);
  const hand = sampleSquares(renderPosition(c, { seed: 4, hand: [160, 120, 330, 300] }), H);
  const top = rankCandidates(c.moves({ verbose: true }), squareDiffs(base, hand))[0];
  assert.ok(top.score <= 0, `top ${top.move.san} ${top.score}`);
});

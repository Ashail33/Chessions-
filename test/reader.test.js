import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../vendor/chess.js';
import { boardHomography, readFeatures, orientCorners, BoardReader, MoveWatcher, occupancy } from '../src/vision.js';
import { renderPosition, CORNERS } from './helpers/render-board.js';

const H = boardHomography(CORNERS);

test('works out which corner is which from the starting position', () => {
  const img = renderPosition(new Chess(), { realistic: true });
  const near = (a, b) => a.every(([x, y], i) => Math.hypot(x - b[i][0], y - b[i][1]) < 1e-6);
  for (const order of [[0, 1, 2, 3], [2, 0, 3, 1], [3, 2, 1, 0], [1, 3, 0, 2]]) {
    const { corners } = orientCorners(img, order.map((i) => CORNERS[i]));
    assert.ok(near(corners, CORNERS), `taps ${order}`);
  }
  // Seen from Black's side, the corners rotate with the board.
  const flipped = [CORNERS[2], CORNERS[3], CORNERS[0], CORNERS[1]];
  const img2 = renderPosition(new Chess(), { realistic: true, corners: flipped });
  assert.ok(near(orientCorners(img2, CORNERS).corners, flipped));
});

test('reads every square of the starting position', () => {
  const chess = new Chess();
  const reader = new BoardReader();
  reader.train(readFeatures(renderPosition(chess, { realistic: true, seed: 1 }), H), occupancy(chess));
  assert.ok(reader.separation() > 2, `separation ${reader.separation()}`);
  const r = reader.read(readFeatures(renderPosition(chess, { realistic: true, seed: 2, shake: 2, light: 0.9 }), H), occupancy(chess));
  assert.deepEqual(r.labels, occupancy(chess));
});

// A game in front of a slightly shaky camera with drifting exposure.
function playThrough(sans, opts = {}) {
  const chess = new Chess();
  const reader = new BoardReader();
  const watcher = new MoveWatcher({ stableReads: 3 });
  let seed = 1;
  let t = 0;
  const frame = (o = {}) => {
    seed++;
    const light = 1 + 0.12 * Math.sin(seed * 1.7);
    return readFeatures(renderPosition(chess, { realistic: true, shake: 2, light, seed, ...opts, ...o }), H);
  };
  reader.train(frame(), occupancy(chess));
  const detected = [];
  for (const san of sans) {
    const before = new Chess(chess.fen());
    for (const hand of [[150, 120, 330, 300], [160, 100, 340, 280]]) {
      const r = watcher.feed(reader.read(frame({ hand }), occupancy(before)), occupancy(before), before.moves({ verbose: true }), (t += 160));
      assert.notEqual(r.state, 'move', 'a hand is not a move');
    }
    chess.move(san);
    let got = null;
    for (let i = 0; i < 8 && !got; i++) {
      const f = frame();
      const r = watcher.feed(reader.read(f, occupancy(before)), occupancy(before), before.moves({ verbose: true }), (t += 160));
      if (r.state === 'move') {
        got = before.move(r.move).san;
        reader.train(f, occupancy(chess), 0.5);
      }
    }
    detected.push(got);
  }
  return detected;
}

test('records a game with camera shake and changing light', () => {
  const line = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O', 'Nf6', 'd3', 'O-O', 'Bxf7+', 'Rxf7', 'Ng5', 'd5', 'exd5', 'Nxd5'];
  assert.deepEqual(playThrough(line), line);
});

test('records en passant and captures in dim light', () => {
  const line = ['e4', 'a6', 'e5', 'd5', 'exd6', 'cxd6', 'Qh5', 'g6', 'Qxg6'];
  assert.deepEqual(playThrough(line, { light: 0.7 }), line);
});

test('a still board is not a move', () => {
  const chess = new Chess();
  chess.move('e4');
  const reader = new BoardReader();
  reader.train(readFeatures(renderPosition(chess, { realistic: true, seed: 5 }), H), occupancy(chess));
  const watcher = new MoveWatcher();
  for (let i = 0; i < 6; i++) {
    const r = watcher.feed(reader.read(readFeatures(renderPosition(chess, { realistic: true, seed: 6 + i, shake: 2 }), H), occupancy(chess)), occupancy(chess), chess.moves({ verbose: true }), i * 160);
    assert.equal(r.state, 'still');
  }
});

test('empty squares stay empty on a wooden board in uneven light', () => {
  // Grain and a shade of its own on every square, shadows beside pieces,
  // light brighter towards one side, blur and noise.
  const chess = new Chess();
  let seed = 1;
  const frame = () => readFeatures(renderPosition(chess, { wood: true, seed: ++seed, light: 0.95 + 0.1 * Math.sin(seed), shake: 1 }), H);
  const reader = new BoardReader();
  reader.train(frame(), occupancy(chess));
  let falsePieces = 0;
  let empties = 0;
  for (const san of ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O', 'Nf6', 'd3', 'd6', 'Bg5', 'h6', 'Bxf6', 'Qxf6']) {
    chess.move(san);
    const occ = occupancy(chess);
    let f;
    for (let i = 0; i < 4; i++) {
      f = frame();
      const r = reader.read(f, occ);
      r.labels.forEach((l, k) => { if (occ[k] === 'e') { empties++; if (l !== 'e') falsePieces++; } });
    }
    reader.train(f, occ, 0.5);
  }
  // Before the light field and each square's own empty look: about 3%.
  assert.ok(falsePieces / empties < 0.012, `${(100 * falsePieces / empties).toFixed(1)}% of empty squares read as pieces`);
});

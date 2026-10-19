import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../vendor/chess.js';
import { GridTracker, project, readFeatures, BoardReader, MoveWatcher, occupancy } from '../src/vision.js';
import { renderPosition, CORNERS } from './helpers/render-board.js';

// A hand-held phone: the board drifts, turns and changes size a little.
function cornersAt(t) {
  const cx = 245;
  const cy = 206;
  const a = 0.06 * Math.sin(t * 0.7);
  const s = 1 + 0.04 * Math.sin(t * 0.45);
  const tx = 24 * Math.sin(t * 0.5);
  const ty = 16 * Math.cos(t * 0.6);
  return CORNERS.map(([x, y]) => {
    const dx = (x - cx) * s;
    const dy = (y - cy) * s;
    return [cx + tx + dx * Math.cos(a) - dy * Math.sin(a), cy + ty + dx * Math.sin(a) + dy * Math.cos(a)];
  });
}

const cornerError = (H, truth) => Math.max(...[[0, 0], [8, 0], [8, 8], [0, 8]].map(([i, j], k) => { const [x, y] = project(H, i, j); return Math.hypot(x - truth[k][0], y - truth[k][1]); }));

test('follows the board as the phone moves', () => {
  const chess = new Chess();
  const tracker = new GridTracker(renderPosition(chess, { realistic: true, corners: cornersAt(0) }), cornersAt(0));
  let worst = 0;
  for (let f = 1; f <= 40; f++) {
    const t = f * 0.35;
    const r = tracker.track(renderPosition(chess, { realistic: true, seed: f, corners: cornersAt(t), light: 1 + 0.08 * Math.sin(f) }));
    assert.ok(r.locked, `frame ${f}`);
    worst = Math.max(worst, cornerError(r.H, cornersAt(t)));
  }
  assert.ok(worst < 1.5, `worst corner error ${worst.toFixed(2)}px`);
});

test('a hand over the board does not knock the grid off', () => {
  const chess = new Chess();
  const tracker = new GridTracker(renderPosition(chess, { realistic: true, corners: cornersAt(0) }), cornersAt(0));
  for (let f = 1; f <= 12; f++) {
    const t = f * 0.3;
    const r = tracker.track(renderPosition(chess, { realistic: true, seed: f, corners: cornersAt(t), hand: f % 3 ? [150, 120, 330, 300] : null }));
    assert.ok(cornerError(r.H, cornersAt(t)) < 2.5, `frame ${f}: ${cornerError(r.H, cornersAt(t)).toFixed(2)}px`);
  }
});

test('records a game with the phone in hand', () => {
  const line = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'O-O', 'Bc5'];
  const chess = new Chess();
  let f = 0;
  let t = 0;
  const img = (o = {}) => renderPosition(chess, { realistic: true, seed: ++f, corners: cornersAt((t += 0.3)), ...o });
  const first = img();
  const tracker = new GridTracker(first, cornersAt(t));
  const reader = new BoardReader();
  reader.train(readFeatures(first, tracker.H), occupancy(chess));
  const watcher = new MoveWatcher();
  const got = [];
  for (const san of line) {
    const before = new Chess(chess.fen());
    for (let i = 0; i < 2; i++) {
      const frame = img({ hand: [150, 120, 330, 300] });
      const r = tracker.track(frame);
      watcher.feed(reader.read(readFeatures(frame, r.H), occupancy(before)), occupancy(before), before.moves({ verbose: true }), f * 160);
    }
    chess.move(san);
    let seen = null;
    for (let i = 0; i < 10 && !seen; i++) {
      const frame = img();
      const r = tracker.track(frame);
      const feats = readFeatures(frame, r.H);
      const w = watcher.feed(reader.read(feats, occupancy(before)), occupancy(before), before.moves({ verbose: true }), f * 160);
      if (w.state === 'move') {
        seen = before.move(w.move).san;
        reader.train(feats, occupancy(chess), 0.5);
        tracker.refresh(frame);
      }
    }
    got.push(seen);
  }
  assert.deepEqual(got, line);
});

test('stays locked when part of the board slides out of view', () => {
  const chess = new Chess();
  const tracker = new GridTracker(renderPosition(chess, { realistic: true }), CORNERS);
  for (let f = 1; f <= 12; f++) {
    const shifted = CORNERS.map(([x, y]) => [x - 6 * f, y]); // a8 ends 32px off the left edge
    const r = tracker.track(renderPosition(chess, { realistic: true, seed: f, corners: shifted }));
    assert.ok(r.locked, `frame ${f}`);
    assert.ok(cornerError(r.H, shifted) < 2, `frame ${f}: ${cornerError(r.H, shifted).toFixed(2)}px`);
  }
});

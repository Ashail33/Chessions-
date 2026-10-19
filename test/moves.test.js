import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../vendor/chess.js';
import { boardHomography, readFeatures, BoardReader, MoveWatcher, occupancy } from '../src/vision.js';
import { renderPosition, CORNERS } from './helpers/render-board.js';
import { standIn } from './helpers/stand-in.js';

// A 16-move game in front of the camera, a hand over the board before each
// move. A move is recorded by itself, asked about (with the right one among
// the choices), or wrong: recorded as something else, or missed altogether.
const TOP = [[100, 40], [420, 40], [420, 360], [100, 360]]; // straight down
const STEEP = [[70, 30], [410, 30], [440, 380], [40, 380]];
const LOW = [[150, 150], [330, 150], [455, 385], [25, 385]];
// Each setup: [name, renderer options, corners, most moves it may ask about,
// most it may get wrong, share of squares a stand-in for the trained square
// model reads wrong (none: colours only)]
for (const [name, opts, corners, maxAsked, maxWrong, netWrong] of [
  ['from overhead, wooden board', { overhead: true, wood: true }, TOP, 2, 0],
  ['at a normal angle, wooden board', { wood: true }, CORNERS, 2, 0],
  ['from low down, wooden board', { wood: true }, LOW, 3, 1],
  ['at a normal angle, plain board', { realistic: true, shake: 1 }, CORNERS, 1, 0],
  // The model reads real photos about 99% right; at 97% it already sorts out
  // the low view above.
  ['from low down, wooden board, with the square model', { wood: true }, LOW, 0, 0, 0.03],
]) {
 test(`records moves ${name}`, () => {
  const H = boardHomography(corners);
  const chess = new Chess(); let seed = 1;
  const frame = (o = {}) => {
    const f = readFeatures(renderPosition(chess, { ...opts, corners, seed: ++seed, light: 0.95 + 0.1 * Math.sin(seed), shake: 1, ...o }), H);
    if (netWrong !== undefined) f.net = standIn(occupancy(chess), netWrong, seed);
    return f;
  };
  const reader = new BoardReader(); reader.train(frame(), occupancy(chess));
  const watcher = new MoveWatcher();
  const line = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O', 'Nf6', 'd3', 'd6', 'Bg5', 'h6', 'Bxf6', 'Qxf6', 'Nc3', 'Bg4'];
  const got = []; let t = 0;
  for (const san of line) {
    const before = new Chess(chess.fen());
    for (let i = 0; i < 2; i++) watcher.feed(reader.read(frame({ hand: [150, 120, 330, 300] }), occupancy(before)), occupancy(before), before.moves({ verbose: true }), (t += 160));
    chess.move(san);
    let seen = null;
    let asked = null;
    for (let i = 0; i < 30 && !seen && !asked; i++) {
      const f = frame();
      const w = watcher.feed(reader.read(f, occupancy(before)), occupancy(before), before.moves({ verbose: true }), (t += 160));
      if (w.state === 'move') { seen = before.move(w.move).san; reader.train(f, occupancy(chess), 0.5); }
      if (w.state === 'ask') asked = w.candidates.map((c) => c.move.san);
    }
    // Keep going from the truth after a miss, to judge each move on its own.
    if (seen !== san) { reader.train(frame(), occupancy(chess), 0.5); watcher.reset(); }
    got.push(seen === san ? 'auto' : asked && asked.includes(san) ? `ask(${asked.join('/')})` : `WRONG(${seen || (asked ? 'asked ' + asked.join('/') : '-')} for ${san})`);
  }
  const asked = got.filter((g) => g.startsWith('ask')).length;
  const wrong = got.filter((g) => g.startsWith('WRONG')).length;
  assert.ok(wrong <= maxWrong && asked <= maxAsked, `${got.filter((g) => g !== 'auto').join(' ')}`);
 });
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../vendor/chess.js';
import { analyzePosition, rankMoves, exchangeLoss, labelForGap } from '../src/analysis.js';
import { analyzeGame, gameReport, habitPatterns } from '../src/insights.js';
import { splitPgn } from '../src/import.js';
import { SAMPLES } from '../src/samples.js';

test('starting position is symmetric', () => {
  const a = analyzePosition(new Chess());
  assert.equal(a.dominance, 0);
  assert.equal(a.w.controlled, a.b.controlled);
  assert.equal(a.w.safeMobility, 4); // the knights' four squares
});

test('exchange evaluation', () => {
  assert.equal(exchangeLoss(3, [1], []), 3); // undefended knight attacked by pawn
  assert.equal(exchangeLoss(3, [1], [1]), 2); // defended knight attacked by pawn
  assert.equal(exchangeLoss(1, [3], [1]), 0); // defended pawn attacked by knight
  assert.equal(exchangeLoss(3.25, [9, 100], [9]), 3.25); // queen + king beat one defender
  assert.equal(exchangeLoss(5, [], [1]), 0);
});

test('central pawn moves rank above edge pawn moves', () => {
  const ranked = rankMoves(new Chess()).map((m) => m.san);
  assert.ok(ranked.indexOf('e4') < ranked.indexOf('a3'));
  assert.ok(ranked.indexOf('d4') < ranked.indexOf('h4'));
});

test('hanging a piece is ranked low', () => {
  const c = new Chess('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2');
  const ranked = rankMoves(c);
  const ba6 = ranked.findIndex((m) => m.san === 'Ba6');
  assert.ok(ba6 > ranked.length / 2, `Ba6 ranked ${ba6}`);
});

test('pins limit safe mobility', () => {
  // Knight on c6 pinned by Bb5 against the king on e8.
  const a = analyzePosition(new Chess('r1bqkbnr/ppp2ppp/2np4/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4'));
  const n = a.pieces.find((p) => p.square === 'c6');
  assert.ok(n.pinned);
  assert.equal(n.safe.length, 0);
});

test('game analysis grades moves and tags habits', () => {
  const g = analyzeGame(SAMPLES[0].pgn);
  assert.equal(g.positions.length, g.plies.length + 1);
  const qh5 = g.plies.find((p) => p.san === 'Qh5');
  assert.ok(qh5.tags.includes('early-queen'));
  const a3 = g.plies.find((p) => p.san === 'a3');
  assert.ok(a3.tags.includes('flank-pawn'));
  assert.ok(g.plies.slice(0, 40).every((p) => p.label && p.rank >= 1));
  const r = gameReport(g, 'w');
  assert.equal(r.castledBy, 13);
  assert.equal(r.result, 0);
  assert.equal(habitPatterns([r, gameReport(analyzeGame(SAMPLES[1].pgn), 'w')]).length, 5);
});

test('splitPgn separates games', () => {
  assert.equal(splitPgn(SAMPLES.map((s) => s.pgn).join('\n\n')).length, 2);
  assert.equal(labelForGap(0), 'dominant');
  assert.equal(labelForGap(100), 'mistake');
});

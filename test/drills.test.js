import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeGame, gameReport, slimGame } from '../src/insights.js';
import { gameFacts, aggregate } from '../src/stats.js';
import { findWeaknesses, isSlip } from '../src/weaknesses.js';
import { collectMistakes, problemMap, newProgress, nextDrill, recordAnswer, mastery, fundamentalOf, phaseOf, MASTERED_BOX } from '../src/drills.js';
import { SAMPLES } from '../src/samples.js';

const make = (pgn, i, result) => {
  const game = slimGame(analyzeGame(pgn));
  game.headers = { ...game.headers, Result: result, Date: `2026.0${1 + i}.01` };
  const g = { key: `g${i}`, game, headers: game.headers, userColor: 'w' };
  g.report = gameReport(game, 'w');
  return g;
};
// The early-queen sample loses; the Morphy game wins.
const library = [0, 1, 2, 3, 4, 5].map((i) => make(SAMPLES[i % 2].pgn, i, i % 2 ? '1-0' : '0-1'));

test('categories', () => {
  assert.equal(phaseOf(5), 'opening');
  assert.equal(phaseOf(20), 'middlegame');
  assert.equal(phaseOf(40), 'endgame');
  assert.equal(fundamentalOf({ tags: ['hangs'] }), 'tactics');
  assert.equal(fundamentalOf({ tags: ['early-queen'] }), 'development');
  assert.equal(fundamentalOf({ tags: [] }, { grade: 'blunder' }), 'tactics');
});

test('weaknesses are ranked with evidence and practice', () => {
  const facts = library.map(gameFacts);
  const ws = findWeaknesses(facts, aggregate(facts).openings);
  assert.ok(ws.length >= 1);
  // Edge-pawn pushes only happen in the lost games.
  const flank = ws.find((w) => w.key === 'habit:flank');
  assert.ok(flank, ws.map((w) => w.key).join());
  assert.match(flank.evidence[1], /You score 0% in those games and 100% in the rest/);
  assert.equal(flank.practice.tag, 'flank-pawn');
  assert.ok(flank.examples.length > 0);
  for (let i = 1; i < ws.length; i++) assert.ok(ws[i - 1].impact >= ws[i].impact);
  assert.deepEqual(findWeaknesses(facts.slice(0, 3), []), []);
  assert.ok(isSlip({ tag: 'early-queen' }, { tags: ['early-queen'] }));
  assert.ok(isSlip({ habit: 'castle' }, { color: 'w', fullmove: 10, tags: [] }, { w: { castled: false } }));
  assert.ok(!isSlip({ habit: 'castle' }, { color: 'w', fullmove: 10, tags: [] }, { w: { castled: true } }));
});

test('mistakes, problem map and spaced repetition', () => {
  const mistakes = collectMistakes(library);
  assert.ok(mistakes.length >= 3);
  for (const m of mistakes) assert.ok(m.accept.length && m.fen && m.fundamental && m.piece && m.phase);
  const map = problemMap(mistakes);
  assert.equal(map.rows.reduce((s, r) => s + r.n, 0), mistakes.length);

  const progress = newProgress();
  const first = nextDrill(mistakes, progress);
  recordAnswer(progress, first, false);
  // A missed item comes straight back.
  assert.equal(nextDrill(mistakes, progress).id, first.id);
  // Solving it moves it up a box and schedules it later.
  recordAnswer(progress, first, true);
  assert.notEqual(nextDrill(mistakes, progress).id, first.id);

  // Solve everything repeatedly until mastered.
  for (let k = 0; k < 400 && !mastery(mistakes, progress).mastered; k++) recordAnswer(progress, nextDrill(mistakes, progress), true);
  const m = mastery(mistakes, progress);
  assert.ok(m.mastered);
  assert.ok(mistakes.filter((x) => progress.items[x.id].box >= MASTERED_BOX).length >= 0.8 * mistakes.length);
  const filter = { fundamental: mistakes[0].fundamental };
  assert.ok(nextDrill(mistakes, progress, filter).fundamental === filter.fundamental);
});

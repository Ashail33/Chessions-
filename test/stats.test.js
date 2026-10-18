import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeGame, gameReport, slimGame } from '../src/insights.js';
import { timeClassOf, openingName, pieceOfSan, gameFacts, aggregate, filterFacts } from '../src/stats.js';
import { checkGame } from '../src/enginecheck.js';
import { SAMPLES } from '../src/samples.js';

const make = (pgn, extra = {}) => {
  const game = slimGame(analyzeGame(pgn));
  game.headers = { ...game.headers, ...extra };
  return { game, headers: game.headers, userColor: 'w', report: gameReport(game, 'w') };
};

test('time classes', () => {
  assert.equal(timeClassOf('60'), 'bullet');
  assert.equal(timeClassOf('180+2'), 'blitz');
  assert.equal(timeClassOf('600'), 'rapid');
  assert.equal(timeClassOf('1800+20'), 'classical');
  assert.equal(timeClassOf('1/86400'), 'daily');
  assert.equal(timeClassOf(undefined), null);
});

test('opening names', () => {
  assert.equal(openingName({ Opening: 'Italian Game: Two Knights Defense' }), 'Italian Game');
  assert.equal(openingName({ ECOUrl: 'https://www.chess.com/openings/Sicilian-Defense-Old-Sicilian-Variation-3.d4' }), 'Sicilian Defense');
  assert.equal(openingName({}), null);
  assert.equal(pieceOfSan('Nxf3+'), 'n');
  assert.equal(pieceOfSan('exd5'), 'p');
  assert.equal(pieceOfSan('O-O-O'), 'k');
});

test('facts and aggregate', () => {
  const games = [
    make(SAMPLES[0].pgn, { Date: '2026.01.05', TimeControl: '180+2' }),
    make(SAMPLES[1].pgn, { Date: '2026.02.05', TimeControl: '600' }),
    make(SAMPLES[1].pgn, { Date: '2026.03.05', TimeControl: '600' }),
  ];
  const facts = games.map(gameFacts);
  assert.equal(facts[0].opening.moves, '1.e4 e5 2.Qh5 Nc6');
  assert.equal(facts[0].timeClass, 'blitz');
  assert.ok(facts[0].pieceGaps.some((x) => x.piece === 'q'));
  const a = aggregate(facts);
  assert.equal(a.n, 3);
  assert.equal(a.openings.length, 2);
  assert.equal(a.openings[0].n, 2);
  assert.ok(Math.abs(a.score - 2 / 3) < 1e-9);
  assert.equal(a.trend.length, 3);
  assert.ok(a.trend[0].date < a.trend[2].date);
  assert.ok(a.curves.all.length > 10);
  assert.equal(a.principles.length, 5);
  assert.deepEqual(a.timeClasses.sort(), ['blitz', 'rapid']);
  assert.equal(filterFacts(facts, { timeClass: 'rapid' }).length, 2);
  assert.equal(a.engine, null);
});

test('engine check grades each move from evaluations', async () => {
  const g = make(SAMPLES[0].pgn);
  // Fake engine: White is fine until 12.Qe2, which drops the bishop (-300).
  const idx = g.game.plies.findIndex((p) => p.san === 'Qe2');
  let i = 0;
  const engine = { search: async () => { const k = i++; const white = k <= idx ? 20 : -300; return { score: k % 2 === 0 ? white : -white, bestmove: 'h2h3' }; } };
  const res = await checkGame(engine, g.game);
  assert.equal(res.evals.length, g.game.positions.length);
  assert.equal(res.plies[idx].grade, 'blunder');
  assert.equal(res.plies[idx].loss, 320);
  assert.equal(res.plies[idx].best, 'h3');
  assert.equal(res.plies[0].grade, 'best');
  const f = gameFacts({ ...g, engine: res });
  assert.equal(f.engine.blunders, 1);
});

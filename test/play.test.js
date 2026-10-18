import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../vendor/chess.js';
import { PlaySession, engineGrade } from '../src/play.js';

// Mock engine: evaluates by material from the side to move's view, and
// records whether it was asked to play at limited strength.
function mockEngine() {
  const calls = [];
  const values = { p: 100, n: 300, b: 300, r: 500, q: 900, k: 0 };
  return {
    calls,
    async search(fen, opts = {}) {
      calls.push(opts);
      const c = new Chess(fen);
      let score = 0;
      for (const row of c.board()) for (const p of row) if (p) score += (p.color === c.turn() ? 1 : -1) * values[p.type];
      // Prefer captures of the most valuable piece, else the first legal move.
      const moves = c.moves({ verbose: true });
      const best = moves.filter((m) => m.captured).sort((a, b) => values[b.captured] - values[a.captured])[0] || moves[0];
      if (best && best.captured) score += values[best.captured];
      return { bestmove: best ? best.from + best.to + (best.promotion || '') : null, score, mate: null, pv: best ? [best.from + best.to] : [], lines: [] };
    },
  };
}

test('engine grades', () => {
  assert.equal(engineGrade(0).key, 'best');
  assert.equal(engineGrade(80).key, 'inaccuracy');
  assert.equal(engineGrade(400).key, 'blunder');
});

test('a blunder is punished at full strength', async () => {
  const engine = mockEngine();
  // 1. e4 d5: Qg4 walks into Bc8xg4.
  const s = new PlaySession(engine, { userColor: 'w', level: 'beginner', punish: 'mistakes', fen: 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2' });
  await s.start();
  const hang = { from: 'd1', to: 'g4' };
  engine.calls.length = 0;
  await s.userMove({ from: hang.from, to: hang.to });
  const userPos = s.positions[s.positions.length - 2];
  assert.ok(userPos.engine.loss >= 800, `loss ${userPos.engine.loss}`);
  assert.equal(userPos.engine.grade.key, 'blunder');
  const reply = s.latest.move;
  assert.ok(reply.punished);
  assert.equal(reply.san, 'Bxg4');
  assert.ok(!engine.calls.some((c) => c.elo), 'no limited-strength search when punishing');
});

test('take back returns to your move', async () => {
  const s = new PlaySession(mockEngine(), { userColor: 'w', level: 'club' });
  await s.start();
  await s.userMove({ from: 'd2', to: 'd4' });
  assert.equal(s.positions.length, 3);
  s.takeBack();
  assert.equal(s.positions.length, 1);
  assert.equal(s.chess.turn(), 'w');
  assert.match(s.pgn(), /\[Event "Practice vs Stockfish/);
});

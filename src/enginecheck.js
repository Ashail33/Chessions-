// Runs Stockfish over every position of an analysed game, so each move gets
// an engine verdict (centipawn loss and the engine's best move) alongside the
// board-dominance grade.

import { Chess } from '../vendor/chess.js';
import { uciToMove, isMateScore } from './engine.js';
import { engineGrade } from './play.js';

export const ENGINE_CHECK_VERSION = 1;
const CAP = 2000;
const clamp = (s) => (isMateScore(s) ? Math.sign(s) * CAP : Math.max(-CAP, Math.min(CAP, s)));

function sanOf(fen, uci) {
  try {
    return new Chess(fen).move(uciToMove(uci)).san;
  } catch {
    return null;
  }
}

// game: { positions: [{ fen }], plies: [{ color, from, to, san }] }
// Returns { evals (White's view, centipawns), plies: [{ loss, grade, best }] }, or null if cancelled.
export async function checkGame(engine, game, { movetime = 80, onProgress = () => {}, isCancelled = () => false } = {}) {
  const evals = [];
  const best = [];
  const total = game.positions.length;
  for (let i = 0; i < total; i++) {
    if (isCancelled()) return null;
    const fen = game.positions[i].fen;
    const c = new Chess(fen);
    if (c.isGameOver()) {
      evals.push(c.isCheckmate() ? (c.turn() === 'w' ? -CAP : CAP) : 0);
      best.push(null);
    } else {
      const r = await engine.search(fen, { movetime });
      evals.push(clamp(c.turn() === 'w' ? r.score : -r.score));
      best.push(r.bestmove);
    }
    onProgress(i + 1, total);
  }
  const plies = game.plies.map((p, i) => {
    const sign = p.color === 'w' ? 1 : -1;
    const played = p.from + p.to;
    const matchesBest = best[i] && best[i].slice(0, 4) === played;
    const loss = matchesBest ? 0 : Math.max(0, sign * evals[i] - sign * evals[i + 1]);
    return { loss: Math.round(loss), grade: engineGrade(loss).key, best: best[i] && !matchesBest ? sanOf(game.positions[i].fen, best[i]) : null };
  });
  return { version: ENGINE_CHECK_VERSION, movetime, evals, plies };
}

// Conventional annotation for an engine grade.
export const NAG = { inaccuracy: '?!', mistake: '?', blunder: '??' };

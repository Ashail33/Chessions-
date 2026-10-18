// A game against Stockfish that plays at your level until you slip, then
// switches to full strength to punish the mistake and shows you how.

import { Chess } from '../vendor/chess.js';
import { analyzePosition, rankMoves, other } from './analysis.js';
import { assessMove } from './insights.js';
import { uciToMove, isMateScore } from './engine.js';

export const LEVELS = [
  { key: 'beginner', text: 'Beginner', elo: 1350 },
  { key: 'club', text: 'Club', elo: 1600 },
  { key: 'strong', text: 'Strong club', elo: 1900 },
  { key: 'expert', text: 'Expert', elo: 2300 },
  { key: 'max', text: 'Full strength', elo: null },
];

export const PUNISH = [
  { key: 'mistakes', text: 'Punish mistakes (lose 1 pawn or more)', threshold: 100 },
  { key: 'inaccuracies', text: 'Punish inaccuracies too (half a pawn)', threshold: 50 },
  { key: 'always', text: 'Always play full strength', threshold: 0 },
];

// Engine verdict on a move, from the centipawns it lost.
export function engineGrade(loss) {
  if (loss <= 20) return { key: 'best', text: 'Best', tone: 'dominant' };
  if (loss <= 50) return { key: 'good', text: 'Good', tone: 'good' };
  if (loss <= 100) return { key: 'inaccuracy', text: 'Inaccuracy', tone: 'passive' };
  if (loss <= 250) return { key: 'mistake', text: 'Mistake', tone: 'concession' };
  return { key: 'blunder', text: 'Blunder', tone: 'mistake' };
}

// Losses are capped so a missed mate doesn't read as "100 pawns".
const clampEval = (s) => (isMateScore(s) ? Math.sign(s) * 2000 : Math.max(-2000, Math.min(2000, s)));

function sanLine(fen, uciMoves, max = 6) {
  const c = new Chess(fen);
  const out = [];
  for (const u of uciMoves.slice(0, max)) {
    try {
      out.push(c.move(uciToMove(u)).san);
    } catch {
      break;
    }
  }
  return out;
}

export class PlaySession {
  constructor(engine, { userColor = 'w', level = 'club', punish = 'mistakes', fen, onUpdate = () => {} } = {}) {
    this.engine = engine;
    this.userColor = userColor;
    this.level = LEVELS.find((l) => l.key === level) || LEVELS[1];
    this.punish = PUNISH.find((p) => p.key === punish) || PUNISH[0];
    this.onUpdate = onUpdate;
    this.chess = new Chess(fen);
    const start = analyzePosition(this.chess);
    this.positions = [{ fen: this.chess.fen(), analysis: start, assessment: null, move: null }];
    this.thinking = true; // locked until start() once the engine is ready
    this.error = null;
    this.userEval = null; // full-strength search of the current position, when it is your move
    this.history = { ids: new Map(), counts: new Map() };
    this.token = 0;
  }

  get over() {
    return this.chess.isGameOver();
  }

  get latest() {
    return this.positions[this.positions.length - 1];
  }

  result() {
    if (!this.chess.isGameOver()) return null;
    if (this.chess.isCheckmate()) return this.chess.turn() === this.userColor ? 'loss' : 'win';
    return 'draw';
  }

  async start() {
    this.thinking = false;
    if (this.chess.turn() !== this.userColor) await this.engineTurn(null);
    else await this.evaluateForUser();
  }

  async evaluateForUser() {
    const token = this.token;
    this.thinking = true;
    this.onUpdate();
    try {
      const fen = this.chess.fen();
      const r = await this.engine.search(fen, { movetime: 600 });
      if (token !== this.token) return;
      this.userEval = { fen, ...r, line: sanLine(fen, r.pv, 4) };
    } catch (err) {
      this.error = err.message;
    }
    this.thinking = false;
    this.onUpdate();
  }

  // Play your move, judge it, and let the engine reply.
  async userMove(m) {
    if (this.thinking || this.over || this.chess.turn() !== this.userColor) return false;
    const token = this.token;
    const beforePos = this.latest;
    const ranked = rankMoves(this.chess);
    const fullmove = this.chess.moveNumber();
    let move;
    try {
      move = this.chess.move({ from: m.from, to: m.to, promotion: m.promotion || 'q' });
    } catch {
      return false;
    }
    const after = analyzePosition(this.chess);
    const assessment = assessMove({ move, color: move.color, before: beforePos.analysis, after, ranked, history: this.history, fullmove });
    const ply = { san: move.san, from: move.from, to: move.to, color: move.color, fullmove, ...assessment };
    const pos = { fen: this.chess.fen(), analysis: after, assessment: ply, move: ply };
    this.positions.push(pos);
    const prior = this.userEval && this.userEval.fen === beforePos.fen ? this.userEval : null;
    this.userEval = null;
    await this.engineTurn(pos, prior, token);
    return true;
  }

  async engineTurn(userPos, prior = null, token = this.token) {
    this.thinking = true;
    this.onUpdate();
    try {
      const fen = this.chess.fen();
      if (!this.chess.isGameOver()) {
        // Full-strength look at the position after your move.
        const full = await this.engine.search(fen, { movetime: 700 });
        if (token !== this.token) return;
        let reply = full.bestmove;
        let punished = false;
        if (userPos && prior) {
          const before = clampEval(prior.score);
          const afterYou = clampEval(-full.score);
          const loss = Math.max(0, before - afterYou);
          const grade = engineGrade(loss);
          punished = this.punish.key === 'always' || loss >= this.punish.threshold;
          userPos.engine = {
            loss,
            grade,
            evalBefore: prior.score,
            evalAfter: -full.score,
            better: prior.pv[0] && prior.pv[0] !== `${userPos.move.from}${userPos.move.to}` ? sanLine(prior.fen, prior.pv, 1)[0] : null,
            threat: sanLine(fen, full.pv, 5),
            punished,
          };
        } else if (this.punish.key === 'always') {
          punished = true;
        }
        if (!punished && this.level.elo) {
          const limited = await this.engine.search(fen, { movetime: 400, elo: this.level.elo });
          if (token !== this.token) return;
          reply = limited.bestmove || reply;
        }
        if (reply) this.playEngineMove(reply, punished, -full.score);
      }
    } catch (err) {
      this.error = err.message;
    }
    this.thinking = false;
    this.onUpdate();
    if (!this.chess.isGameOver() && this.chess.turn() === this.userColor && token === this.token) await this.evaluateForUser();
  }

  playEngineMove(uci, punished, userEvalAfterYourMove) {
    const beforePos = this.latest;
    const ranked = rankMoves(this.chess);
    const fullmove = this.chess.moveNumber();
    const move = this.chess.move(uciToMove(uci));
    const after = analyzePosition(this.chess);
    const assessment = assessMove({ move, color: move.color, before: beforePos.analysis, after, ranked, history: this.history, fullmove });
    const ply = { san: move.san, from: move.from, to: move.to, color: move.color, fullmove, ...assessment, punished, evalForYou: userEvalAfterYourMove };
    this.positions.push({ fen: this.chess.fen(), analysis: after, assessment: ply, move: ply });
  }

  // Undo back to your previous turn.
  takeBack() {
    if (this.thinking) return false;
    let undone = 0;
    while (this.positions.length > 1) {
      const last = this.positions.pop();
      this.chess.undo();
      undone++;
      if (last.move.color === this.userColor) break;
    }
    if (!undone) return false;
    this.history = { ids: new Map(), counts: new Map() };
    this.token++;
    this.userEval = null;
    this.evaluateForUser();
    return true;
  }

  resign() {
    this.token++;
    this.resigned = true;
    this.thinking = false;
    this.onUpdate();
  }

  pgn() {
    const c = this.chess;
    const you = sideName(this.userColor);
    c.setHeader('Event', `Practice vs Stockfish (${this.level.text})`);
    c.setHeader('Date', new Date().toISOString().slice(0, 10).replace(/-/g, '.'));
    c.setHeader(you, 'You');
    c.setHeader(you === 'White' ? 'Black' : 'White', `Stockfish ${this.level.text}`);
    const won = this.userColor === 'w' ? '1-0' : '0-1';
    const lost = this.userColor === 'w' ? '0-1' : '1-0';
    const r = this.resigned ? 'loss' : this.result();
    c.setHeader('Result', r === 'win' ? won : r === 'loss' ? lost : r === 'draw' ? '1/2-1/2' : '*');
    return c.pgn();
  }
}

export const sideName = (c) => (c === 'w' ? 'White' : 'Black');
export { other };

// Turns raw dominance numbers into coaching: per-move "what did this change",
// principle tags discovered from the board, a per-game opening report, and
// patterns across many of your games.

import { Chess } from '../vendor/chess.js';
import { analyzePosition, rankMoves, moveDeltas, labelForGap, other, PIECE_NAMES, VALUES } from './analysis.js';

// Each tag is a principle *observed* on the board, explained by what it does
// to control and freedom rather than as a rule to memorise.
export const TAGS = {
  develops: { text: 'Develops', tone: 'good', lesson: 'A piece left its starting square and now controls new squares. Undeveloped pieces control almost nothing.' },
  'center-pawn': { text: 'Claims center', tone: 'good', lesson: 'Central pawns grab the squares pieces want and open lines for your bishops and queen.' },
  castles: { text: 'Castles', tone: 'good', lesson: 'The king is tucked away and a rook steps toward the center. Your pieces can now attack without worrying about the king.' },
  restricts: { text: 'Restricts', tone: 'good', lesson: 'Took away several safe squares from the opponent’s pieces. Fewer safe moves means fewer good plans for them.' },
  activates: { text: 'Activates', tone: 'good', lesson: 'Your pieces gained several safe squares. Freedom compounds: active pieces create threats.' },
  threat: { text: 'Creates threat', tone: 'good', lesson: 'Attacks something, so the opponent must spend a move responding instead of improving their position.' },
  captures: { text: 'Captures', tone: 'neutral', lesson: 'A capture changes material and often opens lines — check who benefits from the open lines.' },
  'flank-pawn': { text: 'Flank pawn', tone: 'warn', lesson: 'An edge pawn moved early. It barely touches the center and doesn’t develop anything, so the opponent gets a free move to grab space.' },
  'repeat-piece': { text: 'Moves piece again', tone: 'warn', lesson: 'The same piece moved twice while others still sit at home. Each repeat is a move your other pieces didn’t get.' },
  'early-queen': { text: 'Early queen', tone: 'warn', lesson: 'The queen came out before the minor pieces. She is easy to attack with smaller pieces, which gains the opponent free developing moves.' },
  'rim-knight': { text: 'Knight on rim', tone: 'warn', lesson: 'A knight on the edge reaches half as many squares as one in the center. Count its safe moves on the board.' },
  'blocks-bishop': { text: 'Blocks own bishop', tone: 'warn', lesson: 'This move shut in one of your own bishops — it lost several safe squares.' },
  'king-walk': { text: 'Gives up castling', tone: 'warn', lesson: 'The king lost the right to castle without castling. It will be stuck in the center where lines open first.' },
  hangs: { text: 'Leaves material en prise', tone: 'bad', lesson: 'After this move a piece can be won. Dominance means nothing if material is dropped — check what is attacked before moving.' },
};

const HOME = new Set(['b1', 'g1', 'c1', 'f1', 'b8', 'g8', 'c8', 'f8']);

// Assess one move. `before`/`after` are analyzePosition results, `ranked` is
// rankMoves() for the position before the move (may be null beyond the
// analysed window). `history` tracks per-piece move counts.
export function assessMove({ move, color, before, after, ranked, history, fullmove }) {
  const deltas = moveDeltas(before, after, color);
  const me = color;
  const opp = other(color);
  const tags = [];
  const tag = (t) => tags.includes(t) || tags.push(t);

  if ((move.piece === 'n' || move.piece === 'b') && HOME.has(move.from)) tag('develops');
  if (move.flags.includes('k') || move.flags.includes('q')) tag('castles');
  if (move.piece === 'p' && 'cdef'.includes(move.to[0]) && deltas.center > 0) tag('center-pawn');
  if (move.piece === 'p' && 'abgh'.includes(move.to[0]) && !move.captured && fullmove <= 10 && deltas.center <= 0 && !before[me].castled) tag('flank-pawn');
  if (move.piece === 'n' && 'ah'.includes(move.to[0])) tag('rim-knight');
  if (move.piece === 'q' && fullmove <= 8 && before[me].developed < 2) tag('early-queen');
  if (move.captured) tag('captures');
  if (deltas.oppMobility <= -4) tag('restricts');
  if (deltas.myMobility >= 4) tag('activates');
  if (!before[me].castled && before[me].kingSafety === 0 && after[me].kingSafety < 0 && !move.flags.includes('k') && !move.flags.includes('q')) tag('king-walk');

  const newThreats = after[opp].hanging.filter((h) => !before[opp].hanging.some((b) => b.square === h.square));
  if (newThreats.length) tag('threat');

  const myLoss = after[me].hanging.length ? after[me].hanging[0].loss : 0;
  const lossBefore = before[me].hanging.length ? before[me].hanging[0].loss : 0;
  const evenTrade = move.captured && VALUES[move.captured] >= myLoss;
  if (myLoss >= 1 && myLoss > lossBefore && !evenTrade) tag('hangs');

  // Own bishops (other than the moved piece) that lost safe squares.
  const bishopsBefore = before.pieces.filter((p) => p.color === me && p.type === 'b' && p.square !== move.from);
  for (const b of bishopsBefore) {
    const now = after.pieces.find((p) => p.square === b.square && p.type === 'b' && p.color === me);
    if (now && b.safe.length - now.safe.length >= 2) tag('blocks-bishop');
  }

  // Repeat moves: the same piece moving again in the opening while minor
  // pieces are still at home, unless it was capturing or escaping attack.
  const id = history.ids.get(move.from);
  const count = (history.counts.get(id) || 0) + 1;
  history.counts.set(id, count);
  history.ids.delete(move.from);
  history.ids.set(move.to, id);
  if (move.flags.includes('k')) history.ids.set(color === 'w' ? 'f1' : 'f8', history.ids.get(color === 'w' ? 'h1' : 'h8'));
  if (move.flags.includes('q')) history.ids.set(color === 'w' ? 'd1' : 'd8', history.ids.get(color === 'w' ? 'a1' : 'a8'));
  const wasAttacked = before[me].hanging.some((h) => h.square === move.from);
  if (count >= 2 && move.piece !== 'p' && move.piece !== 'k' && fullmove <= 12 && before[me].developed < 4 && !move.captured && !wasAttacked) tag('repeat-piece');

  let best = null;
  let gap = null;
  let label = null;
  let rank = null;
  if (ranked) {
    best = slimMove(ranked[0]);
    const idx = ranked.findIndex((r) => r.san === move.san);
    rank = idx + 1;
    const played = ranked[idx];
    gap = Math.max(0, ranked[0].score - played.score);
    label = labelForGap(gap, myLoss);
  }

  return { deltas, tags, gap, label, rank, best, alternatives: ranked ? ranked.slice(0, 5).map(slimMove) : null, total: ranked ? ranked.length : null };
}

const slimMove = (m) => ({ san: m.san, from: m.from, to: m.to, score: m.score, promotion: m.promotion });

function newHistory() {
  const ids = new Map();
  for (const r of ['1', '2', '7', '8']) for (const f of 'abcdefgh') ids.set(f + r, f + r);
  return { ids, counts: new Map() };
}

// Full game analysis. Alternatives are ranked for the first `window` plies,
// which is where opening intuition is built.
export function analyzeGame(pgn, { window = 40 } = {}) {
  const game = new Chess();
  game.loadPgn(pgn);
  const headers = game.getHeaders();
  const moves = game.history({ verbose: true });
  const startFen = headers.FEN || undefined;
  const board = new Chess(startFen);
  const history = newHistory();
  const plies = [];
  let before = analyzePosition(board);
  const positions = [{ fen: board.fen(), analysis: before }];

  moves.forEach((m, ply) => {
    const ranked = ply < window ? rankMoves(board) : null;
    const fullmove = board.moveNumber();
    board.move(m);
    const after = analyzePosition(board);
    const assessment = assessMove({ move: m, color: m.color, before, after, ranked, history, fullmove });
    plies.push({ ply, san: m.san, from: m.from, to: m.to, color: m.color, fullmove, fenBefore: positions[ply].fen, fenAfter: board.fen(), ...assessment });
    positions.push({ fen: board.fen(), analysis: after });
    before = after;
  });

  return { headers, plies, positions, pgn };
}

export function detectUserColor(headers, username) {
  if (!username) return null;
  const u = username.trim().toLowerCase();
  if ((headers.White || '').toLowerCase() === u) return 'w';
  if ((headers.Black || '').toLowerCase() === u) return 'b';
  return null;
}

export function userResult(headers, color) {
  const r = headers.Result;
  if (r === '1/2-1/2') return 0.5;
  if (r === '1-0') return color === 'w' ? 1 : 0;
  if (r === '0-1') return color === 'b' ? 1 : 0;
  return null;
}

// Opening report for one game, from `color`'s point of view.
export function gameReport(game, color, { openingMoves = 12 } = {}) {
  const mine = game.plies.filter((p) => p.color === color && p.fullmove <= openingMoves && p.label);
  const counts = {};
  for (const p of mine) counts[p.label] = (counts[p.label] || 0) + 1;
  const tagCounts = {};
  for (const p of mine) for (const t of p.tags) tagCounts[t] = (tagCounts[t] || 0) + 1;
  const avgGap = mine.length ? mine.reduce((s, p) => s + p.gap, 0) / mine.length : 0;

  const sign = color === 'w' ? 1 : -1;
  const at = (fullmove) => {
    const idx = Math.min(game.positions.length - 1, fullmove * 2);
    return sign * game.positions[idx].analysis.dominance;
  };

  const castle = game.plies.find((p) => p.color === color && p.tags.includes('castles'));
  const devAfter = (n) => {
    const ply = game.plies.filter((p) => p.color === color && p.fullmove <= n).pop();
    return ply ? game.positions[ply.ply + 1].analysis[color].developed : 0;
  };

  const turningPoints = mine
    .filter((p) => p.gap > 6)
    .sort((a, b) => b.gap - a.gap)
    .slice(0, 3);

  return {
    color,
    movesAnalysed: mine.length,
    counts,
    tagCounts,
    avgGap,
    dominanceAt: { 8: at(8), 12: at(12), 15: at(15) },
    castledBy: castle ? castle.fullmove : null,
    developedBy8: devAfter(8),
    earlyQueen: !!tagCounts['early-queen'],
    repeats: tagCounts['repeat-piece'] || 0,
    flankPawns: tagCounts['flank-pawn'] || 0,
    turningPoints,
    result: userResult(game.headers, color),
  };
}

// Compare your games split by each habit: does the habit go with more or
// less board dominance a few moves later, and with better results?
export const HABITS = [
  { key: 'castled10', text: 'Castled by move 10', test: (r) => r.castledBy !== null && r.castledBy <= 10 },
  { key: 'dev3', text: '3+ minor pieces out by move 8', test: (r) => r.developedBy8 >= 3 },
  { key: 'earlyQueen', text: 'Brought the queen out early', test: (r) => r.earlyQueen },
  { key: 'repeats', text: 'Moved the same piece twice in the opening', test: (r) => r.repeats > 0 },
  { key: 'flank', text: 'Pushed edge pawns early', test: (r) => r.flankPawns > 0 },
];

export function habitPatterns(reports) {
  const avg = (xs, f) => (xs.length ? xs.reduce((s, x) => s + f(x), 0) / xs.length : null);
  return HABITS.map((h) => {
    const yes = reports.filter(h.test);
    const no = reports.filter((r) => !h.test(r));
    const scored = (xs) => xs.filter((r) => r.result !== null);
    return {
      ...h,
      yes: { n: yes.length, dominance: avg(yes, (r) => r.dominanceAt[12]), score: avg(scored(yes), (r) => r.result) },
      no: { n: no.length, dominance: avg(no, (r) => r.dominanceAt[12]), score: avg(scored(no), (r) => r.result) },
    };
  });
}

// Human-readable sentence describing what a move changed.
export function describeDeltas(d, color) {
  const parts = [];
  const signed = (n) => (n > 0 ? `+${n}` : `${n}`);
  if (d.controlled) parts.push(`${signed(d.controlled)} squares controlled`);
  if (d.center) parts.push(`${signed(d.center)} center`);
  if (d.oppMobility) parts.push(`opponent safe moves ${signed(d.oppMobility)}`);
  if (d.myMobility) parts.push(`your safe moves ${signed(d.myMobility)}`);
  if (d.oppCramped > 0) parts.push(`${d.oppCramped} more enemy piece${d.oppCramped > 1 ? 's' : ''} cramped`);
  if (d.oppCramped < 0) parts.push(`${-d.oppCramped} enemy piece${d.oppCramped < -1 ? 's' : ''} freed`);
  return parts.length ? parts.join(' · ') : 'No change in board control.';
}

export const pieceName = (t) => PIECE_NAMES[t];

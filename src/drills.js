// Mistake categories and spaced-repetition drills.
//
// Every costly move you made is classified by fundamental, piece and phase.
// Each one becomes a drill: the position before your move, where you have to
// find a good move. Missed drills come back soon; solved ones come back
// later and later (Leitner boxes). A category is mastered when its positions
// have been solved three times running and recent accuracy is high.

import { pieceOfSan, PIECES } from './stats.js';

export const FUNDAMENTALS = {
  tactics: { text: 'Tactics & hanging pieces', lesson: 'Before every move, check what your opponent attacks afterwards, and look at all checks and captures.' },
  development: { text: 'Development', lesson: 'Bring out a new piece each move in the opening. Knights and bishops before the queen, and no piece moves twice without a reason.' },
  king: { text: 'King safety', lesson: 'Castle early, keep the pawns in front of your king, and don’t open lines towards it.' },
  activity: { text: 'Piece activity', lesson: 'Put pieces where they have the most safe squares. Avoid the rim and don’t block your own bishops.' },
  centre: { text: 'Centre & space', lesson: 'Fight for d4, e4, d5 and e5. Moves that give up central squares hand your opponent the board.' },
};
export const PHASES = {
  opening: { text: 'Opening', range: 'moves 1–12' },
  middlegame: { text: 'Middlegame', range: 'moves 13–30' },
  endgame: { text: 'Endgame', range: 'after move 30' },
};

export const phaseOf = (fullmove) => (fullmove <= 12 ? 'opening' : fullmove <= 30 ? 'middlegame' : 'endgame');

export function fundamentalOf(ply, engine) {
  const t = ply.tags || [];
  if (t.includes('hangs') || (engine && (engine.grade === 'blunder' || engine.grade === 'mistake'))) return 'tactics';
  if (t.includes('king-walk')) return 'king';
  if (t.includes('early-queen') || t.includes('repeat-piece') || t.includes('flank-pawn')) return 'development';
  if (t.includes('rim-knight') || t.includes('blocks-bishop')) return 'activity';
  if (ply.deltas && (ply.deltas.center < 0 || ply.deltas.space < 0)) return 'centre';
  return 'activity';
}

// A move is a mistake worth drilling if it fell well short of the most
// dominating move, or the engine marked it a mistake or blunder.
export function isMistake(ply, engine) {
  if (engine && (engine.grade === 'blunder' || engine.grade === 'mistake')) return true;
  return ply.gap !== null && ply.gap !== undefined && ply.gap > 8;
}

// Collect classified mistakes from analysed games (newest first).
// games: [{ key, game: { plies, positions }, engine, userColor, headers }]
export function collectMistakes(games) {
  const out = [];
  for (const g of games) {
    if (!g.game) continue;
    g.game.plies.forEach((p, i) => {
      if (p.color !== g.userColor) return;
      const e = g.engine && g.engine.plies[i];
      if (!isMistake(p, e)) return;
      const accept = [];
      if (e && e.best) accept.push(e.best);
      else if (p.alternatives) for (const a of p.alternatives) if (a.score >= p.alternatives[0].score - 3) accept.push(a.san);
      if (!accept.length) return;
      out.push({
        id: `${g.key}#${i}`,
        game: g,
        ply: i,
        fen: g.game.positions[i].fen,
        san: p.san,
        fullmove: p.fullmove,
        color: p.color,
        accept,
        engineChecked: !!e,
        evalBefore: e ? g.engine.evals[i] : null,
        cost: e ? e.loss / 10 : p.gap,
        tags: p.tags || [],
        fundamental: fundamentalOf(p, e),
        piece: pieceOfSan(p.san),
        phase: phaseOf(p.fullmove),
      });
    });
  }
  return out;
}

// Counts and cost per fundamental x phase, and per piece.
export function problemMap(mistakes) {
  const grid = {};
  for (const f of Object.keys(FUNDAMENTALS)) {
    grid[f] = {};
    for (const ph of Object.keys(PHASES)) grid[f][ph] = { n: 0, cost: 0 };
  }
  const pieces = {};
  for (const m of mistakes) {
    const cell = grid[m.fundamental][m.phase];
    cell.n++;
    cell.cost += m.cost;
    (pieces[m.piece] ||= { piece: m.piece, name: PIECES[m.piece], n: 0, cost: 0 }).n++;
    pieces[m.piece].cost += m.cost;
  }
  const rows = Object.keys(FUNDAMENTALS).map((f) => ({
    key: f, ...FUNDAMENTALS[f],
    n: Object.values(grid[f]).reduce((s, c) => s + c.n, 0),
    cost: Object.values(grid[f]).reduce((s, c) => s + c.cost, 0),
    cells: grid[f],
  })).sort((a, b) => b.cost - a.cost);
  return { rows, pieces: Object.values(pieces).sort((a, b) => b.cost - a.cost), max: Math.max(1, ...rows.flatMap((r) => Object.values(r.cells).map((c) => c.cost))) };
}

// ---------- spaced repetition ----------
// Rounds since an item was last seen before it is due again, per box.
export const INTERVALS = [0, 3, 8, 20, 50];
export const MASTERED_BOX = 3;

export function newProgress() {
  return { round: 0, items: {}, log: [] };
}

export function matches(mistake, filter) {
  if (!filter) return true;
  return (!filter.fundamental || mistake.fundamental === filter.fundamental)
    && (!filter.piece || mistake.piece === filter.piece)
    && (!filter.phase || mistake.phase === filter.phase)
    && (!filter.tag || mistake.tags.includes(filter.tag))
    && (!filter.games || filter.games.includes(mistake.game.key));
}

// Pick the next drill: overdue items in the lowest box first, then new ones.
export function nextDrill(mistakes, progress, filter, skip = new Set()) {
  const pool = mistakes.filter((m) => matches(m, filter) && !skip.has(m.id));
  if (!pool.length) return null;
  const due = [];
  const fresh = [];
  for (const m of pool) {
    const s = progress.items[m.id];
    if (!s) fresh.push(m);
    else if (s.box < INTERVALS.length && progress.round - s.seen >= INTERVALS[s.box]) due.push({ m, s });
  }
  due.sort((a, b) => a.s.box - b.s.box || a.s.seen - b.s.seen);
  if (due.length && (due[0].s.box === 0 || !fresh.length)) return due[0].m;
  if (fresh.length) return fresh.sort((a, b) => b.cost - a.cost)[0];
  if (due.length) return due[0].m;
  // Everything is scheduled for later: review the least-solid item anyway.
  return pool.map((m) => ({ m, s: progress.items[m.id] })).sort((a, b) => a.s.box - b.s.box || a.s.seen - b.s.seen)[0].m;
}

export function recordAnswer(progress, mistake, correct) {
  const s = progress.items[mistake.id] || { box: 0, seen: 0, tries: 0, solved: 0 };
  s.box = correct ? Math.min(INTERVALS.length, s.box + 1) : 0;
  s.seen = progress.round;
  s.tries++;
  if (correct) s.solved++;
  progress.items[mistake.id] = s;
  progress.round++;
  progress.log.push({ id: mistake.id, correct, f: mistake.fundamental, p: mistake.piece, ph: mistake.phase, t: Date.now() });
  if (progress.log.length > 500) progress.log.splice(0, progress.log.length - 500);
  return s;
}

// Mastery for a set of mistakes: share of items solidly learnt, and recent accuracy.
export function mastery(mistakes, progress, filter) {
  const pool = mistakes.filter((m) => matches(m, filter));
  const ids = new Set(pool.map((m) => m.id));
  const solid = pool.filter((m) => (progress.items[m.id] || { box: 0 }).box >= MASTERED_BOX).length;
  const attempts = progress.log.filter((l) => ids.has(l.id)).slice(-10);
  const accuracy = attempts.length ? attempts.filter((l) => l.correct).length / attempts.length : null;
  const share = pool.length ? solid / pool.length : 0;
  return {
    total: pool.length,
    solid,
    share,
    accuracy,
    attempts: attempts.length,
    mastered: pool.length > 0 && share >= 0.8 && accuracy !== null && accuracy >= 0.8,
  };
}

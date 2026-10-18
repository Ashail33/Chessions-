// Statistics across your games: per-game facts, then aggregates for the
// Insights dashboard. Pure functions over analysed games (no DOM).

import { HABITS, habitPatterns } from './insights.js';

export const PIECES = { p: 'Pawn', n: 'Knight', b: 'Bishop', r: 'Rook', q: 'Queen', k: 'King' };
const CURVE_PLIES = 40;

// Bullet / blitz / rapid / classical / daily from a PGN TimeControl, using
// the usual estimate of base time + 40 moves of increment.
export function timeClassOf(tc) {
  if (!tc || tc === '-' || tc.includes('/')) return tc ? 'daily' : null;
  const [base, inc] = tc.split('+').map(Number);
  if (!Number.isFinite(base)) return null;
  const t = base + 40 * (inc || 0);
  return t < 180 ? 'bullet' : t < 480 ? 'blitz' : t < 1500 ? 'rapid' : 'classical';
}

// Opening family name from Lichess's Opening header or Chess.com's ECOUrl.
export function openingName(h) {
  if (h.Opening) return h.Opening.split(':')[0].split(',')[0].trim();
  const slug = h.ECOUrl && h.ECOUrl.split('/openings/')[1];
  if (!slug) return null;
  const words = [];
  for (const w of slug.split('-')) {
    if (/^\d/.test(w)) break;
    words.push(w);
    if (/^(Defense|Defence|Game|Opening|Gambit|Attack|System)$/.test(w)) break;
  }
  return words.join(' ') || null;
}

export function pieceOfSan(san) {
  if (san.startsWith('O-O')) return 'k';
  const c = san[0];
  return 'KQRBN'.includes(c) ? c.toLowerCase() : 'p';
}

function parseDate(d) {
  const m = d && d.match(/^(\d{4})\.(\d{2})\.(\d{2})/);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

// Everything the dashboard needs about one analysed game.
export function gameFacts(g) {
  const { plies, positions } = g.game;
  const color = g.userColor;
  const sign = color === 'w' ? 1 : -1;
  const r = g.report;
  const mine = plies.filter((p) => p.color === color && p.label);
  const firstMoves = plies.slice(0, 4).map((p, i) => (i % 2 === 0 ? `${p.fullmove}.${p.san}` : p.san)).join(' ');
  const engine = g.engine && g.engine.plies
    ? (() => {
        const losses = g.engine.plies.filter((_, i) => plies[i] && plies[i].color === color).map((e) => Math.min(e.loss, 1000));
        const count = (k) => g.engine.plies.filter((e, i) => plies[i] && plies[i].color === color && e.grade === k).length;
        return { acpl: mean(losses), blunders: count('blunder'), mistakes: count('mistake'), inaccuracies: count('inaccuracy') };
      })()
    : null;
  return {
    game: g,
    date: parseDate(g.headers.Date || g.headers.UTCDate),
    color,
    result: r.result,
    timeClass: timeClassOf(g.headers.TimeControl),
    opening: { key: `${color}:${firstMoves}`, moves: firstMoves, name: openingName(g.headers) },
    board12: r.dominanceAt[12],
    avgGap: r.avgGap,
    habits: Object.fromEntries(HABITS.map((h) => [h.key, h.test(r)])),
    curve: positions.slice(0, CURVE_PLIES + 1).map((p) => sign * p.analysis.dominance),
    pieceGaps: mine.map((p) => ({ piece: pieceOfSan(p.san), gap: p.gap })),
    engine,
  };
}

export function filterFacts(facts, { color = 'all', timeClass = 'all' } = {}) {
  return facts.filter((f) => (color === 'all' || f.color === color) && (timeClass === 'all' || f.timeClass === timeClass));
}

const score = (fs) => mean(fs.filter((f) => f.result !== null).map((f) => f.result));

function averageCurve(fs) {
  const out = [];
  for (let i = 0; i <= CURVE_PLIES; i++) {
    const vals = fs.filter((f) => f.curve.length > i).map((f) => f.curve[i]);
    if (vals.length < Math.max(1, Math.ceil(fs.length / 4))) break;
    out.push(mean(vals));
  }
  return out;
}

export function aggregate(facts) {
  const n = facts.length;
  const dated = facts.filter((f) => f.date !== null).sort((a, b) => a.date - b.date);
  const chrono = dated.length >= n / 2 ? dated : facts.slice().reverse();
  const window = Math.max(3, Math.min(10, Math.round(chrono.length / 5)));
  const trend = chrono.map((f, i) => {
    const slice = chrono.slice(Math.max(0, i - window + 1), i + 1);
    return { date: f.date, board12: f.board12, rolling: mean(slice.map((x) => x.board12)) };
  });
  const half = Math.min(10, Math.floor(chrono.length / 2));
  const improvement = half >= 3
    ? { recent: mean(chrono.slice(-half).map((f) => f.board12)), earlier: mean(chrono.slice(0, half).map((f) => f.board12)), size: half }
    : null;

  const groups = new Map();
  for (const f of facts) {
    if (!groups.has(f.opening.key)) groups.set(f.opening.key, []);
    groups.get(f.opening.key).push(f);
  }
  const openings = [...groups.values()]
    .map((fs) => {
      const names = fs.map((f) => f.opening.name).filter(Boolean);
      const name = names.sort((a, b) => names.filter((x) => x === b).length - names.filter((x) => x === a).length)[0] || null;
      return { key: fs[0].opening.key, moves: fs[0].opening.moves, color: fs[0].color, name, n: fs.length, score: score(fs), board12: mean(fs.map((f) => f.board12)), avgGap: mean(fs.map((f) => f.avgGap)) };
    })
    .sort((a, b) => b.n - a.n || (b.board12 || 0) - (a.board12 || 0));

  const recentSet = new Set(chrono.slice(-Math.min(10, Math.floor(chrono.length / 2))));
  const principles = HABITS.map((h) => {
    const rate = (fs) => (fs.length ? fs.filter((f) => f.habits[h.key]).length / fs.length : null);
    const recent = chrono.filter((f) => recentSet.has(f));
    const earlier = chrono.filter((f) => !recentSet.has(f));
    return { key: h.key, text: h.text, good: h.key === 'castled10' || h.key === 'dev3', rate: rate(facts), recent: recent.length >= 3 ? rate(recent) : null, earlier: earlier.length >= 3 ? rate(earlier) : null };
  });

  const byPiece = {};
  for (const f of facts) for (const { piece, gap } of f.pieceGaps) (byPiece[piece] ||= []).push(gap);
  const pieces = Object.entries(byPiece)
    .map(([piece, gaps]) => ({ piece, name: PIECES[piece], n: gaps.length, avgGap: mean(gaps), costly: gaps.filter((x) => x > 8).length / gaps.length }))
    .sort((a, b) => b.avgGap - a.avgGap);

  const checked = facts.filter((f) => f.engine);
  const wins = facts.filter((f) => f.result === 1);
  const losses = facts.filter((f) => f.result === 0);

  return {
    n,
    score: score(facts),
    board12: mean(facts.map((f) => f.board12)),
    avgGap: mean(facts.map((f) => f.avgGap)),
    byColor: Object.fromEntries(['w', 'b'].map((c) => {
      const fs = facts.filter((f) => f.color === c);
      return [c, { n: fs.length, score: score(fs), board12: mean(fs.map((f) => f.board12)) }];
    })),
    trend,
    improvement,
    curves: { all: averageCurve(facts), wins: wins.length >= 2 ? averageCurve(wins) : [], losses: losses.length >= 2 ? averageCurve(losses) : [] },
    slip: slipPoint(averageCurve(losses)),
    openings,
    principles,
    pieces,
    habits: habitPatterns(facts.map((f) => f.game.report)),
    engine: checked.length
      ? {
          checked: checked.length,
          acpl: mean(checked.map((f) => f.engine.acpl).filter((x) => x !== null)),
          blundersPerGame: mean(checked.map((f) => f.engine.blunders)),
          mistakesPerGame: mean(checked.map((f) => f.engine.mistakes)),
        }
      : null,
    timeClasses: [...new Set(facts.map((f) => f.timeClass).filter(Boolean))],
  };
}

// The first full move after which your average board share in lost games
// stays below -5.
function slipPoint(curve) {
  for (let i = 2; i < curve.length; i++) {
    if (curve.slice(i).every((v) => v < -5)) return Math.ceil(i / 2);
  }
  return null;
}

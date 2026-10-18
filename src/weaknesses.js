// Finds the patterns that cost you the most across your games and ranks them,
// each with evidence, a lesson, example moves and a way to practise it
// against Stockfish. Pure functions over gameFacts() results.

import { TAGS } from './insights.js';

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const score = (fs) => mean(fs.filter((f) => f.result !== null).map((f) => f.result));
const pct = (x) => `${Math.round(x * 100)}%`;
const signed = (x) => `${x > 0 ? '+' : ''}${x.toFixed(1)}`;
export const MIN_GAMES = 5;

// Habit weaknesses: bad habits you have, or good habits you skip.
const HABIT_RULES = [
  { key: 'earlyQueen', bad: true, tag: 'early-queen', title: 'Bringing the queen out early', lesson: 'An early queen gets chased by smaller pieces, and every chase is a free developing move for your opponent. Bring out knights and bishops first.', focus: 'Develop knights and bishops before the queen' },
  { key: 'repeats', bad: true, tag: 'repeat-piece', title: 'Moving the same piece twice in the opening', lesson: 'Each repeat move is a move your other pieces didn’t get. Unless you’re capturing or escaping, move a new piece.', focus: 'Move each piece once before moving one twice' },
  { key: 'flank', bad: true, tag: 'flank-pawn', title: 'Pushing edge pawns early', lesson: 'Edge pawns barely touch the centre. Spend your first moves on centre pawns and pieces, then use flank pawns with a purpose.', focus: 'Keep edge pawns home in the opening' },
  { key: 'castled10', bad: false, habit: 'castle', title: 'Leaving your king in the centre', lesson: 'An uncastled king is the first target once the centre opens. Castle by move 10 so your rooks connect and your pieces can attack freely.', focus: 'Castle by move 10' },
  { key: 'dev3', bad: false, habit: 'develop', title: 'Slow development', lesson: 'With fewer than three minor pieces out by move 8, you’re playing with less army than your opponent. Develop a new piece almost every move.', focus: 'Get three minor pieces out by move 8' },
];

// Recurring move mistakes, by principle tag.
const TAG_RULES = [
  { tag: 'hangs', title: 'Leaving pieces en prise', focus: 'Check what is attacked before every move', punish: 'inaccuracies' },
  { tag: 'blocks-bishop', title: 'Blocking your own bishops', focus: 'Keep diagonals open for your bishops' },
  { tag: 'rim-knight', title: 'Knights on the rim', focus: 'Develop knights towards the centre' },
  { tag: 'king-walk', title: 'Losing the right to castle', focus: 'Keep your king safe and castle early' },
];

function habitWeakness(rule, facts) {
  const has = (f) => (rule.bad ? f.habits[rule.key] : !f.habits[rule.key]);
  const yes = facts.filter(has);
  const no = facts.filter((f) => !has(f));
  if (yes.length < 2 || no.length < 2 || yes.length / facts.length < 0.15) return null;
  const domCost = mean(no.map((f) => f.board12)) - mean(yes.map((f) => f.board12));
  const sy = score(yes);
  const sn = score(no);
  const scoreCost = sy !== null && sn !== null ? sn - sy : 0;
  if (domCost < 2 && scoreCost < 0.05) return null;
  const freq = yes.length / facts.length;
  const evidence = [`In ${yes.length} of ${facts.length} games.`];
  if (sy !== null && sn !== null) evidence.push(`You score ${pct(sy)} in those games and ${pct(sn)} in the rest.`);
  evidence.push(`Board after move 12: ${signed(mean(yes.map((f) => f.board12)))} with it, ${signed(mean(no.map((f) => f.board12)))} without.`);
  const examples = rule.tag
    ? tagExamples(yes, rule.tag)
    : yes.slice(0, 6).map((f) => ({ game: f.game, ply: Math.min(f.game.game.plies.length - 1, rule.key === 'castled10' ? 19 : 15) }));
  return {
    key: `habit:${rule.key}`, kind: 'habit', title: rule.title, lesson: rule.lesson, evidence,
    impact: freq * (Math.max(0, scoreCost) * 2 + Math.max(0, domCost) / 10),
    examples,
    practice: { type: 'focus', focus: rule.focus, tag: rule.tag || null, habit: rule.habit || null },
  };
}

function tagExamples(facts, tag) {
  const out = [];
  for (const f of facts) {
    f.game.game.plies.forEach((p, i) => {
      if (p.color === f.color && p.tags.includes(tag)) out.push({ game: f.game, ply: i, gap: p.gap || 0 });
    });
  }
  return out.sort((a, b) => b.gap - a.gap).slice(0, 8);
}

function tagWeakness(rule, facts) {
  const examples = tagExamples(facts, rule.tag);
  const total = facts.reduce((s, f) => s + (f.game.report.tagCounts[rule.tag] || 0), 0);
  const perGame = total / facts.length;
  if (perGame < 0.3 || examples.length < 2) return null;
  const avgGap = mean(examples.map((e) => e.gap));
  return {
    key: `tag:${rule.tag}`, kind: 'tag', title: rule.title, lesson: TAGS[rule.tag].lesson,
    evidence: [`${total} times in ${facts.length} games (${perGame.toFixed(1)} per game).`, `Each one gives away about ${(avgGap / 10).toFixed(1)} pawns of board and material against the best option.`],
    impact: perGame * (avgGap / 15),
    examples,
    practice: { type: 'focus', focus: rule.focus, tag: rule.tag, punish: rule.punish || null },
  };
}

function openingWeakness(facts, openings) {
  const overall = score(facts);
  const overallBoard = mean(facts.map((f) => f.board12));
  const candidates = openings
    .filter((o) => o.n >= 3 && o.score !== null)
    .map((o) => ({ o, gap: (overall - o.score) + Math.max(0, overallBoard - o.board12) / 20 }))
    .filter(({ o, gap }) => gap > 0.12 && (o.score <= overall - 0.1 || o.board12 <= overallBoard - 5))
    .sort((a, b) => b.gap - a.gap);
  if (!candidates.length) return null;
  const { o, gap } = candidates[0];
  const these = facts.filter((f) => f.opening.key === o.key);
  return {
    key: `opening:${o.key}`, kind: 'opening',
    title: `Your ${o.moves} as ${o.color === 'w' ? 'White' : 'Black'}${o.name ? ` (${o.name})` : ''}`,
    lesson: 'Play this opening against Stockfish from the position where your games usually start, and watch which squares your pieces fight for. You learn more from the board than from memorising lines.',
    evidence: [`${o.n} games, scoring ${pct(o.score)} against your overall ${pct(overall)}.`, `Board after move 12: ${signed(o.board12)} (you average ${signed(overallBoard)}).`],
    impact: (o.n / facts.length) * gap * 3,
    examples: these.slice(0, 8).map((f) => ({ game: f.game, ply: Math.min(f.game.game.plies.length - 1, 7) })),
    practice: { type: 'opening', color: o.color, fen: these[0].game.game.positions[Math.min(4, these[0].game.game.positions.length - 1)].fen, moves: o.moves },
  };
}

const PHASES = [
  { key: 'opening', text: 'the opening (moves 1–12)', test: (m) => m <= 12 },
  { key: 'middlegame', text: 'the middlegame (moves 13–30)', test: (m) => m > 12 && m <= 30 },
  { key: 'endgame', text: 'the endgame (after move 30)', test: (m) => m > 30 },
];

function blunderWeakness(facts) {
  const checked = facts.filter((f) => f.game.engine);
  if (checked.length < 3) return null;
  const counts = Object.fromEntries(PHASES.map((p) => [p.key, []]));
  for (const f of checked) {
    const { plies } = f.game.game;
    f.game.engine.plies.forEach((e, i) => {
      const p = plies[i];
      if (!p || p.color !== f.color || (e.grade !== 'blunder' && e.grade !== 'mistake')) return;
      const phase = PHASES.find((ph) => ph.test(p.fullmove));
      counts[phase.key].push({ game: f.game, ply: i, gap: e.loss });
    });
  }
  const worst = PHASES.map((p) => ({ p, list: counts[p.key], perGame: counts[p.key].length / checked.length })).sort((a, b) => b.perGame - a.perGame)[0];
  if (worst.perGame < 0.6) return null;
  return {
    key: `blunders:${worst.p.key}`, kind: 'engine', title: `Mistakes in ${worst.p.text}`,
    lesson: 'Most of these are pieces left undefended or checks and captures you didn’t look at. Before each move, ask: what does my opponent attack after this?',
    evidence: [`${worst.perGame.toFixed(1)} engine mistakes or blunders per game in ${worst.p.text}, across ${checked.length} checked games.`],
    impact: worst.perGame * 0.6,
    examples: worst.list.sort((a, b) => b.gap - a.gap).slice(0, 8),
    practice: { type: 'focus', focus: 'Blunder check: what does your opponent attack after your move?', tag: 'hangs', punish: 'inaccuracies' },
  };
}

function conversionWeakness(facts) {
  const checked = facts.filter((f) => f.game.engine);
  if (checked.length < 3) return null;
  const thrown = [];
  let winning = 0;
  for (const f of checked) {
    const sign = f.color === 'w' ? 1 : -1;
    const evals = f.game.engine.evals.map((v) => sign * v);
    let peak = -Infinity;
    let at = 0;
    evals.forEach((v, i) => { if (v > peak) { peak = v; at = i; } });
    if (peak < 250) continue;
    winning++;
    if (f.result !== 1) thrown.push({ f, at, peak });
  }
  if (thrown.length < 2 || thrown.length / winning < 0.25) return null;
  return {
    key: 'convert', kind: 'engine', title: 'Letting winning positions slip',
    lesson: 'Once you’re clearly better, trade pieces, keep your king safe and stop giving counterplay. Simple moves win won positions.',
    evidence: [`You reached a winning position (+2.5 or better) in ${winning} checked games but won only ${winning - thrown.length}.`],
    impact: (thrown.length / checked.length) * 1.5,
    examples: thrown.map(({ f, at }) => ({ game: f.game, ply: Math.max(0, at - 1) })),
    practice: {
      type: 'positions',
      focus: 'Convert the win: trade down and stay safe',
      positions: thrown.map(({ f, at }) => ({ fen: f.game.game.positions[at].fen, color: f.color })).filter((p) => p.fen.split(' ')[1] === p.color).concat(
        thrown.map(({ f, at }) => ({ fen: f.game.game.positions[Math.min(at + 1, f.game.game.positions.length - 1)].fen, color: f.color })).filter((p) => p.fen.split(' ')[1] === p.color),
      ).slice(0, 6),
    },
  };
}

// facts: gameFacts() for each game; openings: aggregate(facts).openings
export function findWeaknesses(facts, openings) {
  if (facts.length < MIN_GAMES) return [];
  const found = [
    ...HABIT_RULES.map((r) => habitWeakness(r, facts)),
    ...TAG_RULES.map((r) => tagWeakness(r, facts)),
    openingWeakness(facts, openings),
    blunderWeakness(facts),
    conversionWeakness(facts),
  ].filter(Boolean);
  // A habit and its matching tag describe the same leak; keep the stronger.
  const seen = new Map();
  for (const w of found) {
    const id = w.practice.tag || w.key;
    if (!seen.has(id) || seen.get(id).impact < w.impact) seen.set(id, w);
  }
  return [...seen.values()].filter((w) => w.impact > 0.02).sort((a, b) => b.impact - a.impact);
}

// Did a practice move repeat the habit being worked on?
export function isSlip(practice, move, analysisAfter) {
  if (!practice) return false;
  if (practice.tag && move.tags && move.tags.includes(practice.tag)) return true;
  const me = analysisAfter && analysisAfter[move.color];
  if (practice.habit === 'castle' && me && move.fullmove === 10 && !me.castled) return true;
  if (practice.habit === 'develop' && me && move.fullmove === 8 && me.developed < 3) return true;
  return false;
}

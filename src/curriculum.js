// A course of chess skills. Each skill has a short lesson, exercises (Lichess
// puzzles for tactics and endgames, positions from your own games for
// opening and middlegame fundamentals), a mastery test and an "apply it"
// game against Stockfish. The path is ordered by your own weaknesses.

export const GROUPS = [
  { key: 'tactics', text: 'Tactics' },
  { key: 'mates', text: 'Checkmates' },
  { key: 'opening', text: 'Opening fundamentals' },
  { key: 'middlegame', text: 'Middlegame' },
  { key: 'endgame', text: 'Endgames' },
];

// source: 'puzzles' (themes) or 'games' (positions from your games matching `drill`).
// apply: what the practice game checks.
export const SKILLS = [
  {
    id: 'hanging', group: 'tactics', title: 'Spot hanging pieces', source: 'puzzles', themes: ['hangingPiece'],
    drill: { tag: 'hangs' }, apply: { kind: 'noBlunder', focus: 'Check what is attacked before every move' },
    prompt: 'Something is undefended. Win it.',
    lesson: [
      ['A piece is hanging when it can be taken for free', 'It is attacked and nothing defends it, or it is attacked by something worth less than it is. Most games below 1600 are decided by hanging pieces, not by deep plans.'],
      ['Ask two questions every move', 'Before you move: what did my opponent’s last move attack? After you choose your move: what will my opponent be able to take? Only then play it.'],
      ['Count attackers and defenders', 'If a piece is attacked twice and defended once, it falls. Captures happen cheapest first, so a pawn attacking your knight wins material even if the knight is defended.'],
      ['Look for loose pieces on both sides', 'A piece with no defender is a target even before it is attacked. Keep yours protected, and aim your moves at theirs.'],
    ],
  },
  {
    id: 'defend', group: 'tactics', title: 'Defend against threats', source: 'puzzles', themes: ['defensiveMove'],
    drill: { fundamental: 'tactics' }, apply: { kind: 'noBlunder', focus: 'Find your opponent’s threat before you move' },
    prompt: 'Your opponent is threatening something. Find the move that holds.',
    lesson: [
      ['Every move has a threat behind it', 'When your opponent moves, stop and ask what they want to do next. Checks, captures and attacks on undefended pieces come first.'],
      ['Four ways to meet a threat', 'Move the attacked piece, defend it, block the line of attack, or capture the attacker. Pick the one that leaves you most active.'],
      ['Counter-attack only when it’s bigger', 'Ignoring a threat works only if your own threat is larger, such as a check or winning more material. Otherwise, deal with it.'],
    ],
  },
  {
    id: 'fork', group: 'tactics', title: 'Forks', source: 'puzzles', themes: ['fork'], drill: null,
    apply: { kind: 'noBlunder', focus: 'Look for squares that attack two targets' },
    prompt: 'Find the move that attacks two things at once.',
    lesson: [
      ['One piece, two targets', 'A fork attacks two pieces at once. Your opponent can only save one, so you win the other.'],
      ['Knights are the best forkers', 'A knight jumps and attacks in a ring of up to eight squares. Look for knight checks that also hit the queen or a rook.'],
      ['Line up the targets', 'Kings, queens and undefended pieces make the best targets. When two of them sit a knight’s jump apart, or on the same diagonal or line as one square, there may be a fork.'],
      ['Pawns fork too', 'A pawn pushed between two pieces attacks both. It is the cheapest piece, so it always wins material.'],
    ],
  },
  {
    id: 'pin', group: 'tactics', title: 'Pins and skewers', source: 'puzzles', themes: ['pin', 'skewer'], drill: null,
    apply: { kind: 'noBlunder', focus: 'Look for pieces lined up with the king or queen' },
    prompt: 'Use a line: pin or skewer a piece.',
    lesson: [
      ['A pin freezes a piece', 'When a piece stands in front of a more valuable one on a line, a bishop, rook or queen can pin it. If the piece moves, the one behind is lost. Pinned to the king, it can’t legally move at all.'],
      ['Attack the pinned piece', 'A pinned piece can’t run away. Pile up on it, especially with pawns.'],
      ['A skewer is a pin in reverse', 'Attack the more valuable piece first. When it moves away, you take what was behind it.'],
    ],
  },
  {
    id: 'discovered', group: 'tactics', title: 'Discovered attacks', source: 'puzzles', themes: ['discoveredAttack'], drill: null,
    apply: { kind: 'noBlunder', focus: 'Look for pieces you can move out of a line' },
    prompt: 'Move one piece to unleash another.',
    lesson: [
      ['Two attacks with one move', 'When a piece moves out of the way of a bishop, rook or queen behind it, that line opens. The moving piece can make its own threat at the same time.'],
      ['Discovered check is the strongest', 'If the uncovered line gives check, the moving piece can go almost anywhere, even capture something defended, because the check must be answered first.'],
    ],
  },
  {
    id: 'trapped', group: 'tactics', title: 'Trapping pieces', source: 'puzzles', themes: ['trappedPiece'], drill: { fundamental: 'activity' },
    apply: { kind: 'noBlunder', focus: 'Look for enemy pieces with no safe squares' },
    prompt: 'A piece has nowhere to go. Trap it.',
    lesson: [
      ['A piece with no safe squares is half lost', 'Use the Freedom overlay: an enemy piece with a red 0 or 1 badge is a candidate. Attack it and it can’t escape.'],
      ['Edges and corners are traps', 'Bishops deep in enemy territory and knights on the rim run out of squares fastest. Don’t send your own pieces there without a way back.'],
    ],
  },
  {
    id: 'mate', group: 'mates', title: 'Checkmate patterns', source: 'puzzles', themes: ['mateIn1', 'backRankMate', 'mateIn2'], drill: null,
    apply: { kind: 'noBlunder', focus: 'Check every check: is one of them mate?' },
    prompt: 'Find the checkmate.',
    lesson: [
      ['Checks first', 'Before anything else, look at every check you have. Forcing moves leave your opponent the fewest replies.'],
      ['The back rank', 'A king behind its own unmoved pawns has no escape square. A rook or queen landing on that rank is often mate. Give your own king a flight square (h3 or g3) once the middle game starts.'],
      ['Take away the squares', 'Mate needs every square around the king covered or blocked. Count them: your checking piece covers some, your other pieces and the king’s own pieces cover the rest.'],
    ],
  },
  {
    id: 'attack', group: 'mates', title: 'Attacking the king', source: 'puzzles', themes: ['kingsideAttack'], drill: { fundamental: 'king' },
    apply: { kind: 'noBlunder', focus: 'Bring more attackers than they have defenders' },
    prompt: 'Break through to the king.',
    lesson: [
      ['Attack with more pieces than they defend with', 'Before attacking, count your pieces aimed at the king against their defenders. Bring the extra piece in first.'],
      ['Open lines towards the king', 'Pawn breaks and sacrifices that rip open the king’s shelter let your rooks and queen in.'],
    ],
  },
  {
    id: 'centre', group: 'opening', title: 'Control the centre', source: 'games', drill: { fundamental: 'centre' },
    apply: { kind: 'board', focus: 'Fight for d4, e4, d5 and e5' },
    prompt: 'Find the move that claims the most central squares.',
    lesson: [
      ['The centre is where pieces are strongest', 'A knight on e4 reaches eight squares; on a1 it reaches two. Pawns on d4 and e4 claim the squares your pieces want and keep your opponent’s out.'],
      ['Occupy with pawns, support with pieces', 'Start with one or two centre pawns, then develop knights and bishops that guard them.'],
      ['Watch the Control overlay', 'Amber is your territory, indigo theirs. Good opening moves turn central squares amber.'],
    ],
  },
  {
    id: 'develop', group: 'opening', title: 'Develop your pieces', source: 'games', drill: { fundamental: 'development' },
    apply: { kind: 'slips', tags: ['early-queen', 'repeat-piece', 'flank-pawn'], focus: 'A new piece every move, queen last' },
    prompt: 'Develop: which piece should come out, and where?',
    lesson: [
      ['Knights and bishops first', 'Get them off the back rank in the first moves, aimed at the centre. A piece at home controls almost nothing.'],
      ['Each piece once', 'Moving the same piece twice in the opening gives your opponent a free move. Only do it to capture or escape an attack.'],
      ['Queen last', 'An early queen gets chased by smaller pieces, and every chase develops their army.'],
      ['Edge pawns can wait', 'a-, b-, g- and h-pawn moves don’t fight for the centre or develop anything.'],
    ],
  },
  {
    id: 'king', group: 'opening', title: 'Keep your king safe', source: 'games', drill: { fundamental: 'king' },
    apply: { kind: 'castle', focus: 'Castle by move 10' },
    prompt: 'Find the move that keeps your king safest.',
    lesson: [
      ['Castle early', 'Aim to castle by move 10. It tucks the king away and brings a rook towards the centre.'],
      ['Keep the shelter', 'The pawns in front of your castled king are its walls. Every pawn move there creates a hole.'],
      ['Don’t lose the right to castle', 'Moving your king or the rooks early can leave your king stuck in the centre, where lines open first.'],
    ],
  },
  {
    id: 'activity', group: 'middlegame', title: 'Activate your pieces', source: 'games', drill: { fundamental: 'activity' },
    apply: { kind: 'slips', tags: ['rim-knight', 'blocks-bishop'], focus: 'Put every piece where it has the most safe squares' },
    prompt: 'Find the move that makes your worst piece better.',
    lesson: [
      ['Improve your worst piece', 'When there’s no tactic, find your least active piece (the Freedom overlay shows its safe-move count) and give it a better square.'],
      ['Knights need outposts', 'A knight on a central square that pawns can’t attack is a monster. On the rim it is half a piece.'],
      ['Open lines for bishops and rooks', 'Don’t block your bishops with your own pawns. Put rooks on open files.'],
    ],
  },
  {
    id: 'opening-tactics', group: 'middlegame', title: 'Punish opening mistakes', source: 'puzzles', themes: ['opening'], drill: { phase: 'opening' },
    apply: { kind: 'noBlunder', focus: 'When they break a principle, look for the punishment' },
    prompt: 'Your opponent broke a rule in the opening. Punish it.',
    lesson: [
      ['Undeveloped means vulnerable', 'When your opponent moves the same piece twice or brings the queen out early, your extra developed pieces can create threats they can’t meet.'],
      ['The king in the centre', 'If they haven’t castled, opening the centre with a pawn break often wins material or mates.'],
    ],
  },
  {
    id: 'pawn-endgame', group: 'endgame', title: 'Pawn endgames', source: 'puzzles', themes: ['pawnEndgame', 'advancedPawn'], drill: { phase: 'endgame' },
    apply: { kind: 'noBlunder', focus: 'Activate the king and push passed pawns' },
    prompt: 'Find the winning plan in the endgame.',
    lesson: [
      ['The king is a fighting piece', 'Once queens are gone, bring your king to the centre. It defends pawns and escorts them forward.'],
      ['Passed pawns must be pushed', 'A pawn with no enemy pawns in front of it or on the next files is a passed pawn. The closer it is to promoting, the more pieces it ties down.'],
      ['Opposition', 'With kings facing each other two squares apart, the side not to move often wins the race for key squares.'],
    ],
  },
  {
    id: 'rook-endgame', group: 'endgame', title: 'Rook endgames', source: 'puzzles', themes: ['rookEndgame'], drill: { phase: 'endgame' },
    apply: { kind: 'noBlunder', focus: 'Keep your rook active and behind passed pawns' },
    prompt: 'Find the best rook move.',
    lesson: [
      ['Rooks belong behind passed pawns', 'Behind your own passed pawn, the rook gains scope as the pawn advances. Behind an enemy passer, it stops it.'],
      ['An active rook is worth a pawn', 'A rook attacking pawns from the side or the 7th rank usually beats a passive rook defending them.'],
      ['Cut the king off', 'Use your rook on a file or rank to keep the enemy king away from your pawns.'],
    ],
  },
];

export const skillById = (id) => SKILLS.find((s) => s.id === id);

// How the weaknesses found in your games map to skills.
const WEAKNESS_TO_SKILLS = {
  'tag:hangs': ['hanging', 'defend'],
  'tag:blocks-bishop': ['activity'],
  'tag:rim-knight': ['activity'],
  'tag:king-walk': ['king'],
  'habit:earlyQueen': ['develop'],
  'habit:repeats': ['develop'],
  'habit:flank': ['develop', 'centre'],
  'habit:castled10': ['king'],
  'habit:dev3': ['develop'],
  convert: ['rook-endgame', 'pawn-endgame'],
};
const DEFAULT_ORDER = ['hanging', 'defend', 'centre', 'develop', 'king', 'fork', 'mate', 'pin', 'discovered', 'activity', 'trapped', 'opening-tactics', 'attack', 'pawn-endgame', 'rook-endgame'];

// Learning path: skills that address your biggest weaknesses come first.
// weaknesses: findWeaknesses() output; problems: problemMap(mistakes).rows
export function learningPath(weaknesses = [], problems = []) {
  const score = Object.fromEntries(SKILLS.map((s) => [s.id, 0]));
  const reasons = {};
  weaknesses.forEach((w, rank) => {
    let ids = WEAKNESS_TO_SKILLS[w.key];
    if (!ids && w.key.startsWith('opening:')) ids = ['centre', 'develop'];
    if (!ids && w.key.startsWith('blunders:')) ids = w.key.endsWith('endgame') ? ['pawn-endgame', 'rook-endgame'] : ['hanging', 'defend', 'fork'];
    for (const id of ids || []) {
      score[id] += w.impact * (1 + 1 / (rank + 1));
      reasons[id] ||= w;
    }
  });
  const totalCost = problems.reduce((s, r) => s + r.cost, 0) || 1;
  const byFund = { tactics: ['hanging', 'defend'], development: ['develop'], king: ['king'], activity: ['activity'], centre: ['centre'] };
  for (const r of problems) {
    for (const id of byFund[r.key] || []) {
      score[id] += 0.3 * (r.cost / totalCost);
      if (r.n) reasons[id] ||= { kind: 'problem', title: r.text, evidence: [`${r.n} of your costly moves were about ${r.text.toLowerCase()}.`] };
    }
  }
  return SKILLS.map((s) => ({ skill: s, score: score[s.id], reason: reasons[s.id] || null }))
    .sort((a, b) => b.score - a.score || DEFAULT_ORDER.indexOf(a.skill.id) - DEFAULT_ORDER.indexOf(b.skill.id));
}

// ---------- puzzles ----------
export const LEVELS = [{ text: 'Level 1', max: 1000 }, { text: 'Level 2', max: 1300 }, { text: 'Level 3', max: 1600 }, { text: 'Level 4', max: 1900 }];

export function puzzlesFor(bank, skill) {
  return (skill.themes || []).flatMap((t) => (bank[t] || []).map(([id, fen, moves, rating]) => ({ id, fen, moves: moves.split(' '), rating, theme: t })));
}

const levelOf = (rating) => Math.max(0, LEVELS.findIndex((l) => rating < l.max));

export function newSkillProgress() {
  return { lesson: false, level: 0, recent: [], attempts: 0, solved: 0, seen: {}, apply: null };
}

// Next puzzle: a previously missed one that is due, else an unseen one at your level.
export function nextPuzzle(puzzles, sp, round) {
  const missed = puzzles.filter((p) => sp.seen[p.id] && !sp.seen[p.id].ok && round - sp.seen[p.id].at >= 3);
  if (missed.length) return missed[0];
  const fresh = puzzles.filter((p) => !sp.seen[p.id]);
  const atLevel = fresh.filter((p) => levelOf(p.rating) === sp.level);
  const pool = atLevel.length ? atLevel : fresh.filter((p) => levelOf(p.rating) <= sp.level).concat(fresh);
  if (pool.length) return pool[Math.floor(pool.length * 0.37) % pool.length];
  // Bank exhausted: revisit the oldest.
  return puzzles.slice().sort((a, b) => sp.seen[a.id].at - sp.seen[b.id].at)[0] || null;
}

// Record a puzzle answer and adapt the level: three right in a row moves up,
// two misses in a row moves down.
export function recordPuzzle(sp, puzzle, ok, round) {
  sp.seen[puzzle.id] = { ok, at: round };
  sp.attempts++;
  if (ok) sp.solved++;
  sp.recent.push(ok);
  if (sp.recent.length > 15) sp.recent.shift();
  sp.streak = ok ? (sp.streak || 0) + 1 : 0;
  sp.misses = ok ? 0 : (sp.misses || 0) + 1;
  if (sp.streak >= 3 && sp.level < LEVELS.length - 1) { sp.level++; sp.streak = 0; }
  if (sp.misses >= 2 && sp.level > 0) { sp.level--; sp.misses = 0; }
  return sp;
}

// The moves the user has to find, and the replies played automatically.
// Lichess puzzles start with the opponent's move; the user plays the odd plies.
export function puzzleLine(puzzle) {
  return { setup: puzzle.moves[0], line: puzzle.moves.slice(1) };
}

// Mastery steps for a skill. drills: mastery() of the linked drills, or null.
export function skillStatus(skill, sp, drills) {
  const answered = sp.recent.length;
  const right = sp.recent.filter(Boolean).length;
  const exercisesDone = skill.source === 'puzzles'
    ? answered >= 12 && right / answered >= 0.8 && sp.level >= 1
    : drills ? drills.mastered : false;
  const steps = [
    { key: 'lesson', text: 'Read the lesson', done: sp.lesson },
    { key: 'exercises', text: skill.source === 'puzzles' ? 'Solve 80% of your last 12+ exercises (Level 2 or higher)' : 'Master the positions from your games', done: exercisesDone, detail: skill.source === 'puzzles' ? `${right}/${answered} recent · ${LEVELS[sp.level].text}` : drills ? `${drills.solid}/${drills.total} solid` : 'No positions yet' },
  ];
  if (skill.source === 'puzzles' && drills && drills.total) steps.push({ key: 'yours', text: 'Solve the same idea in your own games', done: drills.mastered, detail: `${drills.solid}/${drills.total} solid` });
  steps.push({ key: 'apply', text: skill.apply.kind === 'noBlunder' ? 'Play Stockfish without a blunder' : skill.apply.kind === 'castle' ? 'Castle by move 10 in a game vs Stockfish' : skill.apply.kind === 'board' ? 'Hold the board at move 12 in a game vs Stockfish' : 'Play a game vs Stockfish with no slips', done: !!(sp.apply && sp.apply.passed) });
  const done = steps.filter((s) => s.done).length;
  const state = done === steps.length ? 'mastered' : done === 0 ? 'new' : 'learning';
  return { steps, done, total: steps.length, state };
}

// Did a practice game pass the skill's "apply it" test?
// positions: PlaySession positions; color: you; engineGrades: grades of your moves.
export function applyPassed(skill, positions, color) {
  const mine = positions.filter((p) => p.move && p.move.color === color);
  if (mine.length < 8) return { passed: false, reason: 'Play at least 8 moves.' };
  const a = skill.apply;
  if (a.kind === 'noBlunder') {
    const blunders = mine.filter((p) => p.engine && p.engine.grade.key === 'blunder').length;
    return { passed: blunders === 0, reason: blunders ? `${blunders} blunder${blunders > 1 ? 's' : ''}.` : 'No blunders.' };
  }
  if (a.kind === 'castle') {
    const castled = mine.some((p) => p.move.fullmove <= 10 && p.analysis[color].castled);
    return { passed: castled, reason: castled ? 'Castled in time.' : 'Not castled by move 10.' };
  }
  if (a.kind === 'board') {
    const at12 = positions.find((p) => p.move && p.move.fullmove === 12 && p.move.color === color);
    const sign = color === 'w' ? 1 : -1;
    const ok = at12 && sign * at12.analysis.dominance >= 0;
    return { passed: !!ok, reason: at12 ? (ok ? 'You held the board at move 12.' : 'Your opponent owned more of the board at move 12.') : 'Play past move 12.' };
  }
  const slips = mine.filter((p) => p.move.tags && p.move.tags.some((t) => a.tags.includes(t))).length;
  return { passed: slips === 0, reason: slips ? `${slips} slip${slips > 1 ? 's' : ''}.` : 'No slips.' };
}

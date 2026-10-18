// Board-dominance analysis.
//
// Everything here is measured directly from the position — no engine, no
// opening book. The goal is to make "who is dominating the board, and why"
// visible: which squares each side controls, how many *safe* moves each
// side's pieces have, which pieces are cramped, and what each move changes.

export const VALUES = { p: 1, n: 3, b: 3.25, r: 5, q: 9, k: 100 };
export const PIECE_NAMES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

const FILES = 'abcdefgh';
export const sqName = (i) => FILES[i & 7] + ((i >> 3) + 1);
export const sqIndex = (s) => (s.charCodeAt(1) - 49) * 8 + (s.charCodeAt(0) - 97);
export const other = (c) => (c === 'w' ? 'b' : 'w');

const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

// The 4 central squares count double; the ring around them counts once.
const CENTER_WEIGHT = new Array(64).fill(0);
for (const s of ['c3', 'd3', 'e3', 'f3', 'c4', 'f4', 'c5', 'f5', 'c6', 'd6', 'e6', 'f6']) CENTER_WEIGHT[sqIndex(s)] = 1;
for (const s of ['d4', 'e4', 'd5', 'e5']) CENTER_WEIGHT[sqIndex(s)] = 2;
export const isCenter = (i) => CENTER_WEIGHT[i] > 0;

const HOME_MINORS = {
  w: [['b1', 'n'], ['g1', 'n'], ['c1', 'b'], ['f1', 'b']],
  b: [['b8', 'n'], ['g8', 'n'], ['c8', 'b'], ['f8', 'b']],
};
const CASTLED_SQUARES = { w: ['g1', 'h1', 'c1', 'b1'], b: ['g8', 'h8', 'c8', 'b8'] };

const inBoard = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;

export function gridFrom(chess) {
  const g = new Array(64).fill(null);
  for (const row of chess.board()) {
    for (const p of row) if (p) g[sqIndex(p.square)] = { type: p.type, color: p.color };
  }
  return g;
}

// Squares attacked by the piece on square i. With xray, sliders see through
// friendly sliders moving on the same line (batteries such as Q behind B).
export function attacksFrom(g, i, xray = false) {
  const p = g[i];
  const f = i & 7;
  const r = i >> 3;
  const out = [];
  const step = (df, dr) => {
    if (inBoard(f + df, r + dr)) out.push((r + dr) * 8 + f + df);
  };
  if (p.type === 'p') {
    const d = p.color === 'w' ? 1 : -1;
    step(-1, d);
    step(1, d);
  } else if (p.type === 'n') {
    for (const [df, dr] of KNIGHT) step(df, dr);
  } else if (p.type === 'k') {
    for (const [df, dr] of KING) step(df, dr);
  } else {
    const dirs = p.type === 'b' ? DIAG : p.type === 'r' ? ORTH : DIAG.concat(ORTH);
    for (const [df, dr] of dirs) {
      const diag = df !== 0 && dr !== 0;
      let nf = f + df;
      let nr = r + dr;
      while (inBoard(nf, nr)) {
        const j = nr * 8 + nf;
        out.push(j);
        const q = g[j];
        if (q) {
          const sameLine = q.type === 'q' || (diag ? q.type === 'b' : q.type === 'r');
          if (!(xray && q.color === p.color && sameLine)) break;
        }
        nf += df;
        nr += dr;
      }
    }
  }
  return out;
}

// Pieces of `color` pinned to their own king, mapped to the squares they may
// still move to (along the pin line).
function findPins(g, color) {
  const pins = new Map();
  const k = g.findIndex((p) => p && p.type === 'k' && p.color === color);
  if (k < 0) return pins;
  for (const [df, dr] of DIAG.concat(ORTH)) {
    const diag = df !== 0 && dr !== 0;
    let nf = (k & 7) + df;
    let nr = (k >> 3) + dr;
    let shield = -1;
    const ray = [];
    while (inBoard(nf, nr)) {
      const j = nr * 8 + nf;
      ray.push(j);
      const q = g[j];
      if (q) {
        if (q.color === color) {
          if (shield >= 0) break;
          shield = j;
        } else {
          if (shield >= 0 && (q.type === 'q' || (diag ? q.type === 'b' : q.type === 'r'))) {
            pins.set(shield, new Set(ray));
          }
          break;
        }
      }
      nf += df;
      nr += dr;
    }
  }
  return pins;
}

// Static exchange evaluation: the attackers on each side capture on a square
// cheapest-first, and either side may stop when continuing would lose.
// Returns what the owner of a piece worth `value` loses if `opp` starts.
export function exchangeLoss(value, opp, mine) {
  const lists = [opp.slice().sort((a, b) => a - b), mine.slice().sort((a, b) => a - b)];
  const next = [0, 0];
  const gain = [];
  let captured = value;
  let side = 0;
  let d = 0;
  while (next[side] < lists[side].length) {
    gain[d] = captured - (d > 0 ? gain[d - 1] : 0);
    captured = lists[side][next[side]++];
    side ^= 1;
    d++;
  }
  for (let k = d - 1; k > 0; k--) gain[k - 1] = -Math.max(-gain[k - 1], gain[k]);
  return d ? Math.max(0, gain[0]) : 0;
}

const withoutOne = (list, v) => {
  const i = list.indexOf(v);
  return i < 0 ? list : list.slice(0, i).concat(list.slice(i + 1));
};

export function analyzePosition(chess) {
  const g = gridFrom(chess);
  // attackers[c][j]: values of c's pieces attacking square j.
  const attackers = { w: [], b: [] };
  for (let j = 0; j < 64; j++) {
    attackers.w.push([]);
    attackers.b.push([]);
  }
  for (let i = 0; i < 64; i++) {
    const p = g[i];
    if (!p) continue;
    for (const j of attacksFrom(g, i, true)) attackers[p.color][j].push(VALUES[p.type]);
  }
  const att = { w: attackers.w.map((l) => l.length), b: attackers.b.map((l) => l.length) };
  const minAtt = { w: attackers.w.map((l) => Math.min(...l)), b: attackers.b.map((l) => Math.min(...l)) };

  // Who owns each square: a pawn's guard beats any number of pieces,
  // otherwise more attackers wins; equal attackers means contested.
  const owner = new Array(64).fill(null);
  for (let i = 0; i < 64; i++) {
    const w = att.w[i];
    const b = att.b[i];
    if (!w && !b) continue;
    if (w && !b) owner[i] = 'w';
    else if (b && !w) owner[i] = 'b';
    else if (minAtt.w[i] === 1 && minAtt.b[i] !== 1) owner[i] = 'w';
    else if (minAtt.b[i] === 1 && minAtt.w[i] !== 1) owner[i] = 'b';
    else owner[i] = w > b ? 'w' : b > w ? 'b' : 'c';
  }

  const pins = { w: findPins(g, 'w'), b: findPins(g, 'b') };
  const pieces = [];
  const side = {};
  for (const c of ['w', 'b']) {
    side[c] = {
      controlled: 0, center: 0, space: 0, safeMobility: 0, mobility: 0, cramped: 0,
      developed: 0, castled: false, kingSafety: 0, kingPressure: 0, material: 0, hanging: [],
    };
  }

  for (let i = 0; i < 64; i++) {
    const p = g[i];
    if (!p) continue;
    const c = p.color;
    const o = other(c);
    const s = side[c];
    if (p.type !== 'k') s.material += VALUES[p.type];
    const piece = { square: sqName(i), index: i, type: p.type, color: c, safe: [], unsafe: [], pinned: pins[c].has(i), cramped: false };
    pieces.push(piece);

    if (p.type !== 'k') {
      const loss = exchangeLoss(VALUES[p.type], attackers[o][i], attackers[c][i]);
      if (loss > 0) s.hanging.push({ square: sqName(i), type: p.type, loss });
    }
    if (p.type === 'p' || p.type === 'k') continue;

    const v = VALUES[p.type];
    let targets = attacksFrom(g, i).filter((j) => !g[j] || g[j].color !== c);
    if (pins[c].has(i)) targets = targets.filter((j) => pins[c].get(i).has(j));
    // A square is safe if moving there doesn't lose material in the exchange.
    for (const j of targets) {
      const occ = g[j];
      const won = occ ? VALUES[occ.type] : 0;
      const safe = won - exchangeLoss(v, attackers[o][j], withoutOne(attackers[c][j], v)) >= 0;
      (safe ? piece.safe : piece.unsafe).push(sqName(j));
    }
    s.mobility += targets.length;
    s.safeMobility += piece.safe.length;
    piece.cramped = piece.safe.length <= 1;
    if (piece.cramped) s.cramped++;
  }

  // Control counts squares beyond your own first two ranks: guarding your
  // back rank is not influence over the board.
  for (let i = 0; i < 64; i++) {
    const c = owner[i];
    if (c !== 'w' && c !== 'b') continue;
    const r = i >> 3;
    if ((c === 'w' && r >= 2) || (c === 'b' && r <= 5)) side[c].controlled++;
    side[c].center += CENTER_WEIGHT[i];
    if ((c === 'w' && r >= 4) || (c === 'b' && r <= 3)) side[c].space++;
  }

  for (const c of ['w', 'b']) {
    const s = side[c];
    s.developed = HOME_MINORS[c].filter(([sq, t]) => {
      const p = g[sqIndex(sq)];
      return !(p && p.type === t && p.color === c);
    }).length;
    const k = g.findIndex((p) => p && p.type === 'k' && p.color === c);
    s.castled = k >= 0 && CASTLED_SQUARES[c].includes(sqName(k));
    // King safety: a castled king behind its pawns is safe; a king that has
    // lost the right to castle without castling is a long-term liability.
    if (s.castled) {
      const ahead = c === 'w' ? 1 : -1;
      let shield = 0;
      for (const df of [-1, 0, 1]) {
        for (const dr of [ahead, 2 * ahead]) {
          const f = (k & 7) + df;
          const r = (k >> 3) + dr;
          const p = inBoard(f, r) && g[r * 8 + f];
          if (p && p.type === 'p' && p.color === c) shield++;
        }
      }
      s.kingSafety = 2 + 0.75 * Math.min(shield, 3);
    } else {
      const rights = chess.getCastlingRights(c);
      if (!rights.k && !rights.q) s.kingSafety = -4;
    }
    if (k >= 0) {
      for (const [df, dr] of KING.concat([[0, 0]])) {
        const f = (k & 7) + df;
        const r = (k >> 3) + dr;
        if (inBoard(f, r)) s.kingPressure += att[other(c)][r * 8 + f];
      }
    }
    s.hanging.sort((a, b) => b.loss - a.loss);
  }

  const moveNumber = chess.moveNumber();
  const opening = moveNumber <= 15 ? 1 : moveNumber >= 25 ? 0 : (25 - moveNumber) / 10;
  const dominance = dominanceScore(side.w, side.b, opening);

  return { grid: g, owner, att, pieces, w: side.w, b: side.b, dominance, opening, turn: chess.turn(), moveNumber };
}

// Positive = White dominates. Roughly 10 points ≈ one pawn of positional pull.
export function dominanceScore(w, b, opening = 1) {
  return (
    (w.controlled - b.controlled) * 1 +
    (w.center - b.center) * 1 +
    (w.space - b.space) * 0.5 +
    (w.safeMobility - b.safeMobility) * 0.6 +
    (b.cramped - w.cramped) * 2 +
    (b.kingPressure - w.kingPressure) * 0.5 +
    opening * ((w.developed - b.developed) * 2.5 + (w.kingSafety - b.kingSafety) * 1.5)
  );
}

// Map a dominance score to the share of the board a side "owns" (0–100).
export const dominanceShare = (d) => 50 + 50 * Math.tanh(d / 40);

// Score from the perspective of `color` for a position just reached, where it
// is now the opponent's turn: material + dominance, minus what we leave en
// prise, plus a bonus for threats (a double threat is hard to parry).
export function scorePositionFor(a, color) {
  const sign = color === 'w' ? 1 : -1;
  const opp = other(color);
  let s = sign * (a.dominance + 10 * (a.w.material - a.b.material));
  const loss = a[color].hanging.length ? a[color].hanging[0].loss : 0;
  s -= 10 * loss;
  const threats = a[opp].hanging;
  if (threats.length >= 2) s += 8 * threats[1].loss;
  else if (threats.length === 1) s += Math.min(4, 2 + threats[0].loss);
  return s;
}

// Score every legal move in the current position. Returns moves sorted best
// first; each carries the analysis of the resulting position.
export function rankMoves(chess) {
  const color = chess.turn();
  const out = [];
  for (const m of chess.moves({ verbose: true })) {
    chess.move(m);
    const a = analyzePosition(chess);
    let score = scorePositionFor(a, color);
    if (m.san.includes('#')) score = 10000;
    else if (chess.isDraw()) score = Math.min(score, 0);
    chess.undo();
    out.push({ san: m.san, from: m.from, to: m.to, piece: m.piece, captured: m.captured, flags: m.flags, promotion: m.promotion, score, analysis: a });
  }
  out.sort((x, y) => y.score - x.score);
  return out;
}

// What a move changed, from the mover's point of view.
export function moveDeltas(before, after, color) {
  const me = color;
  const opp = other(color);
  const gained = [];
  const lost = [];
  for (let i = 0; i < 64; i++) {
    const was = before.owner[i] === me;
    const now = after.owner[i] === me;
    if (now && !was) gained.push(sqName(i));
    if (was && !now) lost.push(sqName(i));
  }
  const sign = color === 'w' ? 1 : -1;
  return {
    controlled: after[me].controlled - before[me].controlled,
    center: after[me].center - before[me].center,
    space: after[me].space - before[me].space,
    myMobility: after[me].safeMobility - before[me].safeMobility,
    oppMobility: after[opp].safeMobility - before[opp].safeMobility,
    oppCramped: after[opp].cramped - before[opp].cramped,
    dominance: sign * (after.dominance - before.dominance),
    gained,
    lost,
  };
}

// How good a move was relative to the most dominating move available.
export function labelForGap(gap, hangingLoss = 0) {
  if (gap <= 3) return 'dominant';
  if (gap <= 8) return 'good';
  if (gap <= 16 && hangingLoss < 2) return 'passive';
  if (gap <= 30) return 'concession';
  return 'mistake';
}

export const LABELS = {
  dominant: { text: 'Dominant', blurb: 'One of the most commanding moves available.' },
  good: { text: 'Good', blurb: 'Close to the most dominating option.' },
  passive: { text: 'Passive', blurb: 'Playable, but a stronger grip on the board was available.' },
  concession: { text: 'Concession', blurb: 'Gave the opponent noticeably more freedom or space.' },
  mistake: { text: 'Mistake', blurb: 'Lost material or a lot of board control.' },
};

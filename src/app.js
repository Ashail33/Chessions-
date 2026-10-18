import { Chess } from '../vendor/chess.js';
import { analyzePosition, rankMoves, dominanceShare, other, LABELS } from './analysis.js';
import { analyzeGame, slimGame, ANALYSIS_VERSION, assessMove, gameReport, habitPatterns, detectUserColor, describeDeltas, TAGS } from './insights.js';
import { splitPgn, compactPgn, gameKey, fetchLichess, fetchChessCom, TIME_CLASSES } from './import.js';
import { library } from './library.js';
import { Board } from './board.js';
import { renderChart } from './chart.js';
import { SAMPLES } from './samples.js';
import { Engine, formatScore, uciToMove } from './engine.js';
import { PlaySession, LEVELS, PUNISH, sideName } from './play.js';

const WINDOW = 40; // plies with every alternative ranked
const OPENING_MOVES = 12;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('chessions:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('chessions:' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const state = {
  games: [],
  current: -1,
  index: 0,
  variation: null,
  overlay: store.get('overlay', 'control'),
  freedom: store.get('freedom', 'opp'),
  showBest: store.get('showBest', true),
  flipped: false,
  mode: 'review',
  quiz: null,
  play: null,
  playIndex: null, // null follows the live position
  hint: null,
};
let engine = null;
let nextId = 1;

// ---------- analysis workers ----------
// A small pool so large libraries analyse in parallel.
const POOL_SIZE = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
const pool = [];
const pending = new Map();
for (let i = 0; i < POOL_SIZE; i++) {
  try {
    const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    const slot = { w, busy: 0, dead: false };
    w.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      slot.busy--;
      e.data.error ? p.reject(new Error(e.data.error)) : p.resolve(e.data.game);
    };
    w.onerror = () => {
      slot.dead = true;
      for (const [id, p] of pending) {
        if (p.slot !== slot) continue;
        pending.delete(id);
        p.reject(new Error('Worker failed'));
      }
    };
    pool.push(slot);
  } catch {
    break;
  }
}
const liveWorkers = () => pool.filter((s) => !s.dead);
const analyseHere = (pgn) => new Promise((resolve, reject) => setTimeout(() => {
  try { resolve(slimGame(analyzeGame(pgn, { window: WINDOW }))); } catch (err) { reject(err); }
}, 0));

function runAnalysis(id, pgn) {
  const live = liveWorkers();
  if (!live.length) return analyseHere(pgn);
  const slot = live.reduce((a, b) => (b.busy < a.busy ? b : a));
  slot.busy++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, slot });
    slot.w.postMessage({ id, pgn, window: WINDOW });
  }).catch((err) => {
    if (/Worker|module/i.test(err.message)) return analyseHere(pgn);
    throw err;
  });
}

// Stored analyses keep only summary numbers per position; the full board
// analysis is recomputed when a position is shown.
const analysisCache = new Map();
function analysisFor(fen) {
  let a = analysisCache.get(fen);
  if (!a) {
    a = analyzePosition(new Chess(fen));
    analysisCache.set(fen, a);
    if (analysisCache.size > 300) analysisCache.delete(analysisCache.keys().next().value);
  }
  return a;
}

// ---------- games ----------
function readHeaders(pgn) {
  const h = {};
  for (const m of pgn.matchAll(/\[(\w+)\s+"([^"]*)"\]/g)) h[m[1]] = m[2];
  return h;
}

function makeGame(pgn, { userColor = null, sample = false } = {}) {
  const compact = compactPgn(pgn);
  const headers = readHeaders(compact);
  const detected = detectUserColor(headers, $('username').value);
  return {
    id: nextId++, key: gameKey(headers, compact), pgn: compact, headers, added: 0,
    userColor: userColor || detected || 'w', colorKnown: !!(userColor || detected), sample,
    game: null, report: null, error: null,
  };
}

const record = (g) => ({ key: g.key, pgn: g.pgn, userColor: g.userColor, colorKnown: g.colorKnown, added: g.added, game: g.game, version: ANALYSIS_VERSION });

function throttle(fn, ms) {
  let timer = null;
  return () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; fn(); }, ms);
  };
}

// Add games (skipping ones already in the library) and analyse them.
async function addGames(pgns, { userColor = null, persist = true, sample = false } = {}) {
  // The example games make way once you bring your own.
  if (!sample && state.games.some((g) => g.sample)) {
    const cur = currentGame();
    state.games = state.games.filter((g) => !g.sample);
    state.current = cur && !cur.sample ? state.games.indexOf(cur) : state.games.length ? 0 : -1;
    state.index = cur && cur.sample ? 0 : state.index;
  }
  const known = new Set(state.games.map((g) => g.key));
  const base = Date.now() * 1000;
  const added = [];
  pgns.forEach((pgn, i) => {
    const g = makeGame(pgn, { userColor, sample });
    if (known.has(g.key)) return;
    known.add(g.key);
    g.added = base + i;
    added.push(g);
  });
  state.games.push(...added);
  if (state.current < 0 && added.length) state.current = state.games.indexOf(added[0]);
  renderGameList();
  render();
  const result = await analyseGames(added, { persist });
  return { ...result, added, skipped: pgns.length - added.length };
}

let job = null; // the import or analysis currently running
let storageFull = false;

async function analyseGames(list, { persist = true } = {}) {
  const me = { cancelled: false };
  job = me;
  $('import-cancel').hidden = false;
  let next = 0;
  let done = 0;
  let failed = 0;
  const batch = [];
  const flush = async () => {
    if (!persist || !batch.length) return;
    if (!(await library.put(batch.splice(0).map(record)))) storageFull = true;
  };
  const refresh = throttle(() => { renderGameList(); renderLower(); }, 700);
  const run = async () => {
    while (next < list.length && !me.cancelled) {
      const g = list[next++];
      try {
        g.game = await runAnalysis(g.id, g.pgn);
        g.report = gameReport(g.game, g.userColor, { openingMoves: OPENING_MOVES });
        if (!g.sample) batch.push(g);
      } catch (err) {
        g.error = err.message;
        failed++;
      }
      done++;
      if (list.length > 1) setStatus(`Analysed ${done} of ${list.length} games…`);
      if (batch.length >= 25) await flush();
      if (currentGame() === g) render();
      refresh();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, liveWorkers().length) }, run));
  await flush();
  if (me.cancelled) {
    const cur = currentGame();
    const drop = new Set(list.filter((g) => !g.game && !g.error));
    state.games = state.games.filter((g) => !drop.has(g));
    state.current = state.games.length ? Math.max(0, state.games.indexOf(cur)) : -1;
  }
  if (job === me) {
    job = null;
    $('import-cancel').hidden = true;
  }
  renderGameList();
  render();
  renderLower();
  return { analysed: done - failed, failed, cancelled: me.cancelled };
}

function setStatus(text, error = false) {
  const el = $('import-status');
  el.textContent = text;
  el.classList.toggle('error', error);
}

const currentGame = () => state.games[state.current] || null;

// ---------- view model ----------
function view() {
  const g = currentGame();
  if (state.mode === 'train' && state.quiz && state.quiz.position) return state.quiz.position;
  if (state.mode === 'play' && state.play) return state.play.positions[playCursor()];
  if (state.variation) {
    const v = state.variation;
    return v.positions[v.cursor];
  }
  if (!g || !g.game) {
    const chess = new Chess();
    return { fen: chess.fen(), analysis: analyzePosition(chess), assessment: null };
  }
  const pos = g.game.positions[state.index];
  const ply = state.index > 0 ? g.game.plies[state.index - 1] : null;
  return { fen: pos.fen, analysis: analysisFor(pos.fen), assessment: ply, move: ply };
}

const userColor = () => (state.mode === 'play' && state.play ? state.play.userColor : currentGame() ? currentGame().userColor : 'w');
const playCursor = () => (state.playIndex === null ? state.play.positions.length - 1 : state.playIndex);
const playLive = () => state.mode === 'play' && state.play && state.playIndex === null;
const canMoveInPlay = () => playLive() && !state.play.thinking && !state.play.over && !state.play.resigned && state.play.chess.turn() === state.play.userColor;

// ---------- board ----------
const board = new Board($('board'), { onMove: handleBoardMove });

function handleBoardMove(m) {
  if (state.mode === 'train') return answerQuiz(m);
  if (state.mode === 'play') {
    if (!canMoveInPlay()) return;
    state.hint = null;
    state.play.userMove(m);
    return;
  }
  const v = view();
  const g = currentGame();
  // Playing the game's own next move just steps forward.
  if (!state.variation && g && g.game) {
    const next = g.game.plies[state.index];
    if (next && next.from === m.from && next.to === m.to) return go(state.index + 1);
  }
  const pos = playMove(v, m);
  if (!state.variation) state.variation = { base: state.index, positions: [v], cursor: 0 };
  const vr = state.variation;
  vr.positions = vr.positions.slice(0, vr.cursor + 1).concat(pos);
  vr.cursor++;
  render();
}

// Play a move from a view position and assess it against every alternative.
function playMove(v, m) {
  const chess = new Chess(v.fen);
  const ranked = rankMoves(chess);
  const fullmove = chess.moveNumber();
  const move = chess.move({ from: m.from, to: m.to, promotion: m.promotion });
  const after = analyzePosition(chess);
  const assessment = assessMove({ move, color: move.color, before: v.analysis, after, ranked, history: { ids: new Map(), counts: new Map() }, fullmove });
  const ply = { san: move.san, from: move.from, to: move.to, color: move.color, fullmove, ...assessment };
  return { fen: chess.fen(), analysis: after, assessment: ply, move: ply };
}

function go(index) {
  const g = currentGame();
  if (state.mode === 'play' && state.play) {
    const last = state.play.positions.length - 1;
    const i = Math.max(0, Math.min(last, index));
    state.playIndex = i === last ? null : i;
    board.clearSelection();
    render();
    return;
  }
  if (state.variation) {
    const v = state.variation;
    if (index < 0) { exitVariation(); return; }
    v.cursor = Math.max(0, Math.min(v.positions.length - 1, index));
    if (v.cursor === 0) { state.index = v.base; state.variation = null; }
  } else if (g && g.game) {
    state.index = Math.max(0, Math.min(g.game.positions.length - 1, index));
  }
  board.clearSelection();
  render();
}

function exitVariation() {
  if (!state.variation) return;
  state.index = state.variation.base;
  state.variation = null;
  board.clearSelection();
  render();
}

// ---------- rendering ----------
const LEGENDS = {
  control: () => '<span class="sw w"></span>White owns <span class="sw b"></span>Black owns <span class="sw c"></span>Contested. Darker means more attackers. Pawn guards win ties.',
  freedom: (side) => `<span class="sw g"></span>Safe square for ${side === 'w' ? 'White' : 'Black'}’s pieces <span class="sw x"></span>Reachable but loses material. Badges show each piece’s safe moves; red means cramped.`,
  impact: () => '<span class="sw g"></span>Squares the last move won <span class="sw x"></span>Squares it gave up.',
  none: () => 'Plain board.',
};

function render() {
  const v = view();
  const g = currentGame();
  const chess = new Chess(v.fen);
  const me = userColor();
  const freedomSide = state.freedom === 'opp' ? other(me) : me;
  const orientation = state.flipped ? other(me) : me;
  const a = v.analysis;
  const arrows = [];
  const training = state.mode === 'train';
  const playing = state.mode === 'play' && state.play;
  if (playing && state.hint && playLive()) {
    if (state.hint.dom) arrows.push({ ...state.hint.dom, kind: 'dom' });
    if (state.hint.engine) arrows.push({ ...state.hint.engine, kind: 'best' });
  }
  if (!training && !playing && state.showBest) {
    const next = !state.variation && g && g.game ? g.game.plies[state.index] : null;
    if (next && next.best) {
      arrows.push({ from: next.best.from, to: next.best.to, kind: 'best' });
      if (next.best.san !== next.san) arrows.push({ from: next.from, to: next.to, kind: 'played' });
    }
  }
  if (training && state.quiz && state.quiz.answer) {
    const ans = state.quiz.answer;
    arrows.push({ from: ans.best.from, to: ans.best.to, kind: 'best' });
  }
  board.render({
    analysis: a,
    orientation,
    overlay: state.overlay,
    freedomSide,
    impact: v.assessment ? v.assessment.deltas : null,
    lastMove: v.move ? { from: v.move.from, to: v.move.to } : null,
    arrows,
    legal: playing ? (canMoveInPlay() ? chess.moves({ verbose: true }) : null) : training && state.quiz && state.quiz.answer ? null : chess.moves({ verbose: true }),
  });

  const share = dominanceShare(a.dominance);
  $('share-w').style.width = share.toFixed(1) + '%';
  $('share-w-label').textContent = `White ${Math.round(share)}%`;
  $('share-b-label').textContent = `Black ${100 - Math.round(share)}%`;

  document.querySelectorAll('[data-overlay]').forEach((b) => {
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(b.dataset.overlay === state.overlay));
  });
  const arrowNote = playing ? (arrows.length ? ' Green arrow: the engine\u2019s best move. Indigo arrow: the most dominating move.' : '') : arrows.length && !training ? ' Arrows show the next move: green is the most dominating option, grey is what was played.' : '';
  $('legend').innerHTML = LEGENDS[state.overlay](freedomSide) + arrowNote;
  $('freedom-side').value = state.freedom;
  $('show-best').checked = state.showBest;
  $('as-color').value = me;

  renderTitle();
  renderNav();
  renderMetrics(a);
  if (training) renderQuizCoach(); else if (playing) renderPlayCoach(v); else renderCoach(v);
  renderPlayControls();
  renderMoves();
  renderGraph();
  $('variation').hidden = !state.variation || !!playing;
  $('as-color-wrap').hidden = !!playing || training;
  $('show-best-wrap').hidden = !!playing || training;
  if (state.variation) $('variation-moves').textContent = state.variation.positions.slice(1, state.variation.cursor + 1).map((p) => p.move.san).join(' ');
}

function renderTitle() {
  const g = currentGame();
  if (state.mode === 'train') {
    $('game-title').innerHTML = '<strong>Trainer</strong><small>Positions from your games where a more dominating move was available</small>';
    return;
  }
  if (state.mode === 'play' && state.play) {
    const s = state.play;
    $('game-title').innerHTML = `<strong>You vs Stockfish</strong><small>${s.level.text} \u00b7 ${esc(s.punish.text)} \u00b7 you play ${sideName(s.userColor)}</small>`;
    return;
  }
  if (!g) { $('game-title').innerHTML = '<strong>No game loaded</strong>'; return; }
  const h = g.headers;
  const sub = [h.Event, h.Date && h.Date.replace(/\.\?\?/g, ''), h.Result].filter(Boolean).join(' · ');
  $('game-title').innerHTML = `<strong>${esc(h.White || 'White')} vs ${esc(h.Black || 'Black')}</strong><small>${esc(sub)}${g.game ? '' : ' · analysing…'}</small>`;
}

function renderNav() {
  const v = state.variation;
  const g = currentGame();
  let label = 'Start';
  if (state.mode === 'train') label = state.quiz && state.quiz.items.length ? `Position ${state.quiz.i + 1}/${state.quiz.items.length}` : 'Trainer';
  else if (state.mode === 'play' && state.play) {
    const pos = state.play.positions[playCursor()];
    label = pos.move ? `${pos.move.fullmove}${pos.move.color === 'w' ? '.' : '\u2026'} ${pos.move.san}` : 'Start';
  } else if (v) label = `Line, move ${v.cursor}`;
  else if (g && g.game && state.index > 0) {
    const p = g.game.plies[state.index - 1];
    label = `${p.fullmove}${p.color === 'w' ? '.' : '…'} ${p.san}`;
  }
  $('nav-pos').textContent = label;
}

const METRIC_ROWS = [
  ['Squares controlled', (s) => s.controlled, 1],
  ['Center', (s) => s.center, 1],
  ['Space', (s) => s.space, 1],
  ['Safe moves', (s) => s.safeMobility, 1],
  ['Cramped pieces', (s) => s.cramped, -1],
  ['Minors developed', (s) => s.developed, 1],
  ['King safety', (s) => s.kingSafety, 1],
  ['Material', (s) => s.material, 1],
];

function renderMetrics(a) {
  $('metrics').innerHTML = METRIC_ROWS.map(([name, f, dir]) => {
    const w = f(a.w);
    const b = f(a.b);
    const cls = (x, y) => (x === y ? '' : (x - y) * dir > 0 ? 'lead' : 'trail');
    const fmt = (x) => (Number.isInteger(x) ? x : x.toFixed(1));
    return `<dt>${name}</dt><dd class="${cls(w, b)}">${fmt(w)}</dd><dd class="${cls(b, w)}">${fmt(b)}</dd>`;
  }).join('');
}

function tagList(tags) {
  if (!tags.length) return '';
  return `<ul class="tags">${tags.map((t) => `<li class="${TAGS[t].tone}"><b>${TAGS[t].text}</b>${TAGS[t].lesson}</li>`).join('')}</ul>`;
}

function renderCoach(v) {
  const el = $('coach');
  const g = currentGame();
  const p = v.assessment;
  if (!p) {
    const first = g && g.game ? g.game.plies[0] : null;
    el.innerHTML = `<div class="coach-card">
      <span class="eyebrow">Coach</span>
      <h2>Starting position</h2>
      <p>Step through the game with the arrow keys or buttons. After each move you’ll see what it did to board control and to your opponent’s freedom, and which move would have dominated most.</p>
      <p class="delta">Try the <b>Freedom</b> overlay: it shows where your opponent’s pieces can safely go. Good moves shrink that number.</p>
      ${first ? '<button type="button" class="btn primary" id="coach-start">Play first move</button>' : ''}
    </div>`;
    const btn = $('coach-start');
    if (btn) btn.onclick = () => go(1);
    return;
  }
  const who = p.color === userColor() ? 'You' : 'Opponent';
  const label = p.label ? `<span class="pill ${p.label}">${LABELS[p.label].text}</span>` : '<span class="pill neutral">Not graded</span>';
  const bestLine = p.best
    ? p.best.san === p.san
      ? `<p>This was the most dominating move available (#1 of ${p.total}).</p>`
      : `<p>Ranked <b>#${p.rank}</b> of ${p.total}. Most dominating: <b class="mono">${esc(p.best.san)}</b>. Step back one move to see it as a green arrow.</p>`
    : '<p class="delta">Beyond move 20 moves are not graded. The opening is where these habits form.</p>';
  const gained = p.deltas.gained.length ? `Won ${p.deltas.gained.length} square${p.deltas.gained.length > 1 ? 's' : ''}` : '';
  const lost = p.deltas.lost.length ? `gave up ${p.deltas.lost.length}` : '';
  const alts = p.alternatives
    ? `<span class="eyebrow">Most dominating moves here</span><ol class="alts">${p.alternatives.map((m, i) => `<li><button type="button" data-alt="${i}" class="${m.san === p.san ? 'played' : ''}"><span class="rank">${i + 1}</span><span>${esc(m.san)}${m.san === p.san ? ' (played)' : ''}</span><span class="rank">${i === 0 ? 'best' : '−' + (p.alternatives[0].score - m.score).toFixed(1)}</span></button></li>`).join('')}</ol>`
    : '';
  el.innerHTML = `<div class="coach-card">
    <span class="eyebrow">${who} · move ${p.fullmove}</span>
    <h2><span class="mono">${esc(p.san)}</span>${label}</h2>
    ${p.label ? `<p class="delta">${LABELS[p.label].blurb}</p>` : ''}
    ${bestLine}
    <p class="delta">${describeDeltas(p.deltas)}${gained || lost ? `. ${[gained, lost].filter(Boolean).join(', ')}.` : ''}</p>
    ${tagList(p.tags)}
    ${alts}
  </div>`;
  el.querySelectorAll('[data-alt]').forEach((b) => {
    b.onclick = () => tryAlternative(p.alternatives[Number(b.dataset.alt)]);
  });
}

// Replay an alternative from the position before the shown move.
function tryAlternative(alt) {
  if (state.variation) {
    state.variation.cursor = Math.max(0, state.variation.cursor - 1);
  } else {
    if (!currentGame() || state.index === 0) return;
    state.index -= 1;
  }
  handleBoardMove({ from: alt.from, to: alt.to, promotion: alt.promotion });
}

function renderMoves() {
  const g = currentGame();
  const el = $('moves');
  const playing = state.mode === 'play' && state.play;
  const plies = playing
    ? state.play.positions.slice(1).map((p) => ({ ...p.move, dot: p.move.punished ? 'punish' : p.engine ? p.engine.grade.tone : null }))
    : g && g.game ? g.game.plies.map((p) => ({ ...p, dot: p.label })) : [];
  if (!plies.length) { el.innerHTML = '<li class="empty" style="grid-column:1/-1">No moves yet.</li>'; return; }
  const current = playing ? playCursor() : state.variation ? -1 : state.index;
  let html = '';
  plies.forEach((p, i) => {
    if (p.color === 'w' || i === 0) html += `<span class="num">${p.fullmove}.</span>`;
    if (i === 0 && p.color === 'b') html += '<span></span>';
    html += `<button type="button" data-ply="${i + 1}" aria-current="${current === i + 1}">${p.dot ? `<span class="dot ${p.dot}"></span>` : ''}${esc(p.san)}</button>`;
  });
  el.innerHTML = html;
  el.querySelectorAll('[data-ply]').forEach((b) => { b.onclick = () => { state.variation = null; go(Number(b.dataset.ply)); }; });
  // Keep the current move visible without scrolling the page itself.
  const cur = el.querySelector('[aria-current="true"]');
  if (cur) {
    const top = cur.offsetTop - el.offsetTop;
    if (top < el.scrollTop || top > el.scrollTop + el.clientHeight - cur.offsetHeight) el.scrollTop = top - el.clientHeight / 2;
  }
}

function renderGraph() {
  const g = currentGame();
  const el = $('chart');
  if (state.mode === 'play' && state.play) {
    const s = state.play;
    const sign = s.userColor === 'w' ? 1 : -1;
    renderChart(el, {
      values: s.positions.map((p) => sign * p.analysis.dominance),
      marks: s.positions.slice(1).filter((p) => p.move.color === s.userColor && p.move.label).map((p, _, all) => ({ index: s.positions.indexOf(p), label: p.move.label })),
      current: playCursor(),
      openingPlies: OPENING_MOVES * 2,
      onSelect: (i) => go(i),
    });
    return;
  }
  if (!g || !g.game) { el.innerHTML = '<p class="empty">The chart appears once a game is analysed.</p>'; return; }
  const sign = g.userColor === 'w' ? 1 : -1;
  const values = g.game.positions.map((p) => sign * p.analysis.dominance);
  const marks = g.game.plies.filter((p) => p.color === g.userColor && p.label).map((p) => ({ index: p.ply + 1, label: p.label }));
  renderChart(el, {
    values,
    marks,
    current: state.variation ? state.variation.base : state.index,
    openingPlies: OPENING_MOVES * 2,
    onSelect: (i) => { state.variation = null; state.mode = 'review'; go(i); },
  });
}

function renderGameList() {
  const el = $('game-list');
  $('games-count').textContent = state.games.length ? `Games (${state.games.length})` : 'Games';
  if (!state.games.length) { el.innerHTML = '<li class="empty">Paste a PGN or import your games to start.</li>'; return; }
  el.innerHTML = state.games.map((g, i) => {
    const h = g.headers;
    const r = g.report;
    const status = g.error ? `<span class="pill mistake">Error</span>` : !g.game ? '<span>Analysing…</span>' : `${h.Date && !h.Date.startsWith('?') ? `<span>${esc(h.Date.replace(/\.\?\?/g, ''))}</span>` : ''}<span>As ${g.userColor === 'w' ? 'White' : 'Black'}</span><span>${h.Result || ''}</span>${r ? `<span>Avg gap ${r.avgGap.toFixed(1)}</span>` : ''}`;
    return `<li><button type="button" data-game="${i}" aria-current="${i === state.current}"><span class="players">${esc(h.White || '?')} – ${esc(h.Black || '?')}</span><span class="meta">${status}</span></button></li>`;
  }).join('');
  el.querySelectorAll('[data-game]').forEach((b) => {
    b.onclick = () => selectGame(Number(b.dataset.game));
  });
}

function selectGame(i) {
  state.current = i;
  state.index = 0;
  state.variation = null;
  state.mode = 'review';
  board.clearSelection();
  renderGameList();
  render();
  renderLower();
}

// ---------- lower panes ----------
function renderLower() {
  renderReport();
  renderPatterns();
  if (state.mode !== 'train') renderTrainerIntro();
}

const fmtSigned = (x) => (x === null || x === undefined ? '–' : (x > 0 ? '+' : '') + x.toFixed(1));
const pct = (x) => (x === null || x === undefined ? '–' : Math.round(x * 100) + '%');

function labelBar(counts) {
  const total = Object.values(counts).reduce((s, n) => s + n, 0) || 1;
  return `<div class="labelbar">${Object.keys(LABELS).map((k) => (counts[k] ? `<span class="${k}" style="width:${(100 * counts[k]) / total}%" title="${LABELS[k].text}: ${counts[k]}"></span>` : '')).join('')}</div>
    <p class="hint">${Object.keys(LABELS).filter((k) => counts[k]).map((k) => `${LABELS[k].text} ${counts[k]}`).join(' · ')}</p>`;
}

function renderReport() {
  const el = $('report');
  const g = currentGame();
  if (!g || !g.game || !g.report) { el.innerHTML = '<p class="empty">Select an analysed game to see its opening report.</p>'; return; }
  const r = g.report;
  const warn = Object.entries(r.tagCounts).filter(([t]) => TAGS[t].tone === 'warn' || TAGS[t].tone === 'bad').sort((a, b) => b[1] - a[1]);
  el.innerHTML = `
    <h2>Your opening, moves 1–${OPENING_MOVES}</h2>
    <div class="stats">
      <div class="stat"><b>${fmtSigned(r.dominanceAt[12])}</b><span>Your dominance after move 12</span></div>
      <div class="stat"><b>${r.avgGap.toFixed(1)}</b><span>Average gap to the most dominating move (lower is better)</span></div>
      <div class="stat"><b>${r.castledBy ? 'Move ' + r.castledBy : 'No'}</b><span>Castled</span></div>
      <div class="stat"><b>${r.developedBy8}/4</b><span>Minor pieces developed by move 8</span></div>
    </div>
    <div class="cols">
      <div>
        <h3>How your moves graded</h3>
        ${labelBar(r.counts)}
        <h3>Habits that cost you board</h3>
        ${warn.length ? `<ul class="tags">${warn.map(([t, n]) => `<li class="${TAGS[t].tone}"><b>${TAGS[t].text} ×${n}</b>${TAGS[t].lesson}</li>`).join('')}</ul>` : '<p class="hint">None flagged in this opening.</p>'}
      </div>
      <div>
        <h3>Turning points</h3>
        ${r.turningPoints.length ? `<ol class="turning">${r.turningPoints.map((p) => `<li>
          <div class="head"><span><b class="mono">${p.fullmove}${p.color === 'w' ? '.' : '…'} ${esc(p.san)}</b> <span class="pill ${p.label}">${LABELS[p.label].text}</span></span><button type="button" class="btn" data-jump="${p.ply}">Show</button></div>
          <span class="delta">Most dominating was <b class="mono">${esc(p.best.san)}</b>. ${describeDeltas(p.deltas)}.</span>
        </li>`).join('')}</ol>` : '<p class="hint">No big misses in the opening. Nice.</p>'}
      </div>
    </div>`;
  el.querySelectorAll('[data-jump]').forEach((b) => {
    b.onclick = () => { state.mode = 'review'; state.variation = null; go(Number(b.dataset.jump)); $('board').scrollIntoView({ behavior: 'smooth', block: 'center' }); };
  });
}

function renderPatterns() {
  const el = $('patterns');
  const reports = state.games.filter((g) => g.report).map((g) => g.report);
  if (reports.length < 2) {
    el.innerHTML = '<h2>Patterns across your games</h2><p class="empty">Import at least two of your games. Set your username first so each game is read from your side.</p>';
    return;
  }
  const counts = {};
  const tags = {};
  for (const r of reports) {
    for (const [k, n] of Object.entries(r.counts)) counts[k] = (counts[k] || 0) + n;
    for (const [k, n] of Object.entries(r.tagCounts)) tags[k] = (tags[k] || 0) + n;
  }
  const rows = habitPatterns(reports);
  const warn = Object.entries(tags).filter(([t]) => TAGS[t].tone !== 'good' && TAGS[t].tone !== 'neutral').sort((a, b) => b[1] - a[1]).slice(0, 4);
  el.innerHTML = `
    <h2>Patterns across ${reports.length} games</h2>
    <p class="hint">Your own games, split by habit. Compare how much of the board you owned after move 12 when you did something and when you didn’t.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Habit</th><th>Games with / without</th><th>Dominance at move 12 with / without</th><th>Score with / without</th></tr></thead>
      <tbody>${rows.map((h) => {
        const diff = h.yes.dominance !== null && h.no.dominance !== null ? h.yes.dominance - h.no.dominance : null;
        return `<tr><td>${h.text}</td><td class="num">${h.yes.n} / ${h.no.n}</td><td class="num"><span class="${diff > 0 ? 'pos' : diff < 0 ? 'neg' : ''}">${fmtSigned(h.yes.dominance)}</span> / ${fmtSigned(h.no.dominance)}</td><td class="num">${pct(h.yes.score)} / ${pct(h.no.score)}</td></tr>`;
      }).join('')}</tbody>
    </table></div>
    <div class="cols" style="margin-top:18px">
      <div><h3>All your opening moves</h3>${labelBar(counts)}</div>
      <div><h3>Most frequent leaks</h3>${warn.length ? `<ul class="tags">${warn.map(([t, n]) => `<li class="${TAGS[t].tone}"><b>${TAGS[t].text} ×${n}</b>${TAGS[t].lesson}</li>`).join('')}</ul>` : '<p class="hint">Nothing recurring.</p>'}</div>
    </div>`;
}

// ---------- trainer ----------
function quizItems() {
  const items = [];
  for (const g of state.games) {
    if (!g.game) continue;
    for (const p of g.game.plies) {
      if (p.color === g.userColor && p.label && p.gap > 6 && p.fullmove <= 15) items.push({ game: g, ply: p });
    }
  }
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function renderTrainerIntro() {
  const n = quizItems().length;
  $('trainer').innerHTML = `<div class="trainer-box">
    <h2>Find the dominating move</h2>
    <p>The trainer shows positions from your own games where a much stronger grip on the board was available. Pick a move on the board; you’ll see how it ranks among every legal move and what it does to control and freedom.</p>
    <p class="hint">${n ? `${n} positions ready from your games.` : 'Analyse some games first. Positions appear once a game has moves graded Passive or worse.'}</p>
    <div class="row" style="justify-content:flex-start">${n ? '<button type="button" class="btn primary" id="start-train">Start training</button>' : ''}${state.mode === 'train' ? '<button type="button" class="btn" id="stop-train">Back to game review</button>' : ''}</div>
  </div>`;
  const s = $('start-train');
  if (s) s.onclick = startQuiz;
  const t = $('stop-train');
  if (t) t.onclick = stopQuiz;
}

function startQuiz() {
  const items = quizItems();
  if (!items.length) return;
  state.mode = 'train';
  state.variation = null;
  state.quiz = { items, i: 0, answer: null, position: null };
  loadQuiz();
  renderTrainerIntro();
  $('board').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function stopQuiz() {
  state.mode = 'review';
  state.quiz = null;
  render();
  renderTrainerIntro();
}

function loadQuiz() {
  const q = state.quiz;
  const item = q.items[q.i];
  const chess = new Chess(item.ply.fenBefore);
  q.answer = null;
  q.position = { fen: item.ply.fenBefore, analysis: analyzePosition(chess), assessment: null, move: null };
  const idx = state.games.indexOf(item.game);
  if (idx !== state.current) { state.current = idx; renderGameList(); }
  board.clearSelection();
  render();
}

function answerQuiz(m) {
  const q = state.quiz;
  const item = q.items[q.i];
  const result = playMove(q.position, m);
  q.answer = { ...result.assessment, played: item.ply };
  q.position = { ...q.position, move: { from: m.from, to: m.to } };
  render();
}

function renderQuizCoach() {
  const el = $('coach');
  const q = state.quiz;
  const item = q.items[q.i];
  const side = item.ply.color === 'w' ? 'White' : 'Black';
  if (!q.answer) {
    el.innerHTML = `<div class="coach-card">
      <span class="eyebrow">Trainer · move ${item.ply.fullmove}</span>
      <h2>${side} to move</h2>
      <p>Find the move that takes the most board from your opponent. Look at which squares are contested and which enemy pieces could be boxed in.</p>
      <p class="delta">Switch overlays freely. The answer is hidden until you move.</p>
      <div class="row" style="justify-content:flex-start"><button type="button" class="btn" id="quiz-skip">Skip</button><button type="button" class="btn" id="quiz-stop">Stop training</button></div>
    </div>`;
  } else {
    const a = q.answer;
    el.innerHTML = `<div class="coach-card">
      <span class="eyebrow">Trainer · move ${item.ply.fullmove}</span>
      <h2><span class="mono">${esc(a.san)}</span><span class="pill ${a.label}">${LABELS[a.label].text}</span></h2>
      <p>Your choice ranks <b>#${a.rank}</b> of ${a.total}. Most dominating: <b class="mono">${esc(a.best.san)}</b>. In the game you played <b class="mono">${esc(a.played.san)}</b> (#${a.played.rank}).</p>
      <p class="delta">${describeDeltas(a.deltas)}</p>
      ${tagList(a.tags)}
      <div class="row" style="justify-content:flex-start"><button type="button" class="btn primary" id="quiz-next">Next position</button><button type="button" class="btn" id="quiz-stop">Stop training</button></div>
    </div>`;
  }
  const next = () => { q.i = (q.i + 1) % q.items.length; loadQuiz(); };
  if ($('quiz-skip')) $('quiz-skip').onclick = next;
  if ($('quiz-next')) $('quiz-next').onclick = next;
  $('quiz-stop').onclick = stopQuiz;
}

// ---------- play the computer ----------
function setPlayStatus(text, error = false) {
  const el = $('play-status');
  el.textContent = text;
  el.classList.toggle('error', error);
}

async function startPlay() {
  if (!engine) engine = new Engine();
  const pick = $('play-color').value;
  const color = pick === 'r' ? (Math.random() < 0.5 ? 'w' : 'b') : pick;
  if (state.play) state.play.token++;
  store.set('play', { color: pick, level: $('play-level').value, punish: $('play-punish').value });
  state.play = new PlaySession(engine, {
    userColor: color,
    level: $('play-level').value,
    punish: $('play-punish').value,
    onUpdate: () => { if (state.mode === 'play') render(); },
  });
  state.mode = 'play';
  state.playIndex = null;
  state.hint = null;
  state.variation = null;
  state.flipped = false;
  board.clearSelection();
  setPlayStatus('Loading Stockfish…');
  render();
  $('board').scrollIntoView({ behavior: 'smooth', block: 'center' });
  try {
    await engine.ready;
    setPlayStatus('');
  } catch (err) {
    engine = null;
    setPlayStatus(`Stockfish couldn’t start in this browser (${err.message}). Try another browser, or run the app from the repo.`, true);
    return;
  }
  state.play.start();
}

function resumePlay() {
  state.mode = 'play';
  state.variation = null;
  board.clearSelection();
  render();
}

function showHint() {
  const s = state.play;
  if (!canMoveInPlay()) return;
  const fen = s.chess.fen();
  const dom = rankMoves(new Chess(fen))[0];
  const eng = s.userEval && s.userEval.fen === fen && s.userEval.bestmove ? uciToMove(s.userEval.bestmove) : null;
  const engSan = eng ? new Chess(fen).move(eng).san : null;
  state.hint = { dom: dom ? { from: dom.from, to: dom.to, san: dom.san } : null, engine: eng ? { from: eng.from, to: eng.to, san: engSan } : null };
  render();
}

function savePlayedGame() {
  const s = state.play;
  if (!s || s.positions.length < 2) return;
  addGames([s.pgn()], { userColor: s.userColor }).then((r) => {
    if (r.added[0]) selectGame(state.games.indexOf(r.added[0]));
    document.querySelector('#lower-tabs [data-tab="report"]').click();
  });
}

function renderPlayControls() {
  const s = state.play;
  const active = state.mode === 'play' && s && !s.over && !s.resigned;
  $('play-hint').hidden = !active;
  $('play-undo').hidden = !active;
  $('play-resign').hidden = !active;
  $('play-hint').disabled = !canMoveInPlay();
  $('play-undo').disabled = !s || s.thinking || s.positions.length < 2;
  $('play-start').textContent = s ? 'New game' : 'Start game';
  const resume = s && state.mode !== 'play' && !s.over && !s.resigned;
  const st = $('play-status');
  if (resume && !st.querySelector('button')) {
    st.classList.remove('error');
    st.innerHTML = 'Your game is paused. <button type="button" class="link" id="play-resume">Back to the game</button>';
    $('play-resume').onclick = resumePlay;
  } else if (!resume && st.querySelector('#play-resume')) {
    st.textContent = '';
  }
}

const evalText = (cp) => `${formatScore(cp)} for you`;

function renderPlayCoach(v) {
  const s = state.play;
  const el = $('coach');
  const idx = playCursor();
  let userIdx = -1;
  for (let i = idx; i > 0; i--) if (s.positions[i].move.color === s.userColor) { userIdx = i; break; }
  const userPos = userIdx > 0 ? s.positions[userIdx] : null;
  const replyPos = userIdx > 0 && userIdx + 1 <= idx ? s.positions[userIdx + 1] : null;
  const live = playLive();

  let status = '';
  if (s.error) status = `<p class="status error">${esc(s.error)}</p>`;
  else if (s.resigned || s.over) {
    const r = s.resigned ? 'loss' : s.result();
    const text = s.resigned ? 'You resigned.' : r === 'win' ? 'Checkmate. You beat Stockfish!' : r === 'loss' ? 'Checkmate. Stockfish wins this one.' : 'Draw.';
    status = `<div class="callout ${r === 'win' ? 'win' : ''}"><b>${text}</b><span>Add the game to your games to get the full report, your patterns, and trainer positions from the moves you missed.</span><div class="row" style="justify-content:flex-start"><button type="button" class="btn primary" id="play-save">Analyse this game</button></div></div>`;
  } else if (!live) status = '<span class="eyebrow">Looking back</span>';
  else if (s.thinking) status = `<span class="thinking">${s.chess.turn() === s.userColor ? 'Checking the position…' : 'Stockfish is thinking…'}</span>`;
  else status = `<span class="eyebrow">Your move${s.userEval ? ` · <span class="eval">${evalText(s.userEval.score)}</span>` : ''}</span>`;

  let body = '';
  if (!userPos) {
    body = `<h2>${s.positions.length > 1 ? 'Stockfish opened' : 'New game'}</h2>
      <p>Stockfish plays at <b>${s.level.text}</b> level while you play well. ${s.punish.key === 'always' ? 'This game it always plays at full strength.' : `When a move costs you ${s.punish.threshold >= 100 ? 'a pawn' : 'half a pawn'} or more, it switches to full strength and goes after it.`}</p>
      <p class="delta">After every move you’ll see the engine’s verdict, how it changed your board dominance, and, when you slip, the line Stockfish uses to punish it.</p>`;
  } else {
    const u = userPos.move;
    const e = userPos.engine;
    const pills = `${e ? `<span class="pill ${e.grade.tone}">${e.grade.text}</span>` : ''}`;
    let engineLine = '<p class="delta">Engine verdict pending…</p>';
    if (e) {
      engineLine = `<p>Evaluation for you: <b class="eval">${formatScore(e.evalBefore)}</b> → <b class="eval">${formatScore(e.evalAfter)}</b>${e.loss >= 20 ? ` (lost ${(e.loss / 100).toFixed(1)} pawn${e.loss >= 150 ? 's' : ''})` : ''}.${e.better && e.loss > 50 ? ` Better was <b class="mono">${esc(e.better)}</b>.` : ''}</p>`;
    }
    const dom = u.label ? `<p class="delta">Board dominance: <b>${LABELS[u.label].text}</b> (#${u.rank} of ${u.total}). ${describeDeltas(u.deltas)}</p>` : '';
    let reply = '';
    if (replyPos) {
      const r = replyPos.move;
      if (r.punished && e && e.loss >= Math.max(50, s.punish.threshold)) {
        reply = `<div class="callout punish"><b>Punished.</b><span>Stockfish switched to full strength and played <b class="mono">${esc(r.san)}</b>. The line it sees: <span class="mono">${esc(e.threat.join(' '))}</span></span></div>`;
      } else {
        reply = `<p class="delta">Stockfish replied <b class="mono">${esc(r.san)}</b>${r.punished ? ' at full strength' : ` at ${s.level.text} level`}.</p>`;
      }
    }
    body = `<h2><span class="mono">${esc(u.san)}</span>${pills}</h2>${engineLine}${dom}${tagList(u.tags)}${reply}`;
  }

  let hint = '';
  if (state.hint && live) {
    const h = state.hint;
    hint = `<div class="callout"><b>Hint</b><span>${h.engine ? `Engine’s choice: <b class="mono">${esc(h.engine.san)}</b> (green arrow). ` : ''}${h.dom ? `Most dominating: <b class="mono">${esc(h.dom.san)}</b> (indigo arrow).` : ''}</span></div>`;
  }

  el.innerHTML = `<div class="coach-card">${status}${body}${hint}</div>`;
  const save = $('play-save');
  if (save) save.onclick = savePlayedGame;
}

function initPlaySetup() {
  const saved = store.get('play', {});
  $('play-level').innerHTML = LEVELS.map((l) => `<option value="${l.key}">${l.text}${l.elo ? ` (~${l.elo})` : ''}</option>`).join('');
  $('play-punish').innerHTML = PUNISH.map((p) => `<option value="${p.key}">${p.text}</option>`).join('');
  $('play-color').value = saved.color || 'w';
  $('play-level').value = saved.level || 'club';
  $('play-punish').value = saved.punish || 'mistakes';
  $('play-start').addEventListener('click', startPlay);
  $('play-hint').addEventListener('click', showHint);
  $('play-undo').addEventListener('click', () => { state.hint = null; state.playIndex = null; if (state.play.takeBack()) render(); });
  $('play-resign').addEventListener('click', () => state.play.resign());
}
initPlaySetup();

// ---------- wiring ----------
function bindTabs(container, onChange) {
  const tabs = container.querySelectorAll('[role="tab"]');
  tabs.forEach((t) => {
    t.addEventListener('click', () => {
      tabs.forEach((x) => x.setAttribute('aria-selected', String(x === t)));
      onChange(t.dataset.tab);
    });
  });
}

let importSource = 'pgn';
bindTabs($('import-tabs'), (tab) => {
  importSource = tab;
  document.querySelectorAll('#import-form [data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== tab; });
  $('fetch-opts').hidden = tab === 'pgn';
  $('import-btn').textContent = tab === 'pgn' ? 'Analyse' : 'Import & analyse';
});
bindTabs($('lower-tabs'), (tab) => {
  document.querySelectorAll('.lower > [data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== tab; });
});

let fetchAbort = null;

function fetchOptions() {
  const all = document.querySelector('input[name="scope"]:checked').value === 'all';
  const timeClasses = [...document.querySelectorAll('input[name="tc"]:checked')].map((i) => i.value);
  return {
    max: all ? Infinity : Math.max(1, Number($('game-count').value) || 50),
    from: $('fetch-from').value || undefined,
    to: $('fetch-to').value || undefined,
    timeClasses,
  };
}

$('import-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (job) { setStatus('An import is still running. Wait for it or cancel it first.'); return; }
  const btn = $('import-btn');
  const username = $('username').value.trim();
  btn.disabled = true;
  const me = { cancelled: false };
  job = me;
  try {
    let pgns;
    if (importSource === 'pgn') {
      pgns = splitPgn($('pgn-input').value);
      if (!pgns.length) throw new Error('No games found. Paste PGN text that includes the moves.');
    } else {
      if (!username) throw new Error('Enter your username at the top first.');
      const opts = fetchOptions();
      if (!opts.timeClasses.length) throw new Error('Pick at least one time control.');
      if (opts.from && opts.to && opts.from > opts.to) throw new Error('The start month is after the end month.');
      fetchAbort = new AbortController();
      $('import-cancel').hidden = false;
      setStatus(`Fetching games for ${username}…`);
      const onProgress = importSource === 'lichess'
        ? ({ games }) => setStatus(`Downloading from Lichess… ${games} games so far`)
        : ({ games, month, monthsDone, months }) => setStatus(`Fetching ${month} (${monthsDone} of ${months} months) · ${games} games found`);
      const fetcher = importSource === 'lichess' ? fetchLichess : fetchChessCom;
      pgns = await fetcher(username, { ...opts, onProgress, signal: fetchAbort.signal });
      fetchAbort = null;
      if (!pgns.length) throw new Error('No standard games match those filters.');
    }
    if (me.cancelled) throw new DOMException('Cancelled', 'AbortError');
    job = null;
    setStatus(`Analysing ${pgns.length} game${pgns.length > 1 ? 's' : ''}…`);
    const r = await addGames(pgns);
    const first = r.added.find((g) => state.games.includes(g));
    if (first) selectGame(state.games.indexOf(first));
    const parts = [`Added ${r.analysed} game${r.analysed === 1 ? '' : 's'}`];
    if (r.skipped) parts.push(`${r.skipped} already in your library`);
    if (r.failed) parts.push(`${r.failed} couldn’t be read`);
    if (r.cancelled) parts.push('stopped early');
    setStatus(parts.join(' · ') + '.' + (storageFull ? ' Your browser storage is full, so some games won’t be remembered next visit.' : ''));
    if (importSource === 'pgn') $('pgn-input').value = '';
  } catch (err) {
    if (err.name === 'AbortError') setStatus('Import cancelled.');
    else setStatus(err instanceof TypeError ? 'Couldn’t reach the site. Check your connection, or paste PGN instead.' : err.message, true);
  } finally {
    if (job === me) job = null;
    fetchAbort = null;
    $('import-cancel').hidden = !job;
    btn.disabled = false;
  }
});

$('time-classes').innerHTML = TIME_CLASSES.map((t) => `<label class="inline" for="tc-${t}"><input type="checkbox" name="tc" id="tc-${t}" value="${t}" checked> ${t[0].toUpperCase() + t.slice(1)}</label>`).join('');

$('import-cancel').addEventListener('click', () => {
  if (fetchAbort) fetchAbort.abort();
  if (job) job.cancelled = true;
});

document.querySelectorAll('input[name="scope"]').forEach((r) => r.addEventListener('change', () => {
  $('game-count').disabled = document.querySelector('input[name="scope"]:checked').value === 'all';
}));

$('username').value = store.get('username', '');
$('username').addEventListener('change', () => {
  const u = $('username').value.trim();
  store.set('username', u);
  const changed = [];
  for (const g of state.games) {
    const c = detectUserColor(g.headers, u);
    if (c && (c !== g.userColor || !g.colorKnown)) { setUserColor(g, c); changed.push(g); }
  }
  library.put(changed.filter((g) => !g.sample && g.game).map(record));
  renderGameList();
  render();
  renderLower();
});

function setUserColor(g, c) {
  g.userColor = c;
  g.colorKnown = true;
  if (g.game) g.report = gameReport(g.game, c, { openingMoves: OPENING_MOVES });
}

$('as-color').addEventListener('change', () => {
  const g = currentGame();
  if (!g) return;
  setUserColor(g, $('as-color').value);
  if (!g.sample && g.game) library.put([record(g)]);
  renderGameList();
  render();
  renderLower();
});

$('clear-games').addEventListener('click', () => {
  state.games = [];
  state.current = -1;
  state.index = 0;
  state.variation = null;
  state.mode = 'review';
  if (job) job.cancelled = true;
  library.clear();
  store.set('games', []);
  renderGameList();
  render();
  renderLower();
});

document.querySelectorAll('[data-overlay]').forEach((b) => {
  b.addEventListener('click', () => { state.overlay = b.dataset.overlay; store.set('overlay', state.overlay); render(); });
});
$('freedom-side').addEventListener('change', () => { state.freedom = $('freedom-side').value; store.set('freedom', state.freedom); render(); });
$('show-best').addEventListener('change', () => { state.showBest = $('show-best').checked; store.set('showBest', state.showBest); render(); });
$('flip').addEventListener('click', () => { state.flipped = !state.flipped; render(); });
$('variation-exit').addEventListener('click', exitVariation);

const cursor = () => (state.mode === 'play' && state.play ? playCursor() : state.variation ? state.variation.cursor : state.index);
$('nav-start').addEventListener('click', () => { if (state.variation) exitVariation(); go(0); });
$('nav-prev').addEventListener('click', () => go(cursor() - 1));
$('nav-next').addEventListener('click', () => go(cursor() + 1));
$('nav-end').addEventListener('click', () => go(1e9));
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select') || state.mode === 'train') return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); go(cursor() - 1); }
  if (e.key === 'ArrowRight') { e.preventDefault(); go(cursor() + 1); }
  if (e.key === 'Home') { e.preventDefault(); go(0); }
  if (e.key === 'End') { e.preventDefault(); go(1e9); }
});

// ---------- start ----------
async function boot() {
  renderGameList();
  render();
  renderLower();
  const records = (await library.all()).sort((x, y) => x.added - y.added);
  const legacy = store.get('games', []);
  if (records.length) {
    const stale = [];
    for (const r of records) {
      const g = makeGame(r.pgn);
      Object.assign(g, { key: r.key, added: r.added, userColor: r.userColor, colorKnown: r.colorKnown });
      if (r.version === ANALYSIS_VERSION && r.game) {
        g.game = r.game;
        g.report = gameReport(g.game, g.userColor, { openingMoves: OPENING_MOVES });
      } else {
        stale.push(g);
      }
      state.games.push(g);
    }
    state.current = 0;
    renderGameList();
    render();
    renderLower();
    if (stale.length) {
      setStatus(`Updating the analysis of ${stale.length} saved games…`);
      await analyseGames(stale);
      setStatus('');
    }
  } else if (legacy.length) {
    // Games saved by an earlier version of the app.
    const colors = new Map(legacy.map((l) => [compactPgn(l.pgn), l.userColor]));
    const games = legacy.map((l) => l.pgn);
    await addGames(games);
    for (const g of state.games) {
      const c = colors.get(g.pgn);
      if (c) setUserColor(g, c);
    }
    library.put(state.games.filter((g) => g.game).map(record));
    store.set('games', []);
    setStatus('');
    renderGameList();
    render();
    renderLower();
  } else {
    await addGames(SAMPLES.map((x) => x.pgn), { userColor: 'w', persist: false, sample: true });
    setStatus('');
    go(4);
    renderLower();
  }
}
boot();

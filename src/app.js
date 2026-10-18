import { Chess } from '../vendor/chess.js';
import { analyzePosition, rankMoves, dominanceShare, other, LABELS } from './analysis.js';
import { analyzeGame, assessMove, gameReport, habitPatterns, detectUserColor, describeDeltas, TAGS } from './insights.js';
import { splitPgn, fetchLichess, fetchChessCom } from './import.js';
import { Board } from './board.js';
import { renderChart } from './chart.js';
import { SAMPLES } from './samples.js';

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
};
let nextId = 1;

// ---------- analysis worker ----------
let worker = null;
const pending = new Map();
try {
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    e.data.error ? p.reject(new Error(e.data.error)) : p.resolve(e.data.game);
  };
  worker.onerror = () => {
    worker = null;
    for (const p of pending.values()) p.reject(new Error('Worker failed'));
    pending.clear();
  };
} catch { worker = null; }

function runAnalysis(id, pgn) {
  if (!worker) return new Promise((res) => setTimeout(() => res(analyzeGame(pgn, { window: WINDOW })), 0));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, pgn, window: WINDOW });
  }).catch((err) => {
    if (/Worker|module/i.test(err.message)) return analyzeGame(pgn, { window: WINDOW });
    throw err;
  });
}

// ---------- games ----------
function readHeaders(pgn) {
  const h = {};
  for (const m of pgn.matchAll(/\[(\w+)\s+"([^"]*)"\]/g)) h[m[1]] = m[2];
  return h;
}

async function addGames(pgns, { userColor = null, persist = true, sample = false } = {}) {
  const username = $('username').value;
  const added = pgns.map((pgn) => {
    const headers = readHeaders(pgn);
    return { id: nextId++, pgn, headers, userColor: userColor || detectUserColor(headers, username) || 'w', colorKnown: !!(userColor || detectUserColor(headers, username)), sample, game: null, error: null };
  });
  state.games.push(...added);
  if (persist) saveGames();
  if (state.current < 0 && added.length) state.current = state.games.indexOf(added[0]);
  renderGameList();
  render();
  let done = 0;
  for (const g of added) {
    setStatus(`Analysing ${++done} of ${added.length}…`);
    try {
      g.game = await runAnalysis(g.id, g.pgn);
      g.report = gameReport(g.game, g.userColor, { openingMoves: OPENING_MOVES });
    } catch (err) {
      g.error = err.message;
    }
    renderGameList();
    if (state.games[state.current] === g) render();
  }
  setStatus(added.length ? `Analysed ${added.length} game${added.length > 1 ? 's' : ''}.` : '');
  renderLower();
}

function saveGames() {
  store.set('games', state.games.filter((g) => !g.sample).slice(-50).map((g) => ({ pgn: g.pgn, userColor: g.colorKnown ? g.userColor : null })));
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
  return { fen: pos.fen, analysis: pos.analysis, assessment: ply, move: ply };
}

const userColor = () => (currentGame() ? currentGame().userColor : 'w');

// ---------- board ----------
const board = new Board($('board'), { onMove: handleBoardMove });

function handleBoardMove(m) {
  if (state.mode === 'train') return answerQuiz(m);
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
  if (!training && state.showBest) {
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
    legal: training && state.quiz && state.quiz.answer ? null : chess.moves({ verbose: true }),
  });

  const share = dominanceShare(a.dominance);
  $('share-w').style.width = share.toFixed(1) + '%';
  $('share-w-label').textContent = `White ${Math.round(share)}%`;
  $('share-b-label').textContent = `Black ${100 - Math.round(share)}%`;

  document.querySelectorAll('[data-overlay]').forEach((b) => {
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(b.dataset.overlay === state.overlay));
  });
  $('legend').innerHTML = LEGENDS[state.overlay](freedomSide) + (arrows.length && !training ? ' Arrows show the next move: green is the most dominating option, grey is what was played.' : '');
  $('freedom-side').value = state.freedom;
  $('show-best').checked = state.showBest;
  $('as-color').value = me;

  renderTitle();
  renderNav();
  renderMetrics(a);
  if (training) renderQuizCoach(); else renderCoach(v);
  renderMoves();
  renderGraph();
  $('variation').hidden = !state.variation;
  if (state.variation) $('variation-moves').textContent = state.variation.positions.slice(1, state.variation.cursor + 1).map((p) => p.move.san).join(' ');
}

function renderTitle() {
  const g = currentGame();
  if (state.mode === 'train') {
    $('game-title').innerHTML = '<strong>Trainer</strong><small>Positions from your games where a more dominating move was available</small>';
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
  else if (v) label = `Line, move ${v.cursor}`;
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
  if (!g || !g.game) { el.innerHTML = '<li class="empty" style="grid-column:1/-1">No moves yet.</li>'; return; }
  let html = '';
  g.game.plies.forEach((p, i) => {
    if (p.color === 'w' || i === 0) html += `<span class="num">${p.fullmove}.</span>`;
    if (i === 0 && p.color === 'b') html += '<span></span>';
    const cur = !state.variation && state.index === i + 1;
    html += `<button type="button" data-ply="${i + 1}" aria-current="${cur}">${p.label ? `<span class="dot ${p.label}"></span>` : ''}${esc(p.san)}</button>`;
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
  if (!state.games.length) { el.innerHTML = '<li class="empty">Paste a PGN or import your games to start.</li>'; return; }
  el.innerHTML = state.games.map((g, i) => {
    const h = g.headers;
    const r = g.report;
    const status = g.error ? `<span class="pill mistake">Error</span>` : !g.game ? '<span>Analysing…</span>' : `<span>As ${g.userColor === 'w' ? 'White' : 'Black'}</span><span>${h.Result || ''}</span>${r ? `<span>Avg gap ${r.avgGap.toFixed(1)}</span>` : ''}`;
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
  $('import-btn').textContent = tab === 'pgn' ? 'Analyse' : 'Import & analyse';
});
bindTabs($('lower-tabs'), (tab) => {
  document.querySelectorAll('.lower > [data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== tab; });
});

$('import-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('import-btn');
  const username = $('username').value.trim();
  const max = Math.max(1, Math.min(50, Number($('game-count').value) || 15));
  btn.disabled = true;
  try {
    let pgns;
    if (importSource === 'pgn') {
      pgns = splitPgn($('pgn-input').value);
      if (!pgns.length) throw new Error('No games found. Paste PGN text that includes the moves.');
    } else {
      if (!username) throw new Error('Enter your username at the top first.');
      setStatus(`Fetching games for ${username}…`);
      pgns = importSource === 'lichess' ? await fetchLichess(username, max) : await fetchChessCom(username, max);
      if (!pgns.length) throw new Error('No standard games found for that account.');
    }
    const firstNew = state.games.length;
    await addGames(pgns);
    selectGame(firstNew);
    if (importSource === 'pgn') $('pgn-input').value = '';
  } catch (err) {
    const blocked = err instanceof TypeError;
    setStatus(blocked ? 'Couldn’t reach the site. Check your connection, or paste PGN instead.' : err.message, true);
  } finally {
    btn.disabled = false;
  }
});

$('username').value = store.get('username', '');
$('username').addEventListener('change', () => {
  const u = $('username').value.trim();
  store.set('username', u);
  for (const g of state.games) {
    const c = detectUserColor(g.headers, u);
    if (c && c !== g.userColor) setUserColor(g, c);
  }
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
  saveGames();
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
  saveGames();
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

const cursor = () => (state.variation ? state.variation.cursor : state.index);
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
const saved = store.get('games', []);
renderGameList();
render();
renderLower();
if (saved.length) {
  addGames(saved.map((s) => s.pgn), { persist: false }).then(() => {
    saved.forEach((s, i) => { if (s.userColor && state.games[i]) setUserColor(state.games[i], s.userColor); });
    renderGameList();
    render();
    renderLower();
  });
} else {
  addGames(SAMPLES.map((s) => s.pgn), { userColor: 'w', persist: false, sample: true }).then(() => {
    go(4);
    renderLower();
  });
}

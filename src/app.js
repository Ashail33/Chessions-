import { Chess } from '../vendor/chess.js';
import { analyzePosition, rankMoves, dominanceShare, other, LABELS } from './analysis.js';
import { assessMove, describeDeltas, TAGS } from './insights.js';
import { splitPgn, fetchLichess, fetchChessCom, TIME_CLASSES } from './import.js';
import { Collection, OPENING_MOVES } from './collection.js';
import { Board } from './board.js';
import { renderChart, miniChart } from './chart.js';
import { gameFacts, aggregate, filterFacts } from './stats.js';
import { checkGame, NAG } from './enginecheck.js';
import { engineGrade } from './play.js';
import { SAMPLES } from './samples.js';
import { Engine, formatScore, uciToMove } from './engine.js';
import { PlaySession, LEVELS, PUNISH, sideName } from './play.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('chessions:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('chessions:' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const SCREENS = ['play', 'review', 'insights', 'train'];
const START_FEN = new Chess().fen();

const state = {
  screen: SCREENS.includes(store.get('screen')) ? store.get('screen') : 'play',
  username: store.get('username', ''),
  current: 0,
  index: 0,
  variation: null,
  overlay: store.get('overlay', 'control'),
  freedom: store.get('freedom', 'opp'),
  showBest: store.get('showBest', true),
  why: store.get('why', false),
  flipped: false,
  insights: 'game',
  setup: { color: 'w', level: 'club', punish: 'mistakes', ...store.get('play', {}) },
  play: null,
  playIndex: null, // null follows the live position
  hint: null,
  quiz: null,
  importMsg: { text: '', error: false },
  statsFilter: { color: 'all', timeClass: 'all' },
  gamesFilter: null, // opening key shown in the games sheet
  check: null, // Stockfish game check in progress
};
let engine = null;

const games = new Collection({
  username: () => state.username,
  onChange: () => render(),
  onProgress: (text) => setImportMsg(text),
});

// ---------- position cache ----------
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

// ---------- view model ----------
const currentGame = () => games.games[state.current] || null;
const playCursor = () => (state.playIndex === null ? state.play.positions.length - 1 : state.playIndex);
const playLive = () => state.screen === 'play' && state.play && state.playIndex === null;
const playActive = () => state.play && !state.play.over && !state.play.resigned;
const canMoveInPlay = () => playLive() && !state.play.thinking && playActive() && state.play.chess.turn() === state.play.userColor;

const emptyView = () => ({ fen: START_FEN, analysis: analysisFor(START_FEN), assessment: null, move: null });

function view() {
  if (state.screen === 'play') return state.play ? state.play.positions[playCursor()] : emptyView();
  if (state.screen === 'train') return state.quiz ? state.quiz.position : emptyView();
  if (state.variation) return state.variation.positions[state.variation.cursor];
  const g = currentGame();
  if (!g || !g.game) return emptyView();
  const pos = g.game.positions[state.index];
  const ply = state.index > 0 ? g.game.plies[state.index - 1] : null;
  return { fen: pos.fen, analysis: analysisFor(pos.fen), assessment: ply, move: ply };
}

function userColor() {
  if (state.screen === 'play') return state.play ? state.play.userColor : state.setup.color === 'b' ? 'b' : 'w';
  if (state.screen === 'train' && state.quiz) return state.quiz.items[state.quiz.i].game.userColor;
  const g = currentGame();
  return g ? g.userColor : 'w';
}

// ---------- board ----------
const board = new Board($('board'), { onMove: handleBoardMove });

function handleBoardMove(m) {
  if (state.screen === 'train') return answerQuiz(m);
  if (state.screen === 'play') {
    if (!canMoveInPlay()) return;
    state.hint = null;
    state.play.userMove(m);
    return;
  }
  const v = view();
  const g = currentGame();
  if (!g || !g.game) return;
  // Playing the game's own next move just steps forward.
  if (!state.variation) {
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

// Play a move from a position and assess it against every alternative.
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
  board.clearSelection();
  if (state.screen === 'play') {
    if (!state.play) return;
    const last = state.play.positions.length - 1;
    const i = Math.max(0, Math.min(last, index));
    state.playIndex = i === last ? null : i;
  } else if (state.screen === 'review') {
    const g = currentGame();
    if (state.variation) {
      const v = state.variation;
      if (index <= 0) return exitVariation();
      v.cursor = Math.min(v.positions.length - 1, index);
    } else if (g && g.game) {
      state.index = Math.max(0, Math.min(g.game.positions.length - 1, index));
    }
  }
  render();
}

function cursor() {
  if (state.screen === 'play') return state.play ? playCursor() : 0;
  return state.variation ? state.variation.cursor : state.index;
}

function exitVariation() {
  if (!state.variation) return;
  state.index = state.variation.base;
  state.variation = null;
  board.clearSelection();
  render();
}

// ---------- shared pieces ----------
const fmtSigned = (x) => (x === null || x === undefined ? '–' : (x > 0 ? '+' : '') + x.toFixed(1));
const pct = (x) => (x === null || x === undefined ? '–' : Math.round(x * 100) + '%');
const moveNo = (p) => `${p.fullmove}${p.color === 'w' ? '.' : '…'}`;
const pill = (tone, text) => `<span class="pill ${tone}">${esc(text)}</span>`;

function tagList(tags) {
  if (!tags || !tags.length) return '';
  return `<ul class="tags">${tags.map((t) => `<li class="${TAGS[t].tone}"><b>${TAGS[t].text}</b> ${TAGS[t].lesson}</li>`).join('')}</ul>`;
}

// "Why" details keep their open state across renders.
function why(content, label = 'Why') {
  if (!content) return '';
  return `<details class="why" ${state.why ? 'open' : ''}><summary>${label}</summary><div class="why-body">${content}</div></details>`;
}

function chipGroup(name, options, value) {
  return `<div class="chips" role="radiogroup" data-group="${name}">${options.map((o) => `<button type="button" role="radio" aria-checked="${o.value === value}" data-value="${o.value}">${esc(o.text)}${o.sub ? `<small>${esc(o.sub)}</small>` : ''}</button>`).join('')}</div>`;
}

function moveStrip(plies, current) {
  if (!plies.length) return '';
  return `<div class="strip" id="strip">${plies.map((p, i) => `${p.color === 'w' || i === 0 ? `<span class="num">${p.fullmove}.</span>` : ''}<button type="button" data-ply="${i + 1}" aria-current="${current === i + 1}">${p.dot ? `<i class="dot ${p.dot}"></i>` : ''}${esc(p.san)}${p.nag ? `<span class="nag ${p.nag.cls}">${p.nag.text}</span>` : ''}</button>`).join('')}</div>`;
}

function scrollStrip() {
  const strip = $('strip');
  const cur = strip && strip.querySelector('[aria-current="true"]');
  if (!cur) return;
  const left = cur.offsetLeft - strip.offsetLeft;
  if (left < strip.scrollLeft + 24 || left > strip.scrollLeft + strip.clientWidth - cur.offsetWidth - 24) {
    strip.scrollLeft = left - strip.clientWidth / 2 + cur.offsetWidth / 2;
  }
}

// ---------- render ----------
const LEGENDS = {
  control: '<i class="sw w"></i>White <i class="sw b"></i>Black <i class="sw c"></i>Contested squares',
  freedom: (side) => `<i class="sw g"></i>Safe squares for ${side === 'w' ? 'White' : 'Black'} <i class="sw x"></i>Denied. Badges: safe moves per piece`,
  impact: '<i class="sw g"></i>Squares won <i class="sw x"></i>Squares given up by the last move',
  none: '',
};

function render() {
  document.querySelectorAll('#tabs [data-screen]').forEach((b) => b.setAttribute('aria-current', String(b.dataset.screen === state.screen)));
  document.body.dataset.screen = state.screen;
  // The board only shows when there is something on it.
  const showStage = state.screen === 'play' ? !!state.play : state.screen === 'train' ? !!state.quiz : state.screen === 'review' ? !!currentGame() : false;
  $('stage').hidden = !showStage;
  if (showStage) renderStage();
  renderPanel();
  scrollStrip();
}

function renderStage() {
  const v = view();
  const me = userColor();
  const freedomSide = state.freedom === 'opp' ? other(me) : me;
  const arrows = [];
  let legal = null;
  const chess = new Chess(v.fen);

  if (state.screen === 'play') {
    if (canMoveInPlay()) legal = chess.moves({ verbose: true });
    if (state.hint && playLive()) {
      if (state.hint.dom) arrows.push({ ...state.hint.dom, kind: 'dom' });
      if (state.hint.engine) arrows.push({ ...state.hint.engine, kind: 'best' });
    }
  } else if (state.screen === 'train') {
    if (state.quiz && !state.quiz.answer) legal = chess.moves({ verbose: true });
    if (state.quiz && state.quiz.answer) arrows.push({ ...state.quiz.answer.best, kind: 'best' });
  } else {
    const g = currentGame();
    if (g && g.game) legal = chess.moves({ verbose: true });
    const next = !state.variation && g && g.game ? g.game.plies[state.index] : null;
    if (state.showBest && next && next.best) {
      arrows.push({ from: next.best.from, to: next.best.to, kind: 'best' });
      if (next.best.san !== next.san) arrows.push({ from: next.from, to: next.to, kind: 'played' });
    }
  }

  board.render({
    analysis: v.analysis,
    orientation: state.flipped ? other(me) : me,
    overlay: state.overlay,
    freedomSide,
    impact: v.assessment ? v.assessment.deltas : null,
    lastMove: v.move ? { from: v.move.from, to: v.move.to } : null,
    arrows,
    legal,
  });

  const share = dominanceShare(v.analysis.dominance);
  $('share-w').style.width = share.toFixed(1) + '%';
  $('share-w-label').textContent = `White ${Math.round(share)}%`;
  $('share-b-label').textContent = `${100 - Math.round(share)}% Black`;

  document.querySelectorAll('#lens [data-overlay]').forEach((b) => {
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(b.dataset.overlay === state.overlay));
  });
  const legend = LEGENDS[state.overlay];
  $('legend').innerHTML = typeof legend === 'function' ? legend(freedomSide) : legend;

  // Navigation label and availability.
  let label = 'Start';
  if (v.move) label = `${moveNo(v.move)} ${v.move.san}`;
  if (state.screen === 'train') label = state.quiz ? `${state.quiz.i + 1} of ${state.quiz.items.length}` : '';
  $('nav-pos').textContent = label;
  const navigable = state.screen === 'review' || (state.screen === 'play' && state.play);
  document.querySelector('.boardbar').classList.toggle('no-nav', !navigable);

  $('stage-head').innerHTML = stageHead();
  const pick = $('pick-game');
  if (pick) pick.onclick = () => openSheet('games');
  const exit = $('exit-line');
  if (exit) exit.onclick = exitVariation;
}

function stageHead() {
  if (state.screen === 'play') {
    if (!state.play) return '<div class="who"><b>Stockfish</b><span>Pick your settings below</span></div>';
    const s = state.play;
    return `<div class="who"><b>Stockfish · ${esc(s.level.text)}</b><span>${s.punish.key === 'always' ? 'Full strength' : 'Punishes ' + (s.punish.key === 'mistakes' ? 'mistakes' : 'inaccuracies')} · you play ${sideName(s.userColor)}</span></div>`;
  }
  if (state.screen === 'train') {
    if (!state.quiz) return '<div class="who"><b>Trainer</b><span>Positions from your games</span></div>';
    const item = state.quiz.items[state.quiz.i];
    const h = item.game.headers;
    return `<div class="who"><b>${sideName(item.ply.color)} to move</b><span>${esc(h.White || '?')} vs ${esc(h.Black || '?')}, move ${item.ply.fullmove}</span></div>`;
  }
  const g = currentGame();
  if (state.variation) {
    const line = state.variation.positions.slice(1, state.variation.cursor + 1).map((p) => p.move.san).join(' ');
    return `<div class="line-banner"><span>Your line: <b class="mono">${esc(line)}</b></span><button type="button" class="btn small" id="exit-line">Back to game</button></div>`;
  }
  if (!g) return '<button type="button" class="game-pick" id="pick-game"><b>No games yet</b><span>Tap to import your games</span><i class="caret"></i></button>';
  const h = g.headers;
  const sub = [h.Date && !h.Date.startsWith('?') ? h.Date.replace(/\.\?\?/g, '') : null, h.Result, g.game ? null : 'analysing…'].filter(Boolean).join(' · ');
  return `<button type="button" class="game-pick" id="pick-game"><b>${esc(h.White || 'White')} vs ${esc(h.Black || 'Black')}</b><span>${esc(sub)}</span><i class="caret"></i></button>`;
}

function renderPanel() {
  const el = $('panel');
  const html = { play: playPanel, review: reviewPanel, insights: insightsPanel, train: trainPanel }[state.screen]();
  el.innerHTML = html;
  bindPanel(el);
}

function bindPanel(el) {
  el.querySelectorAll('details.why').forEach((d) => d.addEventListener('toggle', () => { state.why = d.open; store.set('why', state.why); }));
  el.querySelectorAll('[data-ply]').forEach((b) => { b.onclick = () => { state.variation = null; go(Number(b.dataset.ply)); }; });
  el.querySelectorAll('[data-action]').forEach((b) => { b.onclick = () => ACTIONS[b.dataset.action](b); });
  el.querySelectorAll('.chips[data-group]').forEach((group) => {
    group.querySelectorAll('[data-value]').forEach((b) => {
      b.onclick = () => {
        const key = group.dataset.group;
        if (key === 'insights') state.insights = b.dataset.value;
        else if (key === 'statColor') state.statsFilter.color = b.dataset.value;
        else if (key === 'statTime') state.statsFilter.timeClass = b.dataset.value;
        else {
          state.setup[group.dataset.group] = b.dataset.value;
          store.set('play', state.setup);
        }
        render();
      };
    });
  });
  const chart = $('chart');
  if (chart) drawChart(chart);
}

// ---------- Play ----------
function playPanel() {
  const s = state.play;
  if (!s) return playSetup();
  const live = playLive();
  const idx = playCursor();
  let userIdx = -1;
  for (let i = idx; i > 0; i--) if (s.positions[i].move.color === s.userColor) { userIdx = i; break; }
  const userPos = userIdx > 0 ? s.positions[userIdx] : null;
  const replyPos = userIdx > 0 && userIdx + 1 <= idx ? s.positions[userIdx + 1] : null;

  let status;
  if (s.error) status = `<p class="status error">${esc(s.error)}</p>`;
  else if (!playActive()) status = '';
  else if (!live) status = `<div class="status-row"><span>Looking back</span><button type="button" class="btn small" data-action="playLive">Back to the game</button></div>`;
  else if (s.thinking) status = `<div class="status-row"><span class="thinking">${s.chess.turn() === s.userColor ? 'Checking your position' : 'Stockfish is thinking'}</span>${s.userEval ? `<span class="eval">${formatScore(s.userEval.score)}</span>` : ''}</div>`;
  else status = `<div class="status-row"><b>Your move</b>${s.userEval ? `<span class="eval" title="Engine evaluation for you">${formatScore(s.userEval.score)}</span>` : ''}</div>`;

  let card = '';
  if (!userPos) {
    card = `<article class="verdict"><p class="v-line">${s.positions.length > 1 ? 'Stockfish has opened. ' : ''}Play a move on the board. ${s.punish.key === 'always' ? 'Stockfish is at full strength.' : `If a move costs you ${s.punish.threshold >= 100 ? 'a pawn' : 'half a pawn'} or more, Stockfish switches to full strength.`}</p></article>`;
  } else {
    const u = userPos.move;
    const e = userPos.engine;
    const head = `<div class="v-head"><span class="v-move mono">${moveNo(u)} ${esc(u.san)}</span>${e ? pill(e.grade.tone, e.grade.text) : '<span class="thinking small">Judging</span>'}${e && e.loss >= 20 ? `<span class="v-meta">−${(e.loss / 100).toFixed(1)}</span>` : ''}</div>`;
    const better = e && e.better && e.loss > 50 ? `<p class="v-line">Better was <b class="mono">${esc(e.better)}</b>.</p>` : '';
    let reply = '';
    if (replyPos) {
      const r = replyPos.move;
      reply = r.punished && e && e.loss >= Math.max(50, s.punish.threshold)
        ? `<div class="punish"><b>Punished with ${esc(r.san)}</b><span class="mono">${esc(e.threat.join(' '))}</span></div>`
        : `<p class="v-line muted">Stockfish replied <b class="mono">${esc(r.san)}</b>.</p>`;
    }
    const details = [
      e ? `<p>Evaluation for you went from <b>${formatScore(e.evalBefore)}</b> to <b>${formatScore(e.evalAfter)}</b>.</p>` : '',
      u.label ? `<p>Board dominance: <b>${LABELS[u.label].text}</b>, #${u.rank} of ${u.total} moves. ${describeDeltas(u.deltas)}</p>` : '',
      tagList(u.tags),
    ].join('');
    card = `<article class="verdict tone-${e ? e.grade.tone : 'neutral'}">${head}${better}${reply}${why(details)}</article>`;
  }

  let end = '';
  if (!playActive()) {
    const r = s.resigned ? 'loss' : s.result();
    const text = s.resigned ? 'You resigned' : r === 'win' ? 'You won!' : r === 'loss' ? 'Stockfish wins' : 'Draw';
    end = `<article class="result ${r}"><h2>${text}</h2><p>See where the game turned and add its lessons to your patterns.</p><div class="actions"><button type="button" class="btn primary" data-action="reviewPlayed">Review this game</button><button type="button" class="btn" data-action="newGame">New game</button></div></article>`;
  }

  const actions = playActive()
    ? `<div class="action-bar">
        <button type="button" class="btn" data-action="hint" ${canMoveInPlay() ? '' : 'disabled'}>Hint</button>
        <button type="button" class="btn" data-action="undo" ${s.thinking || s.positions.length < 2 ? 'disabled' : ''}>Take back</button>
        <button type="button" class="btn" data-action="resign">Resign</button>
      </div>`
    : '';

  let hint = '';
  if (state.hint && live) {
    const h = state.hint;
    hint = `<p class="hint-line">${h.engine ? `<i class="sw best"></i>Engine: <b class="mono">${esc(h.engine.san)}</b>` : ''}${h.dom && (!h.engine || h.dom.san !== h.engine.san) ? ` <i class="sw dom"></i>Most dominating: <b class="mono">${esc(h.dom.san)}</b>` : ''}</p>`;
  }

  const plies = s.positions.slice(1).map((p) => ({ ...p.move, dot: p.move.punished ? 'punished' : p.engine ? p.engine.grade.tone : null }));
  return `${end}${status}${card}${hint}${actions}${moveStrip(plies, idx)}`;
}

function playSetup() {
  const short = { beginner: 'Beginner', club: 'Club', strong: 'Strong', expert: 'Expert', max: 'Max' };
  const levels = LEVELS.map((l) => ({ value: l.key, text: short[l.key], sub: l.elo ? String(l.elo) : 'full' }));
  const punish = [
    { value: 'mistakes', text: 'Mistakes' },
    { value: 'inaccuracies', text: 'Inaccuracies' },
    { value: 'always', text: 'Always' },
  ];
  const punishNote = {
    mistakes: 'Plays at your level, but goes full strength after any move that loses a pawn or more.',
    inaccuracies: 'Goes full strength after anything that loses half a pawn or more.',
    always: 'Full strength every move. Hard mode.',
  }[state.setup.punish];
  return `<article class="setup">
    <h2>Play Stockfish</h2>
    <div class="field"><span class="label">Play as</span>${chipGroup('color', [{ value: 'w', text: 'White' }, { value: 'b', text: 'Black' }, { value: 'r', text: 'Random' }], state.setup.color)}</div>
    <div class="field"><span class="label">Opponent</span>${chipGroup('level', levels, state.setup.level)}</div>
    <div class="field"><span class="label">Punish</span>${chipGroup('punish', punish, state.setup.punish)}<p class="note">${punishNote}</p></div>
    <button type="button" class="btn primary wide" data-action="startGame">Start game</button>
    <p class="status ${state.engineError ? 'error' : ''}" id="play-status">${state.engineError ? esc(state.engineError) : ''}</p>
  </article>`;
}

// ---------- Review ----------
function reviewPanel() {
  const g = currentGame();
  const banner = games.busy || state.importMsg.text ? `<p class="status ${state.importMsg.error ? 'error' : ''}">${esc(state.importMsg.text)}</p>` : '';
  if (!g) {
    return `${banner}<article class="empty-card"><h2>Bring in your games</h2><p>Import from Chess.com or Lichess, or paste PGN. Every opening move gets graded by how much of the board it wins.</p><button type="button" class="btn primary wide" data-action="openImport">Import games</button></article>`;
  }
  if (!g.game) return `${banner}<article class="verdict"><p class="v-line"><span class="thinking">Analysing this game</span></p></article>`;
  const v = view();
  const p = v.assessment;
  let card;
  if (!p) {
    card = `<article class="verdict"><p class="v-line">Step through with ▶ or tap a move. Each move shows how it changed your grip on the board.</p></article>`;
  } else {
    const who = p.color === g.userColor ? 'You' : 'Opponent';
    const head = `<div class="v-head"><span class="v-move mono">${moveNo(p)} ${esc(p.san)}</span>${p.label ? pill(p.label, LABELS[p.label].text) : pill('neutral', 'Not graded')}<span class="v-meta">${who}${p.rank ? ` · #${p.rank} of ${p.total}` : ''}</span></div>`;
    const best = p.best && p.best.san !== p.san ? `<p class="v-line">Most dominating: <b class="mono">${esc(p.best.san)}</b></p>` : p.best ? '<p class="v-line">The most dominating move here.</p>' : '<p class="v-line muted">Moves after 20 aren’t graded.</p>';
    const alts = p.alternatives
      ? `<ol class="alts">${p.alternatives.map((m, i) => `<li><button type="button" data-action="tryAlt" data-alt="${i}"><span>${i + 1}. <b class="mono">${esc(m.san)}</b>${m.san === p.san ? ' (played)' : ''}</span><span class="muted">${i === 0 ? 'best' : '−' + (p.alternatives[0].score - m.score).toFixed(1)}</span></button></li>`).join('')}</ol>`
      : '';
    const details = `<p>${describeDeltas(p.deltas)}</p>${tagList(p.tags)}${alts ? `<p class="label">Top moves here (tap to try one)</p>${alts}` : ''}`;
    card = `<article class="verdict tone-${p.label || 'neutral'}">${head}${best}${engineLine(g, p.ply)}${why(details)}</article>`;
  }
  const plies = g.game.plies.map((x, i) => ({ ...x, dot: x.label, nag: nagFor(g, i) }));
  const key = g.engine ? '<p class="key"><span><i class="all"></i>Board control</span><span><i class="engine"></i>Engine evaluation</span></p>' : '';
  return `${banner}${card}${checkBar([g])}${moveStrip(plies, state.variation ? -1 : state.index)}<div class="chart" id="chart"></div>${key}`;
}

function engineLine(g, plyIndex) {
  const e = g.engine && g.engine.plies[plyIndex];
  if (!e) return '';
  const grade = engineGrade(e.loss);
  return `<p class="engine-line"><span class="src">Engine</span>${pill(grade.tone, grade.text)}${e.loss >= 20 ? `<span class="mono">\u2212${(e.loss / 100).toFixed(1)}</span>` : ''}${e.best ? `<span>best <b class="mono">${esc(e.best)}</b></span>` : ''}</p>`;
}

function nagFor(g, i) {
  const e = g.engine && g.engine.plies[i];
  return e && NAG[e.grade] ? { text: NAG[e.grade], cls: e.grade } : null;
}

// Offer, or show progress of, a Stockfish check for these games.
function checkBar(list, label = 'Check this game with Stockfish', waiting = list.filter((g) => g.game && !g.engine).length) {
  if (state.check) {
    const c = state.check;
    const pctDone = c.total ? (100 * c.done) / c.total : 0;
    const which = c.list.length > 1 ? `Game ${c.i + 1} of ${c.list.length}` : 'Stockfish is checking';
    return `<div class="check-bar"><span id="check-text">${which}</span><div class="progress"><span id="check-progress" style="width:${pctDone}%"></span></div><button type="button" class="btn small" data-action="cancelCheck">Cancel</button></div>`;
  }
  const todo = list.filter((g) => g.game && !g.engine);
  if (!todo.length) return '';
  state.checkTargets = todo;
  return `<div class="check-bar"><span>${waiting > 1 ? `${waiting} games not checked yet` : 'Find tactical mistakes too'}</span><button type="button" class="btn small" data-action="runCheck">${todo.length > 1 ? label : 'Check with Stockfish'}</button></div>`;
}

async function runEngineCheck(list) {
  if (state.check || !list.length) return;
  if (!engine) engine = new Engine();
  state.check = { list, i: 0, done: 0, total: 0, cancelled: false };
  render();
  try {
    await engine.ready;
  } catch (err) {
    state.check = null;
    engine = null;
    setImportMsg(`Stockfish couldn\u2019t start here (${err.message}).`, true);
    return;
  }
  for (const g of list) {
    const c = state.check;
    if (!c || c.cancelled) break;
    const res = await checkGame(engine, g.game, {
      movetime: 80,
      isCancelled: () => !state.check || state.check.cancelled,
      onProgress: (done, total) => {
        c.done = done;
        c.total = total;
        const bar = $('check-progress');
        if (bar) bar.style.width = `${(100 * done) / total}%`;
      },
    });
    if (res) {
      g.engine = res;
      games.save(g);
    }
    c.i++;
    c.done = 0;
    if (c.i < list.length) render();
  }
  state.check = null;
  render();
}

function drawChart(el) {
  const g = currentGame();
  if (state.screen !== 'review' || !g || !g.game) return;
  const sign = g.userColor === 'w' ? 1 : -1;
  renderChart(el, {
    values: g.game.positions.map((p) => sign * p.analysis.dominance),
    marks: g.game.plies.filter((p) => p.color === g.userColor && p.label).map((p) => ({ index: p.ply + 1, label: p.label })),
    current: state.variation ? state.variation.base : state.index,
    openingPlies: OPENING_MOVES * 2,
    onSelect: (i) => { state.variation = null; go(i); },
    engine: g.engine ? g.engine.evals.map((v) => sign * v) : null,
  });
}

// ---------- Insights ----------
function labelBar(counts) {
  const total = Object.values(counts).reduce((s, n) => s + n, 0) || 1;
  return `<div class="labelbar">${Object.keys(LABELS).map((k) => (counts[k] ? `<span class="${k}" style="width:${(100 * counts[k]) / total}%"></span>` : '')).join('')}</div>
    <p class="legend-row">${Object.keys(LABELS).filter((k) => counts[k]).map((k) => `<span><i class="dot ${k}"></i>${LABELS[k].text} ${counts[k]}</span>`).join('')}</p>`;
}

function insightsPanel() {
  const own = games.games.filter((g) => g.report);
  const tabs = chipGroup('insights', [{ value: 'game', text: 'This game' }, { value: 'all', text: `All games${own.length ? ` (${own.length})` : ''}` }], state.insights);
  return `<div class="insights">${tabs}${state.insights === 'game' ? gameInsights() : allInsights(own)}</div>`;
}

function gameInsights() {
  const g = currentGame();
  if (!g || !g.report) return '<article class="empty-card"><p>Pick a game in Review to see its opening report.</p></article>';
  const r = g.report;
  const h = g.headers;
  const leaks = Object.entries(r.tagCounts).filter(([t]) => TAGS[t].tone === 'warn' || TAGS[t].tone === 'bad').sort((a, b) => b[1] - a[1]);
  return `
    <p class="context">${esc(h.White || '?')} vs ${esc(h.Black || '?')} · you played ${sideName(g.userColor)}</p>
    <div class="tiles">
      <div class="tile"><b class="${r.dominanceAt[12] >= 0 ? 'pos' : 'neg'}">${fmtSigned(r.dominanceAt[12])}</b><span>Board after move 12</span></div>
      <div class="tile"><b>${r.avgGap.toFixed(1)}</b><span>Avg gap to best</span></div>
      <div class="tile"><b>${r.castledBy ? 'Move ' + r.castledBy : 'No'}</b><span>Castled</span></div>
      <div class="tile"><b>${r.developedBy8}/4</b><span>Minors out by move 8</span></div>
    </div>
    ${engineBlock(g)}
    <section class="block"><h3>Your opening moves</h3>${labelBar(r.counts)}</section>
    <section class="block"><h3>Turning points</h3>${r.turningPoints.length ? `<ul class="list">${r.turningPoints.map((p) => `<li><button type="button" data-action="jump" data-jump="${p.ply}"><span><b class="mono">${moveNo(p)} ${esc(p.san)}</b> ${pill(p.label, LABELS[p.label].text)}</span><span class="muted">Best was <b class="mono">${esc(p.best.san)}</b></span></button></li>`).join('')}</ul>` : '<p class="muted">No big misses in the opening.</p>'}</section>
    ${leaks.length ? `<section class="block"><h3>What cost you board</h3>${why(`<ul class="tags">${leaks.map(([t, n]) => `<li class="${TAGS[t].tone}"><b>${TAGS[t].text} ×${n}</b> ${TAGS[t].lesson}</li>`).join('')}</ul>`, leaks.map(([t, n]) => `${TAGS[t].text} ×${n}`).join(' · '))}</section>` : ''}`;
}

function engineBlock(g) {
  if (!g.engine) return `<section class="block"><h3>Engine check</h3>${checkBar([g]) || '<p class="muted">Not checked yet.</p>'}</section>`;
  const f = gameFacts(g);
  const misses = g.game.plies
    .map((p, i) => ({ p, e: g.engine.plies[i] }))
    .filter(({ p, e }) => p.color === g.userColor && e && e.loss >= 50)
    .sort((a, b) => b.e.loss - a.e.loss)
    .slice(0, 3);
  return `<section class="block"><h3>Engine check</h3>
    <div class="tiles">
      <div class="tile"><b>${f.engine.acpl === null ? '\u2013' : Math.round(f.engine.acpl)}</b><span>Avg loss per move (centipawns)</span></div>
      <div class="tile"><b class="${f.engine.blunders ? 'neg' : ''}">${f.engine.blunders}</b><span>Blunders</span></div>
      <div class="tile"><b>${f.engine.mistakes}</b><span>Mistakes</span></div>
      <div class="tile"><b>${f.engine.inaccuracies}</b><span>Inaccuracies</span></div>
    </div>
    ${misses.length ? `<ul class="list">${misses.map(({ p, e }) => `<li><button type="button" data-action="jump" data-jump="${p.ply}"><span><b class="mono">${moveNo(p)} ${esc(p.san)}${NAG[e.grade] || ''}</b> ${pill(engineGrade(e.loss).tone, engineGrade(e.loss).text)}</span><span class="muted">Lost ${(e.loss / 100).toFixed(1)} pawns \u00b7 best was <b class="mono">${esc(e.best || '?')}</b></span></button></li>`).join('')}</ul>` : '<p class="muted">No engine mistakes. Clean game.</p>'}
  </section>`;
}

function allInsights(own) {
  if (own.length < 2) return '<article class="empty-card"><p>Import a few of your games to see which habits win you the board.</p><button type="button" class="btn primary wide" data-action="openImport">Import games</button></article>';
  const allFacts = own.map(gameFacts);
  const f = state.statsFilter;
  const tcs = [...new Set(allFacts.map((x) => x.timeClass).filter(Boolean))];
  if (f.timeClass !== 'all' && !tcs.includes(f.timeClass)) f.timeClass = 'all';
  const facts = filterFacts(allFacts, f);
  const filters = `<div class="filters">
    ${chipGroup('statColor', [{ value: 'all', text: 'Both colours' }, { value: 'w', text: 'As White' }, { value: 'b', text: 'As Black' }], f.color)}
    ${tcs.length > 1 ? chipGroup('statTime', [{ value: 'all', text: 'All speeds' }, ...tcs.map((t) => ({ value: t, text: t[0].toUpperCase() + t.slice(1) }))], f.timeClass) : ''}
  </div>`;
  if (facts.length < 2) return `${filters}<article class="empty-card"><p>Fewer than two games match these filters.</p></article>`;
  const a = aggregate(facts);
  state.openingRows = a.openings;

  const tiles = `<div class="tiles">
    <div class="tile"><b>${a.n}</b><span>Games</span></div>
    <div class="tile"><b>${pct(a.score)}</b><span>Score</span></div>
    <div class="tile"><b class="${a.board12 >= 0 ? 'pos' : 'neg'}">${fmtSigned(a.board12)}</b><span>Board after move 12</span></div>
    <div class="tile"><b>${a.engine ? Math.round(a.engine.acpl) : a.avgGap.toFixed(1)}</b><span>${a.engine ? `Engine loss per move (${a.engine.checked} checked)` : 'Avg gap to best move'}</span></div>
  </div>`;

  // Are you improving?
  let trend = '';
  if (a.trend.length >= 4) {
    const imp = a.improvement;
    const diff = imp ? imp.recent - imp.earlier : null;
    const verdict = imp ? `Your last ${imp.size} games average <b class="${diff >= 0 ? 'trend-up' : 'trend-down'}">${fmtSigned(imp.recent)}</b> board at move 12, against ${fmtSigned(imp.earlier)} in your first ${imp.size}.` : '';
    const n = a.trend.length;
    trend = `<section class="block"><h3>Are you improving?</h3>${verdict ? `<p class="callout-line">${verdict}</p>` : ''}
      <div class="mini">${miniChart({ series: [{ values: a.trend.map((t) => t.board12), cls: 'all', dots: true }, { values: a.trend.map((t) => t.rolling), cls: 'rolling' }], yLimit: 60, xTicks: [0, n - 1], xLabel: (i) => (i === 0 ? 'oldest' : 'newest') })}</div>
      <p class="key"><span><i class="dots"></i>Each game</span><span><i class="rolling"></i>Rolling average</span></p></section>`;
  }

  // Where games slip
  let slip = '';
  if (a.curves.all.length > 4) {
    const plies = Math.max(a.curves.all.length, a.curves.wins.length, a.curves.losses.length);
    const ticks = [0, 10, 20, 30, 40].filter((t) => t < plies);
    const line = a.slip ? `In games you lose, your board share drops below zero for good around <b>move ${a.slip}</b>.` : a.curves.losses.length ? 'Your losses aren’t decided by the opening board. Look at the engine check for tactics.' : '';
    slip = `<section class="block"><h3>Where your games slip</h3>${line ? `<p class="callout-line">${line}</p>` : ''}
      <div class="mini">${miniChart({ series: [{ values: a.curves.all, cls: 'all' }, { values: a.curves.wins, cls: 'wins' }, { values: a.curves.losses, cls: 'losses' }], yLimit: 40, xTicks: ticks, xLabel: (i) => `move ${i / 2 + 1}` })}</div>
      <p class="key"><span><i class="all"></i>All games</span>${a.curves.wins.length ? '<span><i class="wins"></i>Wins</span>' : ''}${a.curves.losses.length ? '<span><i class="losses"></i>Losses</span>' : ''}</p></section>`;
  }

  // Openings
  const top = a.openings.slice(0, 8);
  const openings = `<section class="block"><h3>Your openings</h3><p class="muted small">Grouped by the first two moves of each game. Tap one to see those games.</p>
    <ul class="rows">${top.map((o, i) => `<li style="padding:0;border:0"><button type="button" data-action="openingGames" data-opening="${i}">
      <div class="row-head"><span class="mono">${esc(o.moves)}</span><span class="muted small">as ${sideName(o.color)}</span></div>
      ${o.name ? `<span class="muted small">${esc(o.name)}</span>` : ''}
      <div class="row-meta"><span><b>${o.n}</b> game${o.n > 1 ? 's' : ''}</span><span>score <b>${pct(o.score)}</b></span><span>board at 12 <b class="${o.board12 >= 0 ? 'pos' : 'neg'}">${fmtSigned(o.board12)}</b></span></div>
    </button></li>`).join('')}</ul></section>`;

  // Principles scorecard
  const principles = `<section class="block"><h3>Principles scorecard</h3><p class="muted small">How often each habit shows up in your openings${a.principles.some((p) => p.recent !== null) ? ', recently and before' : ''}.</p>
    <ul class="rows">${a.principles.map((p) => {
      const change = p.recent !== null && p.earlier !== null ? p.recent - p.earlier : null;
      const better = change === null ? null : p.good ? change > 0.05 : change < -0.05;
      const worse = change === null ? null : p.good ? change < -0.05 : change > 0.05;
      return `<li><div class="row-head"><b>${p.text}</b><span class="mono">${pct(p.rate)}</span></div>
        <div class="meter ${p.good ? '' : 'warn'}"><span style="width:${Math.round((p.rate || 0) * 100)}%"></span></div>
        ${change !== null ? `<span class="small ${better ? 'trend-up' : worse ? 'trend-down' : 'muted'}">Recent ${pct(p.recent)} vs earlier ${pct(p.earlier)}${better ? ', improving' : worse ? ', slipping' : ''}</span>` : ''}</li>`;
    }).join('')}</ul></section>`;

  // Habits with / without (existing view)
  const rows = a.habits;
  const scale = Math.max(10, ...rows.flatMap((h) => [Math.abs(h.yes.dominance || 0), Math.abs(h.no.dominance || 0)]));
  const row = (k, x) => (x.n
    ? `<div class="habit-row"><span class="k">${k}</span>${bar(x.dominance)}<span class="v">${fmtSigned(x.dominance)}</span><span class="s">${pct(x.score)} won</span></div>`
    : `<div class="habit-row"><span class="k">${k}</span><span class="muted none">No games yet</span></div>`);
  const bar = (v) => (v === null ? '<span class="hbar empty"></span>' : `<span class="hbar ${v >= 0 ? 'pos' : 'neg'}" style="--w:${Math.min(50, (50 * Math.abs(v)) / scale)}%"></span>`);
  const habits = `<section class="block"><h3>Which habits win you the board</h3>
    ${why(`<p class="muted small">Your board share after move 12, in games with and without each habit.</p><ul class="habits">${rows.map((h) => `<li><div class="habit-head"><b>${h.text}</b><span class="muted">${h.yes.n} of ${h.yes.n + h.no.n} games</span></div>${row('With', h.yes)}${row('Without', h.no)}</li>`).join('')}</ul>`, 'Compare games with and without each habit')}
  </section>`;

  // Costliest pieces
  const maxGap = Math.max(...a.pieces.map((p) => p.avgGap), 1);
  const pieces = a.pieces.length ? `<section class="block"><h3>Which pieces cost you board</h3><p class="muted small">Average gap to the most dominating move, by the piece you moved.</p>
    <ul class="rows">${a.pieces.map((p) => `<li><div class="row-head"><b>${p.name}</b><span class="muted small">${p.n} moves · ${pct(p.costly)} costly</span></div><div class="meter warn"><span style="width:${Math.round((100 * p.avgGap) / maxGap)}%"></span></div></li>`).join('')}</ul></section>` : '';

  // Engine
  const unchecked = facts.filter((x) => !x.engine).map((x) => x.game);
  const engineSec = `<section class="block"><h3>Engine check</h3>
    ${a.engine ? `<p class="callout-line">Across ${a.engine.checked} checked game${a.engine.checked > 1 ? 's' : ''}: <b>${Math.round(a.engine.acpl)}</b> centipawns lost per move, <b>${a.engine.blundersPerGame.toFixed(1)}</b> blunders and <b>${a.engine.mistakesPerGame.toFixed(1)}</b> mistakes per game.</p>` : '<p class="muted small">Stockfish checks catch the tactics board control can’t see.</p>'}
    ${checkBar(unchecked.slice(0, 10), `Check ${Math.min(10, unchecked.length)} with Stockfish`, unchecked.length)}
  </section>`;

  return `${filters}${tiles}${trend}${slip}${openings}${principles}${pieces}${habits}${engineSec}`;
}

// ---------- Train ----------
function quizItems() {
  const items = [];
  for (const g of games.games) {
    if (!g.game) continue;
    for (const p of g.game.plies) if (p.color === g.userColor && p.label && p.gap > 6 && p.fullmove <= 15) items.push({ game: g, ply: p });
  }
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function trainPanel() {
  const q = state.quiz;
  if (!q) {
    const n = quizItems().length;
    return `<article class="setup"><h2>Find the dominating move</h2>
      <p>Positions from your own games where a much stronger grip on the board was available. Make your move and see how it ranks.</p>
      ${n ? `<button type="button" class="btn primary wide" data-action="startQuiz">Start · ${n} positions</button>` : '<p class="muted">Import or play a few games first. Positions appear when a move of yours was graded Passive or worse.</p><button type="button" class="btn wide" data-action="openImport">Import games</button>'}
    </article>`;
  }
  const item = q.items[q.i];
  if (!q.answer) {
    return `<article class="verdict"><p class="v-line">Which move takes the most board from your opponent? Try the <b>Freedom</b> overlay to see their safe squares.</p></article>
      <div class="action-bar"><button type="button" class="btn" data-action="skipQuiz">Skip</button><button type="button" class="btn" data-action="stopQuiz">Stop</button></div>`;
  }
  const a = q.answer;
  return `<article class="verdict tone-${a.label}">
      <div class="v-head"><span class="v-move mono">${esc(a.san)}</span>${pill(a.label, LABELS[a.label].text)}<span class="v-meta">#${a.rank} of ${a.total}</span></div>
      <p class="v-line">Best: <b class="mono">${esc(a.best.san)}</b> · in the game: <b class="mono">${esc(item.ply.san)}</b> (#${item.ply.rank})</p>
      ${why(`<p>${describeDeltas(a.deltas)}</p>${tagList(a.tags)}`)}
    </article>
    <div class="action-bar"><button type="button" class="btn primary" data-action="nextQuiz">Next position</button><button type="button" class="btn" data-action="stopQuiz">Stop</button></div>`;
}

function startQuiz() {
  const items = quizItems();
  if (!items.length) return;
  state.quiz = { items, i: 0, answer: null, position: null };
  loadQuiz();
}

function loadQuiz() {
  const q = state.quiz;
  const item = q.items[q.i];
  q.answer = null;
  q.position = { fen: item.ply.fenBefore, analysis: analysisFor(item.ply.fenBefore), assessment: null, move: null };
  board.clearSelection();
  render();
}

function answerQuiz(m) {
  const q = state.quiz;
  if (!q || q.answer) return;
  const result = playMove(q.position, m);
  q.answer = result.assessment;
  q.position = { ...q.position, move: { from: m.from, to: m.to } };
  render();
}

// ---------- play actions ----------
async function startGame() {
  if (state.check) state.check.cancelled = true;
  if (!engine) engine = new Engine();
  state.engineError = null;
  const pick = state.setup.color;
  const color = pick === 'r' ? (Math.random() < 0.5 ? 'w' : 'b') : pick;
  if (state.play) state.play.token++;
  state.play = new PlaySession(engine, {
    userColor: color,
    level: state.setup.level,
    punish: state.setup.punish,
    onUpdate: () => { if (state.screen === 'play') render(); },
  });
  state.playIndex = null;
  state.hint = null;
  state.flipped = false;
  board.clearSelection();
  render();
  try {
    await engine.ready;
  } catch (err) {
    engine = null;
    state.play = null;
    state.engineError = `Stockfish couldn’t start here (${err.message}).`;
    render();
    return;
  }
  state.play.start();
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

async function reviewPlayed() {
  const s = state.play;
  if (!s || s.positions.length < 2) return;
  const r = await games.add([s.pgn()], { userColor: s.userColor });
  const g = r.added[0] || games.games.find((x) => x.pgn === s.pgn());
  state.play = null;
  if (g) selectGame(games.games.indexOf(g));
  setScreen('review');
}

const ACTIONS = {
  startGame,
  newGame: () => { state.play = null; render(); },
  hint: showHint,
  undo: () => { state.hint = null; state.playIndex = null; if (state.play.takeBack()) render(); },
  resign: () => state.play.resign(),
  playLive: () => { state.playIndex = null; render(); },
  reviewPlayed,
  openImport: () => openSheet('import'),
  tryAlt: (b) => {
    const p = view().assessment;
    const alt = p && p.alternatives && p.alternatives[Number(b.dataset.alt)];
    if (!alt) return;
    if (state.variation) state.variation.cursor = Math.max(0, state.variation.cursor - 1);
    else state.index = Math.max(0, state.index - 1);
    handleBoardMove({ from: alt.from, to: alt.to, promotion: alt.promotion });
  },
  jump: (b) => { state.variation = null; setScreen('review'); go(Number(b.dataset.jump)); },
  startQuiz,
  runCheck: () => runEngineCheck(state.checkTargets || []),
  cancelCheck: () => { if (state.check) state.check.cancelled = true; },
  openingGames: (b) => { const o = state.openingRows && state.openingRows[Number(b.dataset.opening)]; if (o) { state.gamesFilter = o; openSheet('games'); } },
  skipQuiz: () => { const q = state.quiz; q.i = (q.i + 1) % q.items.length; loadQuiz(); },
  nextQuiz: () => { const q = state.quiz; q.i = (q.i + 1) % q.items.length; loadQuiz(); },
  stopQuiz: () => { state.quiz = null; render(); },
};

// ---------- navigation ----------
function setScreen(screen) {
  if (!SCREENS.includes(screen)) return;
  state.screen = screen;
  store.set('screen', screen);
  board.clearSelection();
  render();
  window.scrollTo({ top: 0 });
}

function selectGame(i) {
  state.current = Math.max(0, i);
  state.index = 0;
  state.variation = null;
  board.clearSelection();
  render();
}

// ---------- sheets ----------
const sheet = $('sheet');
let sheetKind = null;

function openSheet(kind) {
  sheetKind = kind;
  renderSheet();
  if (!sheet.open) sheet.showModal();
}

function closeSheet() {
  sheetKind = null;
  if (sheet.open) sheet.close();
}

function renderSheet() {
  const body = $('sheet-body');
  if (sheetKind === 'games') {
    const of = state.gamesFilter;
    const shown = games.games.map((g, i) => [g, i]).filter(([g]) => !of || (g.game && gameFacts(g).opening.key === of.key));
    $('sheet-title').textContent = of ? `${of.n} game${of.n > 1 ? 's' : ''} with this opening` : games.games.length ? `Your games (${games.games.length})` : 'Your games';
    body.innerHTML = `${of ? `<div class="check-bar"><span class="mono">${esc(of.moves)}</span><button type="button" class="btn small" id="sheet-all">Show all</button></div>` : '<button type="button" class="btn primary wide" id="sheet-import">Import games</button>'}
      <ul class="game-list">${shown.map(([g, i]) => {
        const h = g.headers;
        const meta = g.error ? 'Couldn’t read' : !g.game ? 'Analysing…' : [h.Date && !h.Date.startsWith('?') ? h.Date.replace(/\.\?\?/g, '') : null, `as ${sideName(g.userColor)}`, h.Result].filter(Boolean).join(' · ');
        return `<li><button type="button" data-game="${i}" aria-current="${i === state.current}"><b>${esc(h.White || '?')} – ${esc(h.Black || '?')}</b><span>${esc(meta)}${g.sample ? ' · example' : ''}</span></button></li>`;
      }).join('')}</ul>`;
    if ($('sheet-import')) $('sheet-import').onclick = () => openSheet('import');
    if ($('sheet-all')) $('sheet-all').onclick = () => { state.gamesFilter = null; renderSheet(); };
    body.querySelectorAll('[data-game]').forEach((b) => { b.onclick = () => { selectGame(Number(b.dataset.game)); setScreen('review'); closeSheet(); }; });
  } else if (sheetKind === 'import') {
    $('sheet-title').textContent = 'Import games';
    const src = state.importSource || 'chesscom';
    body.innerHTML = `
      ${chipGroup('source', [{ value: 'chesscom', text: 'Chess.com' }, { value: 'lichess', text: 'Lichess' }, { value: 'pgn', text: 'Paste PGN' }], src)}
      <form id="import-form" class="form">
        ${src === 'pgn'
          ? '<label class="field" for="pgn-input"><span class="label">PGN</span><textarea id="pgn-input" rows="6" placeholder="Paste one or more games"></textarea></label>'
          : `<label class="field" for="imp-user"><span class="label">Username</span><input id="imp-user" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(state.username)}" placeholder="Your ${src === 'lichess' ? 'Lichess' : 'Chess.com'} name" required></label>
            <div class="field"><span class="label">Games</span>
              <div class="scope"><label for="scope-recent"><input type="radio" name="scope" id="scope-recent" value="recent" checked> Latest</label><input id="game-count" type="number" min="1" value="50" aria-label="How many"><label for="scope-all"><input type="radio" name="scope" id="scope-all" value="all"> All of them</label></div>
            </div>
            <details class="why"><summary>Filters</summary><div class="why-body">
              <div class="months"><label for="fetch-from">From<input type="month" id="fetch-from"></label><label for="fetch-to">To<input type="month" id="fetch-to"></label></div>
              <div class="tcs">${TIME_CLASSES.map((t) => `<label for="tc-${t}"><input type="checkbox" name="tc" id="tc-${t}" value="${t}" checked> ${t[0].toUpperCase() + t.slice(1)}</label>`).join('')}</div>
            </div></details>`}
        <div class="actions"><button type="submit" class="btn primary wide" id="import-btn" ${games.busy ? 'disabled' : ''}>Import</button><button type="button" class="btn" id="import-cancel" ${games.busy ? '' : 'hidden'}>Cancel</button></div>
        <p class="status ${state.importMsg.error ? 'error' : ''}" id="import-status" role="status">${esc(state.importMsg.text)}</p>
      </form>`;
    body.querySelectorAll('.chips[data-group="source"] [data-value]').forEach((b) => { b.onclick = () => { state.importSource = b.dataset.value; renderSheet(); }; });
    $('import-form').addEventListener('submit', runImport);
    $('import-cancel').onclick = () => { if (fetchAbort) fetchAbort.abort(); games.cancel(); };
    const count = $('game-count');
    body.querySelectorAll('input[name="scope"]').forEach((r) => r.addEventListener('change', () => { count.disabled = $('scope-all').checked; }));
  } else if (sheetKind === 'settings') {
    $('sheet-title').textContent = 'Settings';
    body.innerHTML = `
      <label class="field" for="set-user"><span class="label">Your username</span><input id="set-user" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(state.username)}" placeholder="Chess.com or Lichess name"><small class="muted">Used to tell which side you played in imported games.</small></label>
      <label class="toggle" for="set-best"><input type="checkbox" id="set-best" ${state.showBest ? 'checked' : ''}> Show best-move arrows in Review</label>
      <div class="field"><span class="label">Freedom overlay shows</span>${chipGroup('freedom', [{ value: 'opp', text: 'Opponent’s pieces' }, { value: 'me', text: 'My pieces' }], state.freedom)}</div>
      <details class="why"><summary>How it works</summary><div class="why-body prose">
        <p>Each position is measured straight from the board. <b>Control</b> is who owns each square (a pawn's guard beats pieces). <b>Freedom</b> is how many safe moves each side's pieces have: take those away and your opponent runs out of good plans.</p>
        <p>For your first 20 moves, every legal alternative is tried. A move is graded by how far it falls short of the most dominating one: Dominant, Good, Passive, Concession or Mistake.</p>
        <p>It looks one move ahead, so it can misjudge sacrifices. Stockfish in Play keeps you honest about tactics.</p>
      </div></details>
      <button type="button" class="btn danger wide" id="set-clear">Remove all imported games</button>`;
    $('set-user').addEventListener('change', (e) => setUsername(e.target.value));
    $('set-best').addEventListener('change', (e) => { state.showBest = e.target.checked; store.set('showBest', state.showBest); render(); });
    body.querySelectorAll('.chips[data-group="freedom"] [data-value]').forEach((b) => { b.onclick = () => { state.freedom = b.dataset.value; store.set('freedom', state.freedom); renderSheet(); render(); }; });
    $('set-clear').onclick = async (e) => {
      if (e.target.dataset.confirm !== 'yes') { e.target.dataset.confirm = 'yes'; e.target.textContent = 'Tap again to remove them all'; return; }
      await games.clear();
      state.current = 0;
      state.index = 0;
      state.variation = null;
      closeSheet();
    };
  }
}

function setUsername(u) {
  state.username = u.trim();
  store.set('username', state.username);
  games.redetect();
}

$('sheet-close').onclick = closeSheet;
sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });
sheet.addEventListener('close', () => { sheetKind = null; state.gamesFilter = null; });
$('open-settings').onclick = () => openSheet('settings');

// ---------- import ----------
let fetchAbort = null;

function setImportMsg(text, error = false) {
  state.importMsg = { text, error };
  const el = $('import-status');
  if (el) {
    el.textContent = text;
    el.classList.toggle('error', error);
  }
  if (state.screen === 'review' && !sheet.open) renderPanel();
}

async function runImport(e) {
  e.preventDefault();
  if (games.busy) return;
  const src = state.importSource || 'chesscom';
  const btn = $('import-btn');
  btn.disabled = true;
  $('import-cancel').hidden = false;
  try {
    let pgns;
    if (src === 'pgn') {
      pgns = splitPgn($('pgn-input').value);
      if (!pgns.length) throw new Error('No games found. Paste PGN text that includes the moves.');
    } else {
      const username = $('imp-user').value.trim();
      if (!username) throw new Error('Enter your username.');
      if (username !== state.username) setUsername(username);
      const all = $('scope-all').checked;
      const opts = {
        max: all ? Infinity : Math.max(1, Number($('game-count').value) || 50),
        from: $('fetch-from').value || undefined,
        to: $('fetch-to').value || undefined,
        timeClasses: [...document.querySelectorAll('input[name="tc"]:checked')].map((i) => i.value),
      };
      if (!opts.timeClasses.length) throw new Error('Pick at least one time control.');
      if (opts.from && opts.to && opts.from > opts.to) throw new Error('The start month is after the end month.');
      fetchAbort = new AbortController();
      setImportMsg(`Fetching games for ${username}…`);
      const onProgress = src === 'lichess'
        ? ({ games: n }) => setImportMsg(`Downloading… ${n} games so far`)
        : ({ games: n, month, monthsDone, months }) => setImportMsg(`Fetching ${month} (${monthsDone} of ${months} months) · ${n} games`);
      pgns = await (src === 'lichess' ? fetchLichess : fetchChessCom)(username, { ...opts, onProgress, signal: fetchAbort.signal });
      fetchAbort = null;
      if (!pgns.length) throw new Error('No standard games match those filters.');
    }
    setImportMsg(`Analysing ${pgns.length} game${pgns.length > 1 ? 's' : ''}…`);
    const r = await games.add(pgns);
    const first = r.added.find((g) => games.games.includes(g));
    if (first) selectGame(games.games.indexOf(first));
    const parts = [`Added ${r.analysed} game${r.analysed === 1 ? '' : 's'}`];
    if (r.skipped) parts.push(`${r.skipped} already here`);
    if (r.failed) parts.push(`${r.failed} couldn’t be read`);
    if (r.cancelled) parts.push('stopped early');
    setImportMsg(parts.join(' · ') + '.' + (games.storageFull ? ' Storage is full, so some won’t be remembered.' : ''));
    if (r.added.length && !r.cancelled) {
      closeSheet();
      setScreen('review');
    }
  } catch (err) {
    if (err.name === 'AbortError') setImportMsg('Import cancelled.');
    else setImportMsg(err instanceof TypeError ? 'Couldn’t reach the site. Check your connection, or paste PGN instead.' : err.message, true);
  } finally {
    fetchAbort = null;
    if ($('import-btn')) $('import-btn').disabled = false;
    if ($('import-cancel')) $('import-cancel').hidden = true;
  }
}

// ---------- wiring ----------
document.querySelectorAll('#tabs [data-screen]').forEach((b) => { b.onclick = () => setScreen(b.dataset.screen); });
document.querySelectorAll('#lens [data-overlay]').forEach((b) => {
  b.onclick = () => { state.overlay = b.dataset.overlay; store.set('overlay', state.overlay); render(); };
});
$('flip').onclick = () => { state.flipped = !state.flipped; render(); };
$('nav-start').onclick = () => { if (state.variation) exitVariation(); go(0); };
$('nav-prev').onclick = () => go(cursor() - 1);
$('nav-next').onclick = () => go(cursor() + 1);
$('nav-end').onclick = () => go(1e9);
document.addEventListener('keydown', (e) => {
  if (sheet.open || e.target.closest('input, textarea, select') || state.screen === 'train' || state.screen === 'insights') return;
  const keys = { ArrowLeft: () => go(cursor() - 1), ArrowRight: () => go(cursor() + 1), Home: () => go(0), End: () => go(1e9) };
  if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
});

// ---------- start ----------
async function boot() {
  render();
  if (!(await games.load())) {
    await games.add(SAMPLES.map((x) => x.pgn), { userColor: 'w', persist: false, sample: true });
    state.index = 4;
    setImportMsg('');
  }
  render();
}
boot();

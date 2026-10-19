import { Chess } from '../vendor/chess.js';
import { analyzePosition, rankMoves, dominanceShare, other, LABELS } from './analysis.js';
import { assessMove, describeDeltas, TAGS } from './insights.js';
import { splitPgn, fetchLichess, fetchChessCom, TIME_CLASSES } from './import.js';
import { Collection, OPENING_MOVES } from './collection.js';
import { Board } from './board.js';
import { renderChart, miniChart } from './chart.js';
import { gameFacts, aggregate, filterFacts, PIECES } from './stats.js';
import { findWeaknesses, isSlip, MIN_GAMES } from './weaknesses.js';
import { collectMistakes, problemMap, newProgress, nextDrill, recordAnswer, mastery, matches as drillMatches, FUNDAMENTALS, PHASES, MASTERED_BOX } from './drills.js';
import { checkGame, NAG } from './enginecheck.js';
import { engineGrade } from './play.js';
import { SAMPLES } from './samples.js';
import { Engine, formatScore, uciToMove } from './engine.js';
import { PlaySession, LEVELS, PUNISH, sideName } from './play.js';
import { CaptureSession } from './capture.js';
import { SKILLS, GROUPS, skillById, learningPath, puzzlesFor, newSkillProgress, nextPuzzle, recordPuzzle, skillStatus, applyPassed, LEVELS as SKILL_LEVELS } from './curriculum.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('chessions:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('chessions:' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const SCREENS = ['play', 'record', 'review', 'insights', 'train'];
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
  insights: 'fix',
  drill: null, // drill session
  practice: null, // focus for the current Stockfish game
  capture: null, // over-the-board recording
  learn: null, // open skill: { id, view: 'skill' | 'lesson' | 'puzzle', card, puzzle }
  captureMe: 'w',
  setup: { color: 'w', level: 'club', punish: 'mistakes', ...store.get('play', {}) },
  play: null,
  playIndex: null, // null follows the live position
  hint: null,
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
  if (state.screen === 'record' && state.capture) {
    const c = state.capture.chess;
    const fen = c.fen();
    const last = c.history({ verbose: true }).pop();
    return { fen, analysis: analysisFor(fen), assessment: null, move: last ? { from: last.from, to: last.to, san: last.san, color: last.color, fullmove: c.moveNumber() - (last.color === 'b' ? 1 : 0) } : null };
  }
  if (state.screen === 'play') return state.play ? state.play.positions[playCursor()] : emptyView();
  if (state.screen === 'train' && state.learn && state.learn.position) return state.learn.position;
  if (state.screen === 'train') return state.drill && state.drill.position ? state.drill.position : emptyView();
  if (state.variation) return state.variation.positions[state.variation.cursor];
  const g = currentGame();
  if (!g || !g.game) return emptyView();
  const pos = g.game.positions[state.index];
  const ply = state.index > 0 ? g.game.plies[state.index - 1] : null;
  return { fen: pos.fen, analysis: analysisFor(pos.fen), assessment: ply, move: ply };
}

function userColor() {
  if (state.screen === 'record') return state.captureMe === 'b' ? 'b' : 'w';
  if (state.screen === 'play') return state.play ? state.play.userColor : state.setup.color === 'b' ? 'b' : 'w';
  if (state.screen === 'train' && state.learn && state.learn.color) return state.learn.color;
  if (state.screen === 'train' && state.drill && state.drill.item) return state.drill.item.color;
  const g = currentGame();
  return g ? g.userColor : 'w';
}

// ---------- board ----------
const board = new Board($('board'), { onMove: handleBoardMove });

function handleBoardMove(m) {
  if (state.screen === 'train' && state.learn) return answerPuzzle(m);
  if (state.screen === 'train') return answerDrill(m);
  if (state.screen === 'record' && state.capture) {
    if (state.capture.step === 'recording') state.capture.play(m);
    return;
  }
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
  const showStage = state.screen === 'play' ? !!state.play : state.screen === 'record' ? !!(state.capture && ['recording', 'done'].includes(state.capture.step)) : state.screen === 'train' ? !!((state.learn && state.learn.position) || (state.drill && state.drill.item)) : state.screen === 'review' ? !!currentGame() : false;
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

  if (state.screen === 'record' && state.capture) {
    if (state.capture.step === 'recording') legal = chess.moves({ verbose: true });
  } else if (state.screen === 'play') {
    if (canMoveInPlay()) legal = chess.moves({ verbose: true });
    if (state.hint && playLive()) {
      if (state.hint.dom) arrows.push({ ...state.hint.dom, kind: 'dom' });
      if (state.hint.engine) arrows.push({ ...state.hint.engine, kind: 'best' });
    }
  } else if (state.screen === 'train' && state.learn) {
    const L = state.learn;
    const pz = L.view === 'puzzle' && L.puzzle;
    if (pz && !pz.result && !pz.busy) legal = chess.moves({ verbose: true });
    if (L.arrows) arrows.push(...L.arrows);
  } else if (state.screen === 'train') {
    const d = state.drill;
    if (d && d.item && !d.answer && !d.judging) legal = chess.moves({ verbose: true });
    if (d && d.answer && !d.answer.correct && d.answer.bestMove) arrows.push({ ...d.answer.bestMove, kind: 'best' });
  } else {
    const g = currentGame();
    if (g && g.game) legal = chess.moves({ verbose: true });
    const next = !state.variation && g && g.game ? g.game.plies[state.index] : null;
    if (state.showBest && next && next.best) {
      arrows.push({ from: next.best.from, to: next.best.to, kind: 'best' });
      if (next.best.san !== next.san) arrows.push({ from: next.from, to: next.to, kind: 'played' });
    }
  }

  // While recording a board game the overlays are noise: show a plain board.
  const recording = state.screen === 'record' && !!state.capture;
  $('share').hidden = recording;
  $('lens').hidden = recording;
  $('legend').hidden = recording;

  board.render({
    analysis: v.analysis,
    orientation: state.flipped ? other(me) : me,
    overlay: recording ? 'none' : state.overlay,
    freedomSide,
    impact: v.assessment ? v.assessment.deltas : null,
    lastMove: v.move ? { from: v.move.from, to: v.move.to } : null,
    arrows,
    legal,
  });

  renderStamp();

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
  if (state.screen === 'train') label = state.learn ? (state.learn.view === 'puzzle' ? SKILL_LEVELS[learnSkill(state.learn.id).level].text : 'Example') : state.drill ? `${state.drill.right}/${state.drill.done} solved` : '';
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
  if (state.screen === 'record' && state.capture) {
    const c = state.capture.chess;
    return `<div class="who"><b>Recording a board game</b><span>${c.history().length} moves \u00b7 ${sideName(c.turn())} to move</span></div>`;
  }
  if (state.screen === 'play') {
    if (!state.play) return '<div class="who"><b>Stockfish</b><span>Pick your settings below</span></div>';
    const s = state.play;
    return `<div class="who"><b>Stockfish · ${esc(s.level.text)}</b><span>${s.punish.key === 'always' ? 'Full strength' : 'Punishes ' + (s.punish.key === 'mistakes' ? 'mistakes' : 'inaccuracies')} · you play ${sideName(s.userColor)}</span></div>`;
  }
  if (state.screen === 'train' && state.learn && state.learn.position) {
    const L = state.learn;
    const sk = skillById(L.id);
    return `<div class="who"><b>${esc(sk.title)} \u00b7 ${sideName(L.color)} to move</b><span>${L.view === 'puzzle' ? esc(sk.prompt) : 'Worked example'}</span></div>`;
  }
  if (state.screen === 'train') {
    const d = state.drill;
    if (!d || !d.item) return '<div class="who"><b>Drills</b><span>Positions from your games</span></div>';
    const h = d.item.game.headers;
    return `<div class="who"><b>${esc(d.label)} \u00b7 ${sideName(d.item.color)} to move</b><span>${esc(h.White || '?')} vs ${esc(h.Black || '?')}, move ${d.item.fullmove}${d.streak > 1 ? ` \u00b7 ${d.streak} in a row` : ''}</span></div>`;
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
  const html = { play: playPanel, record: recordPanel, review: reviewPanel, insights: insightsPanel, train: trainPanel }[state.screen]();
  el.innerHTML = html;
  const slot = $('cam-slot');
  if (slot && state.capture) slot.append(state.capture.el);
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
        else if (key === 'captureMe') state.captureMe = b.dataset.value;
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

  let focus = '';
  const pr = state.practice;
  if (pr) {
    const slips = s.positions.filter((x) => x.move && x.move.color === s.userColor && isSlip(pr, x.move, x.analysis));
    const lastSlip = userPos && slips.includes(userPos);
    const counts = pr.tag || pr.tags || pr.habit;
    const blunders = s.positions.filter((x) => x.move && x.move.color === s.userColor && x.engine && x.engine.grade.key === 'blunder').length;
    const tally = counts ? `<span class="${slips.length ? 'neg' : 'pos'}">${slips.length} slip${slips.length === 1 ? '' : 's'}</span>` : pr.skill ? `<span class="${blunders ? 'neg' : 'pos'}">${blunders} blunder${blunders === 1 ? '' : 's'}</span>` : '';
    focus = `<div class="focus-bar"><span><b>${pr.skill ? 'Skill test' : 'Practising'}</b> ${esc(pr.focus)}</span>${tally}</div>`;
    if (lastSlip) focus += `<div class="punish"><b>Slip: ${esc(pr.title)}</b><span>${esc(pr.lesson || '')}</span></div>`;
    if (!playActive() && pr.skill && !pr.applyResult) {
      pr.applyResult = applyPassed(skillById(pr.skill), s.positions, s.userColor);
      const sp = learnSkill(pr.skill);
      if (pr.applyResult.passed) { sp.apply = { passed: true, t: Date.now() }; saveLearn(); }
    }
    if (pr.applyResult) {
      end = end.replace('</h2>', `</h2><p class="${pr.applyResult.passed ? 'trend-up' : 'neg'}"><b>${pr.applyResult.passed ? 'Skill test passed.' : 'Not passed yet.'}</b> ${esc(pr.applyResult.reason)}</p>`)
        .replace('<div class="actions">', '<div class="actions"><button type="button" class="btn" data-action="backToSkill">Back to the skill</button>');
    }
    if (!playActive() && !pr.logged && pr.key !== 'drill') {
      pr.logged = true;
      (practiceLog[pr.key] ||= []).push({ t: Date.now(), slips: slips.length, result: s.resigned ? 'loss' : s.result() });
      store.set('practiceLog', practiceLog);
    }
    if (!playActive()) {
      const more = pr.positions && pr.index + 1 < pr.positions.length;
      end = end.replace('</h2>', `</h2><p>${slips.length ? `${slips.length} slip${slips.length > 1 ? 's' : ''} on <b>${esc(pr.focus.toLowerCase())}</b> this game.` : `No slips on <b>${esc(pr.focus.toLowerCase())}</b>. Well played.`}</p>`)
        .replace('<div class="actions">', `<div class="actions">${more ? `<button type="button" class="btn primary" data-action="nextPosition">Next position (${pr.index + 2} of ${pr.positions.length})</button>` : ''}`);
    }
  }
  const plies = s.positions.slice(1).map((p) => ({ ...p.move, dot: p.move.punished ? 'punished' : p.engine ? p.engine.grade.tone : null }));
  return `${focus}${end}${status}${card}${hint}${actions}${moveStrip(plies, idx)}`;
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
  const { ws } = weaknessData();
  const weak = ws.length ? `<article class="setup"><h2>Practise your weak spots</h2>
      <ul class="rows">${ws.slice(0, 3).map((w, i) => `<li><div class="row-head"><b>${esc(w.title)}</b></div><span class="small muted">${esc(w.practice.focus || 'Start from your opening position')}</span>${practiceHistory(w.key)}<div class="actions"><button type="button" class="btn small primary" data-action="practise" data-weak="${i}">Practise</button></div></li>`).join('')}</ul>
    </article>` : '';
  return `${weak}<article class="setup">
    <h2>Play Stockfish</h2>
    <div class="field"><span class="label">Play as</span>${chipGroup('color', [{ value: 'w', text: 'White' }, { value: 'b', text: 'Black' }, { value: 'r', text: 'Random' }], state.setup.color)}</div>
    <div class="field"><span class="label">Opponent</span>${chipGroup('level', levels, state.setup.level)}</div>
    <div class="field"><span class="label">Punish</span>${chipGroup('punish', punish, state.setup.punish)}<p class="note">${punishNote}</p></div>
    <button type="button" class="btn primary wide" data-action="startGame">Start game</button>
    <p class="status ${state.engineError ? 'error' : ''}" id="play-status">${state.engineError ? esc(state.engineError) : ''}</p>
  </article>`;
}

// ---------- Record ----------
function recordPanel() {
  if (state.capture) return capturePanel();
  return `<article class="setup"><h2>Record a game on a real board</h2>
    <p>Play over the board and the camera writes down the moves. When you finish, analyse the game or copy the PGN.</p>
    <ul class="tips">
      <li><b>Set up the starting position</b> and point the camera at the board. It finds the board by itself.</li>
      <li><b>Look down from high up</b>, as close to overhead as you can. From low down, tall pieces hide the squares behind them.</li>
      <li><b>Keep all 64 squares in view</b> and the light even. Holding the phone is fine; it follows the board.</li>
      <li>If it misses a move or isn’t sure, it asks, and you can always play the move on the on-screen board.</li>
    </ul>
    <button type="button" class="btn primary wide" data-action="startCapture">Start recording</button>
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
  const tabs = chipGroup('insights', [{ value: 'fix', text: 'What to fix' }, { value: 'game', text: 'This game' }, { value: 'all', text: `All games${own.length ? ` (${own.length})` : ''}` }], state.insights);
  const body = state.insights === 'fix' ? fixInsights() : state.insights === 'game' ? gameInsights() : allInsights(own);
  return `<div class="insights">${tabs}${body}</div>`;
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

// ---------- Over-the-board capture ----------
function capturePanel() {
  const c = state.capture;
  if (c.error) return `<article class="empty-card"><h2>Camera unavailable</h2><p>${esc(c.error)}</p><button type="button" class="btn wide" data-action="captureCancel">Back</button></article>`;
  if (c.step === 'camera') return '<article class="verdict"><p class="v-line"><span class="thinking">Starting the camera</span></p></article><div id="cam-slot"></div>';
  if (c.step === 'corners') {
    const finding = c.searching && !c.corners.length;
    const head = finding
      ? `<p class="v-line"><span class="thinking">${c.candidate ? 'Found the board, hold still' : c.seeing ? 'Seeing the squares. Keep the whole board in view' : 'Looking for the board'}</span></p>
      <p class="small muted">Set up the pieces in the starting position and point the camera at the board, with all 64 squares in view. It finds the board by itself. If it doesn’t, tap the four corners.</p>`
      : `<p class="v-line">Tap the four corners of the board (${c.corners.length} of 4).</p>
      <p class="small muted">Any order is fine: the pieces show which side is White. Keep all 64 squares in view.</p>`;
    return `<article class="verdict">${head}${c.status ? `<p class="small neg">${esc(c.status)}</p>` : ''}</article>
      <div id="cam-slot"></div>
      <div class="action-bar">${c.lastCorners && !c.corners.length ? '<button type="button" class="btn" data-action="captureLastCorners">Same spot as last time</button>' : ''}${c.corners.length ? '<button type="button" class="btn" data-action="captureRedo">Start again</button>' : ''}<button type="button" class="btn" data-action="captureCancel">Cancel</button></div>`;
  }
  if (c.step === 'confirm') {
    const k = c.check || { ok: false, wrong: 0, separation: 0 };
    const note = c.settling
      ? '<p class="v-line"><span class="thinking">Found the board. Checking the pieces</span></p>'
      : k.ok
      ? '<p class="v-line"><b class="pos">All 32 pieces found.</b> White and black dots show what the camera reads on each square.</p>'
      : k.wrong > 12
        ? '<p class="v-line"><b class="neg">Set up the starting position.</b> The board is found; recording starts from the starting position. If the pieces are set up and White is on the wrong side, tap Turn board.</p>'
        : k.wrong
        ? `<p class="v-line"><b class="neg">${k.wrong} square${k.wrong === 1 ? ' reads' : 's read'} wrong</b> (ringed in red). Check the grid sits on the squares and every piece is on its starting square. This updates as you fix it; if the light changed, tap Re-learn colours.</p>`
        : '<p class="v-line"><b class="neg">The pieces are hard to tell from the squares.</b> More light, or a steeper angle from above, helps. You can still try.</p>';
    return `${lowCameraHint(c)}<article class="verdict tone-${k.ok ? 'dominant' : 'passive'}">${note}
      <div class="field"><span class="label">You are playing</span>${chipGroup('captureMe', [{ value: 'w', text: 'White' }, { value: 'b', text: 'Black' }, { value: 'none', text: 'Just recording' }], state.captureMe)}</div></article>
      <div class="chips rec-toggles">${camViewChip(c)}</div>
      <div id="cam-slot"></div>
      <div class="action-bar"><button type="button" class="btn primary" data-action="captureStart">Start recording</button><button type="button" class="btn" data-action="captureRecheck">Re-learn colours</button><button type="button" class="btn" data-action="captureTurn">Turn board</button><button type="button" class="btn" data-action="captureRedo">Find again</button></div>`;
  }
  const hist = c.chess.history({ verbose: true });
  const plies = hist.map((m, i) => ({ san: m.san, color: m.color, fullmove: Math.floor(i / 2) + 1 }));
  if (c.step === 'done') {
    const pgn = c.pgn(captureNames());
    return `<article class="result"><h2>Game recorded</h2><p>${hist.length} moves. Copy the PGN or analyse it straight away.</p>
      <textarea id="capture-pgn" rows="6" readonly>${esc(pgn)}</textarea>
      <div class="actions"><button type="button" class="btn primary" data-action="captureAnalyse">Analyse this game</button><button type="button" class="btn" data-action="captureCopy">Copy PGN</button><button type="button" class="btn" data-action="captureCancel">Close</button></div>
      <p class="status" id="copy-status"></p></article>${moveStrip(plies, -1)}`;
  }
  const ask = c.candidates
    ? `<article class="rec-status rec-ask"><span class="rec-dot" aria-hidden="true"></span><div><b>${esc(c.status)}</b>${c.candidates.length ? `<div class="chips">${c.candidates.map((x, i) => `<button type="button" data-action="capturePick" data-i="${i}">${esc(x.move.san)}</button>`).join('')}</div>` : ''}<span>Or play the move on the board above.</span><button type="button" class="btn small" data-action="captureDismiss">Nothing was played</button></div></article>`
    : recStatus(c);
  const toggles = `<div class="chips rec-toggles"><button type="button" data-action="captureSpeak" aria-pressed="${c.speak}">${c.speak ? 'Saying moves' : 'Moves muted'}</button>${c.showCamera ? camViewChip(c) : ''}<button type="button" data-action="captureCamera" aria-pressed="${c.showCamera}">${c.showCamera ? 'Hide camera' : 'Show camera'}</button></div>`;
  return `${ask}${lowCameraHint(c)}${moveStrip(plies, plies.length)}${toggles}<div id="cam-slot" ${c.showCamera ? '' : 'hidden'}></div>
    <div class="action-bar"><button type="button" class="btn" data-action="captureUndo" ${hist.length ? '' : 'disabled'}>Undo move</button><button type="button" class="btn primary" data-action="captureFinish">Finish</button></div>`;
}

// From a low camera tall pieces hide the squares behind them, and moves to
// squares one behind the other look alike.
function lowCameraHint(c) {
  return c.lowCamera
    ? '<p class="cam-hint"><b>Raise the phone higher.</b> From this low, tall pieces hide the squares behind them. Looking down from higher up reads moves much more reliably.</p>'
    : '';
}

// Straightened board view, or the camera as it is.
function camViewChip(c) {
  return c.view === 'board'
    ? '<button type="button" data-action="captureView" data-value="camera">Camera view</button>'
    : '<button type="button" data-action="captureView" data-value="board">Board view</button>';
}

// The big live status while recording.
function recStatus(c) {
  const toMove = `${sideName(c.chess.turn())} to move`;
  if (c.status === 'Watching the board' && c.lastPlayed) {
    return `<article class="rec-status rec-played" data-key="${c.chess.history().length}"><span class="rec-dot" aria-hidden="true"></span><div><b>Played <span class="mono">${esc(c.lastPlayed.san)}</span></b><span>${toMove}. Watching for the next move.</span></div></article>`;
  }
  const kinds = {
    'Hand over the board': ['busy', 'Hand over the board', 'It reads the move once your hand is clear.'],
    'Reading the move': ['busy', 'Reading the move', 'Hold on a moment.'],
    'Finding the board': ['busy', 'Finding the board', 'Point the camera back at the board. It locks on again by itself.'],
    'Took back the last move. Put the pieces back on the board.': ['busy', 'Took back the last move', 'Put the pieces back where they were.'],
  };
  const [kind, title, sub] = kinds[c.status] || ['live', c.chess.history().length ? 'Watching the board' : 'Ready. Make the first move', c.chess.history().length ? toMove : 'White moves first. Missed one? Play it on the board above.'];
  return `<article class="rec-status rec-${kind}"><span class="rec-dot" aria-hidden="true"></span><div><b>${esc(title)}</b><span>${esc(sub)}</span></div></article>`;
}

function captureNames() {
  const me = state.username || 'You';
  if (state.captureMe === 'w') return { white: me, black: 'Opponent' };
  if (state.captureMe === 'b') return { white: 'Opponent', black: me };
  return { white: 'White', black: 'Black' };
}

const CAPTURE_ACTIONS = {
  startCapture: () => {
    if (state.check) state.check.cancelled = true;
    state.capture = new CaptureSession({ onChange: () => { if (state.screen === 'record') render(); }, memory: store });
    state.flipped = false;
    render();
    state.capture.open();
  },
  captureRedo: () => state.capture.redoCorners(),
  captureStart: () => state.capture.start(),
  captureRecheck: () => state.capture.recheck(),
  captureTurn: () => state.capture.turnBoard(),
  captureLastCorners: () => state.capture.useLastCorners(),
  captureSpeak: () => state.capture.setSpeak(!state.capture.speak),
  captureCamera: () => state.capture.toggleCamera(),
  captureView: (b) => state.capture.setView(b.dataset.value),
  capturePick: (b) => { const x = state.capture.candidates[Number(b.dataset.i)]; if (x) state.capture.play(x.move); },
  captureDismiss: () => state.capture.dismiss(),
  captureUndo: () => state.capture.undo(),
  captureFinish: () => state.capture.finish(),
  captureCancel: () => { state.capture.close(); state.capture = null; render(); },
  captureCopy: () => {
    const t = $('capture-pgn');
    const done = (ok) => { const s = $('copy-status'); if (s) s.textContent = ok ? 'Copied.' : 'Select the text above and copy it.'; };
    try {
      navigator.clipboard.writeText(t.value).then(() => done(true), () => { t.select(); done(false); });
    } catch {
      t.select();
      done(false);
    }
  },
  captureAnalyse: async () => {
    const c = state.capture;
    const me = state.captureMe === 'none' ? null : state.captureMe;
    const pgn = c.pgn(captureNames());
    state.capture = null;
    const r = await games.add([pgn], { userColor: me });
    if (r.added[0]) selectGame(games.games.indexOf(r.added[0]));
    setScreen('review');
  },
};

// ---------- What to fix ----------
const practiceLog = store.get('practiceLog', {});

function weaknessData() {
  const own = games.games.filter((g) => g.report && !g.sample);
  const pool = own.length ? own : games.games.filter((g) => g.report);
  const facts = pool.map(gameFacts);
  const ws = facts.length >= MIN_GAMES ? findWeaknesses(facts, aggregate(facts).openings) : [];
  state.weakRows = ws;
  return { pool, facts, ws };
}

function drillFilterFor(w) {
  const p = w.practice;
  if (w.kind === 'opening') return { games: [...new Set(w.examples.map((e) => e.game.key))], phase: 'opening' };
  if (w.key.startsWith('blunders:')) return { fundamental: 'tactics', phase: w.key.split(':')[1] };
  if (w.key === 'convert') return { games: [...new Set(w.examples.map((e) => e.game.key))] };
  if (p.tag) return { tag: p.tag };
  if (p.habit === 'castle') return { fundamental: 'king' };
  if (p.habit === 'develop') return { fundamental: 'development', phase: 'opening' };
  return null;
}

const filterAttrs = (f) => (f ? Object.entries(f).map(([k, v]) => `data-${k}="${esc(Array.isArray(v) ? v.join('|') : v)}"`).join(' ') : '');
const filterFromEl = (b) => {
  const f = {};
  for (const k of ['fundamental', 'piece', 'phase', 'tag']) if (b.dataset[k]) f[k] = b.dataset[k];
  if (b.dataset.games) f.games = b.dataset.games.split('|');
  return f;
};

function practiceHistory(key) {
  const log = practiceLog[key];
  if (!log || !log.length) return '';
  const first = log[0].slips;
  const last = log[log.length - 1].slips;
  return `<p class="small ${last < first ? 'trend-up' : 'muted'}">Practised ${log.length}× · slips ${first} → ${last}</p>`;
}

function weaknessCard(w, i, mistakes) {
  const filter = drillFilterFor(w);
  const n = filter ? mistakes.filter((m) => drillMatches(m, filter)).length : 0;
  const m = filter && n ? mastery(mistakes, drillProgress, filter) : null;
  return `<li class="weak">
    <div class="weak-head"><span class="rank">${i + 1}</span><b>${esc(w.title)}</b></div>
    ${w.evidence.map((e) => `<p class="small muted">${esc(e)}</p>`).join('')}
    ${m ? `<div class="meter"><span style="width:${Math.round(m.share * 100)}%"></span></div><p class="small muted">${m.mastered ? '<b class="trend-up">Mastered</b>' : `${m.solid} of ${m.total} drill positions solid`}${m.accuracy !== null ? ` · ${pct(m.accuracy)} recent accuracy` : ''}</p>` : ''}
    ${practiceHistory(w.key)}
    ${why(`<p>${esc(w.lesson)}</p>`, 'Lesson')}
    <div class="actions">
      ${n ? `<button type="button" class="btn primary" data-action="startDrill" ${filterAttrs(filter)} data-label="${esc(w.title)}">Drill ${n}</button>` : ''}
      <button type="button" class="btn${n ? '' : ' primary'}" data-action="practise" data-weak="${i}">Practise vs Stockfish</button>
      <button type="button" class="btn" data-action="examples" data-weak="${i}">Examples</button>
    </div>
  </li>`;
}

function fixInsights() {
  const { facts, ws } = weaknessData();
  if (facts.length < MIN_GAMES) {
    return `<article class="empty-card"><h2>Find what’s holding you back</h2><p>With at least ${MIN_GAMES} analysed games, this ranks the patterns costing you the most and turns each one into drills and practice games.</p><button type="button" class="btn primary wide" data-action="openImport">Import games</button></article>`;
  }
  const mistakes = myMistakes();
  const top = ws.slice(0, 3);
  const rest = ws.slice(3);
  const unchecked = facts.filter((f) => !f.game.engine).length;
  const cards = ws.length
    ? `<section class="block"><h3>Fix these first</h3><ol class="weaks">${top.map((w, i) => weaknessCard(w, i, mistakes)).join('')}</ol>
       ${rest.length ? why(`<ol class="weaks">${rest.map((w, i) => weaknessCard(w, i + 3, mistakes)).join('')}</ol>`, `${rest.length} more to work on`) : ''}</section>`
    : '<article class="empty-card"><p>No clear weak spots stand out yet. Keep importing games, or check them with Stockfish below.</p></article>';
  const engineNote = unchecked ? `<section class="block"><p class="muted small">${unchecked} game${unchecked > 1 ? 's aren’t' : ' isn’t'} checked by Stockfish yet. Checked games add tactics, blunder timing and unconverted wins to this list.</p>${checkBar(facts.filter((f) => !f.game.engine).map((f) => f.game).slice(0, 10), `Check ${Math.min(10, unchecked)} games`, unchecked)}</section>` : '';
  return `${cards}${problemMapView(mistakes)}${engineNote}`;
}

function problemMapView(mistakes) {
  if (!mistakes.length) return '';
  const map = problemMap(mistakes);
  const phases = Object.keys(PHASES);
  const rows = map.rows.filter((r) => r.n);
  return `<section class="block"><h3>Problem map</h3><p class="muted small">Your costly moves by fundamental and phase. Darker means more board or evaluation lost. Tap a square to drill it.</p>
    <div class="pmap" role="table">
      <span></span>${phases.map((ph) => `<span class="ph" role="columnheader">${PHASES[ph].text}</span>`).join('')}
      ${rows.map((r) => `<span class="fund" role="rowheader">${esc(r.text)}</span>${phases.map((ph) => {
        const c = r.cells[ph];
        return c.n ? `<button type="button" class="cell" style="--h:${(0.12 + 0.88 * c.cost / map.max).toFixed(2)}" data-action="startDrill" data-fundamental="${r.key}" data-phase="${ph}" data-label="${esc(`${r.text}, ${PHASES[ph].text.toLowerCase()}`)}" aria-label="${c.n} ${esc(r.text)} mistakes in the ${ph}">${c.n}</button>` : '<span class="cell empty">·</span>';
      }).join('')}`).join('')}
    </div>
    <p class="label" style="margin-top:6px">By piece</p>
    <div class="chips">${map.pieces.map((pc) => `<button type="button" data-action="startDrill" data-piece="${pc.piece}" data-label="${esc(pc.name)} moves">${esc(pc.name)}<small>${pc.n}</small></button>`).join('')}</div>
  </section>`;
}

// ---------- Learn ----------
let PUZZLES = {};
fetch(new URL('../vendor/puzzles.json', import.meta.url)).then((r) => r.json()).then((d) => { PUZZLES = d; if (state.screen === 'train') render(); }).catch(() => {});
const learnProgress = { round: 0, skills: {}, ...store.get('learn', {}) };
const saveLearn = () => store.set('learn', learnProgress);
function learnSkill(id) {
  learnProgress.skills[id] ||= newSkillProgress();
  return learnProgress.skills[id];
}

function skillState(skill, mistakes) {
  const filter = skill.drill;
  const drills = filter && mistakes.some((m) => drillMatches(m, filter)) ? mastery(mistakes, drillProgress, filter) : null;
  return skillStatus(skill, learnSkill(skill.id), drills);
}

function learnHome() {
  const mistakes = myMistakes();
  const { ws } = weaknessData();
  const path = learningPath(ws, mistakes.length ? problemMap(mistakes).rows : []);
  const states = Object.fromEntries(SKILLS.map((sk) => [sk.id, skillState(sk, mistakes)]));
  const next = path.find((x) => states[x.skill.id].state !== 'mastered');
  const mastered = SKILLS.filter((sk) => states[sk.id].state === 'mastered').length;
  const pillFor = (st) => (st.state === 'mastered' ? pill('dominant', 'Mastered') : st.state === 'learning' ? pill('passive', `${st.done}/${st.total}`) : '<span class="small muted">New</span>');
  const nextCard = next ? `<article class="setup up-next"><span class="label">Up next</span><h2>${esc(next.skill.title)}</h2>
      ${next.reason ? (next.reason.kind === 'problem' ? `<p>${esc(next.reason.evidence[0])}</p>` : `<p>Because of <b>${esc(next.reason.title.toLowerCase())}</b> in your games. ${esc(next.reason.evidence[0])}</p>`) : `<p>${esc(next.skill.lesson[0][1])}</p>`}
      <div class="meter"><span style="width:${Math.round((100 * states[next.skill.id].done) / states[next.skill.id].total)}%"></span></div>
      <button type="button" class="btn primary wide" data-action="openSkill" data-skill="${next.skill.id}">${states[next.skill.id].done ? 'Continue' : 'Start'}</button></article>` : '<article class="result win"><h2>Every skill mastered</h2><p>Keep playing and importing games. New weaknesses will show up here.</p></article>';
  const order = path.map((x) => x.skill.id);
  const groups = GROUPS.map((g) => {
    const list = SKILLS.filter((sk) => sk.group === g.key).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    return `<section class="block"><h3>${g.text}</h3><ul class="rows">${list.map((sk) => `<li style="padding:0;border:0"><button type="button" data-action="openSkill" data-skill="${sk.id}"><div class="row-head"><b>${esc(sk.title)}</b>${pillFor(states[sk.id])}</div></button></li>`).join('')}</ul></section>`;
  }).join('');
  const drillLine = mistakes.length ? `<section class="block"><h3>Your positions</h3><p class="muted small">${mistakes.length} positions from your games where you went wrong, with spaced repetition.</p><button type="button" class="btn wide" data-action="openDrills">Open drills</button></section>` : '';
  return `<p class="context">Your course \u00b7 ${mastered} of ${SKILLS.length} skills mastered</p>${nextCard}${groups}${drillLine}`;
}

function openSkill(id, view = 'skill') {
  state.drill = null;
  state.learn = { id, view, card: 0 };
  setScreen('train');
}

function skillPanel() {
  const L = state.learn;
  const skill = skillById(L.id);
  if (L.view === 'lesson') return lessonPanel(skill);
  if (L.view === 'puzzle') return puzzlePanel(skill);
  const mistakes = myMistakes();
  const st = skillState(skill, mistakes);
  const { ws } = weaknessData();
  const reason = learningPath(ws).find((x) => x.skill.id === skill.id).reason;
  const buttons = {
    lesson: `<button type="button" class="btn small" data-action="skillLesson">${learnSkill(skill.id).lesson ? 'Read again' : 'Read'}</button>`,
    exercises: skill.source === 'puzzles' ? '<button type="button" class="btn small primary" data-action="skillPuzzles">Exercises</button>' : (skill.drill && mistakes.some((m) => drillMatches(m, skill.drill)) ? `<button type="button" class="btn small primary" data-action="startDrill" ${filterAttrs(skill.drill)} data-label="${esc(skill.title)}">Drill</button>` : '<span class="small muted">Import or play games first</span>'),
    yours: skill.drill ? `<button type="button" class="btn small" data-action="startDrill" ${filterAttrs(skill.drill)} data-label="${esc(skill.title)}">Drill</button>` : '',
    apply: '<button type="button" class="btn small" data-action="skillApply">Play</button>',
  };
  return `<button type="button" class="back" data-action="learnHome">\u2039 Your course</button>
    <article class="setup"><h2>${esc(skill.title)}</h2>
      ${reason ? `<p>${esc(reason.evidence.join(' '))}</p>` : `<p>${esc(skill.lesson[0][1])}</p>`}
      <ol class="steps">${st.steps.map((x) => `<li class="${x.done ? 'done' : ''}"><span class="tick" aria-hidden="true">${x.done ? '\u2713' : ''}</span><span class="step-text"><b>${esc(x.text)}</b>${x.detail ? `<small>${esc(x.detail)}</small>` : ''}</span>${buttons[x.key] || ''}</li>`).join('')}</ol>
      ${st.state === 'mastered' ? '<p class="trend-up"><b>Mastered.</b> Exercises still come back now and then to keep it fresh.</p>' : ''}
    </article>`;
}

// Worked example for a lesson: a puzzle for tactics, your own mistake for fundamentals.
function lessonExample(skill) {
  if (skill.source === 'puzzles') {
    const pz = puzzlesFor(PUZZLES, skill).sort((a, b) => a.rating - b.rating)[0];
    if (!pz) return null;
    const c = new Chess(pz.fen);
    const setup = c.move(uciToMove(pz.moves[0]));
    const sol = new Chess(c.fen()).move(uciToMove(pz.moves[1]));
    return { fen: c.fen(), color: c.turn(), last: setup, best: sol, text: `The idea here is <b class="mono">${esc(sol.san)}</b>.` };
  }
  const m = myMistakes().filter((x) => drillMatches(x, skill.drill)).sort((a, b) => b.cost - a.cost)[0];
  if (!m) return null;
  const best = new Chess(m.fen).move(m.accept[0]);
  const played = new Chess(m.fen).move(m.san);
  return { fen: m.fen, color: m.color, played, best, text: `From your game: you played <b class="mono">${esc(m.san)}</b> (grey). <b class="mono">${esc(best.san)}</b> (green) was better.` };
}

function lessonPanel(skill) {
  const L = state.learn;
  const cards = skill.lesson;
  const i = Math.min(L.card, cards.length - 1);
  const [title, text] = cards[i];
  const ex = L.example;
  const last = i === cards.length - 1;
  return `<button type="button" class="back" data-action="skillHome">\u2039 ${esc(skill.title)}</button>
    <article class="lesson"><span class="label">Lesson \u00b7 ${i + 1} of ${cards.length}</span><h2>${esc(title)}</h2><p>${esc(text)}</p>
      ${ex && last ? `<p class="small">${ex.text}${ex.played ? '' : ' <button type="button" class="btn small" data-action="showIdea">Show it</button>'}</p>` : ''}
      <div class="dots">${cards.map((_, k) => `<i class="${k === i ? 'on' : ''}"></i>`).join('')}</div>
      <div class="action-bar">${i ? '<button type="button" class="btn" data-action="lessonPrev">Back</button>' : ''}${last ? `<button type="button" class="btn primary" data-action="lessonDone">${skill.source === 'puzzles' ? 'Try exercises' : 'Done'}</button>` : '<button type="button" class="btn primary" data-action="lessonNext">Next</button>'}</div>
    </article>`;
}

function showLessonExample() {
  const L = state.learn;
  const skill = skillById(L.id);
  const ex = lessonExample(skill);
  L.example = ex;
  if (!ex) { L.position = null; return; }
  L.color = ex.color;
  L.position = { fen: ex.fen, analysis: analysisFor(ex.fen), assessment: null, move: ex.last ? { from: ex.last.from, to: ex.last.to } : null };
  L.arrows = ex.played ? [{ from: ex.played.from, to: ex.played.to, kind: 'played' }, { from: ex.best.from, to: ex.best.to, kind: 'best' }] : [];
}

function puzzlePanel(skill) {
  const L = state.learn;
  const pz = L.puzzle;
  const sp = learnSkill(skill.id);
  const right = sp.recent.filter(Boolean).length;
  const meta = `<p class="small muted">${SKILL_LEVELS[sp.level].text} \u00b7 ${right}/${sp.recent.length} of your recent answers right \u00b7 puzzle rated ${pz ? pz.p.rating : '\u2013'}</p>`;
  const back = `<button type="button" class="back" data-action="skillHome">\u2039 ${esc(skill.title)}</button>`;
  if (!pz) return `${back}<article class="empty-card"><p>Loading exercises\u2026</p></article>`;
  if (!pz.result) {
    return `${back}<article class="verdict"><p class="v-line">${esc(skill.prompt)}${pz.step > 0 ? ' Keep going.' : ''}</p>${why(`<p>${esc(skill.lesson[skill.lesson.length > 1 ? 1 : 0][1])}</p>`, 'Hint')}</article>${meta}
      <div class="action-bar"><button type="button" class="btn" data-action="puzzleSkip">Skip</button></div>`;
  }
  const ok = pz.result === 'solved';
  return `${back}<article class="verdict tone-${ok ? 'dominant' : 'mistake'}">
      <div class="v-head">${pill(ok ? 'dominant' : 'mistake', ok ? 'Solved' : 'Not quite')}${pz.levelChange ? `<span class="v-meta">${pz.levelChange > 0 ? 'Level up' : 'Level down'}</span>` : ''}</div>
      <p class="v-line">${ok ? 'That\u2019s it.' : `The move was <b class="mono">${esc(pz.expectedSan)}</b> (green arrow).`} ${!ok ? 'It will come back in a few exercises.' : ''}</p>
    </article>${meta}
    <div class="action-bar"><button type="button" class="btn primary" data-action="puzzleNext">Next exercise</button>${!ok && !pz.shown ? '<button type="button" class="btn" data-action="puzzleShow">Show solution</button>' : ''}</div>`;
}

function loadPuzzle() {
  const L = state.learn;
  const skill = skillById(L.id);
  const sp = learnSkill(skill.id);
  const list = puzzlesFor(PUZZLES, skill);
  const p = nextPuzzle(list, sp, learnProgress.round);
  L.arrows = [];
  if (!p) { L.puzzle = null; L.position = null; render(); return; }
  const chess = new Chess(p.fen);
  const setup = chess.move(uciToMove(p.moves[0]));
  L.color = chess.turn();
  L.puzzle = { p, chess, step: 1, result: null, levelBefore: sp.level };
  L.position = { fen: chess.fen(), analysis: analysisFor(chess.fen()), assessment: null, move: { from: setup.from, to: setup.to } };
  board.clearSelection();
  render();
}

function setPuzzlePosition(chess, last) {
  const fen = chess.fen();
  state.learn.position = { fen, analysis: analysisFor(fen), assessment: null, move: last ? { from: last.from, to: last.to } : null };
}

function finishPuzzle(ok) {
  const L = state.learn;
  const pz = L.puzzle;
  const sp = learnSkill(L.id);
  recordPuzzle(sp, pz.p, ok, learnProgress.round++);
  saveLearn();
  pz.result = ok ? 'solved' : 'failed';
  pz.levelChange = sp.level - pz.levelBefore;
}

function answerPuzzle(m) {
  const L = state.learn;
  const pz = L && L.puzzle;
  if (!pz || pz.result || pz.busy) return;
  const expected = pz.p.moves[pz.step];
  const before = new Chess(pz.chess.fen());
  const move = pz.chess.move({ from: m.from, to: m.to, promotion: m.promotion || 'q' });
  const exact = move.from + move.to === expected.slice(0, 4) && (!expected[4] || move.promotion === expected[4]);
  if (!exact && !pz.chess.isCheckmate()) {
    pz.chess.undo();
    const exp = before.move(uciToMove(expected));
    pz.expectedSan = exp.san;
    L.arrows = [{ from: exp.from, to: exp.to, kind: 'best' }, { from: move.from, to: move.to, kind: 'played' }];
    finishPuzzle(false);
    render();
    return;
  }
  setPuzzlePosition(pz.chess, move);
  pz.step++;
  if (pz.step >= pz.p.moves.length || pz.chess.isCheckmate()) {
    finishPuzzle(true);
    render();
    return;
  }
  // Opponent's reply, then your next move.
  pz.busy = true;
  render();
  setTimeout(() => {
    if (state.learn !== L || L.puzzle !== pz) return;
    const reply = pz.chess.move(uciToMove(pz.p.moves[pz.step]));
    pz.step++;
    pz.busy = false;
    setPuzzlePosition(pz.chess, reply);
    render();
  }, 450);
}

function showSolution() {
  const L = state.learn;
  const pz = L.puzzle;
  pz.shown = true;
  const c = new Chess(pz.p.fen);
  const moves = pz.p.moves.map((u) => c.move(uciToMove(u)));
  let k = 1;
  const stepOnce = () => {
    if (state.learn !== L || L.puzzle !== pz || k > moves.length) return;
    const replay = new Chess(pz.p.fen);
    for (let j = 0; j < k; j++) replay.move(moves[j].san);
    setPuzzlePosition(replay, moves[k - 1]);
    L.arrows = [];
    render();
    k++;
    setTimeout(stepOnce, 700);
  };
  stepOnce();
}

const LEARN_ACTIONS = {
  openSkill: (b) => openSkill(b.dataset.skill),
  learnHome: () => { state.learn = null; render(); },
  openDrills: () => { state.learn = null; state.showDrills = true; render(); },
  skillHome: () => { const L = state.learn; state.learn = { id: L.id, view: 'skill', card: 0 }; render(); },
  skillLesson: () => { state.learn.view = 'lesson'; state.learn.card = 0; state.learn.position = null; state.learn.arrows = []; render(); },
  lessonNext: () => {
    const L = state.learn;
    L.card++;
    if (L.card === skillById(L.id).lesson.length - 1) showLessonExample();
    render();
  },
  lessonPrev: () => { const L = state.learn; L.card = Math.max(0, L.card - 1); L.position = null; render(); },
  lessonDone: () => {
    const L = state.learn;
    learnSkill(L.id).lesson = true;
    saveLearn();
    if (skillById(L.id).source === 'puzzles') { L.view = 'puzzle'; loadPuzzle(); } else { LEARN_ACTIONS.skillHome(); }
  },
  showIdea: () => {
    const L = state.learn;
    const ex = L.example;
    if (!ex || !ex.best) return;
    L.arrows = [{ from: ex.best.from, to: ex.best.to, kind: 'best' }];
    render();
  },
  skillPuzzles: () => { state.learn.view = 'puzzle'; loadPuzzle(); },
  puzzleNext: loadPuzzle,
  puzzleSkip: loadPuzzle,
  puzzleShow: showSolution,
  skillApply: () => {
    const skill = skillById(state.learn.id);
    const a = skill.apply;
    startGame({ practice: { key: `skill:${skill.id}`, skill: skill.id, title: skill.title, focus: a.focus, lesson: skill.lesson[0][1], tags: a.tags || null, habit: a.kind === 'castle' ? 'castle' : null } });
  },
  backToSkill: () => { const id = state.practice && state.practice.skill; state.play = null; state.practice = null; if (id) openSkill(id); },
};

// ---------- Drills ----------
let drillProgress = { ...newProgress(), ...store.get('drills', {}) };
const saveDrills = () => store.set('drills', drillProgress);
function myMistakes() {
  const own = games.games.filter((g) => g.game && !g.sample);
  return collectMistakes(own.length ? own : games.games.filter((g) => g.game));
}

function trainPanel() {
  if (state.drill && state.drill.item) return drillSession();
  if (state.learn) return skillPanel();
  if (state.showDrills || state.drillDone) return `<button type="button" class="back" data-action="closeDrills">\u2039 Your course</button>${drillsHome()}`;
  return learnHome();
}

function drillsHome() {
  const mistakes = myMistakes();
  if (!mistakes.length) {
    return `<article class="setup"><h2>Drills</h2><p>Import or play a few games first. Every costly move you make becomes a position to drill until you get it right.</p><button type="button" class="btn primary wide" data-action="openImport">Import games</button></article>`;
  }
  const all = mastery(mistakes, drillProgress);
  const fund = Object.keys(FUNDAMENTALS).map((k) => ({ k, m: mastery(mistakes, drillProgress, { fundamental: k }) })).filter((x) => x.m.total);
  const dd = state.drillDone;
  const done = dd ? `<article class="drill-result ${dd.mastered || dd.right * 2 >= dd.done ? 'ok' : 'bad'}${dd.mastered ? ' big' : ''}"><div class="dr-head"><span class="dr-icon" aria-hidden="true">${dd.mastered ? '\u2605' : dd.right * 2 >= dd.done ? '\u2713' : '\u21bb'}</span><div><h2>${dd.mastered ? `${esc(dd.label)} mastered!` : 'Session done'}</h2><p><b>${dd.right} of ${dd.done}</b> solved${dd.mastered ? '. This pattern is under control.' : dd.right * 2 >= dd.done ? '. Nice work.' : '. These will come back until they stick.'}</p></div></div></article>` : '';
  return `${done}<article class="setup"><h2>Drills</h2>
      <p>Positions from your games where you went wrong. Find a better move; Stockfish judges it. Missed positions come back soon, solved ones later, until you get them right three rounds running.</p>
      <div class="meter"><span style="width:${Math.round(all.share * 100)}%"></span></div>
      <p class="small muted">${all.solid} of ${all.total} positions solid${all.accuracy !== null ? ` · ${pct(all.accuracy)} recent accuracy` : ''}</p>
      <button type="button" class="btn primary wide" data-action="startDrill" data-label="Mixed drill">Start mixed drill</button>
    </article>
    <section class="block"><h3>By fundamental</h3><ul class="rows">${fund.map(({ k, m }) => `<li style="padding:0;border:0"><button type="button" data-action="startDrill" data-fundamental="${k}" data-label="${esc(FUNDAMENTALS[k].text)}">
      <div class="row-head"><b>${esc(FUNDAMENTALS[k].text)}</b><span class="small ${m.mastered ? 'trend-up' : 'muted'}">${m.mastered ? 'Mastered' : `${m.solid}/${m.total} solid`}</span></div>
      <div class="meter"><span style="width:${Math.round(m.share * 100)}%"></span></div>
      ${m.accuracy !== null ? `<span class="small muted">${pct(m.accuracy)} of your last ${m.attempts} answers right</span>` : '<span class="small muted">Not started</span>'}
    </button></li>`).join('')}</ul></section>
    <section class="block"><h3>By phase</h3><div class="chips">${Object.keys(PHASES).map((ph) => { const n = mistakes.filter((m) => m.phase === ph).length; return n ? `<button type="button" data-action="startDrill" data-phase="${ph}" data-label="${PHASES[ph].text}">${PHASES[ph].text}<small>${n}</small></button>` : ''; }).join('')}</div></section>
    <section class="block"><h3>By piece</h3><div class="chips">${Object.keys(PIECES).map((pc) => { const n = mistakes.filter((m) => m.piece === pc).length; return n ? `<button type="button" data-action="startDrill" data-piece="${pc}" data-label="${PIECES[pc]} moves">${PIECES[pc]}<small>${n}</small></button>` : ''; }).join('')}</div></section>`;
}

function startDrill(b) {
  const filter = filterFromEl(b);
  if (state.learn) { state.learn.position = null; state.learn.arrows = []; }
  state.drill = { filter, label: b.dataset.label || 'Drill', done: 0, right: 0, streak: 0, recent: [], wasMastered: mastery(myMistakes(), drillProgress, filter).mastered };
  state.drillDone = null;
  setScreen('train');
  loadDrill();
}

function loadDrill() {
  const d = state.drill;
  const mistakes = myMistakes();
  const pool = mistakes.filter((m) => drillMatches(m, d.filter));
  const skip = new Set(d.recent.slice(-Math.min(3, pool.length - 1)));
  const item = nextDrill(pool, drillProgress, null, skip);
  if (!item) { stopDrill(); return; }
  d.item = item;
  d.answer = null;
  d.judging = false;
  d.position = { fen: item.fen, analysis: analysisFor(item.fen), assessment: null, move: null };
  board.clearSelection();
  render();
}

function stopDrill() {
  const d = state.drill;
  if (d && d.done) {
    const m = mastery(myMistakes(), drillProgress, d.filter);
    state.drillDone = { done: d.done, right: d.right, label: d.label, mastered: m.mastered && !d.wasMastered };
  }
  state.drill = null;
  render();
}

async function answerDrill(m) {
  const d = state.drill;
  if (!d || !d.item || d.answer || d.judging) return;
  const item = d.item;
  const chess = new Chess(item.fen);
  const move = chess.move({ from: m.from, to: m.to, promotion: m.promotion || 'q' });
  const afterFen = chess.fen();
  const sign = item.color === 'w' ? 1 : -1;
  let correct = item.accept.includes(move.san);
  let loss = null;
  d.position = { ...d.position, move: { from: m.from, to: m.to } };
  if (!correct) {
    d.judging = true;
    render();
    try {
      if (!engine) engine = new Engine();
      await engine.ready;
      let before = item.evalBefore;
      if (before === null) {
        const r = await engine.search(item.fen, { movetime: 250 });
        before = item.color === 'w' ? r.score : -r.score;
      }
      const after = chess.isCheckmate() ? sign * 100000 : (await engine.search(afterFen, { movetime: 300 }));
      const afterWhite = typeof after === 'number' ? after : chess.turn() === 'w' ? after.score : -after.score;
      const clampCp = (v) => Math.max(-2000, Math.min(2000, v));
      loss = Math.max(0, clampCp(sign * before) - clampCp(sign * afterWhite));
      correct = loss <= 60;
    } catch {
      const label = playMove({ fen: item.fen, analysis: analysisFor(item.fen) }, m).assessment.label;
      correct = label === 'dominant' || label === 'good';
    }
  }
  if (state.drill !== d) return;
  const boxBefore = (drillProgress.items[item.id] || { box: 0 }).box;
  const masteredBefore = mastery(myMistakes(), drillProgress, d.filter).mastered;
  recordAnswer(drillProgress, item, correct);
  saveDrills();
  d.done++;
  d.recent.push(item.id);
  if (correct) { d.right++; d.streak++; } else d.streak = 0;
  let bestMove = null;
  try { const bm = new Chess(item.fen).move(item.accept[0]); bestMove = { from: bm.from, to: bm.to }; } catch { /* no arrow */ }
  const passed = correct && boxBefore < MASTERED_BOX && drillProgress.items[item.id].box >= MASTERED_BOX;
  const categoryMastered = correct && !masteredBefore && mastery(myMistakes(), drillProgress, d.filter).mastered;
  d.answer = { correct, san: move.san, loss, best: item.accept[0], bestMove, passed, categoryMastered };
  try { navigator.vibrate?.(correct ? (passed || categoryMastered ? [40, 60, 40, 60, 120] : 40) : [80, 60, 80]); } catch { /* no vibration */ }
  d.judging = false;
  render();
}

// Big result stamp over the board after a drill answer. Keyed by answer so
// re-renders don't replay the animation.
function renderStamp() {
  const el = $('stamp');
  const d = state.screen === 'train' && state.drill;
  const a = d && d.answer;
  if (!a) { el.hidden = true; el.dataset.key = ''; return; }
  const key = `${d.done}`;
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  const tick = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6 11-11-1.4-1.4z"/></svg>';
  const cross = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6L19 6.4 17.6 5 12 10.6z"/></svg>';
  const title = a.categoryMastered ? 'Mastered!' : a.passed ? 'Passed!' : a.correct ? 'Solved' : 'Not quite';
  el.className = `stamp ${a.correct ? 'ok' : 'bad'}${a.passed || a.categoryMastered ? ' big' : ''}`;
  el.innerHTML = `<div class="stamp-card">${a.correct ? tick : cross}<b>${title}</b></div>`;
  el.hidden = false;
}

function drillSession() {
  const d = state.drill;
  const item = d.item;
  const m = mastery(myMistakes(), drillProgress, d.filter);
  const progress = `<div class="meter"><span style="width:${Math.round(m.share * 100)}%"></span></div><p class="small muted">${esc(d.label)}: ${m.solid} of ${m.total} solid${m.mastered ? ' · <b class="trend-up">mastered</b>' : ''}</p>`;
  if (d.judging) return `<article class="verdict"><p class="v-line"><span class="thinking">Stockfish is judging your move</span></p></article>${progress}`;
  if (!d.answer) {
    return `<article class="verdict"><p class="v-line">In the game you played <b class="mono">${esc(item.san)}</b> here. Find a better move.</p>${why(`<p>${esc(FUNDAMENTALS[item.fundamental].lesson)}</p>`, 'Hint')}</article>
      ${progress}
      <div class="action-bar"><button type="button" class="btn" data-action="skipDrill">Skip</button><button type="button" class="btn" data-action="stopDrill">Finish</button></div>`;
  }
  const a = d.answer;
  const s = drillProgress.items[item.id];
  const next = s && s.box >= MASTERED_BOX ? 'Solid. You won’t see this one for a while.' : a.correct ? `Solve it ${MASTERED_BOX - s.box} more time${MASTERED_BOX - s.box === 1 ? '' : 's'} to pass it.` : 'It will come back after a couple of others.';
  const title = a.categoryMastered ? `${esc(d.label)} mastered!` : a.passed ? 'Position passed!' : a.correct ? 'Solved' : 'Not quite';
  const sub = a.categoryMastered ? 'You’ve solved these positions reliably. This pattern is under control.' : a.passed ? 'You’ve solved this position three times running.' : a.correct && d.streak > 1 ? `${d.streak} in a row` : '';
  return `<article class="drill-result ${a.correct ? 'ok' : 'bad'}${a.passed || a.categoryMastered ? ' big' : ''}">
      <div class="dr-head"><span class="dr-icon" aria-hidden="true">${a.correct ? '\u2713' : '\u2717'}</span><div><h2>${title}</h2>${sub ? `<p>${sub}</p>` : ''}</div></div>
    </article>
    <article class="verdict tone-${a.correct ? 'dominant' : 'mistake'}">
      <div class="v-head"><span class="v-move mono">${esc(a.san)}</span>${pill(a.correct ? 'dominant' : 'mistake', a.correct ? 'Correct' : 'Not quite')}${a.loss !== null && !a.correct ? `<span class="v-meta">\u2212${(a.loss / 100).toFixed(1)}</span>` : ''}</div>
      <p class="v-line">${a.correct ? (a.san === a.best ? 'That’s the best move.' : `Good enough. Stockfish’s top choice was <b class="mono">${esc(a.best)}</b>.`) : `Better was <b class="mono">${esc(a.best)}</b> (green arrow).`}</p>
      <p class="small muted">${next}</p>
    </article>
    ${progress}
    <div class="action-bar"><button type="button" class="btn primary" data-action="nextDrill">Next</button><button type="button" class="btn" data-action="playDrill">Play it out</button><button type="button" class="btn" data-action="stopDrill">Finish</button></div>`;
}

// ---------- play actions ----------
// opts: { fen, color, punish, practice } for practice games.
async function startGame(opts = {}) {
  if (opts instanceof HTMLElement) opts = {};
  if (state.check) state.check.cancelled = true;
  if (!engine) engine = new Engine();
  state.engineError = null;
  const pick = opts.color || state.setup.color;
  const color = pick === 'r' ? (Math.random() < 0.5 ? 'w' : 'b') : pick;
  if (state.play) state.play.token++;
  state.practice = opts.practice || null;
  state.play = new PlaySession(engine, {
    userColor: color,
    level: state.setup.level,
    punish: opts.punish || state.setup.punish,
    fen: opts.fen,
    onUpdate: () => { if (state.screen === 'play') render(); },
  });
  if (state.screen !== 'play') setScreen('play');
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
  ...CAPTURE_ACTIONS,
  ...LEARN_ACTIONS,
  closeDrills: () => { state.showDrills = false; state.drillDone = null; render(); },
  startGame,
  newGame: () => { state.play = null; state.practice = null; render(); },
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
  startDrill,
  skipDrill: () => { state.drill.recent.push(state.drill.item.id); loadDrill(); },
  nextDrill: () => loadDrill(),
  stopDrill,
  playDrill: () => {
    const item = state.drill.item;
    stopDrill();
    startGame({ fen: item.fen, color: item.color, practice: { key: 'drill', title: 'Play out a drill position', focus: FUNDAMENTALS[item.fundamental].text, lesson: FUNDAMENTALS[item.fundamental].lesson } });
  },
  practise: (b) => {
    const w = state.weakRows && state.weakRows[Number(b.dataset.weak)];
    if (!w) return;
    const p = w.practice;
    const practice = { key: w.key, title: w.title, focus: p.focus || 'Play for the centre and quick development', lesson: w.lesson, tag: p.tag || null, habit: p.habit || null };
    if (p.type === 'opening') startGame({ fen: p.fen, color: p.color, practice });
    else if (p.type === 'positions' && p.positions.length) startGame({ fen: p.positions[0].fen, color: p.positions[0].color, punish: 'always', practice: { ...practice, positions: p.positions, index: 0 } });
    else startGame({ punish: p.punish || undefined, practice });
  },
  nextPosition: () => {
    const pr = state.practice;
    const i = pr.index + 1;
    startGame({ fen: pr.positions[i].fen, color: pr.positions[i].color, punish: 'always', practice: { ...pr, index: i } });
  },
  examples: (b) => { const w = state.weakRows && state.weakRows[Number(b.dataset.weak)]; if (w) { state.examples = w; openSheet('examples'); } },
  runCheck: () => runEngineCheck(state.checkTargets || []),
  cancelCheck: () => { if (state.check) state.check.cancelled = true; },
  openingGames: (b) => { const o = state.openingRows && state.openingRows[Number(b.dataset.opening)]; if (o) { state.gamesFilter = o; openSheet('games'); } },

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
  } else if (sheetKind === 'examples') {
    const w = state.examples;
    $('sheet-title').textContent = 'Examples';
    body.innerHTML = `<p class="muted small">${esc(w.title)}. Tap one to see it in Review.</p>
      <ul class="game-list">${w.examples.map((e, i) => {
        const p = e.game.game.plies[e.ply];
        const h = e.game.headers;
        return `<li><button type="button" data-ex="${i}"><b class="mono">${p ? `${moveNo(p)} ${esc(p.san)}` : 'Position'}</b><span>${esc(h.White || '?')} vs ${esc(h.Black || '?')}${h.Date && !h.Date.startsWith('?') ? ` \u00b7 ${esc(h.Date)}` : ''}</span></button></li>`;
      }).join('')}</ul>`;
    body.querySelectorAll('[data-ex]').forEach((b) => {
      b.onclick = () => {
        const e = w.examples[Number(b.dataset.ex)];
        closeSheet();
        selectGame(games.games.indexOf(e.game));
        setScreen('review');
        go(e.ply + 1);
      };
    });
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

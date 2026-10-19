// Camera side of over-the-board capture: opens the camera, lets you tap the
// board corners, reads every square as empty, white or black, and reports
// the moves it sees to the app.

import { Chess } from '../vendor/chess.js';
import { detectBoard } from './detect.js';
import { boardHomography, readFeatures, orientCorners, BoardReader, MoveWatcher, GridTracker, occupancy, squarePoint, project } from './vision.js';

export const CORNER_ORDER = ['a8', 'h8', 'h1', 'a1'];
const SAMPLE_WIDTH = 480;
const RECT = 320; // board view size in pixels
const RECT_MARGIN = 0.3; // squares of border shown around the board

// Spoken form of a move, so you know it was recorded without looking.
const PIECE_WORDS = { N: 'knight', B: 'bishop', R: 'rook', Q: 'queen', K: 'king' };
export function spokenMove(san) {
  if (san.startsWith('O-O-O')) return 'castles long' + (san.includes('#') ? ', checkmate' : san.includes('+') ? ', check' : '');
  if (san.startsWith('O-O')) return 'castles' + (san.includes('#') ? ', checkmate' : san.includes('+') ? ', check' : '');
  const m = san.match(/^([NBRQK])?([a-h])?([1-8])?(x)?([a-h][1-8])(=([NBRQ]))?([+#])?$/);
  if (!m) return san;
  const parts = [];
  if (m[1]) parts.push(PIECE_WORDS[m[1]]);
  else if (m[4]) parts.push(m[2]);
  if (m[1] && (m[2] || m[3])) parts.push(`${m[2] || ''}${m[3] || ''}`);
  if (m[4]) parts.push('takes');
  parts.push(m[5]);
  if (m[7]) parts.push(`promotes to ${PIECE_WORDS[m[7]]}`);
  if (m[8] === '+') parts.push('check');
  if (m[8] === '#') parts.push('checkmate');
  return parts.join(' ');
}

export class CaptureSession {
  // memory: { get(key, fallback), set(key, value) } for settings kept between games.
  constructor({ onChange = () => {}, memory = null } = {}) {
    this.onChange = onChange;
    this.memory = memory;
    this.speak = memory ? memory.get('captureSpeak', true) : true;
    this.showCamera = true;
    this.chess = new Chess();
    this.step = 'camera'; // camera -> corners -> confirm -> recording -> done
    this.corners = [];
    this.candidates = null; // asking which move was played
    this.status = '';
    this.error = null;
    this.reader = new BoardReader();
    this.watcher = new MoveWatcher();
    this.reading = null;
    this.check = null; // result of reading the starting position
    this.el = document.createElement('div');
    this.el.className = 'cam';
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.autoplay = true;
    this.overlay = document.createElement('canvas');
    // Straightened, centred view of the board that holds still as the phone moves.
    this.rect = document.createElement('canvas');
    this.rect.className = 'rect';
    this.rect.width = RECT;
    this.rect.height = RECT;
    this.badge = document.createElement('span');
    this.badge.className = 'cam-badge';
    this.el.append(this.video, this.overlay, this.rect, this.badge);
    this.view = memory ? memory.get('captureView', 'board') : 'board';
    this.locked = false;
    this.sampler = document.createElement('canvas');
    this.overlay.addEventListener('click', (e) => this.tap(e));
    this.timer = null;
  }

  async open() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false });
      this.video.srcObject = this.stream;
      await this.video.play().catch(() => {});
      await new Promise((r) => (this.video.videoWidth ? r() : this.video.addEventListener('loadedmetadata', r, { once: true })));
      this.step = 'corners';
      this.status = '';
      this.openedAt = performance.now();
      this.startSearch();
    } catch (err) {
      this.error = err && err.name === 'NotAllowedError'
        ? 'Camera access was blocked. Allow the camera for this app and try again.'
        : `The camera couldn’t start (${err.message || err}).`;
    }
    this.draw();
    this.onChange();
  }

  get nextCorner() {
    return CORNER_ORDER[this.corners.length];
  }

  // Corners from the last game, for a phone left in the same spot.
  get lastCorners() {
    const c = this.memory && this.memory.get('captureCorners', null);
    return Array.isArray(c) && c.length === 4 ? c : null;
  }

  useLastCorners() {
    const c = this.lastCorners;
    if (!c || this.step !== 'corners') return;
    this.corners = c.map(([x, y]) => [x * this.video.videoWidth, y * this.video.videoHeight]);
    this.calibrate();
    this.draw();
    this.onChange();
  }

  // Tap position in video pixels. Corners can be tapped in any order: the
  // pieces in their starting squares show which corner is which.
  tap(e) {
    if (this.step !== 'corners') return;
    const box = this.overlay.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * this.video.videoWidth;
    const y = ((e.clientY - box.top) / box.height) * this.video.videoHeight;
    this.searching = false;
    this.candidate = null;
    this.corners.push([x, y]);
    this.status = '';
    if (this.corners.length === 4) this.calibrate();
    this.draw();
    this.onChange();
  }

  // Orient the board and learn its colours from the starting position.
  calibrate() {
    const { img, scale } = this.frame();
    try {
      const { corners } = orientCorners(img, this.corners.map(([x, y]) => [x * scale, y * scale]));
      this.corners = corners.map(([x, y]) => [x / scale, y / scale]);
      this.H = boardHomography(this.corners);
      this.tracker = new GridTracker(img, corners);
      this.locked = true;
    } catch {
      this.corners = [];
      this.H = null;
      this.status = 'Those corners didn’t form a board. Tap them again.';
      this.startSearch();
      return;
    }
    const start = occupancy(this.chess);
    const features = readFeatures(img, this.tracker.H);
    this.lastImg = img;
    this.reader = new BoardReader();
    this.reader.train(features, start);
    this.reading = this.reader.read(features, start);
    this.updateCheck();
    this.calibratedAt = performance.now();
    this.lastAutoLearn = this.calibratedAt;
    if (this.memory) this.memory.set('captureCorners', this.corners.map(([x, y]) => [x / this.video.videoWidth, y / this.video.videoHeight]));
    this.step = 'confirm';
    // Keep reading while you check the setup, so fixes show straight away.
    this.stopLoop();
    this.timer = setInterval(() => this.tick(), 200);
  }

  updateCheck() {
    const start = occupancy(this.chess);
    const wrongSquares = [];
    this.reading.labels.forEach((l, i) => { if (l !== start[i] || this.reading.unknown[i]) wrongSquares.push(i); });
    const separation = this.reader.separation();
    const before = this.check && this.check.wrong;
    this.check = { wrong: wrongSquares.length, wrongSquares, separation, ok: wrongSquares.length === 0 && separation >= 2 };
    return before !== this.check.wrong;
  }

  // Re-learn the colours (lighting changes) on request, e.g. after fixing a piece.
  recheck() {
    if (!this.H) return;
    const start = occupancy(this.chess);
    const features = this.features();
    if (!features) return;
    this.reader.train(features, start);
    this.reading = this.reader.read(features, start);
    this.updateCheck();
    this.draw();
    this.onChange();
  }

  redoCorners() {
    this.corners = [];
    this.tracker = null;
    this.locked = false;
    this.rectDrawn = false;
    this.H = null;
    this.check = null;
    this.reading = null;
    this.step = 'corners';
    this.stopLoop();
    this.startSearch();
    this.draw();
    this.onChange();
  }

  // Look for the board by itself while waiting for corners. Two frames that
  // agree make a lock; tapping corners pauses the search.
  startSearch() {
    this.candidate = null;
    this.agreeing = 0;
    this.searching = true;
    clearTimeout(this.searchTimer);
    const loop = () => {
      if (this.step !== 'corners' || !this.searching) return;
      this.search();
      this.searchTimer = setTimeout(loop, 300);
    };
    this.searchTimer = setTimeout(loop, 300);
  }

  search() {
    if (this.corners.length || !this.video.videoWidth) return;
    const { img, scale } = this.frame();
    const found = detectBoard(img);
    if (!found) {
      if (this.candidate) { this.candidate = null; this.draw(); this.onChange(); }
      return;
    }
    const corners = found.corners.map(([x, y]) => [x / scale, y / scale]);
    const prev = this.candidate;
    const agree = prev && Math.max(...corners.map(([x, y], i) => Math.hypot(x - prev[i][0], y - prev[i][1]))) < 6 / scale;
    this.agreeing = agree ? this.agreeing + 1 : 0;
    this.candidate = corners;
    // Cameras spend their first second or so settling exposure and colour, so
    // wait for that and for the board to hold still over a few frames.
    if (this.agreeing >= 2 && performance.now() - (this.openedAt || 0) > 1500) {
      this.searching = false;
      this.corners = corners;
      this.calibrate();
      this.status = '';
    }
    this.draw();
    this.onChange();
  }

  // The current frame at reduced size.
  frame() {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    const scale = SAMPLE_WIDTH / vw;
    const w = SAMPLE_WIDTH;
    const h = Math.round(vh * scale);
    if (this.sampler.width !== w) { this.sampler.width = w; this.sampler.height = h; }
    const ctx = this.sampler.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(this.video, 0, 0, w, h);
    return { img: ctx.getImageData(0, 0, w, h), scale };
  }

  sampleH(scale) {
    return boardHomography(this.corners.map(([x, y]) => [x * scale, y * scale]));
  }

  // Follow the board into the current frame and read it. Null while the
  // board is lost.
  features() {
    if (!this.video.videoWidth || !this.tracker) return null;
    const { img, scale } = this.frame();
    const r = this.tracker.track(img);
    this.locked = r.locked;
    this.lastImg = img;
    // The grid in video pixels, for drawing.
    const Hs = r.H;
    this.H = [Hs[0] / scale, Hs[1] / scale, Hs[2] / scale, Hs[3] / scale, Hs[4] / scale, Hs[5] / scale, Hs[6], Hs[7], Hs[8]];
    this.drawRect(img, Hs);
    return r.locked ? readFeatures(img, Hs) : null;
  }

  // Learn from a frame whose position is known, keeping half of what was learnt
  // before, and take it as the tracker's new reference.
  relearn(features = this.features()) {
    if (features) {
      this.reader.train(features, occupancy(this.chess), 0.5);
      if (this.locked && this.lastImg) this.tracker.refresh(this.lastImg);
    }
    this.watcher.reset();
  }

  setView(view) {
    this.view = view;
    if (this.memory) this.memory.set('captureView', view);
    this.onChange();
  }

  // Warp the board into a square, centred view.
  drawRect(img, H) {
    const ctx = this.rect.getContext('2d');
    if (!this.rectImg) this.rectImg = ctx.createImageData(RECT, RECT);
    const out = this.rectImg.data;
    const { data, width, height } = img;
    const span = 8 + 2 * RECT_MARGIN;
    for (let y = 0; y < RECT; y++) {
      const by = (y / RECT) * span - RECT_MARGIN;
      for (let x = 0; x < RECT; x++) {
        const bx = (x / RECT) * span - RECT_MARGIN;
        const w = H[6] * bx + H[7] * by + H[8];
        const px = Math.round((H[0] * bx + H[1] * by + H[2]) / w);
        const py = Math.round((H[3] * bx + H[4] * by + H[5]) / w);
        const o = (y * RECT + x) * 4;
        if (px < 0 || py < 0 || px >= width || py >= height) { out[o] = out[o + 1] = out[o + 2] = 20; out[o + 3] = 255; continue; }
        const k = (py * width + px) * 4;
        out[o] = data[k];
        out[o + 1] = data[k + 1];
        out[o + 2] = data[k + 2];
        out[o + 3] = 255;
      }
    }
    ctx.putImageData(this.rectImg, 0, 0);
    this.rectDrawn = true;
  }

  start() {
    this.step = 'recording';
    this.status = 'Watching the board';
    this.watcher = new MoveWatcher();
    this.stopLoop();
    this.timer = setInterval(() => this.tick(), 160);
    this.keepAwake();
    this.say('Recording');
    this.draw();
    this.onChange();
  }

  // Stop the screen sleeping mid-game.
  async keepAwake() {
    try {
      if (navigator.wakeLock && !this.wakeLock) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener('release', () => { this.wakeLock = null; });
      }
    } catch { /* not supported or refused */ }
  }

  say(text) {
    if (!this.speak || typeof speechSynthesis === 'undefined') return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.05;
      speechSynthesis.speak(u);
    } catch { /* no speech */ }
  }

  setSpeak(on) {
    this.speak = on;
    if (this.memory) this.memory.set('captureSpeak', on);
    if (!on && typeof speechSynthesis !== 'undefined') try { speechSynthesis.cancel(); } catch { /* no speech */ }
    this.onChange();
  }

  toggleCamera() {
    this.showCamera = !this.showCamera;
    this.onChange();
  }

  stopLoop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setStatus(text) {
    if (this.status !== text) { this.status = text; this.onChange(); }
  }

  tick() {
    const features = this.features();
    if (!features) {
      this.draw();
      if (this.tracker && !this.locked) this.setStatus('Finding the board');
      return;
    }
    const occ = occupancy(this.chess);
    this.reading = this.reader.read(features, occ);
    if (this.step === 'confirm') {
      // Just after locking on the camera may still be settling: if squares
      // read wrong, learn the colours again from a newer frame.
      const now = performance.now();
      if (this.check && this.check.wrong && now - this.calibratedAt < 3000 && now - this.lastAutoLearn > 600) {
        this.lastAutoLearn = now;
        this.reader.train(features, occ);
        this.reading = this.reader.read(features, occ);
      }
      const changed = this.updateCheck();
      this.draw();
      if (changed) this.onChange();
      return;
    }
    // A wake lock is dropped when the app is hidden; take it again.
    if (!this.wakeLock && document.visibilityState === 'visible') this.keepAwake();
    this.draw();
    if (this.candidates) return;
    const r = this.watcher.feed(this.reading, occ, this.chess.moves({ verbose: true }), performance.now());
    if (r.state === 'blocked') return this.setStatus('Hand over the board');
    if (r.state === 'still') return this.setStatus('Watching the board');
    if (r.state === 'waiting') return this.setStatus('Reading the move');
    if (r.state === 'move') {
      this.play(r.move, features);
      return;
    }
    // Something changed but no legal move clearly explains it.
    this.candidates = r.candidates.filter((c) => c.wrong <= 3);
    this.status = this.candidates.length ? 'Which move was that?' : 'Couldn’t read that move. Play it on the board above.';
    if (navigator.vibrate) try { navigator.vibrate([60, 80, 60]); } catch { /* not supported */ }
    this.say(this.candidates.length ? 'Which move was that?' : 'Couldn’t read that move');
    this.onChange();
  }

  // Apply a move (detected, picked or entered by hand) and learn the new position.
  play(m, features) {
    const move = this.chess.move({ from: m.from, to: m.to, promotion: m.promotion || 'q' });
    this.candidates = null;
    // The app shows the last move played while it watches for the next one.
    this.status = 'Watching the board';
    this.lastPlayed = move;
    this.relearn(features);
    this.say(spokenMove(move.san));
    if (navigator.vibrate) try { navigator.vibrate(40); } catch { /* not supported */ }
    if (this.chess.isGameOver()) this.finish();
    this.onChange();
    return move;
  }

  // Nothing was played: what the camera sees is the current position.
  dismiss() {
    this.candidates = null;
    this.status = 'Watching the board';
    this.relearn();
    this.onChange();
  }

  undo() {
    if (!this.chess.history().length) return;
    this.chess.undo();
    this.candidates = null;
    this.lastPlayed = null;
    this.watcher.reset();
    this.status = 'Took back the last move. Put the pieces back on the board.';
    this.onChange();
  }

  finish() {
    this.stopLoop();
    this.step = 'done';
    this.close();
    this.onChange();
  }

  close() {
    this.stopLoop();
    this.searching = false;
    clearTimeout(this.searchTimer);
    if (this.wakeLock) this.wakeLock.release().catch(() => {});
    this.wakeLock = null;
    if (typeof speechSynthesis !== 'undefined') try { speechSynthesis.cancel(); } catch { /* no speech */ }
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  pgn({ white = 'White', black = 'Black' } = {}) {
    const c = this.chess;
    c.setHeader('Event', 'Over-the-board game');
    c.setHeader('Date', new Date().toISOString().slice(0, 10).replace(/-/g, '.'));
    c.setHeader('White', white || 'White');
    c.setHeader('Black', black || 'Black');
    const result = c.isCheckmate() ? (c.turn() === 'w' ? '0-1' : '1-0') : c.isDraw() ? '1/2-1/2' : '*';
    c.setHeader('Result', result);
    return c.pgn();
  }

  // Grid and readings on the straightened view.
  drawRectMarks() {
    const ctx = this.rect.getContext('2d');
    const span = 8 + 2 * RECT_MARGIN;
    const q = RECT / span;
    const at = (f, rFromTop) => [(f + RECT_MARGIN) * q, (rFromTop + RECT_MARGIN) * q];
    ctx.strokeStyle = this.locked ? 'rgba(25, 153, 94, 0.9)' : 'rgba(214, 170, 56, 0.9)';
    ctx.lineWidth = 1.5;
    for (let k = 0; k <= 8; k++) {
      ctx.beginPath(); ctx.moveTo(...at(k, 0)); ctx.lineTo(...at(k, 8)); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(...at(0, k)); ctx.lineTo(...at(8, k)); ctx.stroke();
    }
    if (!this.reading) return;
    for (let sq = 0; sq < 64; sq++) {
      const [x, y] = at((sq & 7) + 0.5, 7 - (sq >> 3) + 0.5);
      const label = this.reading.labels[sq];
      const wrong = this.step === 'confirm' && this.check && this.check.wrongSquares.includes(sq);
      if (this.reading.unknown[sq] || wrong) {
        ctx.strokeStyle = '#ff5c69';
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(x, y, q * 0.32, 0, Math.PI * 2); ctx.stroke();
      }
      if (!this.reading.unknown[sq] && label !== 'e') {
        ctx.beginPath(); ctx.arc(x, y, q * 0.14, 0, Math.PI * 2);
        ctx.fillStyle = label === 'w' ? '#ffffff' : '#111111';
        ctx.fill();
        ctx.strokeStyle = label === 'w' ? '#111111' : '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }

  // Corner markers while calibrating, the square grid afterwards.
  draw() {
    const showRect = this.view === 'board' && !!this.rectDrawn && (this.step === 'confirm' || this.step === 'recording');
    this.el.classList.toggle('mode-board', showRect);
    this.badge.hidden = !this.tracker || !(this.step === 'confirm' || this.step === 'recording');
    this.badge.textContent = this.locked ? 'Locked on' : 'Finding the board';
    this.badge.classList.toggle('lost', !this.locked);
    if (showRect) this.drawRectMarks();
    const vw = this.video.videoWidth || 640;
    const vh = this.video.videoHeight || 480;
    this.overlay.width = vw;
    this.overlay.height = vh;
    const ctx = this.overlay.getContext('2d');
    ctx.clearRect(0, 0, vw, vh);
    const s = vw / 640;
    ctx.lineWidth = 3 * s;
    ctx.font = `${Math.round(22 * s)}px sans-serif`;
    if (!this.H && this.candidate && this.step === 'corners') {
      ctx.strokeStyle = 'rgba(232, 178, 58, 0.95)';
      ctx.lineWidth = 4 * s;
      ctx.beginPath();
      this.candidate.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.stroke();
      ctx.lineWidth = 3 * s;
    }
    if (!this.H) {
      this.corners.forEach(([x, y], i) => {
        ctx.fillStyle = '#19995e';
        ctx.beginPath();
        ctx.arc(x, y, 9 * s, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.fillText(String(i + 1), x + 12 * s, y - 10 * s);
      });
    }
    if (this.H) {
      ctx.strokeStyle = 'rgba(25, 153, 94, 0.9)';
      for (let k = 0; k <= 8; k++) {
        const line = (x0, y0, x1, y1) => {
          const [ax, ay] = project(this.H, x0, y0);
          const [bx, by] = project(this.H, x1, y1);
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
          ctx.stroke();
        };
        line(k, 0, k, 8);
        line(0, k, 8, k);
      }
      // Label two squares so a rotated grid is easy to spot.
      ctx.fillStyle = '#ffffff';
      for (const [sq, name] of [[0, 'a1'], [63, 'h8']]) {
        const [x, y] = squarePoint(this.H, sq, 0.08, 0.92);
        ctx.fillText(name, x, y);
      }
      // What the camera reads on each square.
      if (this.reading) {
        for (let sq = 0; sq < 64; sq++) {
          const [x, y] = squarePoint(this.H, sq);
          const label = this.reading.labels[sq];
          const wrong = this.step === 'confirm' && this.check && this.check.wrongSquares.includes(sq);
          if (this.reading.unknown[sq] || wrong) {
            ctx.strokeStyle = '#ff5c69';
            ctx.lineWidth = 3 * s;
            ctx.beginPath();
            ctx.arc(x, y, 11 * s, 0, Math.PI * 2);
            ctx.stroke();
          }
          if (!this.reading.unknown[sq] && label !== 'e') {
            ctx.beginPath();
            ctx.arc(x, y, 6 * s, 0, Math.PI * 2);
            ctx.fillStyle = label === 'w' ? '#ffffff' : '#111111';
            ctx.fill();
            ctx.strokeStyle = label === 'w' ? '#111111' : '#ffffff';
            ctx.lineWidth = 1.5 * s;
            ctx.stroke();
            ctx.lineWidth = 3 * s;
          }
        }
      }
    }
  }
}

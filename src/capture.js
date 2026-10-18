// Camera side of over-the-board capture: opens the camera, lets you tap the
// board corners, samples frames and reports settled changes to the app.

import { Chess } from '../vendor/chess.js';
import { boardHomography, sampleSquares, rankCandidates, Tracker, squarePoint, project } from './vision.js';

export const CORNER_ORDER = ['a8', 'h8', 'h1', 'a1'];
const SAMPLE_WIDTH = 480;
const CONFIDENT = 1;
const MARGIN = 1.5;

export class CaptureSession {
  constructor({ onChange = () => {} } = {}) {
    this.onChange = onChange;
    this.chess = new Chess();
    this.step = 'camera'; // camera -> corners -> confirm -> recording -> done
    this.corners = [];
    this.candidates = null; // asking which move was played
    this.status = '';
    this.error = null;
    this.tracker = new Tracker();
    this.el = document.createElement('div');
    this.el.className = 'cam';
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.autoplay = true;
    this.overlay = document.createElement('canvas');
    this.el.append(this.video, this.overlay);
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

  // Tap position in video pixels.
  tap(e) {
    if (this.step !== 'corners') return;
    const box = this.overlay.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * this.video.videoWidth;
    const y = ((e.clientY - box.top) / box.height) * this.video.videoHeight;
    this.corners.push([x, y]);
    if (this.corners.length === 4) {
      try {
        this.H = boardHomography(this.corners);
        this.step = 'confirm';
      } catch {
        this.corners = [];
        this.status = 'Those corners didn’t form a board. Tap them again.';
      }
    }
    this.draw();
    this.onChange();
  }

  redoCorners() {
    this.corners = [];
    this.H = null;
    this.step = 'corners';
    this.stopLoop();
    this.draw();
    this.onChange();
  }

  // Sample the current frame at reduced size.
  signature() {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw) return null;
    const scale = SAMPLE_WIDTH / vw;
    const w = SAMPLE_WIDTH;
    const h = Math.round(vh * scale);
    if (this.sampler.width !== w) { this.sampler.width = w; this.sampler.height = h; }
    const ctx = this.sampler.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(this.video, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const H = boardHomography(this.corners.map(([x, y]) => [x * scale, y * scale]));
    return sampleSquares(img, H);
  }

  start() {
    this.step = 'recording';
    this.status = 'Watching the board';
    this.tracker = new Tracker();
    const sig = this.signature();
    if (sig) this.tracker.reset(sig);
    this.stopLoop();
    this.timer = setInterval(() => this.tick(), 160);
    this.draw();
    this.onChange();
  }

  stopLoop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    const sig = this.signature();
    if (!sig) return;
    const r = this.tracker.feed(sig, performance.now());
    if (r.state === 'moving') {
      if (this.status !== 'Hand over the board') { this.status = 'Hand over the board'; this.onChange(); }
      return;
    }
    if (r.state === 'still' && this.status === 'Hand over the board') { this.status = 'Watching the board'; this.onChange(); }
    if (r.state !== 'changed' || this.candidates) return;
    const moves = this.chess.moves({ verbose: true });
    const ranked = rankCandidates(moves, r.diffs, this.tracker.noise);
    const [top, second] = ranked;
    this.lastSig = sig;
    if (top && top.score > CONFIDENT && (!second || top.score - second.score > MARGIN)) {
      this.unexplainedSince = null;
      this.play(top.move);
    } else if (!top || top.score <= 0) {
      // Nothing legal explains the change: most likely a hand resting over
      // the board. Keep looking, and only ask if it doesn't clear up.
      const now = performance.now();
      this.unexplainedSince ??= now;
      this.tracker.pendingHandled = false;
      if (now - this.unexplainedSince < 3000) return;
      this.unexplainedSince = null;
      this.candidates = [];
      this.status = 'Couldn\u2019t read that move. Play it on the board above.';
      this.onChange();
    } else {
      this.unexplainedSince = null;
      this.candidates = ranked.filter((c) => c.score > -1).slice(0, 4);
      this.status = this.candidates.length ? 'Which move was that?' : 'Couldn’t read that move. Enter it on the board.';
      if (!this.candidates.length) this.candidates = [];
      this.onChange();
    }
  }

  // Apply a move (detected, picked or entered by hand) and re-baseline.
  play(m) {
    const move = this.chess.move({ from: m.from, to: m.to, promotion: m.promotion || 'q' });
    this.candidates = null;
    this.status = `Played ${move.san}`;
    const sig = this.lastSig || this.signature();
    if (sig) this.tracker.accept(sig);
    this.lastSig = null;
    if (navigator.vibrate) try { navigator.vibrate(40); } catch { /* not supported */ }
    if (this.chess.isGameOver()) this.finish();
    this.onChange();
    return move;
  }

  dismiss() {
    this.candidates = null;
    this.status = 'Watching the board';
    const sig = this.signature();
    if (sig) this.tracker.accept(sig);
    this.onChange();
  }

  undo() {
    if (!this.chess.history().length) return;
    this.chess.undo();
    this.candidates = null;
    const sig = this.signature();
    if (sig) this.tracker.accept(sig);
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

  // Corner markers while calibrating, the square grid afterwards.
  draw() {
    const vw = this.video.videoWidth || 640;
    const vh = this.video.videoHeight || 480;
    this.overlay.width = vw;
    this.overlay.height = vh;
    const ctx = this.overlay.getContext('2d');
    ctx.clearRect(0, 0, vw, vh);
    const s = vw / 640;
    ctx.lineWidth = 3 * s;
    ctx.font = `${Math.round(22 * s)}px sans-serif`;
    this.corners.forEach(([x, y], i) => {
      ctx.fillStyle = '#19995e';
      ctx.beginPath();
      ctx.arc(x, y, 9 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.fillText(CORNER_ORDER[i], x + 12 * s, y - 10 * s);
    });
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
        const [x, y] = squarePoint(this.H, sq, 0.3, 0.6);
        ctx.fillText(name, x, y);
      }
    }
  }
}

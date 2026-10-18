// Board rendering with dominance overlays and click-to-move.

import { sqName, sqIndex } from './analysis.js';

const GLYPHS = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const TEXT = '︎'; // force text presentation (the pawn glyph has an emoji form)

export class Board {
  constructor(root, { onMove } = {}) {
    this.root = root;
    this.onMove = onMove;
    this.selected = null;
    this.state = null;
    root.classList.add('board');
    this.squares = [];
    for (let k = 0; k < 64; k++) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'sq';
      el.innerHTML = '<span class="ov"></span><span class="mark"></span><span class="pc"></span><span class="badge"></span><span class="coord-f"></span><span class="coord-r"></span>';
      el.addEventListener('click', () => this.click(el.dataset.sq));
      root.appendChild(el);
      this.squares.push(el);
    }
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('viewBox', '0 0 8 8');
    this.svg.classList.add('arrows');
    this.svg.setAttribute('aria-hidden', 'true');
    root.appendChild(this.svg);
  }

  // state: { analysis, orientation, overlay, freedomSide, impact, lastMove, arrows, legal }
  render(state) {
    this.state = state;
    const { analysis: a, orientation = 'w', overlay = 'control', freedomSide, impact, lastMove, legal } = state;
    const freedom = new Map();
    const badges = new Map();
    if (overlay === 'freedom') {
      for (const p of a.pieces) {
        if (p.color !== freedomSide || p.type === 'p' || p.type === 'k') continue;
        badges.set(p.square, p);
        for (const s of p.safe) freedom.set(s, 'safe');
        for (const s of p.unsafe) if (freedom.get(s) !== 'safe') freedom.set(s, 'denied');
      }
    }
    const targets = new Set(this.selected && legal ? legal.filter((m) => m.from === this.selected).map((m) => m.to) : []);

    this.squares.forEach((el, k) => {
      const file = orientation === 'w' ? k % 8 : 7 - (k % 8);
      const rank = orientation === 'w' ? 7 - Math.floor(k / 8) : Math.floor(k / 8);
      const i = rank * 8 + file;
      const name = sqName(i);
      el.dataset.sq = name;
      el.className = 'sq ' + ((file + rank) % 2 ? 'light' : 'dark');
      const ov = el.children[0];
      const mark = el.children[1];
      const pc = el.children[2];
      const badge = el.children[3];
      el.children[4].textContent = rank === (orientation === 'w' ? 0 : 7) ? 'abcdefgh'[file] : '';
      el.children[5].textContent = file === (orientation === 'w' ? 0 : 7) ? String(rank + 1) : '';

      ov.className = 'ov';
      ov.style.removeProperty('--a');
      if (overlay === 'control') {
        const net = a.att.w[i] - a.att.b[i];
        const o = a.owner[i];
        if (o === 'c') ov.classList.add('contested');
        else if (o) {
          ov.classList.add(o === 'w' ? 'own-w' : 'own-b');
          ov.style.setProperty('--a', String(0.28 + 0.24 * Math.min(Math.max(Math.abs(net), 1), 3) / 3 + (Math.abs(net) >= 2 ? 0.1 : 0)));
        }
      } else if (overlay === 'impact' && impact) {
        if (impact.gained.includes(name)) ov.classList.add('gained');
        if (impact.lost.includes(name)) ov.classList.add('lost');
      }
      mark.className = 'mark';
      if (overlay === 'freedom' && freedom.has(name)) mark.classList.add(freedom.get(name));
      if (targets.has(name)) mark.classList.add('target');

      const p = a.grid[i];
      pc.textContent = p ? GLYPHS[p.type] + TEXT : '';
      pc.className = 'pc' + (p ? ' ' + p.color : '');
      const bp = badges.get(name);
      badge.textContent = bp ? String(bp.safe.length) : '';
      badge.className = 'badge' + (bp ? (bp.cramped ? ' cramped' : ' free') : '');
      if (bp) el.classList.add(bp.cramped ? 'is-cramped' : 'is-free');
      if (lastMove && (lastMove.from === name || lastMove.to === name)) el.classList.add('last');
      if (this.selected === name) el.classList.add('selected');
      el.setAttribute('aria-label', name + (p ? ` ${p.color === 'w' ? 'white' : 'black'} ${p.type}` : ''));
    });
    this.drawArrows(state.arrows || [], orientation);
  }

  drawArrows(arrows, orientation) {
    const pos = (s) => {
      const i = sqIndex(s);
      const f = i & 7;
      const r = i >> 3;
      return orientation === 'w' ? [f + 0.5, 7 - r + 0.5] : [7 - f + 0.5, r + 0.5];
    };
    this.svg.innerHTML = '';
    for (const { from, to, kind } of arrows) {
      const [x1, y1] = pos(from);
      const [x2, y2] = pos(to);
      const len = Math.hypot(x2 - x1, y2 - y1);
      const ux = (x2 - x1) / len;
      const uy = (y2 - y1) / len;
      const ex = x2 - ux * 0.32;
      const ey = y2 - uy * 0.32;
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'arrow ' + kind);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', x1);
      line.setAttribute('y1', y1);
      line.setAttribute('x2', ex);
      line.setAttribute('y2', ey);
      const head = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      const px = -uy * 0.2;
      const py = ux * 0.2;
      head.setAttribute('points', `${x2},${y2} ${ex + px},${ey + py} ${ex - px},${ey - py}`);
      g.append(line, head);
      this.svg.appendChild(g);
    }
  }

  click(sq) {
    const legal = this.state && this.state.legal;
    if (!legal) return;
    if (this.selected) {
      const choices = legal.filter((m) => m.from === this.selected && m.to === sq);
      if (choices.length) {
        const move = choices.find((m) => !m.promotion || m.promotion === 'q') || choices[0];
        this.selected = null;
        this.onMove && this.onMove(move);
        return;
      }
    }
    this.selected = legal.some((m) => m.from === sq) && this.selected !== sq ? sq : null;
    this.render(this.state);
  }

  clearSelection() {
    this.selected = null;
  }
}

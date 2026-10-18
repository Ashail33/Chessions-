// Dominance-over-time chart. Values are from the player's perspective:
// above the line you control more of the board, below the opponent does.

const W = 640;
const H = 150;
const PAD = { l: 34, r: 10, t: 12, b: 22 };
const LIMIT = 60;

export function renderChart(root, { values, marks, current, openingPlies, onSelect }) {
  const n = values.length;
  const x = (i) => PAD.l + (n > 1 ? (i / (n - 1)) * (W - PAD.l - PAD.r) : 0);
  const y = (v) => PAD.t + ((LIMIT - Math.max(-LIMIT, Math.min(LIMIT, v))) / (2 * LIMIT)) * (H - PAD.t - PAD.b);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const zero = y(0);
  const area = `M${x(0)},${zero} L${pts.join(' L')} L${x(n - 1)},${zero} Z`;
  const ticks = [-40, -20, 0, 20, 40];
  const moveTicks = [];
  for (let m = 5; m * 2 < n; m += 5) moveTicks.push(m);

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Board dominance through the game">`;
  svg += `<defs><clipPath id="above"><rect x="0" y="0" width="${W}" height="${zero}"/></clipPath><clipPath id="below"><rect x="0" y="${zero}" width="${W}" height="${H}"/></clipPath></defs>`;
  if (openingPlies) svg += `<rect class="c-opening" x="${x(0)}" y="${PAD.t}" width="${x(Math.min(openingPlies, n - 1)) - x(0)}" height="${H - PAD.t - PAD.b}"/>`;
  for (const t of ticks) {
    svg += `<line class="c-grid${t === 0 ? ' zero' : ''}" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(t)}" y2="${y(t)}"/>`;
    svg += `<text class="c-label" x="${PAD.l - 6}" y="${y(t) + 3}" text-anchor="end">${t > 0 ? '+' + t : t}</text>`;
  }
  for (const m of moveTicks) svg += `<text class="c-label" x="${x(m * 2)}" y="${H - 6}" text-anchor="middle">${m}</text>`;
  if (n > 1) {
    svg += `<path class="c-area up" d="${area}" clip-path="url(#above)"/>`;
    svg += `<path class="c-area down" d="${area}" clip-path="url(#below)"/>`;
    svg += `<polyline class="c-line" points="${pts.join(' ')}"/>`;
  }
  for (const { index, label } of marks) {
    svg += `<circle class="c-dot ${label}" cx="${x(index)}" cy="${y(values[index])}" r="3.2"/>`;
  }
  if (current !== null && current !== undefined && n > 0) {
    svg += `<line class="c-cursor" x1="${x(current)}" x2="${x(current)}" y1="${PAD.t}" y2="${H - PAD.b}"/>`;
    svg += `<circle class="c-cursor-dot" cx="${x(current)}" cy="${y(values[current])}" r="4.5"/>`;
  }
  svg += `<rect class="c-hit" x="0" y="0" width="${W}" height="${H}"/></svg>`;
  root.innerHTML = svg;

  root.querySelector('.c-hit').addEventListener('click', (e) => {
    const box = root.querySelector('svg').getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    const i = Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * (n - 1));
    onSelect(Math.max(0, Math.min(n - 1, i)));
  });
}

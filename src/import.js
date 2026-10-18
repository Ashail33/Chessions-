// Getting games in: pasted PGN, Lichess, or Chess.com (both public APIs allow
// browser requests, so no server is needed).

export const TIME_CLASSES = ['bullet', 'blitz', 'rapid', 'classical', 'daily'];

export function splitPgn(text) {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n(?=\s*\[Event )/)
    .map((s) => s.trim())
    .filter((s) => /\d\./.test(s));
}

// Keep only the headers the app uses and drop comments (clocks, evals), so
// large libraries stay small in storage.
const KEEP = ['Event', 'Site', 'Date', 'White', 'Black', 'Result', 'WhiteElo', 'BlackElo', 'TimeControl', 'ECO', 'Link', 'FEN', 'SetUp'];
export function compactPgn(pgn) {
  const headers = [];
  for (const m of pgn.matchAll(/^\[(\w+)\s+"([^"]*)"\]\s*$/gm)) if (KEEP.includes(m[1])) headers.push(`[${m[1]} "${m[2]}"]`);
  const body = pgn
    .replace(/^\[.*\]\s*$/gm, '')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\$\d+/g, ' ')
    .replace(/\d+\.\.\.\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return headers.join('\n') + '\n\n' + body;
}

// A stable identity for a game so re-imports don't duplicate it.
export function gameKey(headers, pgn) {
  if (headers.Link) return headers.Link;
  if (headers.Site && /^https?:/.test(headers.Site)) return headers.Site;
  let h = 0;
  for (let i = 0; i < pgn.length; i++) h = (h * 31 + pgn.charCodeAt(i)) | 0;
  return `pgn:${h}:${pgn.length}`;
}

const monthStart = (ym) => (ym ? Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1) : null);
const monthEnd = (ym) => (ym ? Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 1) - 1 : null);

// options: { max, from: 'YYYY-MM', to: 'YYYY-MM', timeClasses: [...], onProgress, signal }
export async function fetchLichess(username, { max = Infinity, from, to, timeClasses = TIME_CLASSES, onProgress = () => {}, signal } = {}) {
  const params = new URLSearchParams({ clocks: 'false', evals: 'false', opening: 'true' });
  if (Number.isFinite(max)) params.set('max', String(max));
  if (from) params.set('since', String(monthStart(from)));
  if (to) params.set('until', String(monthEnd(to)));
  const perf = timeClasses.map((t) => (t === 'daily' ? 'correspondence' : t));
  if (perf.length < TIME_CLASSES.length) params.set('perfType', perf.join(','));
  const res = await fetch(`https://lichess.org/api/games/user/${encodeURIComponent(username)}?${params}`, {
    headers: { Accept: 'application/x-chess-pgn' },
    signal,
  });
  if (res.status === 404) throw new Error(`Lichess user "${username}" not found.`);
  if (res.status === 429) throw new Error('Lichess is rate-limiting requests. Wait a minute and try again.');
  if (!res.ok) throw new Error(`Lichess returned ${res.status}.`);
  // The export streams; count games as they arrive.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let count = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    text += chunk;
    count += (chunk.match(/\[Event /g) || []).length;
    onProgress({ games: count });
  }
  return splitPgn(text);
}

const CHESSCOM_CLASS = { bullet: 'bullet', blitz: 'blitz', rapid: 'rapid', daily: 'daily' };

export async function fetchChessCom(username, { max = Infinity, from, to, timeClasses = TIME_CLASSES, onProgress = () => {}, signal } = {}) {
  const user = encodeURIComponent(username.trim().toLowerCase());
  const res = await fetch(`https://api.chess.com/pub/player/${user}/games/archives`, { signal });
  if (res.status === 404) throw new Error(`Chess.com user "${username}" not found.`);
  if (!res.ok) throw new Error(`Chess.com returned ${res.status}.`);
  const { archives = [] } = await res.json();
  const wanted = new Set(timeClasses.map((t) => CHESSCOM_CLASS[t]).filter(Boolean));
  const months = archives
    .map((url) => ({ url, ym: url.slice(-7).replace('/', '-') }))
    .filter(({ ym }) => (!from || ym >= from) && (!to || ym <= to))
    .reverse();
  const games = [];
  let done = 0;
  for (const { url, ym } of months) {
    const r = await fetch(url, { signal });
    if (r.status === 429) throw new Error('Chess.com is rate-limiting requests. Wait a minute and try again.');
    if (!r.ok) throw new Error(`Chess.com returned ${r.status} for ${ym}.`);
    const { games: month = [] } = await r.json();
    const picked = month.filter((g) => g.rules === 'chess' && g.pgn && wanted.has(g.time_class)).reverse();
    games.push(...picked.map((g) => g.pgn));
    onProgress({ games: Math.min(games.length, max), month: ym, monthsDone: ++done, months: months.length });
    if (games.length >= max) break;
  }
  return games.slice(0, max);
}

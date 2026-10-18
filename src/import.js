// Getting games in: pasted PGN, Lichess, or Chess.com (both public APIs allow
// browser requests, so no server is needed).

export function splitPgn(text) {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n(?=\s*\[Event )/)
    .map((s) => s.trim())
    .filter((s) => /\d\./.test(s));
}

export async function fetchLichess(username, max = 20) {
  const url = `https://lichess.org/api/games/user/${encodeURIComponent(username)}?max=${max}&clocks=false&evals=false&opening=true`;
  const res = await fetch(url, { headers: { Accept: 'application/x-chess-pgn' } });
  if (res.status === 404) throw new Error(`Lichess user "${username}" not found.`);
  if (!res.ok) throw new Error(`Lichess returned ${res.status}.`);
  return splitPgn(await res.text());
}

export async function fetchChessCom(username, max = 20) {
  const user = encodeURIComponent(username.toLowerCase());
  const res = await fetch(`https://api.chess.com/pub/player/${user}/games/archives`);
  if (res.status === 404) throw new Error(`Chess.com user "${username}" not found.`);
  if (!res.ok) throw new Error(`Chess.com returned ${res.status}.`);
  const { archives = [] } = await res.json();
  const games = [];
  for (const archive of archives.slice().reverse()) {
    const r = await fetch(archive);
    if (!r.ok) break;
    const { games: month = [] } = await r.json();
    const standard = month.filter((g) => g.rules === 'chess' && g.pgn).reverse();
    games.push(...standard.map((g) => g.pgn));
    if (games.length >= max) break;
  }
  return games.slice(0, max);
}

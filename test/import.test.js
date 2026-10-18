import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../vendor/chess.js';
import { compactPgn, gameKey, fetchChessCom, fetchLichess } from '../src/import.js';
import { analyzeGame, gameReport, slimGame } from '../src/insights.js';
import { SAMPLES } from '../src/samples.js';

const CHESSCOM_PGN = `[Event "Live Chess"]
[Site "Chess.com"]
[Date "2026.09.01"]
[White "me"]
[Black "them"]
[Result "1-0"]
[CurrentPosition "x"]
[Link "https://www.chess.com/game/live/1"]

1. e4 {[%clk 0:09:58]} 1... e5 {[%clk 0:09:57]} 2. Qh5 {[%clk 0:09:50]} 2... Nc6 3. Bc4 Nf6 4. Qxf7# 1-0`;

test('compactPgn drops clocks and unused headers but stays loadable', () => {
  const c = compactPgn(CHESSCOM_PGN);
  assert.ok(!c.includes('%clk'));
  assert.ok(!c.includes('CurrentPosition'));
  assert.ok(c.includes('[Link "https://www.chess.com/game/live/1"]'));
  const g = new Chess();
  g.loadPgn(c);
  assert.equal(g.history().length, 7);
  assert.ok(g.isCheckmate());
});

test('gameKey prefers the game link', () => {
  assert.equal(gameKey({ Link: 'L' }, ''), 'L');
  assert.equal(gameKey({ Site: 'https://lichess.org/abc' }, ''), 'https://lichess.org/abc');
  assert.equal(gameKey({}, '1. e4'), gameKey({}, '1. e4'));
  assert.notEqual(gameKey({}, '1. e4'), gameKey({}, '1. d4'));
});

test('slim analysis gives the same report', () => {
  const full = analyzeGame(SAMPLES[0].pgn);
  const slim = structuredClone(slimGame(full));
  assert.deepEqual(gameReport(slim, 'w'), gameReport(full, 'w'));
});

function mockFetch(routes) {
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    const body = routes(String(url));
    if (body === undefined) return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => body, body: null };
  };
  return seen;
}

test('Chess.com: walks months newest first, filters by range and time control', async () => {
  const game = (n, tc) => ({ rules: 'chess', time_class: tc, pgn: `[Event "g${n}"]\n\n1. e4 e5 *` });
  const seen = mockFetch((url) => {
    if (url.endsWith('/games/archives')) {
      return { archives: ['2026/07', '2026/08', '2026/09'].map((m) => `https://api.chess.com/pub/player/me/games/${m}`) };
    }
    if (url.endsWith('2026/07')) return { games: [game(1, 'blitz')] };
    if (url.endsWith('2026/08')) return { games: [game(2, 'blitz'), game(3, 'bullet'), { rules: 'chess960', time_class: 'blitz', pgn: 'x' }] };
    if (url.endsWith('2026/09')) return { games: [game(4, 'rapid'), game(5, 'blitz')] };
  });
  const progress = [];
  const all = await fetchChessCom('Me', { timeClasses: ['blitz', 'rapid'], onProgress: (p) => progress.push(p) });
  assert.deepEqual(all.map((p) => p.match(/g(\d)/)[1]), ['5', '4', '2', '1']);
  assert.equal(progress.length, 3);
  assert.ok(seen[0].includes('/player/me/'));

  const ranged = await fetchChessCom('me', { from: '2026-08', to: '2026-08' });
  assert.deepEqual(ranged.map((p) => p.match(/g(\d)/)[1]), ['3', '2']);

  const recent = await fetchChessCom('me', { max: 2 });
  assert.equal(recent.length, 2);
});

test('Lichess: builds the export query', async () => {
  let asked = '';
  const text = '[Event "a"]\n\n1. e4 *\n\n[Event "b"]\n\n1. d4 *\n';
  globalThis.fetch = async (url) => {
    asked = String(url);
    const bytes = new TextEncoder().encode(text);
    let sent = false;
    return { ok: true, status: 200, body: { getReader: () => ({ read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: bytes })) }) } };
  };
  const games = await fetchLichess('me', { from: '2026-01', to: '2026-02', timeClasses: ['blitz', 'daily'] });
  assert.equal(games.length, 2);
  const q = new URL(asked).searchParams;
  assert.equal(q.get('perfType'), 'blitz,correspondence');
  assert.equal(q.get('since'), String(Date.UTC(2026, 0, 1)));
  assert.equal(q.get('until'), String(Date.UTC(2026, 2, 1) - 1));
  assert.equal(q.get('max'), null);
});

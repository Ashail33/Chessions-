// Analyses games off the main thread so the board stays responsive.
import { analyzeGame, slimGame } from './insights.js';

self.onmessage = (e) => {
  const { id, pgn, window } = e.data;
  try {
    self.postMessage({ id, game: slimGame(analyzeGame(pgn, { window })) });
  } catch (err) {
    self.postMessage({ id, error: err.message || String(err) });
  }
};

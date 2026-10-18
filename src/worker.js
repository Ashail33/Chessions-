// Analyses games off the main thread so the board stays responsive.
import { analyzeGame } from './insights.js';

self.onmessage = (e) => {
  const { id, pgn, window } = e.data;
  try {
    self.postMessage({ id, game: analyzeGame(pgn, { window }) });
  } catch (err) {
    self.postMessage({ id, error: err.message || String(err) });
  }
};

# Chessions Dominance Lab

A study tool for building opening intuition without memorising opening lines.

Instead of telling you "this is the Italian, play Bc4", it measures what every move does to the board:

- **Control**: which side owns each square. A pawn's guard beats any number of pieces; otherwise more attackers wins.
- **Freedom**: how many *safe* moves each side's knights, bishops, rooks and queen have, meaning moves that don't lose material in the exchange that follows. Taking away your opponent's safe moves is what makes them "hard to move".
- **Cramped pieces**: pieces with one safe move or none.
- **Center, space, development and king safety**.

Every move in the opening is compared with every legal alternative and graded by how far it falls short of the most dominating option (*Dominant · Good · Passive · Concession · Mistake*). Moves are tagged with the principle they show (develops, claims center, early queen, knight on the rim, blocks own bishop, moves piece again…), and each tag is explained by what it did on the board.

Inspired by the heatmap layers on [chessyi.com/visualization](https://www.chessyi.com/visualization), with the focus on coaching your own games.

## Features

- **Import** games by pasting PGN, or fetch recent games from **Lichess** or **Chess.com** by username.
- **Board overlays**:
  - *Control* heatmap: amber for White, indigo for Black, striped where contested.
  - *Freedom*: green dots for squares a side's pieces can safely reach, red crosses for squares they're denied, and a safe-move badge on each piece.
  - *Move impact*: the squares the last move won or gave up.
- **Coach panel**: the grade for each move, its rank among all legal moves, what changed, the principle tags, and the top five most dominating alternatives. Click an alternative, or play any move on the board, to explore your own line.
- **Dominance chart** for the whole game, from your side of the board.
- **Game report**: your dominance after move 12, castling, development by move 8, the habits that cost you board, and the three biggest turning points.
- **Your patterns**: your games split by habit (castled by move 10, 3+ minors out by move 8, early queen, repeated piece moves, early edge pawns). You can compare your board dominance and score with and without each habit, so you learn which principles matter *for you*, from your own games.
- **Trainer**: positions from your games where a much more dominating move existed. Find it on the board and see how your choice ranks.

## Run it

There is no build step and nothing to install. Serve the folder over HTTP (ES modules don't load from `file://`):

```sh
npm start            # http://localhost:8080
# or: python3 -m http.server 8080
```

Set your username at the top so each game is analysed from your side. Games and settings are remembered in your browser.

To host it, any static host works (GitHub Pages: Settings → Pages → deploy from the default branch, root folder).

## Tests

```sh
npm test
```

## How the score works

`src/analysis.js` computes everything from the position with no engine:

| Term | Weight |
| --- | --- |
| Squares controlled (beyond your first two ranks) | 1 per square |
| Center (d4/e4/d5/e5 count 2, ring of 12 counts 1) | 1 |
| Space (squares owned in the enemy half) | 0.5 |
| Safe moves of N/B/R/Q | 0.6 |
| Cramped pieces (≤1 safe move) | −2 |
| Attacks on the squares around each king | −0.5 |
| Development and king safety (fade out from move 15 to 25) | 2.5 per minor, 1.5 × king safety |

Candidate moves are scored by material (10 per pawn) plus dominance. Material left en prise is subtracted using a static exchange evaluation, and a bonus is added for threats (a double threat counts much more).

**Limits:** this is a positional lens, not an engine. It looks one move ahead with an exchange check, so it misjudges sacrifices and deep tactics (it will grade Morphy's brilliant sacrifices as concessions). Use it to train your feel for space and freedom, and an engine to check tactics.

## Layout

```
index.html, styles.css   UI
src/analysis.js          attack maps, control, safe mobility, dominance score, move ranking
src/insights.js          move assessment, principle tags, game reports, cross-game habits
src/board.js, chart.js   board with overlays and arrows; dominance chart
src/import.js            PGN splitting, Lichess and Chess.com fetchers
src/worker.js            analyses games off the main thread
vendor/chess.js          chess.js 1.4.0 (BSD-2-Clause) for move legality and PGN parsing
```

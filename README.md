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

The app has five screens, switched from the tab bar: **Play** (Stockfish), **Record** (record a game on a real board with the camera), **Review** (step through a game with the coach), **Insights** (this game's report, or habits across all your games) and **Learn** (a course of skills, and drills on positions from your games). Imports and your games list open from the game picker at the top of Review, and settings from the gear icon.

- **Play the computer.** Stockfish 17.1 runs in your browser at the level you pick (Beginner ~1350 up to full strength). While you play well it stays at that level. When a move costs you a pawn or more (or half a pawn, if you choose), it switches to full strength and goes after the mistake. After every move you see:
  - the engine's verdict (Best / Good / Inaccuracy / Mistake / Blunder), how much the evaluation dropped, and the better move;
  - what the move did to your board dominance, plus the principle tags;
  - when you've been punished, the line Stockfish is using against you.

  Use **Hint** for the engine's choice and the most dominating move, **Take back** to retry, and **Analyse this game** to send a finished game to the report, patterns and trainer.

- **Import your whole history** from **Chess.com** or **Lichess** by username, or paste PGN. Choose the most recent N games or all of them, limit to a date range, and pick time controls (bullet, blitz, rapid, classical, daily). Chess.com is fetched month by month with live progress, and you can cancel at any point. Games are analysed in parallel workers (about a second per game per thread). They're stored in your browser (IndexedDB), so each game is analysed once and re-imports skip games you already have.
- **Board overlays**:
  - *Control* heatmap: amber for White, indigo for Black, striped where contested.
  - *Freedom*: green dots for squares a side's pieces can safely reach, red crosses for squares they're denied, and a safe-move badge on each piece.
  - *Move impact*: the squares the last move won or gave up.
- **Coach panel**: the grade for each move, its rank among all legal moves, what changed, the principle tags, and the top five most dominating alternatives. Click an alternative, or play any move on the board, to explore your own line.
- **Dominance chart** for the whole game, from your side of the board.
- **Game report**: your dominance after move 12, castling, development by move 8, the habits that cost you board, and the three biggest turning points.
- **Your patterns**: your games split by habit (castled by move 10, 3+ minors out by move 8, early queen, repeated piece moves, early edge pawns). You can compare your board dominance and score with and without each habit, so you learn which principles matter *for you*, from your own games.
- **Trainer**: positions from your games where a much more dominating move existed. Find it on the board and see how your choice ranks.

### Learn: a course of skills

Chess comes down to skills and fundamentals, and those can be taught. The **Learn** tab is a course of 15 skills in five groups: tactics (hanging pieces, defending, forks, pins and skewers, discovered attacks, trapping pieces), checkmates (patterns, attacking the king), opening fundamentals (centre, development, king safety), middlegame (piece activity, punishing opening mistakes) and endgames (pawn and rook endgames).

- **Your path** puts the skills behind your biggest weaknesses first ("Up next"), and explains why from your games.
- **Each skill** has a short lesson with a worked example (a puzzle, or your own mistake shown next to the better move), then exercises, then an *apply it* game against Stockfish. A skill is mastered when every step is done: lesson read; 80% of the last 12+ exercises right at Level 2 or above; the matching positions from your own games drilled; and the skill test passed (a game without a blunder, castling by move 10, holding the board at move 12, or no slips, depending on the skill).
- **Exercises** for tactics and endgames come from a themed set of 1,080 well-tested puzzles from the Lichess puzzle database (CC0, `vendor/puzzles.json`), across four rating levels. Three right in a row moves you up a level, two misses move you down, and missed puzzles come back a few exercises later. Opening and middlegame skills use positions from your own games.

### What's holding you back, drills and practice

- **Insights → What to fix** ranks the patterns costing you the most: habits (early queen, repeated piece moves, edge pawns, not castling, slow development), recurring mistakes (pieces left en prise, blocked bishops, knights on the rim, losing castling rights), your weakest opening, the phase where you blunder most and winning positions you didn't convert. Each comes with evidence from your games, a lesson, examples, a drill and a practice game.
- **Problem map:** every costly move is classified by fundamental (tactics, development, king safety, piece activity, centre and space), by piece and by phase (opening, middlegame, endgame). Tap a cell to drill it.
- **Drills (Train tab)** use positions from your own games where you went wrong. You find a better move and Stockfish judges it (within 0.6 of a pawn of the best counts). Spaced repetition: a miss comes back soon, a solve comes back later and later. A category is *mastered* when 80% of its positions have been solved three rounds running and your recent accuracy is 80%+.
- **Practice games vs Stockfish** target a weakness: a focus coach flags each slip, you start from your weak opening, blunder practice punishes even inaccuracies, or you replay the winning positions you let slip. Results are logged, so each weakness shows your slips going down.

### Record a game on a real board

Record (its own tab) → *Start recording*. Set up the pieces and point the phone at the board: it finds the board by itself. It looks for the X-shaped crossings where four squares meet (the ChESS corner response), joins them into a lattice, then tries each placement of the 8x8 board around it: the board's edge picks the right one (the squares alternate light and dark inside it and stop at the edge), helped by the pieces when they're set up. That works on an empty board or mid-game too. a1 is the dark corner; the pieces show which side is White, or it assumes White is nearest the camera and Turn board flips it. If it can't, you can tap the four corners in any order. From that first frame the app learns what each square looks like empty, with a white piece and with a black piece, separately for light and dark squares. Every frame it then reads all 64 squares as empty, white or black (from the far side of each square, so a tall piece leaning over the one behind it doesn't count), and the legal move whose resulting board matches the reading is recorded once it holds for half a second (castling and en passant included). Each square is also compared, point by point, with how it looked after the last move: the share of it that changed (and whether it got brighter or darker) shows where a piece landed or left, even a cream piece on a cream square, and the legal move must explain the change. Change that nothing explains keeps the app from calling the board still, so it asks rather than missing a move; a change of light alone (a shadow) changes no square's pattern, and the colours are learnt again. While recording, the board view washes changed squares amber. A small neural network, trained on a few hundred photos of real boards (about 99% of squares right on photos it never saw), reads every square too, and its vote is added to the colours. How much it counts is measured on your board: at the start it must read the starting position right, and if it doesn't, the colours decide alone. Light is corrected square by square: a smooth field across the board is fitted to the squares known to be empty, so a lamp or window on one side doesn't make empty squares look occupied. Each square also remembers its own look when empty (wood grain, printed letters, a scuff), and the colours are learnt again after every move. The dots on screen show what the last few readings agree on. A hand over the board is ignored. If it isn't sure it asks, and you can always enter a move on the on-screen board. Once set, the grid locks on and follows the board as the phone moves, moves back or in, turns or changes angle: each frame a whole-board match finds how it shifted, turned and changed size (looking wider on a jolt), then the grid crossings, sampled in board squares so they scale with the board, are matched nearby and the grid refitted to the ones that still match (a hand or a moved piece hides some). If the board is lost altogether, it is found again from scratch and turned to match the position on the board. The board is shown straightened and centred, so it holds still while your hand moves. While recording the screen stays on, each move is said out loud (you can mute it) and shown in a large status card, and the last corners are remembered so a phone left in the same spot needs no tapping next time. Finish to copy the PGN or analyse the game.

### Stats and engine checks

- **Engine check:** in Review, *Check with Stockfish* runs the engine over every position of a game (about 80 ms each). Moves get the usual `?!` / `?` / `??` marks, the verdict shows the engine's grade, centipawn loss and best move next to the board-control grade, and the chart adds a dashed engine-evaluation line. Insights → All games can check your library ten games at a time.
- **Insights → All games** is filterable by colour and time control: headline numbers; *Are you improving?* (board share at move 12 per game with a rolling average); *Where your games slip* (average board share by move in wins and losses); *Your openings* (grouped by the first two moves, tap to see those games); a *principles scorecard* comparing recent and earlier games; *which pieces cost you board*; and the with/without habit comparison.

## Run it

There is no build step and nothing to install. Serve the folder over HTTP (ES modules don't load from `file://`):

```sh
npm start            # http://localhost:8080
# or: python3 -m http.server 8080
```

Set your username at the top so each game is analysed from your side. Games and settings are remembered in your browser.

To host it, any static host works (GitHub Pages: Settings → Pages → deploy from the default branch, root folder).

## Android app

The same app is packaged for Android with [Capacitor](https://capacitorjs.com), so it runs fully on your phone: no server and no `npm start`. Stockfish, analysis and your saved games all live on the device, and Chess.com and Lichess imports work directly.

**Install:** copy `Chessions.apk` to your phone and open it. Android will ask you to allow installs from that source (Settings → Apps → Special access → Install unknown apps). It's a debug build signed with a development key, so Play Protect may warn that it's from an unknown developer.

**Get a fresh APK:** every push that changes the app runs the `android` GitHub Action. The APK is attached to the run as the `chessions-apk` artifact. You can also start it by hand from the Actions tab.

**Build it yourself** (needs JDK 21 and the Android SDK, with `ANDROID_HOME` set):

```sh
npm install
npm run android:apk    # → android/app/build/outputs/apk/debug/app-debug.apk
```

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

**Limits:** the dominance score is a positional lens, not an engine. It looks one move ahead with an exchange check, so it misjudges sacrifices and deep tactics (it will grade Morphy's brilliant sacrifices as concessions). Use it to train your feel for space and freedom. The Stockfish opponent in Play mode is what keeps you honest about tactics.

## Layout

```
index.html, styles.css   UI
src/analysis.js          attack maps, control, safe mobility, dominance score, move ranking
src/insights.js          move assessment, principle tags, game reports, cross-game habits
src/board.js, chart.js   board with overlays and arrows; dominance chart
src/import.js            PGN splitting/compaction, Lichess and Chess.com fetchers with date and time-control filters
src/library.js           IndexedDB cache of imported games and their analysis
src/collection.js        your game collection: import, worker-pool analysis, persistence
src/stats.js             per-game facts and dashboard aggregates
src/enginecheck.js       Stockfish check of every move in a game
src/weaknesses.js        ranks what's holding you back
src/drills.js            mistake categories and spaced-repetition drills
src/vision.js            board homography, square sampling, move inference
src/capture.js           camera session for recording over-the-board games
src/detect.js            finds the board in a frame without taps
src/squares.js, squarenet.js  square cut-outs and the trained square model (weights in squarenet-weights.js; scripts/squarenet rebuilds them)
src/worker.js            analyses games off the main thread
src/engine.js            UCI wrapper around Stockfish in a Web Worker (WASM, with a pure-JS fallback)
src/play.js              games against Stockfish: adaptive strength and punishing mistakes
vendor/chess.js          chess.js 1.4.0 (BSD-2-Clause) for move legality and PGN parsing
vendor/stockfish/        Stockfish.js 17.1 lite single-threaded build (GPLv3, see COPYING.txt)
```

The square model's weights are derived from the public-domain Roboflow [Chess Pieces](https://huggingface.co/datasets/Francesco/chess-pieces-mjzgj) photos and from [chess-piece-detection](https://universe.roboflow.com/gustoguardian/chess-piece-detection-bltvi) by gustoguardian (CC BY 4.0).

Stockfish is free software under the GNU GPL v3. Its source is at https://github.com/official-stockfish/Stockfish and https://github.com/nmrugg/stockfish.js. If you distribute this app, the GPL applies to the combined work.

# Chess Coach

Analyze your chess.com games with Stockfish, get an AI coach's take on your recurring mistakes, and drill openings. It's a static site that runs entirely in the browser: no backend, no build step.

## Run it locally
From this folder:
```powershell
python -m http.server 8765
```
Then open http://localhost:8765. It has to be served over HTTP; opening index.html directly as a file won't work. Any static host (such as GitHub Pages) also works.

## Game Review
Click any analyzed game for a full review, similar to chess.com's:
- **Eval bar** and a clickable **eval graph** with dots on the big moments
- Every move (both players) labelled **Brilliant !!, Great !, Best ★, Excellent, Good, Book, Inaccuracy ?!, Mistake ?, Miss ✕, Blunder ??**
- A **coach comment** explaining *why*: what it hangs, what it threatens, the tactic you missed, the mate you allowed, whether it develops or castles. Each comment shows the engine line as proof.
- Best-move arrow, **Retry** to find the better move yourself, and **Explain with AI** for a plain-language take
- Accuracy for both players and a move-quality summary

## What it does
- **Analyze**: type a chess.com username. It downloads your recent games from the public chess.com API and runs Stockfish 18 (NNUE, in-browser, several engines in parallel) on every position. Each of your moves is graded as an inaccuracy, mistake or blunder using lichess-style win-percentage loss. Mistakes and blunders are tagged: missed tactic, hung piece, missed or allowed mate, threw away a winning position, time trouble, opening or endgame error. You also get stats by game phase, by color and by opening, plus a game review with arrows.
- **AI coach**: sends the aggregated stats and your 15 worst mistakes to a free AI and returns your three biggest *recurring* problems and a 2-week plan. Pick one in Settings:
  - **Google Gemini**: free key at https://aistudio.google.com/apikey (recommended)
  - **Groq**: free key at https://console.groq.com/keys
  - **Ollama**: fully local, no key, but needs a decent PC
- **My mistakes**: your own blunders become puzzles. Find the move Stockfish wanted. Alternative moves that are just as good also count.
- **Openings**: drill lines from the Italian, Ruy Lopez, Sicilian, French, Caro-Kann, Scandinavian, Queen's Gambit, London, King's Indian and 1.e4 e5. Learn mode shows arrows; Test mode is from memory and tracks mastery (5 clean runs in a row). "Auto" picks your weakest line. You can paste your own lines. The Openings table on the Analyze tab has **Drill** buttons for the openings you actually play.

Everything (cached analysis, drill progress, API key) is saved in your browser's localStorage only.

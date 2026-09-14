# 🐝 HIVEBREAK

**Shatter the honeycomb. Free the swarm.**

HIVEBREAK is a fast, juicy, honeycomb-themed brick-breaker written in **pure vanilla JavaScript** — no frameworks, no build step, no assets. Break through 8 hand-crafted chambers of the hive, chain bombs, catch power-ups, and face the Queen's Crown.

## Play

Open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8080
# then open http://localhost:8080
```

## Controls

| Input | Action |
|---|---|
| 🖱️ Mouse / touch drag | Move the hive bar |
| ← → | Move the hive bar |
| `Space` / click / tap | Launch the bee · fire stingers |
| `P` / `Esc` | Pause |
| `M` | Mute |

## Gameplay

- **Bricks** — golden honey cells (1 hit), wax cells (2 hits), hardened amber (3 hits), and pulsing 💣 bomb cells that detonate their neighbors.
- **Combo multiplier** — consecutive brick hits without touching the bar raise your score multiplier.
- **Power-ups** drop from destroyed cells:
  - **W** Wide bar
  - **M** Multiball
  - **L** Stingers (auto-fire lasers)
  - **S** Slow bee
  - **C** Sticky comb (catch & re-aim)
  - **+** Extra life
- **8 levels** — from *Worker Cells* to the *Queen's Crown*. Clear them all to win, then keep going in **Endless** mode with rising speed.
- **Best score** persists via `localStorage`.

## Development

```
HIVEBREAK/
├── index.html          # page shell + overlay menus
├── css/style.css       # honey/dark theme
├── js/game.js          # the whole game (~900 lines, zero deps)
└── js/test-headless.js # headless smoke test (Node)
```

Run the headless test suite (stubs the DOM/canvas, plays the game with bots, verifies physics, bombs, level flow, power-ups, and win/endless states):

```bash
node js/test-headless.js
```

## License

MIT — see [LICENSE](LICENSE).

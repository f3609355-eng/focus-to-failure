# fooocus — Wave Trainer

An adaptive focus training app that builds your concentration through progressive wave cycles. Track your focus sessions, earn stickers for hitting goals, and watch your baseline improve over time.

## How It Works

1. **Start Focus** — begin a focus session
2. **I Got Distracted** — mark when you lose focus (honestly!)
3. The app calculates your break length based on your focus time
4. Your goals adapt as your focus baseline improves

### Training Phases

- **Linear Build** — steady goal increases as you hit targets consistently
- **Wave Cycle** — alternates push blocks (stretch goals) with consolidation blocks (comfortable practice)

### Keyboard Shortcuts

- `Space` — Start focus / Pause / Resume
- `Esc` — Close modals

## Tech Stack

Pure vanilla JS (ES modules), CSS, Chart.js — no build step required.

- **IndexedDB** for session history persistence
- **localStorage** for settings and training state
- **Chart.js** for trend visualization

## Files

| File | Purpose |
|------|---------|
| `index.html` | App shell and markup |
| `styles.css` | All styling (single file, organized by section) |
| `app.js` | Main application logic, UI wiring, timer |
| `config.js` | Default configuration + deep merge utilities |
| `storage.js` | IndexedDB + localStorage persistence |
| `analytics.js` | Weighted percentile metrics computation |
| `planner.js` | Wave/Linear training planner |
| `charts.js` | Chart.js wrapper functions |
| `utils.js` | Formatting, download, UUID helpers |

## Deploy

Drop all files on any static host (GitHub Pages, Netlify, Vercel, etc.). No build step needed.


## Golden tests

Open `golden_test.html` via your local server to run deterministic checks against the algorithm engines.

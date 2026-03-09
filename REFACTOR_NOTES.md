# Refactor notes

This pass extracts some of the highest-churn UI and session logic out of `app.js`:

- `ui/history.js` now owns history filtering, summary, and row rendering.
- `session/recovery.js` now owns interrupted-session save/load/recovery.
- `ui/header.js` now owns phase/block-type presentation helpers.
- `session/timer.js` now owns UI-state derivation for timer controls.
- `ui/settings.js` includes small binding helpers for future settings extraction.

The timer core and settings orchestration still remain in `app.js`, but the file is now set up for a second extraction pass.

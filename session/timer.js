export function computeUiState({ mode, timerActive, running }) {
  if (mode === "BREAK" && timerActive) return "break";
  if (mode === "FOCUS" && timerActive && running) return "focusing";
  if (mode === "FOCUS" && timerActive && !running) return "paused";
  return "idle";
}

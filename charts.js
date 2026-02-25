const C = {
  focus:     "#2563eb",
  focusFill: "rgba(37,99,235,0.08)",
  goal:      "#16a34a",
  goalFill:  "rgba(22,163,74,0.06)",
  floor:     "#d97706",
  floorFill: "rgba(217,119,6,0.06)",
  bar:       "rgba(37,99,235,0.55)",
  barHover:  "rgba(37,99,235,0.75)",
  crash:     "rgba(220,38,38,0.55)",
  overshoot: "rgba(168,85,247,0.55)",
  grid:      "rgba(0,0,0,0.06)",
  text:      "#6b6b6b",
  win:       "rgba(22,163,74,0.35)",
  miss:      "rgba(220,38,38,0.25)",
  winLine:   "rgba(22,163,74,0.7)",
  floorLine: "rgba(217,119,6,0.7)",
};

let activeChart = null;

function destroy() {
  if (activeChart) { activeChart.destroy(); activeChart = null; }
}

// ═══════════════════════════════════════
// Helpers
// ═══════════════════════════════════════

function isoWeek(d) {
  const dt = new Date(d.getTime());
  dt.setHours(0, 0, 0, 0);
  dt.setDate(dt.getDate() + 3 - ((dt.getDay() + 6) % 7));
  const week1 = new Date(dt.getFullYear(), 0, 4);
  const wn = 1 + Math.round(((dt - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return `${dt.getFullYear()}-W${String(wn).padStart(2, "0")}`;
}

function parseTS(ts) {
  if (!ts) return null;
  const d = new Date(String(ts).replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? null : d;
}

function weekLabel(isoStr) {
  const [yr, wStr] = isoStr.split("-W");
  const wn = Number(wStr);
  const jan4 = new Date(Number(yr), 0, 4);
  const dayOfWeek = (jan4.getDay() + 6) % 7;
  const mon = new Date(jan4.getTime() - dayOfWeek * 86400000 + (wn - 1) * 7 * 86400000);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[mon.getMonth()]} ${mon.getDate()}`;
}

// ═══════════════════════════════════════
// Tab: Progress (focus + goal + floor)
// ═══════════════════════════════════════
export function drawProgress(ctx, blocks, maxN = 30) {
  destroy();
  const slice = blocks.filter(b => b?.focus_seconds != null).slice(-maxN);
  if (!slice.length) return null;

  const labels = slice.map((_, i) => String(i + 1));
  const focus = slice.map(b => Math.round((b.focus_seconds || 0) / 60 * 10) / 10);
  const goals = slice.map(b => Math.round((b.goal_seconds || 0) / 60 * 10) / 10);
  const floors = slice.map(b => {
    const f = b.floor_seconds || b.floor_effective_seconds || 0;
    return f > 0 ? Math.round(f / 60 * 10) / 10 : null;
  });

  activeChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Focus", data: focus,
          borderColor: C.focus, backgroundColor: C.focusFill, fill: true,
          tension: 0.3, borderWidth: 2.5, pointRadius: 3, pointBackgroundColor: C.focus, order: 1,
        },
        {
          label: "Goal", data: goals,
          borderColor: C.goal, backgroundColor: "transparent", borderDash: [6, 3],
          borderWidth: 1.5, pointRadius: 0, tension: 0.1, order: 2,
        },
        {
          label: "Floor", data: floors,
          borderColor: C.floor, backgroundColor: "transparent", borderDash: [3, 3],
          borderWidth: 1.5, pointRadius: 0, tension: 0.1, order: 3,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: true, position: "bottom", labels: { boxWidth: 14, padding: 12, font: { size: 11 }, usePointStyle: true } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y}m` } },
      },
      scales: {
        y: { beginAtZero: true, ticks: { callback: v => `${Math.round(v)}m`, color: C.text, font: { size: 11 } }, grid: { color: C.grid } },
        x: { title: { display: true, text: "Session", color: C.text, font: { size: 11 } }, ticks: { color: C.text, font: { size: 10 }, maxTicksLimit: 15 }, grid: { display: false } },
      },
    },
  });
  return activeChart;
}

// ═══════════════════════════════════════
// Tab: Today
// ═══════════════════════════════════════
export function drawToday(ctx, blocks) {
  destroy();
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayEnd = dayStart + 86400000;

  const todays = blocks.filter(b => {
    const t = Date.parse((b.timestamp || "").replace(" ", "T"));
    return !Number.isNaN(t) && t >= dayStart && t < dayEnd && b.focus_seconds != null;
  });
  if (!todays.length) return null;

  const labels = todays.map((_, i) => `#${i + 1}`);
  const focus = todays.map(b => Math.round((b.focus_seconds || 0) / 60 * 10) / 10);
  const goalLine = todays.map(b => Math.round((b.goal_seconds || 0) / 60 * 10) / 10);
  const colors = todays.map(b => {
    if (b.crash) return C.crash;
    if (b.overshoot) return C.overshoot;
    if (b.is_win) return C.win;
    return C.bar;
  });

  activeChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Focus", data: focus, backgroundColor: colors, borderRadius: 6, order: 2 },
        { label: "Goal", data: goalLine, type: "line", borderColor: C.goal, borderDash: [6, 3], borderWidth: 1.5, pointRadius: 3, pointBackgroundColor: C.goal, fill: false, order: 1 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: "bottom", labels: { boxWidth: 14, padding: 12, font: { size: 11 }, usePointStyle: true } },
        tooltip: {
          callbacks: {
            label: (tip) => {
              const b = todays[tip.dataIndex];
              const base = `${tip.dataset.label}: ${tip.parsed.y}m`;
              if (tip.datasetIndex === 0 && b) {
                const tags = [];
                if (b.crash) tags.push("crash");
                if (b.overshoot) tags.push("overshoot");
                if (b.is_win) tags.push("win ✓");
                if (b.pause_count > 0) tags.push(`${b.pause_count} pause${b.pause_count > 1 ? "s" : ""}`);
                if (b.stop_reason === "COMPLETED") tags.push("task done");
                return tags.length ? `${base} (${tags.join(", ")})` : base;
              }
              return base;
            },
          },
        },
      },
      scales: {
        y: { beginAtZero: true, ticks: { callback: v => `${Math.round(v)}m`, color: C.text, font: { size: 11 } }, grid: { color: C.grid } },
        x: { ticks: { color: C.text, font: { size: 11 } }, grid: { display: false } },
      },
    },
  });
  return activeChart;
}

// ═══════════════════════════════════════
// Tab: Weekly (week-over-week improvement)
// ═══════════════════════════════════════
export function drawWeekly(ctx, blocks) {
  destroy();
  const valid = blocks.filter(b => b?.focus_seconds > 0);
  if (valid.length < 2) return null;

  const weekMap = {};
  for (const b of valid) {
    const d = parseTS(b.timestamp) || (b.date ? new Date(b.date) : null);
    if (!d) continue;
    const wk = isoWeek(d);
    if (!weekMap[wk]) weekMap[wk] = { focus: [], wins: 0, total: 0, floors: [] };
    weekMap[wk].focus.push(b.focus_seconds);
    weekMap[wk].total++;
    if (b.goal_seconds > 0 && b.focus_seconds >= b.goal_seconds) weekMap[wk].wins++;
    const f = b.floor_seconds || b.floor_effective_seconds || 0;
    if (f > 0) weekMap[wk].floors.push(f);
  }

  const weeks = Object.keys(weekMap).sort().slice(-8);
  if (weeks.length < 2) return null;

  const labels = weeks.map(weekLabel);
  const avgFocus = weeks.map(w => {
    const arr = weekMap[w].focus;
    return Math.round(arr.reduce((a, x) => a + x, 0) / arr.length / 60 * 10) / 10;
  });
  const winRates = weeks.map(w => {
    const wk = weekMap[w];
    return wk.total > 0 ? Math.round((wk.wins / wk.total) * 100) : 0;
  });
  const avgFloor = weeks.map(w => {
    const arr = weekMap[w].floors;
    return arr.length > 0 ? Math.round(arr.reduce((a, x) => a + x, 0) / arr.length / 60 * 10) / 10 : null;
  });

  activeChart = new Chart(ctx, {
    data: {
      labels,
      datasets: [
        { type: "bar", label: "Avg Focus", data: avgFocus, backgroundColor: C.bar, borderRadius: 6, yAxisID: "y", order: 2 },
        { type: "line", label: "Win Rate", data: winRates, borderColor: C.winLine, backgroundColor: "transparent", borderWidth: 2, pointRadius: 4, pointBackgroundColor: C.winLine, tension: 0.3, yAxisID: "y1", order: 1 },
        { type: "line", label: "Floor", data: avgFloor, borderColor: C.floorLine, backgroundColor: "transparent", borderDash: [4, 3], borderWidth: 1.5, pointRadius: 0, tension: 0.3, yAxisID: "y", order: 3 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: true, position: "bottom", labels: { boxWidth: 14, padding: 12, font: { size: 11 }, usePointStyle: true } },
        tooltip: {
          callbacks: {
            label: (tip) => tip.dataset.yAxisID === "y1" ? `Win rate: ${tip.parsed.y}%` : `${tip.dataset.label}: ${tip.parsed.y}m`,
            footer: (items) => { const wk = weeks[items[0]?.dataIndex]; return wk ? `${weekMap[wk].total} sessions` : ""; },
          },
        },
      },
      scales: {
        y: { beginAtZero: true, position: "left", ticks: { callback: v => `${Math.round(v)}m`, color: C.text, font: { size: 11 } }, grid: { color: C.grid } },
        y1: { beginAtZero: true, max: 100, position: "right", ticks: { callback: v => `${v}%`, color: C.text, font: { size: 10 } }, grid: { display: false } },
        x: { ticks: { color: C.text, font: { size: 10 } }, grid: { display: false } },
      },
    },
  });
  return activeChart;
}

// ═══════════════════════════════════════
// Tab: Hit Rate (rolling win rate)
// ═══════════════════════════════════════
export function drawConsistency(ctx, blocks, windowSize = 5) {
  destroy();
  const valid = blocks.filter(b => b?.focus_seconds != null && b?.goal_seconds > 0);
  if (valid.length < windowSize) return null;

  const labels = [];
  const rates = [];
  for (let i = windowSize - 1; i < valid.length; i++) {
    const window = valid.slice(i - windowSize + 1, i + 1);
    const wins = window.filter(b => b.focus_seconds >= b.goal_seconds).length;
    rates.push(Math.round(wins / windowSize * 100));
    labels.push(String(i + 1));
  }

  activeChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Win rate", data: rates,
        borderColor: C.goal, backgroundColor: C.goalFill, fill: true,
        tension: 0.3, borderWidth: 2, pointRadius: 2, pointBackgroundColor: C.goal,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => `Hit rate: ${ctx.parsed.y}% (last ${windowSize})` } },
      },
      scales: {
        y: { min: 0, max: 100, ticks: { callback: v => `${v}%`, color: C.text, font: { size: 11 } }, grid: { color: C.grid } },
        x: { title: { display: true, text: "Session", color: C.text, font: { size: 11 } }, ticks: { color: C.text, font: { size: 10 }, maxTicksLimit: 15 }, grid: { display: false } },
      },
    },
  });
  return activeChart;
}

// ═══════════════════════════════════════
// Tab: Distribution (histogram of focus times)
// ═══════════════════════════════════════
export function drawDistribution(ctx, blocks, plan) {
  destroy();
  const vals = blocks.map(b => Number(b.focus_seconds)).filter(x => x > 0);
  if (vals.length < 3) return null;

  const binWidth = 120; // 2-minute bins
  const maxVal = Math.max(...vals);
  const numBins = Math.min(25, Math.max(5, Math.ceil(maxVal / binWidth)));
  const bins = Array(numBins).fill(0);
  const binLabels = [];

  for (let i = 0; i < numBins; i++) {
    binLabels.push(`${Math.round(i * binWidth / 60)}m`);
  }
  for (const v of vals) {
    const idx = Math.min(numBins - 1, Math.floor(v / binWidth));
    bins[idx]++;
  }

  const floorSec = plan?.floor_sec || 0;
  const goalSec = plan?.goal_sec || 0;

  const barColors = bins.map((_, i) => {
    const binCenter = (i + 0.5) * binWidth;
    if (floorSec > 0 && binCenter < floorSec * 0.8) return C.crash;
    if (goalSec > 0 && binCenter >= goalSec) return C.win;
    return C.bar;
  });

  activeChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: binLabels,
      datasets: [{
        label: "Sessions", data: bins,
        backgroundColor: barColors, borderRadius: 4,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => {
              const i = items[0]?.dataIndex ?? 0;
              return `${Math.round(i * binWidth / 60)}–${Math.round((i + 1) * binWidth / 60)} min`;
            },
            label: (tip) => `${tip.parsed.y} session${tip.parsed.y !== 1 ? "s" : ""}`,
          },
        },
      },
      scales: {
        y: { beginAtZero: true, ticks: { stepSize: 1, color: C.text, font: { size: 11 } }, grid: { color: C.grid }, title: { display: true, text: "Sessions", color: C.text, font: { size: 11 } } },
        x: { ticks: { color: C.text, font: { size: 10 }, maxTicksLimit: 12 }, grid: { display: false }, title: { display: true, text: "Focus duration", color: C.text, font: { size: 11 } } },
      },
    },
  });
  return activeChart;
}

export function destroyChart() { destroy(); }

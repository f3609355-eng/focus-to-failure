import { fmtHHMMSS } from "./utils.js";

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
};

let activeChart = null;

function destroy() {
  if (activeChart) { activeChart.destroy(); activeChart = null; }
}

function minLabel(sec) {
  return `${Math.round(sec / 60)}m`;
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
          label: "Focus",
          data: focus,
          borderColor: C.focus,
          backgroundColor: C.focusFill,
          fill: true,
          tension: 0.3,
          borderWidth: 2.5,
          pointRadius: 3,
          pointBackgroundColor: C.focus,
          order: 1,
        },
        {
          label: "Goal",
          data: goals,
          borderColor: C.goal,
          backgroundColor: "transparent",
          borderDash: [6, 3],
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.1,
          order: 2,
        },
        {
          label: "Floor",
          data: floors,
          borderColor: C.floor,
          backgroundColor: "transparent",
          borderDash: [3, 3],
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.1,
          order: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          display: true,
          position: "bottom",
          labels: { boxWidth: 14, padding: 12, font: { size: 11 }, usePointStyle: true },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y}m`,
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { callback: v => `${Math.round(v)}m`, color: C.text, font: { size: 11 } },
          grid: { color: C.grid },
        },
        x: {
          title: { display: true, text: "Session", color: C.text, font: { size: 11 } },
          ticks: { color: C.text, font: { size: 10 }, maxTicksLimit: 15 },
          grid: { display: false },
        },
      },
    },
  });
  return activeChart;
}

// ═══════════════════════════════════════
// Tab: Today (bar chart of today's blocks)
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

  const labels = todays.map((_, i) => `Block ${i + 1}`);
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
        {
          label: "Focus",
          data: focus,
          backgroundColor: colors,
          borderRadius: 6,
          order: 2,
        },
        {
          label: "Goal",
          data: goalLine,
          type: "line",
          borderColor: C.goal,
          borderDash: [6, 3],
          borderWidth: 1.5,
          pointRadius: 3,
          pointBackgroundColor: C.goal,
          fill: false,
          order: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          position: "bottom",
          labels: { boxWidth: 14, padding: 12, font: { size: 11 }, usePointStyle: true },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y}m`,
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { callback: v => `${Math.round(v)}m`, color: C.text, font: { size: 11 } },
          grid: { color: C.grid },
        },
        x: {
          ticks: { color: C.text, font: { size: 11 } },
          grid: { display: false },
        },
      },
    },
  });
  return activeChart;
}

// ═══════════════════════════════════════
// Tab: Time of Day (bucket averages)
// ═══════════════════════════════════════
export function drawBuckets(ctx, blocks) {
  destroy();
  const buckets = ["Morning", "Afternoon", "Evening", "Night"];
  const sums = {};
  const cnts = {};
  for (const k of buckets) { sums[k] = 0; cnts[k] = 0; }

  for (const b of blocks) {
    if (b.bucket && sums[b.bucket] !== undefined && b.focus_seconds > 0) {
      sums[b.bucket] += b.focus_seconds;
      cnts[b.bucket] += 1;
    }
  }

  const bars = buckets.map(k => cnts[k] ? Math.round(sums[k] / cnts[k] / 60 * 10) / 10 : 0);
  const counts = buckets.map(k => cnts[k]);
  const hasData = bars.some(v => v > 0);
  if (!hasData) return null;

  activeChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: buckets,
      datasets: [{
        label: "Avg focus",
        data: bars,
        backgroundColor: [
          "rgba(251,191,36,0.5)",  // Morning - amber
          "rgba(37,99,235,0.5)",   // Afternoon - blue
          "rgba(168,85,247,0.5)",  // Evening - purple
          "rgba(100,116,139,0.5)", // Night - slate
        ],
        borderRadius: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const i = ctx.dataIndex;
              return `Avg: ${ctx.parsed.y}m (${counts[i]} sessions)`;
            },
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { callback: v => `${Math.round(v)}m`, color: C.text, font: { size: 11 } },
          grid: { color: C.grid },
        },
        x: {
          ticks: { color: C.text, font: { size: 11 } },
          grid: { display: false },
        },
      },
    },
  });
  return activeChart;
}

// ═══════════════════════════════════════
// Tab: Consistency (win rate over time)
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
        label: "Win rate",
        data: rates,
        borderColor: C.goal,
        backgroundColor: C.goalFill,
        fill: true,
        tension: 0.3,
        borderWidth: 2,
        pointRadius: 2,
        pointBackgroundColor: C.goal,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `Hit rate: ${ctx.parsed.y}% (last ${windowSize})`,
          },
        },
      },
      scales: {
        y: {
          min: 0,
          max: 100,
          ticks: { callback: v => `${v}%`, color: C.text, font: { size: 11 } },
          grid: { color: C.grid },
        },
        x: {
          title: { display: true, text: "Session", color: C.text, font: { size: 11 } },
          ticks: { color: C.text, font: { size: 10 }, maxTicksLimit: 15 },
          grid: { display: false },
        },
      },
    },
  });
  return activeChart;
}

export function destroyChart() { destroy(); }

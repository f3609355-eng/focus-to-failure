import { DEFAULT_CONFIG, deepCopy, deepMerge } from "./config.js";
import { getAllBlocks, putBlock, bulkPut, clearAll, getConfig, setConfig, clearConfig, exportBackup, importBackup, clearTrainingState, clearPrefs } from "./storage.js";
import { fmtHHMMSS, fmtMin, nowTimestamp, bucketForDate, downloadText, escHTML } from "./utils.js";
import { computeMetrics } from "./analytics.js";
import { blendMetrics } from "./engine/blendEngine.js";
import { WavePlanner, Phase, BlockType } from "./planner.js";
import { drawProgress, drawToday, drawBuckets, drawConsistency, destroyChart } from "./charts.js";

// ════════════════════════════════════════════════
// DOM Helpers
// ════════════════════════════════════════════════

const $ = (id) => document.getElementById(id);

// ════════════════════════════════════════════════
// State
// ════════════════════════════════════════════════

let cfg = deepCopy(DEFAULT_CONFIG);
const savedCfg = getConfig();
if (savedCfg) deepMerge(cfg, savedCfg);

// Migrate old ui_scale format (raw CSS value like 1.35) → new format (1.0 = default)
if (savedCfg?.window?.ui_scale != null && !localStorage.getItem("ftf_scale_v2")) {
  cfg.window.ui_scale = Math.round((cfg.window.ui_scale / 1.35) * 100) / 100;
  setConfig(cfg);
}
localStorage.setItem("ftf_scale_v2", "1");

let cached = { m:null, plan:null, bucketNow:null };
let planComputeCount = 0;
let focusStartSnapshot = { m:null, plan:null, goalSec:0 };
let blocks = [];
let planner = new WavePlanner(cfg);

let mode = "FOCUS";      // FOCUS | BREAK
let running = false;
let startTS = null;
let elapsed = 0;
let breakTotal = 0;
let tickHandle = null;
let goalHitDuringFocus = false;
let goalHitAt = null;

let activeTab = "progress";
let settingsWired = false;

// ════════════════════════════════════════════════
// Config Persistence
// ════════════════════════════════════════════════

function persistConfig() {
  setConfig(cfg);
  planner.setConfig(cfg);
}

// ════════════════════════════════════════════════
// Break Computation
// ════════════════════════════════════════════════

function computeBreakSeconds(focusSeconds, crash = false, overshoot = false, isPush = false) {
  const b = cfg.breaks;
  const base = Math.max(0, focusSeconds) * (b.break_percent / 100);

  let mult = 1.0;
  if (crash)     mult *= b.crash_break_multiplier;
  if (overshoot) mult *= b.overshoot_break_multiplier;
  if (isPush)    mult *= b.push_break_multiplier;

  let sec = Math.round(base * mult);
  sec = Math.max(b.min_break_seconds, sec);
  if (b.max_break_minutes > 0) sec = Math.min(b.max_break_minutes * 60, sec);
  return sec;
}

// ════════════════════════════════════════════════
// UI Scale
// ════════════════════════════════════════════════

// UI scale: slider value 1.0 = default look. Actual CSS = slider × 1.35
const UI_SCALE_BASE = 1.35;

function applyUIScale() {
  const actual = cfg.window.ui_scale * UI_SCALE_BASE;
  document.documentElement.style.setProperty("--ui-scale", String(actual));
  $("uiScaleVal").textContent = `${cfg.window.ui_scale.toFixed(2)}×`;
  $("uiScale").value = cfg.window.ui_scale;
  setTimeout(() => {
    try { redrawCharts(); } catch {}
  }, 60);
}

// ════════════════════════════════════════════════
// Advanced Toggle
// ════════════════════════════════════════════════

function loadAdvancedFlag() {
  const on = localStorage.getItem("ftf_advanced") === "1";
  document.body.classList.toggle("advanced", on);
  document.body.classList.toggle("simple", !on);
  $("advancedToggle").checked = on;
}

function setAdvancedFlag(on) {
  localStorage.setItem("ftf_advanced", on ? "1" : "0");
  loadAdvancedFlag();
  syncHeader();
  // Resize charts that may have just become visible
  setTimeout(() => {
    redrawCharts();
  }, 60);
}

// ════════════════════════════════════════════════
// Settings ↔ UI Sync
// ════════════════════════════════════════════════

function setSettingsControlsFromCfg() {
  const b = cfg.breaks;
  const w = cfg.wave;
  const d = cfg.debug;

  $("breakPercent").value = b.break_percent;
  $("breakPercentVal").textContent = `${Math.round(b.break_percent)}%`;
  $("maxBreakMin").value = b.max_break_minutes;
  $("minBreakSec").value = b.min_break_seconds;

  $("crashMult").value = b.crash_break_multiplier;
  $("crashMultVal").textContent = `${b.crash_break_multiplier.toFixed(2)}×`;
  $("overMult").value = b.overshoot_break_multiplier;
  $("overMultVal").textContent = `${b.overshoot_break_multiplier.toFixed(2)}×`;
  $("pushMult").value = b.push_break_multiplier;
  $("pushMultVal").textContent = `${b.push_break_multiplier.toFixed(2)}×`;

  $("autoStartFocusMain").checked = b.auto_start_next_focus;

  $("waveVisibility").value = w.wave_visibility;
  $("floorIncSec").value = w.floor_raise_increment_seconds;
  $("floorStreak").value = w.floor_raise_clean_streak;

  $("pushA").value = w.push_a_pct_of_median;
  $("pushAVal").textContent = `${Math.round(w.push_a_pct_of_median * 100)}%`;
  $("pushB").value = w.push_b_pct_of_median;
  $("pushBVal").textContent = `${Math.round(w.push_b_pct_of_median * 100)}%`;

  $("uiScale").value = cfg.window.ui_scale;
  $("uiScaleVal").textContent = `${cfg.window.ui_scale.toFixed(2)}×`;

  if ($("goalOverrideEnabled")) $("goalOverrideEnabled").checked = !!d.goal_override_enabled;
  if ($("goalOverrideMin")) $("goalOverrideMin").value = d.goal_override_minutes;
}

// ════════════════════════════════════════════════
// Intensity Presets
// ════════════════════════════════════════════════

function applyIntensityPreset(preset) {
  if (preset === "Easy") {
    Object.assign(cfg.breaks, { break_percent: 30, crash_break_multiplier: 1.7, overshoot_break_multiplier: 1.25 });
    Object.assign(cfg.wave, { push_a_pct_of_median: 0.10, push_b_pct_of_median: 0.06, floor_raise_clean_streak: 7 });
  } else if (preset === "Hard") {
    Object.assign(cfg.breaks, { break_percent: 20, crash_break_multiplier: 1.35, overshoot_break_multiplier: 1.15 });
    Object.assign(cfg.wave, { push_a_pct_of_median: 0.14, push_b_pct_of_median: 0.10, floor_raise_clean_streak: 5 });
  } else {
    Object.assign(cfg.breaks, { break_percent: 25, crash_break_multiplier: 1.5, overshoot_break_multiplier: 1.2 });
    Object.assign(cfg.wave, { push_a_pct_of_median: 0.12, push_b_pct_of_median: 0.08, floor_raise_clean_streak: 5 });
  }
  persistConfig();
  setSettingsControlsFromCfg();
  applyUIScale();
  syncHeader();
}

// ════════════════════════════════════════════════
// Planner Bridge
// ════════════════════════════════════════════════

function planNow() {
  planComputeCount++;
  const bucketNow = bucketForDate(new Date());
  const bucketBlocks = blocks.filter((b) => b && b.bucket === bucketNow);

  const mGlobal = computeMetrics(blocks, cfg);
  const mBucket = computeMetrics(bucketBlocks, cfg);

  // Soft bucket blending (shared)
const bucketN = bucketBlocks.length;
const mBlend = blendMetrics(mGlobal, mBucket, bucketN, cfg);

// Back-compat fields expected by planner/ui
const m = {
  ...mBlend,
  floor_global: mBlend.floor_global,
  floor_bucket: mBlend.floor_bucket,
  median_global: mBlend.median_global,
  median_bucket: mBlend.median_bucket,
  ceiling_global: mBlend.ceiling_global,
  ceiling_bucket: mBlend.ceiling_bucket,
  floor_effective: mBlend.floor,
  median_effective: mBlend.median,
  ceiling_effective: mBlend.ceiling,
  bucket_weight: mBlend.bucket_weight,
  bucket_n: mBlend.bucket_n,
  recent_iqr: mBlend.recent_iqr,
  recent_n: mBlend.recent_n,
  recent_crashes: mBlend.recent_crashes,
  recent_overshoots_7: mBlend.recent_overshoots_7,
};


  const plan = planner.planNext(blocks, m, { bucket: bucketNow, bucketBlocks });

  // Manual goal override (debug)
  if (cfg.debug.goal_override_enabled) {
    const min = Number(cfg.debug.goal_override_minutes || 0);
    if (Number.isFinite(min) && min > 0) {
      plan.goal_sec = Math.round(min * 60);
      plan.debug = plan.debug || {};
      plan.debug.goal_override_minutes = min;
    }
  }

  // Attach useful planning context for UI/debug panels
  plan.debug = plan.debug || {};
  plan.debug.bucket = bucketNow;
  plan.debug.bucket_n = mBlend.bucket_n;
  plan.debug.bucket_weight = mBlend.bucket_weight;
  plan.debug.floor_global = mGlobal.floor;
  plan.debug.floor_bucket = mBucket.floor;

  return { m, plan };
}

// ════════════════════════════════════════════════
// Today Stats
// ════════════════════════════════════════════════

function todayStats() {
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayEnd = dayStart + 86400000;

  const todays = blocks.filter((b) => {
    const t = Date.parse((b.timestamp || "").replace(" ", "T"));
    return !Number.isNaN(t) && t >= dayStart && t < dayEnd;
  });

  const vals = todays.map((b) => Number(b.focus_seconds)).filter((x) => x > 0);
  if (!vals.length) return { count: 0, best: null, avg: null };

  return {
    count: vals.length,
    best: Math.max(...vals),
    avg: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length),
  };
}


function ensureCached() {
  if (!cached.plan || !cached.m) {
    cached = planNow(); // compute once
  }
  return cached;
}

function prettyPhase(p) {
  const s = String(p || "").toUpperCase();
  if (!s) return "--";
  if (s === "LINEAR") return "Building";
  if (s.startsWith("WAVE")) return "Wave";
  return s.charAt(0) + s.slice(1).toLowerCase();
}

function friendlyBlockType(bt) {
  if (!bt) return "";
  if (bt === "CONSOLIDATE") return "Consolidation";
  if (bt === "PUSH_A" || bt === "PUSH_B") return "Stretch";
  if (bt === "RAISE_FLOOR") return "Floor raise";
  return bt;
}

function statusMessage(plan, m, blockCount) {
  // First-run
  if (blockCount === 0) {
    return { text: "Press Start Focus and concentrate until you can't. The app will learn your rhythm.", tone: "" };
  }

  // During calibration (< 3 blocks)
  if (blockCount < 3) {
    return { text: `Calibrating — ${3 - blockCount} more sessions to establish your baseline.`, tone: "calm" };
  }

  const mode = plan.debug?.mode || plan.phase;
  const bt = plan.block_type;

  if (mode === "BOOT") {
    return { text: "Warming up — complete a few more sessions for the algorithm to dial in.", tone: "calm" };
  }

  if (plan.phase === "LINEAR") {
    const bumped = plan.debug?.bumped;
    if (bumped) {
      return { text: `Goal raised to ${fmtHHMMSS(plan.goal_sec)}. You've been consistent — keep it up.`, tone: "good" };
    }
    return { text: `Building your baseline. Goal adapts as you improve.`, tone: "calm" };
  }

  if (plan.phase === "WAVE") {
    if (plan.debug?.mode === "WAVE_EASY") {
      return { text: "Recovery block — easy target to stabilize after a tough stretch.", tone: "warn" };
    }
    if (bt === "PUSH_A" || bt === "PUSH_B") {
      return { text: `Stretch block — aim for ${fmtHHMMSS(plan.push_target || plan.goal_sec)}. It's okay to fall short.`, tone: "" };
    }
    return { text: "Consolidation — land inside your comfort zone to build your streak.", tone: "calm" };
  }

  return { text: "Ready when you are.", tone: "calm" };
}

// ════════════════════════════════════════════════
// Sync UI
// ════════════════════════════════════════════════

function syncTodayCard() {
  const s = todayStats();
  $("todayCount").textContent = String(s.count || 0);
  $("todayBest").textContent = s.best == null ? "--" : fmtHHMMSS(s.best);
  const { m, plan } = ensureCached();
  $("statFloor").textContent = plan.floor_sec > 0 ? fmtMin(plan.floor_sec) : "--";
  $("todayGoal").textContent = fmtHHMMSS(plan.goal_sec || 0);
}

function syncHeader() {
  const { m, plan } = ensureCached();

  // Mode badge
  const modeEl = $("modeLabel");
  modeEl.textContent = mode;
  modeEl.setAttribute("data-mode", mode);
  document.body.setAttribute("data-mode", mode);

  // Goal hit visual feedback
  document.body.classList.toggle("goal-hit", goalHitDuringFocus && mode === "FOCUS");

  $("timerLabel").textContent = fmtHHMMSS(elapsed);
  $("targetsLabel").textContent = `Goal: ${fmtHHMMSS(plan.goal_sec || 0)}`;

  // Phase badge: show phase + block type
  const phaseTxt = prettyPhase(plan.phase);
  const btTxt = friendlyBlockType(plan.block_type);
  $("phaseLabel").textContent = btTxt ? `${phaseTxt} · ${btTxt}` : phaseTxt;

  // Metrics line
  const adv = document.body.classList.contains("advanced");
  const metricsEl = $("metricsLabel");
  if (metricsEl) {
    if (!adv) {
      const f = plan.floor_sec > 0 ? fmtMin(plan.floor_sec) : "--";
      const med = m.median == null ? "--" : fmtMin(m.median);
      metricsEl.textContent = `Floor: ${f} · Typical: ${med}`;
    } else {
      metricsEl.textContent =
        `F/M/C: ${fmtMin(m.floor)} / ${fmtMin(m.median)} / ${fmtMin(m.ceiling)} | ` +
        `IQR: ${fmtMin(m.recent_iqr)} | Crashes: ${m.recent_crashes}/${Math.max(1, m.recent_n)}`;
    }
    metricsEl.style.display = (m.floor != null || plan.floor_sec > 0) ? "" : "none";
  }

  // Button states
  const timerActive = startTS != null;
  const focusStarted = mode === "FOCUS" && timerActive;
  $("pauseBtn").disabled = !timerActive;
  $("distractedBtn").disabled = !focusStarted;
  $("endBreakBtn").disabled = !(mode === "BREAK" && timerActive);

  try { syncTodayCard(); } catch {}

  // Status bar — only update when timer is NOT running (avoid overwriting focus/break messages)
  if (startTS == null) {
    const sm = statusMessage(plan, m, blocks.length);
    const el = $("statusLabel");
    el.textContent = sm.text;
    el.className = "status-bar" + (sm.tone ? ` status-${sm.tone}` : "");
  }

  // Debug panel
  try {
    const dbg = plan.debug || {};
    const lines = Object.entries(dbg).map(([k, v]) => {
      const vv = typeof v === "number" ? Math.round(v * 1000) / 1000 : v;
      return `${k}: ${vv}`;
    });
    lines.push(`goal_sec: ${plan.goal_sec}`, `min_goal_sec: ${plan.min_goal_sec}`, `floor_sec: ${plan.floor_sec}`);
    lines.push(`phase: ${plan.phase}`, `block_type: ${plan.block_type}`, `push_target: ${plan.push_target}`);
    $("debugText").textContent = lines.join("\n");
  } catch {}
}

// ════════════════════════════════════════════════
// Charts
// ════════════════════════════════════════════════

function redrawCharts() {
  try {
    const chartWrap = $("chartWrap");
    const emptyEl = $("chartEmpty");
    const histWrap = $("historyWrap");
    const canvas = $("mainChart");
    if (!canvas) return;

    // Show/hide based on tab
    const isHistory = activeTab === "history";
    chartWrap.classList.toggle("hidden", isHistory);
    emptyEl.classList.add("hidden");
    histWrap.classList.toggle("hidden", !isHistory);

    if (isHistory) {
      destroyChart();
      return;
    }

    const ctx = canvas.getContext("2d");
    const maxN = Number(cfg.wave.trend_points || 30);
    let chart = null;

    if (activeTab === "progress") {
      chart = drawProgress(ctx, blocks, maxN);
    } else if (activeTab === "today") {
      chart = drawToday(ctx, blocks);
    } else if (activeTab === "buckets") {
      chart = drawBuckets(ctx, blocks);
    } else if (activeTab === "consistency") {
      chart = drawConsistency(ctx, blocks);
    }

    // Show empty state if no data for this tab
    if (!chart) {
      chartWrap.classList.add("hidden");
      emptyEl.classList.remove("hidden");
    }
  } catch (e) {
    console.warn("redrawCharts failed", e);
  }
}

// ════════════════════════════════════════════════
// History Table
// ════════════════════════════════════════════════

function yesNo(v) { return v ? "Yes" : "No"; }

function rowHTML(b) {
  const focus = fmtHHMMSS(Number(b.focus_seconds || 0));
  const brk   = fmtHHMMSS(Number(b.break_seconds || 0));
  const tl    = fmtHHMMSS(Number(b.target_low_seconds || 0));
  const th    = fmtHHMMSS(Number(b.target_high_seconds || 0));
  const push  = b.push_target_seconds ? fmtHHMMSS(Number(b.push_target_seconds)) : "--";
  return `<tr>
    <td>${escHTML(b.idx)}</td>
    <td>${escHTML(b.phase || "--")}</td>
    <td>${escHTML(b.block_type || "--")}</td>
    <td>${focus}</td><td>${brk}</td>
    <td>${tl}</td><td>${th}</td><td>${push}</td>
    <td>${yesNo(b.crash)}</td>
    <td>${b.overshoot ? fmtHHMMSS(Number(b.overshoot)) : "--"}</td>
    <td>${escHTML(b.stop_reason || "--")}</td>
    <td>${escHTML(b.bucket || "--")}</td>
    <td>${escHTML(b.timestamp || "--")}</td>
  </tr>`;
}

function renderTable() {
  $("historyBody").innerHTML = blocks.map(rowHTML).join("");
}

// ════════════════════════════════════════════════
// Timer Core
// ════════════════════════════════════════════════

function cancelTick() {
  if (tickHandle) { clearInterval(tickHandle); tickHandle = null; }
}

function tick() {
  if (!running || startTS == null) return;
  const now = performance.now();

  if (mode === "FOCUS") {
    elapsed = Math.floor((now - startTS) / 1000);
    const goalSec = Number(focusStartSnapshot.goalSec || 0);
    if (goalSec > 0 && !goalHitDuringFocus && elapsed >= goalSec) {
      goalHitDuringFocus = true;
      goalHitAt = elapsed;
      syncHeader(); // update visual state immediately
    }
  } else {
    const rem = breakTotal - Math.floor((now - startTS) / 1000);
    elapsed = Math.max(0, rem);
    if (elapsed <= 0) { finishBreak(); return; }
  }
  $("timerLabel").textContent = fmtHHMMSS(elapsed);
}

function startFocus() {
  cancelTick();
  cached = planNow();
  focusStartSnapshot = { m: cached.m, plan: cached.plan, goalSec: Number(cached.plan?.goal_sec || 0) };
  mode = "FOCUS";
  running = true;
  startTS = performance.now();
  elapsed = 0;
  goalHitDuringFocus = false;
  goalHitAt = null;
  $("pauseBtn").textContent = "Pause";
  $("statusLabel").textContent = "Focus running — stay with it until you can't.";
  $("statusLabel").className = "status-bar";
  syncHeader();
  tickHandle = setInterval(tick, 250);
}

function startBreak(seconds) {
  cancelTick();
  mode = "BREAK";
  running = true;
  breakTotal = Math.floor(seconds);
  elapsed = breakTotal;
  startTS = performance.now();
  $("pauseBtn").textContent = "Pause";
  $("statusLabel").textContent = "Break — rest your eyes and move around.";
  $("statusLabel").className = "status-bar status-calm";
  syncHeader();
  tickHandle = setInterval(tick, 250);
}

async function finalizeFocus(stopReason) {
  if (mode !== "FOCUS" || startTS == null) return;
  const focusSeconds = elapsed | 0;
  if (focusSeconds <= 0) return;

  cancelTick();
  running = false;

  const { m, plan } = ensureCached();
  const crash = m.crash_threshold != null && focusSeconds < m.crash_threshold;
  const overshoot = m.overshoot_threshold != null && focusSeconds > m.overshoot_threshold;
  const isPush = plan.block_type === BlockType.PUSH_A || plan.block_type === BlockType.PUSH_B;
  const pushTarget = isPush ? plan.push_target : 0;
  const pushHit = isPush ? focusSeconds >= pushTarget : false;
  const breakSeconds = computeBreakSeconds(focusSeconds, crash, overshoot, isPush);
  const goalSec = Number(plan.goal_sec || 0);
  const isWin = goalSec > 0 && focusSeconds >= goalSec;

  const idx = blocks.length ? Math.max(...blocks.map((b) => b.idx)) + 1 : 1;
  const block = {
    idx,
    goal_seconds: goalSec,
    min_goal_seconds: plan.min_goal_sec || 0,
    floor_seconds: plan.floor_sec || 0,
    floor_global_seconds: m.floor_global || null,
    floor_bucket_seconds: m.floor_bucket || null,
    floor_effective_seconds: m.floor || null,
    bucket_weight: m.bucket_weight || 0,
    bucket_n: m.bucket_n || 0,
    median_global_seconds: m.median_global || null,
    median_bucket_seconds: m.median_bucket || null,
    median_effective_seconds: m.median || null,
    ceiling_global_seconds: m.ceiling_global || null,
    ceiling_bucket_seconds: m.ceiling_bucket || null,
    ceiling_effective_seconds: m.ceiling || null,
    validity: 'valid',
    focus_seconds: focusSeconds,
    is_win: isWin,
    break_seconds: breakSeconds,
    timestamp: nowTimestamp(),
    bucket: bucketForDate(new Date()),
    phase: plan.phase,
    block_type: plan.block_type,
    target_low_seconds: plan.target_low,
    target_high_seconds: plan.target_high,
    push_target_seconds: pushTarget,
    push_hit: pushHit,
    crash,
    overshoot,
    stop_reason: stopReason,
    wave_cycle_id: plan.wave_cycle_id || 0,
    wave_cycle_pos: plan.wave_cycle_pos || 0,
  };

  blocks.push(block);
  await putBlock(block);
  planner.updateAfterBlock(block);

  renderTable();
  redrawCharts();
  syncHeader();

  if (isWin) showWinModal(focusSeconds, goalSec);

  startBreak(breakSeconds);
}

function endBreakEarly() {
  if (mode !== "BREAK" || startTS == null) return;
  cancelTick();
  running = false;
  startTS = null;
  elapsed = 0;
  mode = "FOCUS";
  syncHeader();

  if (cfg.breaks.auto_start_next_focus) {
    startFocus();
  } else {
    $("statusLabel").textContent = "Break ended early. Ready when you are.";
    $("statusLabel").className = "status-bar status-calm";
  }
}

function finishBreak() {
  cancelTick();
  running = false;
  startTS = null;
  elapsed = 0;
  syncHeader();

  if (cfg.breaks.auto_start_next_focus) {
    setTimeout(startFocus, 300);
  } else {
    $("statusLabel").textContent = "Break's over. Ready for the next one?";
    $("statusLabel").className = "status-bar status-calm";
  }
}

function togglePause() {
  if (startTS == null) return;
  if (running) {
    running = false;
    cancelTick();
    $("pauseBtn").textContent = "Resume";
    $("statusLabel").textContent = "Paused — press Resume or Space to continue.";
    $("statusLabel").className = "status-bar status-warn";
  } else {
    running = true;
    if (mode === "FOCUS") {
      startTS = performance.now() - elapsed * 1000;
    } else {
      startTS = performance.now() - Math.max(0, breakTotal - elapsed) * 1000;
    }
    $("pauseBtn").textContent = "Pause";
    tickHandle = setInterval(tick, 250);
  }
}

function resetTimer() {
  cancelTick();
  running = false;
  startTS = null;
  elapsed = 0;
  mode = "FOCUS";
  goalHitDuringFocus = false;
  goalHitAt = null;
  $("pauseBtn").textContent = "Pause";
  $("statusLabel").textContent = "Timer reset. Ready when you are.";
  $("statusLabel").className = "status-bar status-calm";
  syncHeader();
}

// ════════════════════════════════════════════════
// Win Modal & Confetti
// ════════════════════════════════════════════════

function computeWinStreak() {
  let streak = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]?.is_win) streak++;
    else break;
  }
  return streak;
}

function pickStickerEmoji() {
  const list = ["⭐", "🏅", "✨", "🧠", "🚀", "✅", "🔥", "🥇", "🏆", "🌱"];
  return list[Math.floor(Math.random() * list.length)];
}

function runConfetti() {
  const canvas = $("confettiCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  ctx.scale(dpr, dpr);

  const W = rect.width, H = rect.height;
  const colors = ["#2563eb", "#60a5fa", "#fbbf24", "#34d399", "#f472b6", "#a78bfa"];
  const N = 100;
  const pieces = Array.from({ length: N }, () => ({
    x: Math.random() * W,
    y: -20 - Math.random() * H,
    r: 3 + Math.random() * 5,
    vy: 2 + Math.random() * 3.5,
    vx: -2 + Math.random() * 4,
    rot: Math.random() * Math.PI,
    vr: -0.15 + Math.random() * 0.3,
    c: colors[Math.floor(Math.random() * colors.length)],
  }));

  const start = performance.now();
  const dur = 1500;

  function frame(t) {
    const dt = t - start;
    const fade = Math.max(0, 1 - dt / dur);
    ctx.clearRect(0, 0, W, H);
    for (const p of pieces) {
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      p.vy += 0.03;
      ctx.save();
      ctx.globalAlpha = 0.85 * fade;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.r / 2, -p.r / 2, p.r, p.r * 1.3);
      ctx.restore();
    }
    if (dt < dur) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function showWinModal(focusSec, goalSec) {
  const panel = $("winModal");
  if (!panel) return;

  const streak = computeWinStreak();
  if ($("stickerEmoji")) $("stickerEmoji").textContent = pickStickerEmoji();
  if ($("stickerStreak")) $("stickerStreak").textContent = `Streak: ${streak}`;
  if ($("winModalTitle")) $("winModalTitle").textContent = streak > 1 ? `${streak} in a row!` : "Nice. You earned a sticker.";
  if ($("winModalText")) $("winModalText").textContent = `You focused for ${fmtHHMMSS(focusSec)} — goal was ${fmtHHMMSS(goalSec)}.`;

  panel.classList.remove("hidden");
  runConfetti();
  $("winModalOk")?.focus();
}

function hideWinModal() {
  const panel = $("winModal");
  if (panel) panel.classList.add("hidden");
  const c = $("confettiCanvas");
  if (c) {
    const ctx = c.getContext("2d");
    ctx?.clearRect(0, 0, c.width, c.height);
  }
}

// ════════════════════════════════════════════════
// Settings Modal
// ════════════════════════════════════════════════

function openSettings() {
  $("modalBackdrop").classList.remove("hidden");
  $("settingsModal").classList.remove("hidden");
  document.body.classList.add("modal-open");
  setSettingsControlsFromCfg();
  loadAdvancedFlag();
}

function closeSettings() {
  $("modalBackdrop").classList.add("hidden");
  $("settingsModal").classList.add("hidden");
  document.body.classList.remove("modal-open");
}

// ════════════════════════════════════════════════
// Export / Import
// ════════════════════════════════════════════════

function exportCSV() {
  const cols = [
    "block", "phase", "block_type", "focus_seconds", "break_seconds",
    "target_low_seconds", "target_high_seconds", "push_target_seconds", "push_hit",
    "crash", "overshoot", "stop_reason", "bucket", "timestamp", "wave_cycle_id", "wave_cycle_pos",
  ];
  const lines = [cols.join(",")];
  for (const b of blocks) {
    lines.push([
      b.idx, b.phase, b.block_type, b.focus_seconds, b.break_seconds,
      b.target_low_seconds, b.target_high_seconds, b.push_target_seconds, b.push_hit ? 1 : 0,
      b.crash ? 1 : 0, b.overshoot ? 1 : 0, b.stop_reason, b.bucket,
      b.timestamp, b.wave_cycle_id, b.wave_cycle_pos,
    ].join(","));
  }
  downloadText(`focus_to_failure_${Date.now()}.csv`, lines.join("\n"));
}

function exportJSONL() {
  downloadText(
    `focus_to_failure_${Date.now()}.jsonl`,
    blocks.map((b) => JSON.stringify(b)).join("\n") + "\n"
  );
}

async function importJSONLText(text) {
  const lines = text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const imported = [];
  for (const line of lines) {
    try { imported.push(JSON.parse(line)); } catch {}
  }
  if (!imported.length) return;

  const maxIdx = blocks.length ? Math.max(...blocks.map((b) => b.idx)) : 0;
  const used = new Set(blocks.map((b) => b.idx));
  let shift = maxIdx;

  for (const b of imported) {
    b.idx = Number(b.idx ?? 0) || 0;
    if (b.idx <= 0 || used.has(b.idx)) {
      shift += 1;
      b.idx = shift;
    }
    b.focus_seconds = Number(b.focus_seconds ?? 0);
    b.break_seconds = Number(b.break_seconds ?? 0);
    b.timestamp = String(b.timestamp ?? nowTimestamp());
    b.bucket = String(b.bucket ?? "Unknown");
  }

  blocks = blocks.concat(imported).sort((a, b) => a.idx - b.idx);
  await bulkPut(blocks);

  planner = new WavePlanner(cfg);
  for (const b of blocks) planner.updateAfterBlock(b);

  renderTable();
  redrawCharts();
  syncHeader();
  $("statusLabel").textContent = `Imported ${imported.length} blocks.`;
}

async function clearAllData() {
  if (!confirm("Delete ALL saved history in this browser?")) return;
  blocks = [];
  await clearAll();
  planner = new WavePlanner(cfg);
  renderTable();
  redrawCharts();
  syncHeader();
  $("statusLabel").textContent = "Cleared all history.";
}

function resetSettingsToDefault() {
  if (!confirm("Reset ALL settings to default values?")) return;
  cfg = deepCopy(DEFAULT_CONFIG);
  planner = new WavePlanner(cfg);
  localStorage.setItem("ftf_intensity", "Balanced");
  $("intensityPreset").value = "Balanced";
  persistConfig();
  setSettingsControlsFromCfg();
  applyUIScale();
  syncHeader();
  $("statusLabel").textContent = "Settings reset to default.";
}

function exportSettings() {
  const settingsExport = {
    _type: "ftf_settings_v1",
    _exported: nowTimestamp(),
    config: cfg,
    intensity: localStorage.getItem("ftf_intensity") || "Balanced",
    advanced: localStorage.getItem("ftf_advanced") || "0",
  };
  downloadText(
    `ftf_settings_${Date.now()}.json`,
    JSON.stringify(settingsExport, null, 2)
  );
  $("statusLabel").textContent = "Settings exported.";
}

async function exportBackupFile(){
  try {
    const payload = await exportBackup();
    const out = {
      _type: "ftf_backup_v1",
      _exported: nowTimestamp(),
      ...payload
    };
    downloadText(`ftf_backup_${Date.now()}.json`, JSON.stringify(out, null, 2));
    $("statusLabel").textContent = "Backup exported.";
  } catch (e){
    console.error(e);
    alert("Failed to export backup. See console for details.");
  }
}

async function importBackupFile(file){
  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    // Basic guard
    if (!payload || payload._type !== "ftf_backup_v1") {
      if (!confirm("This file does not look like a Focus to Failure backup. Try importing anyway?")) return;
    }
    if (!confirm("Importing a backup will overwrite your current history and settings. Continue?")) return;
    await importBackup(payload, { overwrite: true });
    alert("Backup imported. The page will now reload.");
    location.reload();
  } catch (e){
    console.error(e);
    alert("Failed to import backup. Make sure you selected a valid .json backup file.");
  }
}

async function resetApp(){
  if (!confirm("Reset the entire app? This clears history, settings, and training state.")) return;
  await clearAll();
  clearConfig();
  clearTrainingState();
  clearPrefs();
  alert("App reset. The page will now reload.");
  location.reload();
}


async function importSettings(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);

    if (!data.config) {
      $("statusLabel").textContent = "Invalid settings file — no config found.";
      return;
    }

    cfg = deepCopy(DEFAULT_CONFIG);
    deepMerge(cfg, data.config);
    persistConfig();

    if (data.intensity) {
      localStorage.setItem("ftf_intensity", data.intensity);
      $("intensityPreset").value = data.intensity;
    }
    if (data.advanced != null) {
      localStorage.setItem("ftf_advanced", data.advanced);
      loadAdvancedFlag();
    }

    planner = new WavePlanner(cfg);
    for (const b of blocks) planner.updateAfterBlock(b);

    setSettingsControlsFromCfg();
    applyUIScale();
    syncHeader();
    $("statusLabel").textContent = "Settings imported successfully.";
  } catch (e) {
    console.warn("Settings import failed", e);
    $("statusLabel").textContent = "Failed to import settings — invalid file.";
  }
}

// ════════════════════════════════════════════════
// Wire Events
// ════════════════════════════════════════════════

function wireMainButtons() {
  $("startFocusBtn").addEventListener("click", startFocus);
  $("pauseBtn").addEventListener("click", togglePause);
  $("endBreakBtn").addEventListener("click", endBreakEarly);
  $("distractedBtn").addEventListener("click", () => finalizeFocus("DISTRACTED"));
  $("resetBtn").addEventListener("click", resetTimer);

  $("openSettingsBtn").addEventListener("click", openSettings);
  $("closeSettingsBtn").addEventListener("click", closeSettings);
  $("modalBackdrop").addEventListener("click", closeSettings);

  // Win modal
  $("winModalOk")?.addEventListener("click", hideWinModal);
  $("winModal")?.addEventListener("click", (e) => { if (e.target?.id === "winModal") hideWinModal(); });

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("winModal")?.classList.contains("hidden")) { hideWinModal(); return; }
      if (!$("settingsModal")?.classList.contains("hidden")) { closeSettings(); return; }
    }
    // Space to start/pause (only when not typing)
    if (e.key === " " && !["INPUT", "TEXTAREA", "SELECT"].includes(e.target?.tagName)) {
      e.preventDefault();
      if (startTS == null) startFocus();
      else togglePause();
    }
  });

  // Stats toggle
  const statsBtn = $("statsToggleBtn");
  if (statsBtn) {
    statsBtn.addEventListener("click", () => {
      const isHidden = document.body.classList.toggle("stats-hidden");
      statsBtn.title = isHidden ? "Show stats" : "Hide stats";
      if (!isHidden) {
        setTimeout(() => { redrawCharts(); }, 60);
      }
    });
  }

  // Chart tab switching
  const tabBar = $("chartTabs");
  if (tabBar) {
    tabBar.addEventListener("click", (e) => {
      const btn = e.target.closest(".chart-tab");
      if (!btn) return;
      const tab = btn.dataset.tab;
      if (!tab || tab === activeTab) return;
      activeTab = tab;
      tabBar.querySelectorAll(".chart-tab").forEach(t => t.classList.remove("active"));
      btn.classList.add("active");
      redrawCharts();
    });
  }

  // Debug toggle
  const dbgBtn = $("debugToggleBtn");
  if (dbgBtn) {
    dbgBtn.addEventListener("click", () => {
      const p = $("debugPanel");
      if (!p) return;
      p.classList.toggle("hidden");
      dbgBtn.title = p.classList.contains("hidden") ? "Debug" : "Hide debug";
      try { syncHeader(); } catch {}
    });
  }
}

function wireSettings() {
  setSettingsControlsFromCfg();
  if (settingsWired) return;
  settingsWired = true;

  // Intensity preset
  const presetSaved = localStorage.getItem("ftf_intensity") || "Balanced";
  $("intensityPreset").value = presetSaved;
  $("intensityPreset").addEventListener("change", () => {
    const p = $("intensityPreset").value;
    localStorage.setItem("ftf_intensity", p);
    applyIntensityPreset(p);
  });

  // Advanced toggle
  $("advancedToggle").addEventListener("change", () => setAdvancedFlag($("advancedToggle").checked));

  // Break settings
  $("breakPercent").addEventListener("input", () => {
    cfg.breaks.break_percent = Number($("breakPercent").value);
    $("breakPercentVal").textContent = `${Math.round(cfg.breaks.break_percent)}%`;
    persistConfig();
  });
  $("maxBreakMin").addEventListener("change", () => { cfg.breaks.max_break_minutes = Number($("maxBreakMin").value); persistConfig(); });
  $("minBreakSec").addEventListener("change", () => { cfg.breaks.min_break_seconds = Number($("minBreakSec").value); persistConfig(); });

  $("crashMult").addEventListener("input", () => {
    cfg.breaks.crash_break_multiplier = Number($("crashMult").value);
    $("crashMultVal").textContent = `${cfg.breaks.crash_break_multiplier.toFixed(2)}×`;
    persistConfig();
  });
  $("overMult").addEventListener("input", () => {
    cfg.breaks.overshoot_break_multiplier = Number($("overMult").value);
    $("overMultVal").textContent = `${cfg.breaks.overshoot_break_multiplier.toFixed(2)}×`;
    persistConfig();
  });
  $("pushMult").addEventListener("input", () => {
    cfg.breaks.push_break_multiplier = Number($("pushMult").value);
    $("pushMultVal").textContent = `${cfg.breaks.push_break_multiplier.toFixed(2)}×`;
    persistConfig();
  });
  $("autoStartFocusMain").addEventListener("change", () => {
    cfg.breaks.auto_start_next_focus = $("autoStartFocusMain").checked;
    persistConfig();
  });

  // Wave settings
  $("waveVisibility").addEventListener("change", () => { cfg.wave.wave_visibility = $("waveVisibility").value; persistConfig(); syncHeader(); });
  $("floorIncSec").addEventListener("change", () => { cfg.wave.floor_raise_increment_seconds = Number($("floorIncSec").value); persistConfig(); });
  $("floorStreak").addEventListener("change", () => { cfg.wave.floor_raise_clean_streak = Number($("floorStreak").value); persistConfig(); });

  $("pushA").addEventListener("input", () => {
    cfg.wave.push_a_pct_of_median = Number($("pushA").value);
    $("pushAVal").textContent = `${Math.round(cfg.wave.push_a_pct_of_median * 100)}%`;
    persistConfig();
  });
  $("pushB").addEventListener("input", () => {
    cfg.wave.push_b_pct_of_median = Number($("pushB").value);
    $("pushBVal").textContent = `${Math.round(cfg.wave.push_b_pct_of_median * 100)}%`;
    persistConfig();
  });

  // UI scale
  $("uiScale").addEventListener("input", () => {
    cfg.window.ui_scale = Number($("uiScale").value);
    applyUIScale();
    persistConfig();
  });

  // Debug goal override
  $("goalOverrideEnabled")?.addEventListener("change", () => {
    cfg.debug.goal_override_enabled = $("goalOverrideEnabled").checked;
    persistConfig();
    syncHeader();
  });
  $("goalOverrideMin")?.addEventListener("change", () => {
    cfg.debug.goal_override_minutes = Number($("goalOverrideMin").value);
    persistConfig();
    syncHeader();
  });

  // Data buttons
  $("exportCsvBtn").addEventListener("click", exportCSV);
  $("exportJsonlBtn").addEventListener("click", exportJSONL);
  $("clearAllBtn").addEventListener("click", clearAllData);
  $("resetDefaultsBtn").addEventListener("click", resetSettingsToDefault);
  $("exportSettingsBtn").addEventListener("click", exportSettings);

  $("exportBackupBtn")?.addEventListener("click", exportBackupFile);
  $("resetAppBtn")?.addEventListener("click", resetApp);

  $("importBackupInput")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await importBackupFile(file);
    e.target.value = "";
  });

  $("importSettingsInput").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await importSettings(file);
    e.target.value = "";
  });

  $("importJsonlInput").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await importJSONLText(await file.text());
    e.target.value = "";
  });
}

// ════════════════════════════════════════════════
// Init
// ════════════════════════════════════════════════

async function init() {
  blocks = (await getAllBlocks()).sort((a, b) => a.idx - b.idx);

  planner = new WavePlanner(cfg);
  for (const b of blocks) planner.updateAfterBlock(b);

  // Set the intensity dropdown to match saved selection,
  // but DON'T call applyIntensityPreset — that would overwrite
  // any custom settings the user tweaked after picking a preset.
  const savedPreset = localStorage.getItem("ftf_intensity") || "Balanced";
  $("intensityPreset").value = savedPreset;

  loadAdvancedFlag();

  wireMainButtons();
  wireSettings();

  setSettingsControlsFromCfg();
  renderTable();
  redrawCharts();
  applyUIScale();
  syncHeader();

  // Show stats by default if user has history
  if (blocks.length > 0) {
    document.body.classList.remove("stats-hidden");
  }
}

if (window.__FTF_TEST__) {
  window.__ftfTestHooks = {
    getPlanComputeCount: () => planComputeCount,
    setRunningState: ({ running: r, mode: md, startOffsetSec=0, goalSec=600 } = {}) => {
      running = (r !== undefined) ? r : running;
      mode = md || mode;
      startTS = performance.now() - startOffsetSec*1000;
      focusStartSnapshot.goalSec = goalSec;
    },
    tickOnce: () => tick(),
    recomputePlan: () => { cached = planNow(); return cached; },
    getCachedPlan: () => cached,
    getDisplayedGoalSec: () => (cached && cached.goal_sec) ? cached.goal_sec : null,

  };
}

init();
import { DEFAULT_CONFIG, deepCopy, deepMerge } from "./config.js";
import { getAllBlocks, putBlock, bulkPut, clearAll, getConfig, setConfig, clearConfig, exportBackup, importBackup, clearTrainingState, clearPrefs } from "./storage.js";
import { fmtHHMMSS, fmtMin, nowTimestamp, bucketForDate, downloadText, escHTML } from "./utils.js";
import { computeMetrics } from "./analytics.js";
import { blendMetrics } from "./engine/blendEngine.js";
import { WavePlanner, Phase, BlockType } from "./planner.js";

const VERSION = "4.0.6";
import { drawProgress, drawToday, drawWeekly, drawConsistency, drawDistribution, destroyChart } from "./charts.js";

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

// Migrate renamed config keys (v3.1)
const _keyRenames = [
  ["push_a_pct_of_median", "push_a_pct_above_floor"],
  ["push_b_pct_of_median", "push_b_pct_above_floor"],
  ["target_band_add_minutes_stability", "consolidate_band_add_minutes"],
  ["easy_consolidate_band_add_minutes", "easy_band_add_minutes"],
];
let _cfgMigrated = false;
for (const [oldKey, newKey] of _keyRenames) {
  if (cfg.wave[oldKey] !== undefined) {
    if (cfg.wave[newKey] === undefined) cfg.wave[newKey] = cfg.wave[oldKey];
    delete cfg.wave[oldKey];
    _cfgMigrated = true;
  }
}

// Growth v2 migration: remove deprecated keys, add new defaults
const _deadWaveKeys = [
  "push_a_pct_above_floor", "push_b_pct_above_floor",
  "floor_raise_clean_streak", "floor_raise_increment_seconds",
  "floor_bonus_cap_minutes", "forced_easy_consolidate_blocks_after_crash",
];
for (const k of _deadWaveKeys) {
  if (cfg.wave[k] !== undefined) { delete cfg.wave[k]; _cfgMigrated = true; }
}
// Unify analytics percentile to match floor engine
if (cfg.analytics?.floor_percentile !== 0.35) {
  cfg.analytics.floor_percentile = 0.35;
  _cfgMigrated = true;
}
if (cfg.ux) { delete cfg.ux; _cfgMigrated = true; }
if (_cfgMigrated) setConfig(cfg);

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
let pauseCount = 0;
let pauseTotal = 0;
let pauseStartedAt = null;

let activeTab = "progress";
let settingsWired = false;
let zenMode = localStorage.getItem("ftf_zen") === "1";
let lastAutoSave = 0;

const SESSION_KEY = "ftf_inflight_session";
const AUTOSAVE_INTERVAL_MS = 15_000; // save every 15s during focus

// ════════════════════════════════════════════════
// Config Persistence
// ════════════════════════════════════════════════

function persistConfig() {
  setConfig(cfg);
  planner.setConfig(cfg);
  invalidateCache();
}

function invalidateCache() {
  cached = { m: null, plan: null, bucketNow: null };
}

function setStatus(text, tone = "calm") {
  const el = $("statusLabel");
  if (!el) return;
  el.textContent = text;
  el.className = "status-bar" + (tone ? ` status-${tone}` : "");
}

// ════════════════════════════════════════════════
// Session Recovery (power loss / tab close)
// ════════════════════════════════════════════════

function saveInflightSession() {
  if (mode !== "FOCUS" || startTS == null) return;
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      elapsed,
      goalSec: focusStartSnapshot.goalSec || 0,
      planSnapshot: focusStartSnapshot.plan ? {
        phase: focusStartSnapshot.plan.phase,
        block_type: focusStartSnapshot.plan.block_type,
        goal_sec: focusStartSnapshot.plan.goal_sec,
        floor_sec: focusStartSnapshot.plan.floor_sec,
        min_goal_sec: focusStartSnapshot.plan.min_goal_sec,
        push_target: focusStartSnapshot.plan.push_target,
        target_low: focusStartSnapshot.plan.target_low,
        target_high: focusStartSnapshot.plan.target_high,
        wave_cycle_id: focusStartSnapshot.plan.wave_cycle_id,
        wave_cycle_pos: focusStartSnapshot.plan.wave_cycle_pos,
      } : null,
      metricsSnapshot: focusStartSnapshot.m ? {
        floor: focusStartSnapshot.m.floor,
        median: focusStartSnapshot.m.median,
        ceiling: focusStartSnapshot.m.ceiling,
        crash_threshold: focusStartSnapshot.m.crash_threshold,
        overshoot_threshold: focusStartSnapshot.m.overshoot_threshold,
        floor_global: focusStartSnapshot.m.floor_global,
        floor_bucket: focusStartSnapshot.m.floor_bucket,
        median_global: focusStartSnapshot.m.median_global,
        median_bucket: focusStartSnapshot.m.median_bucket,
        bucket_weight: focusStartSnapshot.m.bucket_weight,
        bucket_n: focusStartSnapshot.m.bucket_n,
      } : null,
      savedAt: Date.now(),
      timestamp: nowTimestamp(),
      bucket: bucketForDate(new Date()),
    }));
  } catch (e) { /* ignore */ }
}

function clearInflightSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
}

function getInflightSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    // Discard if older than 12 hours (stale crash)
    if (Date.now() - (s.savedAt || 0) > 12 * 3600 * 1000) {
      clearInflightSession();
      return null;
    }
    if (!s.elapsed || s.elapsed < 10) {
      clearInflightSession();
      return null;
    }
    return s;
  } catch (e) {
    return null;
  }
}

async function recoverSession(session) {
  const focusSeconds = Math.floor(session.elapsed);
  const plan = session.planSnapshot || {};
  const m = session.metricsSnapshot || {};
  const goalSec = Number(plan.goal_sec || session.goalSec || 0);

  const crash = m.crash_threshold != null && focusSeconds < m.crash_threshold;
  const overshoot = m.overshoot_threshold != null && focusSeconds > m.overshoot_threshold;
  const isPush = plan.block_type === "PUSH" || plan.block_type === "PUSH_A" || plan.block_type === "PUSH_B";
  const pushTarget = isPush ? (plan.push_target || 0) : 0;
  const pushHit = isPush ? focusSeconds >= pushTarget : false;
  const breakSeconds = computeBreakSeconds(focusSeconds, crash, overshoot, isPush);
  const isWin = goalSec > 0 && focusSeconds >= goalSec;

  const idx = blocks.length ? Math.max(...blocks.map(b => b.idx)) + 1 : 1;
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
    ceiling_global_seconds: null,
    ceiling_bucket_seconds: null,
    ceiling_effective_seconds: m.ceiling || null,
    validity: "recovered",
    focus_seconds: focusSeconds,
    is_win: isWin,
    break_seconds: breakSeconds,
    timestamp: session.timestamp || nowTimestamp(),
    bucket: session.bucket || bucketForDate(new Date()),
    phase: plan.phase || "LINEAR",
    block_type: plan.block_type || "CONSOLIDATE",
    target_low_seconds: plan.target_low || 0,
    target_high_seconds: plan.target_high || 0,
    push_target_seconds: pushTarget,
    push_hit: pushHit,
    crash,
    overshoot,
    stop_reason: "RECOVERED",
    wave_cycle_id: plan.wave_cycle_id || 0,
    wave_cycle_pos: plan.wave_cycle_pos || 0,
  };

  blocks.push(block);
  await putBlock(block);
  planner.updateAfterBlock(block);
  invalidateCache();
  clearInflightSession();

  renderTable();
  redrawCharts();
  syncHeader();
  setStatus(`Recovered ${fmtHHMMSS(focusSeconds)} focus block from interrupted session.`, "good");
}

// ════════════════════════════════════════════════
// Zen Mode (hide timer during focus)
// ════════════════════════════════════════════════

function applyZenMode() {
  document.body.classList.toggle("zen", zenMode);
  const btn = $("zenToggleBtn");
  if (btn) btn.title = zenMode ? "Show timer" : "Hide timer";
}

function toggleZen() {
  zenMode = !zenMode;
  localStorage.setItem("ftf_zen", zenMode ? "1" : "0");
  applyZenMode();
}

// ════════════════════════════════════════════════
// beforeunload (warn during active focus)
// ════════════════════════════════════════════════

window.addEventListener("beforeunload", (e) => {
  if (mode === "FOCUS" && startTS != null && running) {
    saveInflightSession();
    e.preventDefault();
    e.returnValue = "";
  }
});

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

  if ($("fatigueRate")) {
    $("fatigueRate").value = w.fatigue_rate_per_block;
    $("fatigueRateVal").textContent = `${Math.round(w.fatigue_rate_per_block * 100)}%`;
  }

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
    Object.assign(cfg.wave, { push_pct_high: 0.10, push_pct_mid: 0.06, push_pct_low: 0.04, fatigue_rate_per_block: 0.08 });
  } else if (preset === "Hard") {
    Object.assign(cfg.breaks, { break_percent: 20, crash_break_multiplier: 1.35, overshoot_break_multiplier: 1.15 });
    Object.assign(cfg.wave, { push_pct_high: 0.15, push_pct_mid: 0.10, push_pct_low: 0.06, fatigue_rate_per_block: 0.04 });
  } else {
    Object.assign(cfg.breaks, { break_percent: 25, crash_break_multiplier: 1.5, overshoot_break_multiplier: 1.2 });
    Object.assign(cfg.wave, { push_pct_high: 0.12, push_pct_mid: 0.08, push_pct_low: 0.05, fatigue_rate_per_block: 0.06 });
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
  const allBucketBlocks = blocks.filter((b) => b && b.bucket === bucketNow);

  // A3: Recency-weighted bucket — only use bucket blocks from recent N days
  const recencyDays = Number(cfg.analytics.bucket_recency_days || 30);
  const cutoff = Date.now() - recencyDays * 86400000;
  const bucketBlocks = allBucketBlocks.filter((b) => {
    const t = Date.parse((b.timestamp || "").replace(" ", "T"));
    return Number.isNaN(t) || t >= cutoff; // keep if no timestamp (legacy) or recent
  });

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


  const intensity = localStorage.getItem("ftf_intensity") || "Balanced";

  // Count today's completed blocks for fatigue curve
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const blocksToday = blocks.filter((b) => {
    const t = Date.parse((b.timestamp || "").replace(" ", "T"));
    return !Number.isNaN(t) && t >= dayStart;
  }).length;

  const plan = planner.planNext(blocks, m, { bucket: bucketNow, bucketBlocks, intensity, blocksToday });

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
  if (!vals.length) return { count: 0, best: null, avg: null, total: 0 };

  return {
    count: vals.length,
    best: Math.max(...vals),
    avg: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length),
    total: Math.round(vals.reduce((a, b) => a + b, 0)),
  };
}

function computeWinRate(n = 10) {
  const recent = blocks.filter(b => b?.goal_seconds > 0).slice(-n);
  if (!recent.length) return null;
  const wins = recent.filter(b => b.focus_seconds >= b.goal_seconds).length;
  return Math.round((wins / recent.length) * 100);
}

function currentStreak() {
  let streak = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]?.is_win) streak++; else break;
  }
  return streak;
}

function ensureCached() {
  if (!cached.plan || !cached.m) {
    cached = planNow(); // compute once
  }
  return cached;
}

function syncTodayCard() {
  const s = todayStats();
  const { m, plan } = ensureCached();
  const streak = currentStreak();
  const winRate = computeWinRate(10);

  $("todayCount").textContent = String(s.count || 0);
  $("statStreak").textContent = streak > 0 ? `${streak} 🔥` : "0";
  $("statFloor").textContent = plan.floor_sec > 0 ? fmtMin(plan.floor_sec) : "--";
  $("todayGoal").textContent = fmtHHMMSS(plan.goal_sec || 0);

  // Context line beneath stats
  const ctx = $("statsContext");
  if (ctx) {
    const parts = [];

    // Weekly floor delta
    const floorDelta = computeWeeklyFloorDelta();
    if (floorDelta != null) {
      if (floorDelta > 0) parts.push(`Floor this week: +${fmtMin(floorDelta)}`);
      else if (floorDelta < -30) parts.push(`Floor this week: ${fmtMin(floorDelta)}`);
      else parts.push("Floor: steady");
    }

    // Momentum indicator
    if (plan.momLevel) {
      const momLabel = plan.momLevel === "HIGH" ? "🔥 Hot" : plan.momLevel === "LOW" ? "🌊 Recovery" : "⚡ Steady";
      parts.push(momLabel);
    }

    // Fatigue note
    if (plan.fatigue_factor && plan.fatigue_factor < 0.95) {
      parts.push(`Fatigue: ${Math.round(plan.fatigue_factor * 100)}%`);
    }

    if (winRate != null) parts.push(`Win: ${winRate}%`);
    if (s.total > 0) parts.push(`Total: ${fmtHHMMSS(s.total)}`);

    ctx.textContent = parts.join("  ·  ");
  }

  // Render milestone trophies
  try { renderMilestones(); } catch {}
}

/** Compute floor change over last 7 days. */
function computeWeeklyFloorDelta() {
  if (blocks.length < 5) return null;
  const now = Date.now();
  const weekAgo = now - 7 * 86400000;

  // Current floor = plan.floor_sec
  const { plan } = ensureCached();
  const currentFloor = plan.floor_sec;
  if (!currentFloor || currentFloor <= 0) return null;

  // Floor 7 days ago: P35 of blocks that existed before the cutoff
  const oldBlocks = blocks.filter(b => {
    const t = Date.parse((b.timestamp || "").replace(" ", "T"));
    return !Number.isNaN(t) && t < weekAgo;
  });
  if (oldBlocks.length < 3) return null;

  const vals = oldBlocks.map(b => Number(b.focus_seconds)).filter(x => x > 0).sort((a,b) => a - b);
  if (vals.length < 3) return null;

  const idx = 0.35 * (vals.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  const oldFloor = (lo === hi) ? vals[lo] : vals[lo] + (vals[hi] - vals[lo]) * (idx - lo);

  return Math.round(currentFloor - oldFloor);
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
  if (bt === "PUSH" || bt === "PUSH_A" || bt === "PUSH_B") return "Push";
  if (bt === "RAISE_FLOOR") return "Floor raise";
  return bt;
}

function statusMessage(plan, m, blockCount) {
  // First-run
  if (blockCount === 0) {
    return { text: "Press Focus and concentrate until you can't. The app will learn your rhythm.", tone: "" };
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
    if (bt === "PUSH" || bt === "PUSH_A" || bt === "PUSH_B") {
      const momLabel = plan.momLevel === "HIGH" ? "You're on fire — " : plan.momLevel === "LOW" ? "Gentle push — " : "";
      return { text: `${momLabel}Push block — aim for ${fmtHHMMSS(plan.push_target || plan.goal_sec)}. It's okay to fall short.`, tone: "" };
    }
    // Fatigue note for late-day blocks
    if (plan.blocks_today >= 3 && plan.fatigue_factor < 0.90) {
      return { text: `Consolidation — goal adjusted for fatigue (block ${plan.blocks_today + 1} today).`, tone: "calm" };
    }
    return { text: "Consolidation — land this and keep your momentum going.", tone: "calm" };
  }

  return { text: "Ready when you are.", tone: "calm" };
}

// ════════════════════════════════════════════════
// Sync UI — compute/render split
// ════════════════════════════════════════════════

/** Pure: derive all display values from current state. No DOM access. */
function computeHeaderState() {
  const { m, plan } = ensureCached();
  const timerActive = startTS != null;
  const focusStarted = mode === "FOCUS" && timerActive;
  const goalHit = goalHitDuringFocus && mode === "FOCUS";
  const phaseTxt = prettyPhase(plan.phase);
  const btTxt = friendlyBlockType(plan.block_type);
  const adv = document.body.classList.contains("advanced");

  let metricsText = "";
  let metricsVisible = false;
  if (m.floor != null || plan.floor_sec > 0) {
    metricsVisible = true;
    if (!adv) {
      const f = plan.floor_sec > 0 ? fmtMin(plan.floor_sec) : "--";
      const med = m.median == null ? "--" : fmtMin(m.median);
      metricsText = `Floor: ${f} · Typical: ${med}`;
    } else {
      metricsText =
        `F/M/C: ${fmtMin(m.floor)} / ${fmtMin(m.median)} / ${fmtMin(m.ceiling)} | ` +
        `IQR: ${fmtMin(m.recent_iqr)} | Crashes: ${m.recent_crashes}/${Math.max(1, m.recent_n)}`;
    }
  }

  let idleStatus = null;
  if (!timerActive) {
    idleStatus = statusMessage(plan, m, blocks.length);
  }

  // Debug text
  const dbg = plan.debug || {};
  const debugLines = Object.entries(dbg).map(([k, v]) => {
    const vv = typeof v === "number" ? Math.round(v * 1000) / 1000 : v;
    return `${k}: ${vv}`;
  });
  debugLines.push(`goal_sec: ${plan.goal_sec}`, `min_goal_sec: ${plan.min_goal_sec}`, `floor_sec: ${plan.floor_sec}`);
  debugLines.push(`phase: ${plan.phase}`, `block_type: ${plan.block_type}`, `push_target: ${plan.push_target}`);

  // UI state for button groups
  let uiState = "idle";
  if (mode === "BREAK" && timerActive) uiState = "break";
  else if (mode === "FOCUS" && timerActive && running) uiState = "focusing";
  else if (mode === "FOCUS" && timerActive && !running) uiState = "paused";

  return {
    mode, elapsed, goalHit, timerActive, focusStarted, uiState,
    timerText: fmtHHMMSS(elapsed),
    goalText: plan.fatigue_factor && plan.fatigue_factor < 0.95
      ? `Goal: ${fmtHHMMSS(plan.goal_sec || 0)} (${Math.round(plan.fatigue_factor * 100)}%)`
      : `Goal: ${fmtHHMMSS(plan.goal_sec || 0)}`,
    phaseText: btTxt ? `${phaseTxt} · ${btTxt}` : phaseTxt,
    zenText: goalHit ? "Goal reached ✓" : "Focusing…",
    metricsText, metricsVisible,
    idleStatus,
    debugText: debugLines.join("\n"),
  };
}

/** Render computed header state to the DOM. */
function renderHeader(h) {
  const modeEl = $("modeLabel");
  modeEl.textContent = h.mode;
  modeEl.setAttribute("data-mode", h.mode);
  document.body.setAttribute("data-mode", h.mode);

  document.body.classList.toggle("goal-hit", h.goalHit);

  const zenEl = $("zenIndicator");
  if (zenEl) zenEl.textContent = h.zenText;

  $("timerLabel").textContent = h.timerText;
  $("targetsLabel").textContent = h.goalText;
  $("phaseLabel").textContent = h.phaseText;

  const metricsEl = $("metricsLabel");
  if (metricsEl) {
    metricsEl.textContent = h.metricsText;
    metricsEl.style.display = h.metricsVisible ? "" : "none";
  }

  syncControls(h.uiState);

  try { syncTodayCard(); } catch {}

  if (h.idleStatus) {
    setStatus(h.idleStatus.text, h.idleStatus.tone);
  }

  try { $("debugText").textContent = h.debugText; } catch {}
}

/** Update hero button label/style and secondary button enabled state. */
function syncControls(uiState) {
  const hero = $("heroBtn");
  const done = $("doneBtn");
  const dist = $("distractedBtn");
  const reset = $("resetBtn");
  if (!hero) return;

  // Done + Distracted: enabled only during focus or pause
  const canStop = (uiState === "focusing" || uiState === "paused");
  if (done) done.disabled = !canStop;
  if (dist) dist.disabled = !canStop;

  // Reset: enabled when paused or idle with elapsed time
  const canReset = (uiState === "paused");
  if (reset) reset.disabled = !canReset;

  switch (uiState) {
    case "focusing":
      hero.textContent = "Pause";
      hero.setAttribute("data-hero", "pause");
      break;
    case "paused":
      hero.textContent = "Resume";
      hero.setAttribute("data-hero", "resume");
      break;
    case "break":
      hero.textContent = "Skip Break";
      hero.setAttribute("data-hero", "break");
      break;
    default: // idle
      hero.textContent = "Focus";
      hero.removeAttribute("data-hero");
      break;
  }
}

function syncHeader() {
  renderHeader(computeHeaderState());
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
    } else if (activeTab === "weekly") {
      chart = drawWeekly(ctx, blocks);
    } else if (activeTab === "consistency") {
      chart = drawConsistency(ctx, blocks);
    } else if (activeTab === "distribution") {
      const { plan } = ensureCached();
      chart = drawDistribution(ctx, blocks, plan);
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
  const goal  = fmtHHMMSS(Number(b.goal_seconds || 0));
  const brk   = fmtHHMMSS(Number(b.break_seconds || 0));
  const tl    = fmtHHMMSS(Number(b.target_low_seconds || 0));
  const th    = fmtHHMMSS(Number(b.target_high_seconds || 0));
  const push  = b.push_target_seconds ? fmtHHMMSS(Number(b.push_target_seconds)) : "--";
  const pauses = b.pause_count > 0 ? `${b.pause_count}` : "--";
  return `<tr>
    <td>${escHTML(b.idx)}</td>
    <td>${escHTML(b.phase || "--")}</td>
    <td>${escHTML(b.block_type || "--")}</td>
    <td>${focus}</td><td>${goal}</td><td>${brk}</td>
    <td>${tl}</td><td>${th}</td><td>${push}</td>
    <td>${yesNo(b.crash)}</td>
    <td>${b.overshoot ? fmtHHMMSS(Number(b.overshoot)) : "--"}</td>
    <td>${escHTML(b.stop_reason || "--")}</td>
    <td>${pauses}</td>
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
    // Auto-save inflight session periodically
    if (now - lastAutoSave > AUTOSAVE_INTERVAL_MS) {
      lastAutoSave = now;
      saveInflightSession();
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
  lastAutoSave = performance.now();
  goalHitDuringFocus = false;
  goalHitAt = null;
  pauseCount = 0;
  pauseTotal = 0;
  pauseStartedAt = null;
  setStatus("Focus running — stay with it until you can't.", "");
  syncHeader();
  saveInflightSession(); // immediate first save
  tickHandle = setInterval(tick, 250);
}

function startBreak(seconds) {
  cancelTick();
  mode = "BREAK";
  running = true;
  breakTotal = Math.floor(seconds);
  elapsed = breakTotal;
  startTS = performance.now();
  setStatus("Break — rest your eyes and move around.", "calm");
  syncHeader();
  tickHandle = setInterval(tick, 250);
}

async function finalizeFocus(stopReason) {
  if (mode !== "FOCUS" || startTS == null) return;
  const focusSeconds = elapsed | 0;
  if (focusSeconds <= 0) return;

  cancelTick();
  running = false;
  clearInflightSession();

  // Use the plan/metrics from when focus started — not a stale cache from mid-session
  const { m, plan } = (focusStartSnapshot.plan) ? focusStartSnapshot : ensureCached();
  const crash = m.crash_threshold != null && focusSeconds < m.crash_threshold;
  const overshoot = m.overshoot_threshold != null && focusSeconds > m.overshoot_threshold;
  const isPush = plan.block_type === "PUSH" || plan.block_type === "PUSH_A" || plan.block_type === "PUSH_B";
  const pushTarget = isPush ? plan.push_target : 0;
  // Broadened success: 90% of push target counts as a hit
  const pushHit = isPush ? focusSeconds >= (pushTarget * 0.90) : false;
  const breakSeconds = computeBreakSeconds(focusSeconds, crash, overshoot, isPush);
  const goalSec = Number(plan.goal_sec || 0);
  const isWin = goalSec > 0 && focusSeconds >= goalSec;

  const idx = blocks.length ? Math.max(...blocks.map((b) => b.idx)) + 1 : 1;

  // Compute streak before pushing this block
  let streak = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]?.is_win) streak++; else break;
  }
  if (isWin) streak++;

  // Count today's blocks for fatigue/crash context
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const todayBlockCount = blocks.filter((b) => {
    const t = Date.parse((b.timestamp || "").replace(" ", "T"));
    return !Number.isNaN(t) && t >= dayStart;
  }).length;

  const block = {
    idx,
    goal_seconds: goalSec,
    raw_goal_seconds: plan.raw_goal_sec || goalSec,
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
    bucket: bucketForDate(now),
    // Enriched time fields
    hour: now.getHours(),
    day_of_week: now.getDay(),
    date: `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`,
    // Phase & planning
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
    // Session quality
    goal_hit_at_seconds: goalHitAt,
    pause_count: pauseCount,
    pause_total_seconds: pauseTotal,
    // Thresholds for retrospective analysis
    crash_threshold_seconds: m.crash_threshold || null,
    overshoot_threshold_seconds: m.overshoot_threshold || null,
    // Context
    win_streak: streak,
    blocks_today: todayBlockCount,
    fatigue_factor: plan.fatigue_factor || 1,
    momentum_rate: plan.momentum?.rate || null,
    momentum_level: plan.momLevel || null,
  };

  blocks.push(block);
  await putBlock(block);
  planner.updateAfterBlock(block);
  invalidateCache(); // Force fresh plan for next syncHeader

  renderTable();
  redrawCharts();
  syncHeader();

  // ── Celebrations ──
  const freshPlan = ensureCached().plan;

  // Floor milestone
  if (freshPlan.new_milestone) {
    showMilestoneModal(freshPlan.new_milestone);
  } else if (isWin) {
    showWinModal(focusSeconds, goalSec);
  }

  // Check for perfect day (all blocks today hit their goals)
  const todaysBlocks = blocks.filter((b) => {
    const t = Date.parse((b.timestamp || "").replace(" ", "T"));
    return !Number.isNaN(t) && t >= dayStart;
  });
  if (todaysBlocks.length >= 3 && todaysBlocks.every(b => b.is_win)) {
    setTimeout(() => setStatus("⭐ Perfect day — every session hit its goal!", "good"), 1500);
  }

  // Daily total milestones
  const totalFocusToday = todaysBlocks.reduce((s, b) => s + Number(b.focus_seconds || 0), 0);
  const hours = Math.floor(totalFocusToday / 3600);
  if (hours >= 1 && totalFocusToday - focusSeconds < hours * 3600) {
    setTimeout(() => setStatus(`${hours}hr+ of focus today!`, "good"), 2000);
  }

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
    setStatus("Break ended early. Ready when you are.", "calm");
  }
}

function finishBreak() {
  cancelTick();
  running = false;
  startTS = null;
  elapsed = 0;
  mode = "FOCUS";
  syncHeader();

  if (cfg.breaks.auto_start_next_focus) {
    setTimeout(startFocus, 300);
  } else {
    setStatus("Break's over. Ready for the next one?", "calm");
  }
}

function togglePause() {
  if (startTS == null) return;
  if (running) {
    running = false;
    cancelTick();
    if (mode === "FOCUS") {
      pauseCount++;
      pauseStartedAt = performance.now();
      saveInflightSession(); // save on pause so power loss is covered
    }
    setStatus("Paused — press Resume or Space to continue.", "warn");
  } else {
    running = true;
    if (mode === "FOCUS") {
      // Track total pause duration
      if (pauseStartedAt != null) {
        pauseTotal += Math.floor((performance.now() - pauseStartedAt) / 1000);
        pauseStartedAt = null;
      }
      startTS = performance.now() - elapsed * 1000;
    } else {
      startTS = performance.now() - Math.max(0, breakTotal - elapsed) * 1000;
    }
    tickHandle = setInterval(tick, 250);
  }
  syncHeader(); // update UI state immediately
}

function resetTimer() {
  cancelTick();
  running = false;
  startTS = null;
  elapsed = 0;
  mode = "FOCUS";
  goalHitDuringFocus = false;
  goalHitAt = null;
  pauseCount = 0;
  pauseTotal = 0;
  pauseStartedAt = null;
  clearInflightSession();
  setStatus("Timer reset. Ready when you are.", "calm");
  invalidateCache();
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
  const panel2 = $("milestoneModal");
  if (panel2) panel2.classList.add("hidden");
  const c = $("confettiCanvas");
  if (c) {
    const ctx = c.getContext("2d");
    ctx?.clearRect(0, 0, c.width, c.height);
  }
}

function showMilestoneModal(minutes) {
  const panel = $("milestoneModal");
  if (!panel) { showWinModal(minutes * 60, 0); return; }

  const label = minutes >= 60 ? `${minutes / 60}hr` : `${minutes}min`;
  if ($("milestoneEmoji")) $("milestoneEmoji").textContent = "🏆";
  if ($("milestoneTitle")) $("milestoneTitle").textContent = `Floor milestone: ${label}!`;
  if ($("milestoneText")) $("milestoneText").textContent = `Your consistent floor has reached ${label}. This is real, earned growth.`;

  // Update trophy row
  renderMilestones();

  panel.classList.remove("hidden");
  runConfetti();
  $("milestoneOk")?.focus();
}

function renderMilestones() {
  const row = $("trophyRow");
  if (!row) return;
  const { plan } = ensureCached();
  const earned = plan.earned_milestones || [];
  const all = cfg.wave.floor_milestones || [15,20,25,30,40,50,60,75,90,120];
  row.innerHTML = all.map(ms => {
    const got = earned.includes(ms);
    const label = ms >= 60 ? `${ms/60}hr` : `${ms}m`;
    return `<span class="trophy ${got ? "earned" : "locked"}" title="${label} floor">${got ? "🏆" : "🔒"}<span class="trophy-label">${label}</span></span>`;
  }).join("");
  row.style.display = earned.length > 0 ? "" : "none";
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

function openAbout() {
  $("modalBackdrop").classList.remove("hidden");
  $("aboutModal").classList.remove("hidden");
  document.body.classList.add("modal-open");
}

function closeAbout() {
  $("modalBackdrop").classList.add("hidden");
  $("aboutModal").classList.add("hidden");
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
  invalidateCache();

  renderTable();
  redrawCharts();
  syncHeader();
  setStatus(`Imported ${imported.length} blocks.`, "good");
}

async function clearAllData() {
  if (!confirm("Delete ALL saved history in this browser?")) return;
  blocks = [];
  await clearAll();
  planner = new WavePlanner(cfg);
  renderTable();
  redrawCharts();
  syncHeader();
  invalidateCache();
  setStatus("Cleared all history.", "calm");
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
  setStatus("Settings reset to default.", "calm");
}

function exportSettings() {
  const settingsExport = {
    _type: "ftf_settings_v1",
    _version: VERSION,
    _exported: nowTimestamp(),
    config: cfg,
    intensity: localStorage.getItem("ftf_intensity") || "Balanced",
    advanced: localStorage.getItem("ftf_advanced") || "0",
  };
  downloadText(
    `ftf_settings_${Date.now()}.json`,
    JSON.stringify(settingsExport, null, 2)
  );
  setStatus("Settings exported.", "calm");
}

async function exportBackupFile(){
  try {
    const payload = await exportBackup();
    const out = {
      _type: "ftf_backup_v1",
      _version: VERSION,
      _exported: nowTimestamp(),
      ...payload
    };
    downloadText(`ftf_backup_${Date.now()}.json`, JSON.stringify(out, null, 2));
    setStatus("Backup exported.", "calm");
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
      setStatus("Invalid settings file — no config found.", "warn");
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
    invalidateCache();

    setSettingsControlsFromCfg();
    applyUIScale();
    syncHeader();
    setStatus("Settings imported successfully.", "good");
  } catch (e) {
    console.warn("Settings import failed", e);
    setStatus("Failed to import settings — invalid file.", "warn");
  }
}

// ════════════════════════════════════════════════
// Wire Events
// ════════════════════════════════════════════════

function wireMainButtons() {
  // Hero button — dispatches based on current state
  $("heroBtn")?.addEventListener("click", () => {
    const state = $("heroBtn")?.getAttribute("data-hero");
    if (state === "pause") togglePause();
    else if (state === "resume") togglePause();
    else if (state === "break") endBreakEarly();
    else startFocus(); // idle / default
  });
  $("distractedBtn").addEventListener("click", () => finalizeFocus("DISTRACTED"));
  $("doneBtn")?.addEventListener("click", () => finalizeFocus("COMPLETED"));
  $("resetBtn")?.addEventListener("click", resetTimer);

  // Zen mode toggle
  $("zenToggleBtn")?.addEventListener("click", toggleZen);
  applyZenMode();

  $("openSettingsBtn").addEventListener("click", openSettings);
  $("closeSettingsBtn").addEventListener("click", closeSettings);
  $("openAboutBtn")?.addEventListener("click", openAbout);
  $("closeAboutBtn")?.addEventListener("click", closeAbout);
  $("modalBackdrop").addEventListener("click", () => { closeSettings(); closeAbout(); });

  // Win modal
  $("winModalOk")?.addEventListener("click", hideWinModal);
  $("winModal")?.addEventListener("click", (e) => { if (e.target?.id === "winModal") hideWinModal(); });

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("milestoneModal")?.classList.contains("hidden")) { hideWinModal(); return; }
      if (!$("winModal")?.classList.contains("hidden")) { hideWinModal(); return; }
      if (!$("aboutModal")?.classList.contains("hidden")) { closeAbout(); return; }
      if (!$("settingsModal")?.classList.contains("hidden")) { closeSettings(); return; }
    }
    // Space mirrors hero button (only when not typing)
    if (e.key === " " && !["INPUT", "TEXTAREA", "SELECT"].includes(e.target?.tagName)) {
      e.preventDefault();
      const heroState = $("heroBtn")?.getAttribute("data-hero");
      if (heroState === "pause" || heroState === "resume") togglePause();
      else if (heroState === "break") endBreakEarly();
      else startFocus();
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

  if ($("fatigueRate")) {
    $("fatigueRate").addEventListener("input", () => {
      cfg.wave.fatigue_rate_per_block = Number($("fatigueRate").value);
      $("fatigueRateVal").textContent = `${Math.round(cfg.wave.fatigue_rate_per_block * 100)}%`;
      persistConfig();
      invalidateCache();
      syncHeader();
    });
  }

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

  // Version display
  const vEl = $("versionLabel");
  if (vEl) vEl.textContent = `v${VERSION}`;
  console.log(`Focus to Failure v${VERSION}`);

  // Check for interrupted session (power loss, tab crash)
  const staleSession = getInflightSession();
  if (staleSession) {
    const mins = Math.floor(staleSession.elapsed / 60);
    const secs = staleSession.elapsed % 60;
    const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    if (confirm(`You were focusing for ${timeStr} when the session was interrupted.\n\nRecord this block?`)) {
      await recoverSession(staleSession);
    } else {
      clearInflightSession();
    }
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

init().catch((err) => {
  console.error("Focus to Failure: init failed", err);
  document.body.innerHTML = `
    <div style="max-width:420px;margin:60px auto;padding:24px;font-family:system-ui;text-align:center">
      <h2 style="color:#dc2626">Something went wrong</h2>
      <p style="color:#6b6b6b;font-size:14px">The app couldn't start. This is usually caused by corrupted local data.</p>
      <p style="color:#6b6b6b;font-size:13px;word-break:break-all">${String(err?.message || err)}</p>
      <button onclick="localStorage.clear();indexedDB.deleteDatabase('FocusToFailureDB');location.reload()"
        style="margin-top:16px;padding:10px 24px;background:#dc2626;color:#fff;border:none;border-radius:8px;font-size:14px;cursor:pointer">
        Reset App &amp; Reload
      </button>
      <p style="color:#999;font-size:11px;margin-top:12px">This clears all local data. Export a backup first if possible.</p>
    </div>`;
});
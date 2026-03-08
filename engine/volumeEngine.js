/**
 * Volume Engine
 *
 * Tracks daily volume (total focus minutes per day) as the primary growth metric.
 * Session goals are set conservatively to enable more blocks per day.
 *
 * Key concepts:
 * - Daily Volume Floor: p35 of recent daily totals (what you reliably do)
 * - Volume Goal: target total minutes for today (floor + gentle stretch)
 * - Gap-Based Fatigue: recovery based on time since last block, not block count
 * - Time Windows: learns your actual performance by time-of-day
 * - Session Comfort: goals set at/below session floor so each block feels easy
 */

// ── Helpers ──────────────────────────────────────

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function quantile(nums, q) {
  if (!nums || !nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  if (q <= 0) return s[0];
  if (q >= 1) return s[s.length - 1];
  const idx = q * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

// ── Daily Totals ─────────────────────────────────

/**
 * Aggregate blocks into daily totals.
 * Returns array sorted by date: [{ date, totalSec, count, wins, blocks }]
 */
export function computeDailyTotals(blocks) {
  const byDate = {};
  for (const b of blocks) {
    const d = b.date || (b.timestamp || "").slice(0, 10);
    if (!d || d.length < 10) continue;
    if (!byDate[d]) byDate[d] = { date: d, totalSec: 0, count: 0, wins: 0, blocks: [] };
    const sec = Number(b.focus_seconds || 0);
    byDate[d].totalSec += sec;
    byDate[d].count += 1;
    if (b.is_win) byDate[d].wins += 1;
    byDate[d].blocks.push(b);
  }
  return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
}

// ── Volume Floor ─────────────────────────────────

/**
 * Compute volume floor from recent daily totals.
 * Only counts days where user actually worked (at least 1 session).
 */
export function computeVolumeFloor(dailyTotals, vCfg) {
  const windowDays = vCfg.volume_window_days || 14;
  const minDays = vCfg.min_days_for_floor || 3;
  const pct = vCfg.volume_floor_percentile || 0.35;

  const recent = dailyTotals.slice(-windowDays);
  if (recent.length < minDays) return null;

  const totals = recent.map(d => d.totalSec);
  return Math.round(quantile(totals, pct));
}

// ── Volume Goal ──────────────────────────────────

/**
 * Compute daily volume goal.
 * - No floor yet: use config default or median of available data.
 * - With floor: floor + gentle stretch %.
 */
export function computeVolumeGoal(volumeFloorSec, dailyTotals, vCfg) {
  if (volumeFloorSec == null) {
    // Bootstrap: use median of available data, or config default
    const totals = dailyTotals.map(d => d.totalSec);
    if (totals.length >= 2) {
      return Math.round(quantile(totals, 0.50));
    }
    return (vCfg.start_volume_minutes || 90) * 60;
  }
  const stretchPct = clamp(vCfg.volume_stretch_pct || 0.05, 0, 0.30);
  return Math.round(volumeFloorSec * (1 + stretchPct));
}

// ── Gap-Based Fatigue ────────────────────────────

/**
 * Compute fatigue factor based on time gap since last block ended.
 * Returns 1.0 (fully fresh) down to back_to_back_factor (immediate restart).
 *
 * Recovery follows a quadratic ease-out curve:
 *   factor = min + (1 - min) * (1 - (1 - t)^2)
 *   where t = gap_minutes / fresh_after_minutes
 */
export function computeGapFatigue(lastBlockEndMs, nowMs, vCfg) {
  if (!lastBlockEndMs) return 1.0; // no previous block today → fresh

  const gapMin = Math.max(0, (nowMs - lastBlockEndMs) / 60000);
  const freshAfter = vCfg.fresh_after_minutes || 120;
  const minFactor = clamp(vCfg.back_to_back_factor || 0.88, 0.5, 1.0);

  if (gapMin >= freshAfter) return 1.0;

  // Quadratic ease-out: fast initial recovery, then tapers
  const t = gapMin / freshAfter;
  const recovery = 1 - Math.pow(1 - t, 2);
  return minFactor + (1.0 - minFactor) * recovery;
}

// ── Time Windows ─────────────────────────────────

const WINDOWS = [
  { key: "morning",   label: "Morning",   startH: 6,  endH: 12 },
  { key: "afternoon", label: "Afternoon", startH: 12, endH: 17 },
  { key: "evening",   label: "Evening",   startH: 17, endH: 22 },
  { key: "night",     label: "Night",     startH: 22, endH: 6  },
];

/**
 * Analyze session performance by time-of-day window.
 * Returns { morning: { count, avgSec, winRate, ... }, ... }
 */
export function computeTimeWindows(blocks) {
  const result = {};
  for (const w of WINDOWS) {
    result[w.key] = { ...w, sessions: [], totalSec: 0, count: 0, wins: 0, avgSec: 0, winRate: 0 };
  }

  for (const b of blocks) {
    let h = b.hour;
    if (h == null) {
      try { h = new Date(b.timestamp).getHours(); } catch { continue; }
    }
    const wKey = hourToWindowKey(h);
    result[wKey].sessions.push(b);
    result[wKey].totalSec += Number(b.focus_seconds || 0);
    if (b.is_win) result[wKey].wins += 1;
  }

  for (const w of Object.values(result)) {
    w.count = w.sessions.length;
    w.avgSec = w.count > 0 ? Math.round(w.totalSec / w.count) : 0;
    w.winRate = w.count > 0 ? w.wins / w.count : 0;
  }
  return result;
}

/** Map an hour (0-23) to a window key. */
export function hourToWindowKey(h) {
  if (h >= 6 && h < 12) return "morning";
  if (h >= 12 && h < 17) return "afternoon";
  if (h >= 17 && h < 22) return "evening";
  return "night";
}

// ── Session Target (Volume-Aware) ────────────────

/**
 * Compute a conservative session target for volume mode.
 * Aims at or below session floor so each block feels achievable → more blocks → more volume.
 *
 * Also considers the current time window's average performance if available.
 */
export function computeSessionTarget(sessionFloorSec, gapFatigue, windowAvgSec, vCfg) {
  const startMin = vCfg.start_session_minutes || 25;
  if (!sessionFloorSec || sessionFloorSec <= 0) return startMin * 60;

  const comfortPct = clamp(vCfg.session_comfort_pct || 0.90, 0.60, 1.0);

  // Use the lower of floor-based and window-based target
  let base = Math.round(sessionFloorSec * comfortPct);
  if (windowAvgSec && windowAvgSec > 0) {
    const windowTarget = Math.round(windowAvgSec * comfortPct);
    base = Math.min(base, windowTarget);
  }

  // Apply gap-based fatigue
  const fatigued = Math.round(base * gapFatigue);

  // Never go below absolute minimum
  const absMin = (vCfg.absolute_min_session_minutes || 15) * 60;
  return Math.max(absMin, fatigued);
}

// ── Volume-Aware Break ───────────────────────────

/**
 * Compute break multiplier for volume mode.
 * - Early in the day (low progress): generous breaks to preserve energy.
 * - Near volume goal: normal breaks.
 */
export function volumeBreakMultiplier(progressPct, vCfg) {
  const earlyBonus = clamp(vCfg.early_break_bonus || 0.25, 0, 1.0);
  // Linear ramp: full bonus at 0% progress, no bonus at 100%
  const bonus = earlyBonus * Math.max(0, 1 - progressPct);
  return 1.0 + bonus;
}

// ── Last Block End Time ──────────────────────────

/**
 * Find when the most recent block ended today.
 * Returns timestamp in ms, or null if no blocks today.
 */
export function lastBlockEndToday(blocks, dayStartMs) {
  let latest = null;
  for (const b of blocks) {
    const t = Date.parse((b.timestamp || "").replace(" ", "T"));
    if (Number.isNaN(t) || t < dayStartMs) continue;
    const endMs = t + (Number(b.focus_seconds || 0) + Number(b.break_seconds || 0)) * 1000;
    if (!latest || endMs > latest) latest = endMs;
  }
  return latest;
}

// ── Volume Summary ───────────────────────────────

/**
 * Compute full volume state for the current day.
 * This is the main entry point called by app.js each render cycle.
 */
export function computeVolumeState(blocks, vCfg, nowMs) {
  const now = new Date(nowMs || Date.now());
  const dayStartMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;

  // Daily totals (all history)
  const dailyTotals = computeDailyTotals(blocks);

  // Volume floor & goal
  const volumeFloorSec = computeVolumeFloor(dailyTotals, vCfg);
  const volumeGoalSec = computeVolumeGoal(volumeFloorSec, dailyTotals, vCfg);

  // Today's progress
  const todayBlocks = blocks.filter(b => {
    const t = Date.parse((b.timestamp || "").replace(" ", "T"));
    return !Number.isNaN(t) && t >= dayStartMs;
  });
  const todayTotalSec = todayBlocks.reduce((s, b) => s + Number(b.focus_seconds || 0), 0);
  const todayCount = todayBlocks.length;
  const progressPct = volumeGoalSec > 0 ? clamp(todayTotalSec / volumeGoalSec, 0, 2) : 0;

  // Gap fatigue
  const lastEndMs = lastBlockEndToday(blocks, dayStartMs);
  const gapFatigue = computeGapFatigue(lastEndMs, nowMs || Date.now(), vCfg);

  // Time windows (use recent blocks, not just today)
  const recentBlocks = blocks.slice(-50); // last 50 sessions for window analysis
  const windows = computeTimeWindows(recentBlocks);
  const currentWindow = hourToWindowKey(now.getHours());
  const windowData = windows[currentWindow];

  // Session target
  // We need session floor from the existing planner — pass it in from app.js
  // Here we compute what we can; sessionFloorSec will be injected by caller
  const breakMult = volumeBreakMultiplier(progressPct, vCfg);

  // Remaining volume
  const remainingSec = Math.max(0, volumeGoalSec - todayTotalSec);
  const volumeHit = todayTotalSec >= volumeGoalSec;

  return {
    // Floors & goals
    volumeFloorSec,
    volumeGoalSec,

    // Today
    todayTotalSec,
    todayCount,
    progressPct,
    remainingSec,
    volumeHit,
    todayStr,

    // Fatigue
    gapFatigue,
    lastEndMs,
    gapMinutes: lastEndMs ? Math.round((Date.now() - lastEndMs) / 60000) : null,

    // Windows
    windows,
    currentWindow,
    windowAvgSec: windowData?.avgSec || 0,

    // Breaks
    breakMultiplier: breakMult,

    // History
    dailyTotals,
  };
}

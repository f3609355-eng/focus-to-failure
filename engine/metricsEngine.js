import { clamp } from "../utils.js";
import { extractValidFocusSeconds } from "./floorEngine.js";

/** Simple (unweighted) quantile. */
function quantile(nums, q){
  if (!nums || !nums.length) return null;
  const s = [...nums].sort((a,b)=>a-b);
  if (q <= 0) return s[0];
  if (q >= 1) return s[s.length-1];
  const idx = q * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  const t = idx - lo;
  return s[lo] + (s[hi] - s[lo]) * t;
}

/**
 * Compute consistent planning metrics from history:
 * - Applies the SAME validity filter as the floor engine (minFracGoal).
 * - Uses a rolling window (metricsWindowN) for floor/median/ceiling/IQR.
 * - Also computes recent IQR/crashes/overshoots for wave gating.
 *
 * Returns seconds (integers) or nulls.
 */
export function computePlanningMetrics(blocks, cfg){
  const floorCfg = cfg.floor_engine || {};
  const aCfg = cfg.analytics || {};

  const minFracGoal = Number(floorCfg.min_frac_goal ?? 0.5);

  // valid focus seconds (for percentile metrics)
  const validFocus = extractValidFocusSeconds(blocks, { minFracGoal });

  const metricsWindowN = Math.max(5, Math.floor(aCfg.metrics_window_n ?? 21)); // odd recommended
  const recentN = Math.max(5, Math.floor(aCfg.recent_window_n ?? 13));

  if (validFocus.length < 2){
    return {
      floor:null, median:null, ceiling:null, iqr:null,
      recent_iqr:null, recent_crashes:0, recent_overshoots_7:0, recent_n:0,
      crash_threshold:null, overshoot_threshold:null,
      sample_n: validFocus.length
    };
  }

  const vals = validFocus.slice(-metricsWindowN);

  const floorP = clamp(Number(floorCfg.percentile ?? aCfg.floor_percentile ?? 0.35), 0.05, 0.95);
  const medP = clamp(Number(aCfg.median_percentile ?? 0.50), 0.05, 0.95);
  const ceilP = clamp(Number(aCfg.ceiling_percentile ?? 0.80), 0.05, 0.95);
  const q1P = clamp(Number(aCfg.iqr_low_percentile ?? 0.25), 0.05, 0.95);
  const q3P = clamp(Number(aCfg.iqr_high_percentile ?? 0.75), 0.05, 0.95);

  const F = quantile(vals, floorP);
  const M = quantile(vals, medP);
  const C = quantile(vals, ceilP);
  const Q1 = quantile(vals, q1P);
  const Q3 = quantile(vals, q3P);

  const floor = F==null?null:Math.round(F);
  const median = M==null?null:Math.round(M);
  const ceiling = C==null?null:Math.round(C);
  const iqr = (Q1==null||Q3==null)?null:Math.round(Q3-Q1);

  // thresholds derived from consistent metrics
  let crashThr = null;
  if (floor!=null){
    crashThr = Math.max((aCfg.crash_min_minutes ?? 8)*60, Math.round((aCfg.crash_relative_mult ?? 0.60)*floor));
  }
  let overThr = null;
  if (median!=null){
    overThr = Math.round((aCfg.overshoot_mult ?? 1.35)*median);
  }

  // Recent IQR: use valid focus (consistent with floor/median view)
  const recent = validFocus.slice(-recentN);
  const rn_valid = recent.length;

  let recentIQR = null;
  if (rn_valid >= 4){
    recentIQR = Math.round((quantile(recent, 0.75) ?? 0) - (quantile(recent, 0.25) ?? 0));
  }

  // Crash/overshoot counting: use ALL blocks (not just valid).
  // A crash IS a short block — filtering it out defeats the purpose.
  const allFocus = (blocks || []).map(b => Number(b.focus_seconds)).filter(x => x > 0);
  const allRecent = allFocus.slice(-recentN);
  const rn_all = allRecent.length;
  const recentCrashes = (crashThr==null)?0:allRecent.filter(x=>x<crashThr).length;
  const allLast7 = allFocus.slice(-7);
  const overs7 = (overThr==null)?0:allLast7.filter(x=>x>overThr).length;

  return {
    floor, median, ceiling, iqr,
    recent_iqr: recentIQR,
    recent_crashes: recentCrashes,
    recent_overshoots_7: overs7,
    recent_n: rn_all,
    recent_n_valid: rn_valid,
    crash_threshold: crashThr,
    overshoot_threshold: overThr,
    sample_n: vals.length
  };
}

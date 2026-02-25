import { clamp } from "../utils.js";
import { fatigueFactor, pushPctForMomentum } from "./waveEngine.js";

/**
 * Goal Engine v2
 * - Fatigue-adjusted goals (block N of day)
 * - Single PUSH type with momentum-driven intensity
 * - No floor bonus (floor = real P35 only)
 */

export function pickGoalFromBand(tl, th, intensity="Balanced"){
  const t = (intensity==="Easy") ? 0.35 : (intensity==="Hard") ? 0.65 : 0.50;
  return Math.round(tl + (th - tl) * t);
}

export function jitteredPct(base, jitter, rng=Math.random){
  const j = (rng()*2 - 1) * (jitter || 0);
  return clamp(base + j, 0, 0.5);
}

/** Adaptive minimum: can dip below 25 during calibration, restores milestone once floor is there. */
export function computeAdaptiveMinGoalSec(floorSec, waveCfg){
  const absMin = (waveCfg.absolute_min_minutes ?? 15) * 60;
  const milestone = (waveCfg.milestone_minutes ?? 25) * 60;
  const ratio = Number(waveCfg.adaptive_min_ratio ?? 0.90);
  if (!floorSec || floorSec <= 0) return milestone;
  return (floorSec < milestone)
    ? Math.max(absMin, Math.round(ratio * floorSec))
    : Math.max(milestone, Math.round(ratio * floorSec));
}

// ── Linear Mode ───────────────────────────

export function computeLinearBand(F, M, waveCfg){
  const tl = Math.max(F, (waveCfg.start_goal_minutes||25)*60);
  const th = Math.max(tl+60, Math.min(M, F + (waveCfg.consolidate_band_add_minutes||10)*60));
  return { tl, th };
}

export function computeLinearGoal({ tl, th, minGoalSec, intensity, linearGoalSec, evalBlocks, tier, waveCfg, blocksToday }){
  const winN = Math.max(3, Math.floor(waveCfg.linear_window_blocks || 5));
  const win = (evalBlocks||[]).filter(b=>b && b.goal_seconds!=null).slice(-winN);
  const success = win.filter(b=>Number(b.focus_seconds||0) >= Number(b.goal_seconds||0)).length;

  const bandGoal = pickGoalFromBand(tl, th, intensity);
  let goal = Math.max(minGoalSec, bandGoal);

  if (linearGoalSec && linearGoalSec > 0){
    goal = Math.max(goal, linearGoalSec);
  }

  let bumped = false;
  if (win.length >= winN && success >= (waveCfg.linear_success_needed || 3)){
    const bump = (tier===1) ? (waveCfg.linear_bump_tier1_sec||120)
               : (tier===2) ? (waveCfg.linear_bump_tier2_sec||60)
               : (tier===3) ? (waveCfg.linear_bump_tier3_sec||30)
               : (waveCfg.linear_bump_tier4_sec||15);
    goal = goal + bump;
    bumped = true;
  }

  // Apply fatigue curve
  const ff = fatigueFactor(blocksToday || 0, waveCfg);
  const fatigueGoal = Math.round(goal * ff);

  return { goalSec: Math.max(minGoalSec, fatigueGoal), rawGoalSec: goal, nextLinearGoalSec: goal, winN, success, bumped, fatigueFactor: ff };
}

// ── Wave Mode ─────────────────────────────

export function computeWaveEasyBand(F, M, waveCfg){
  const tl = Math.max((waveCfg.start_goal_minutes||25)*60, F);
  const th = Math.max(tl+60, Math.min(M, F + (waveCfg.easy_band_add_minutes||6)*60));
  return { tl, th };
}

export function computeWaveBand(F, M, waveCfg){
  const tl = Math.max(10*60, F);
  const th = Math.max(tl+60, Math.min(M, F + (waveCfg.target_band_add_minutes_wave||8)*60));
  return { tl, th };
}

/**
 * Compute wave goal.
 * - No floor bonus (F = real floor from P35)
 * - Push intensity from momentum
 * - Fatigue-adjusted
 */
export function computeWaveGoal({ bt, F, M, C, minGoalSec, intensity, waveCfg, momentum, blocksToday, rng=Math.random }){
  const { tl, th } = computeWaveBand(F, M, waveCfg);

  let pushTarget = 0;
  if (bt === "PUSH") {
    const pct = jitteredPct(
      pushPctForMomentum(momentum || { rate: 0.5 }, waveCfg),
      (waveCfg.push_jitter_pct || 0),
      rng
    );
    pushTarget = Math.round(F * (1.0 + pct));
    pushTarget = Math.min(pushTarget, C);
    pushTarget = Math.min(pushTarget, F + (waveCfg.push_cap_add_minutes || 12) * 60);
    pushTarget = Math.max(pushTarget, th + 60);
  }

  const baseGoal = Math.max(minGoalSec, pickGoalFromBand(tl, th, intensity));
  const rawGoal = (pushTarget > 0) ? Math.max(baseGoal, pushTarget) : baseGoal;

  // Apply fatigue curve
  const ff = fatigueFactor(blocksToday || 0, waveCfg);
  const fatigueGoal = Math.round(rawGoal * ff);
  const fatiguePush = pushTarget > 0 ? Math.round(pushTarget * ff) : 0;

  return {
    F, tl, th,
    pushTarget: fatiguePush,
    rawPushTarget: pushTarget,
    baseGoal,
    rawGoalSec: rawGoal,
    goalSec: Math.max(minGoalSec, fatigueGoal),
    fatigueFactor: ff,
    blocksToday: blocksToday || 0,
  };
}

import { clamp } from "../utils.js";

/**
 * Goal Engine
 * - Converts planner context (floor/median/ceiling + mode + block type) into a single displayed goal.
 * - Applies low-friction intensity pick + optional jitter + safety caps.
 */

export function pickGoalFromBand(tl, th, intensity="Balanced"){
  const t = (intensity==="Easy") ? 0.35 : (intensity==="Hard") ? 0.65 : 0.50;
  return Math.round(tl + (th - tl) * t);
}

export function jitteredPct(base, jitter, rng=Math.random){
  const j = (rng()*2 - 1) * (jitter || 0);
  return clamp(base + j, 0, 0.5);
}

/** Adaptive minimum: can dip below 25 during calibration, but restores milestone once floor is there. */
export function computeAdaptiveMinGoalSec(floorSec, waveCfg){
  const absMin = (waveCfg.absolute_min_minutes ?? 15) * 60;
  const milestone = (waveCfg.milestone_minutes ?? 25) * 60;
  const ratio = Number(waveCfg.adaptive_min_ratio ?? 0.90);
  if (!floorSec || floorSec <= 0) return milestone;
  return (floorSec < milestone)
    ? Math.max(absMin, Math.round(ratio * floorSec))
    : Math.max(milestone, Math.round(ratio * floorSec));
}

export function computeLinearBand(F, M, waveCfg){
  const tl = Math.max(F, (waveCfg.start_goal_minutes||25)*60);
  const th = Math.max(tl+60, Math.min(M, F + (waveCfg.target_band_add_minutes_stability||10)*60));
  return { tl, th };
}

export function computeLinearGoal({ tl, th, minGoalSec, intensity, linearGoalSec, evalBlocks, tier, waveCfg }){
  const winN = Math.max(3, Math.floor(waveCfg.linear_window_blocks || 5));
  const win = (evalBlocks||[]).filter(b=>b && b.goal_seconds!=null).slice(-winN);
  const success = win.filter(b=>Number(b.focus_seconds||0) >= Number(b.goal_seconds||0)).length;

  // pick one goal from the band + apply adaptive min
  const bandGoal = pickGoalFromBand(tl, th, intensity);
  let goal = Math.max(minGoalSec, bandGoal);

  // maintain a training goal
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

  return { goalSec: goal, nextLinearGoalSec: goal, winN, success, bumped };
}

export function computeWaveEasyBand(F, M, waveCfg){
  const tl = Math.max((waveCfg.start_goal_minutes||25)*60, F);
  const th = Math.max(tl+60, Math.min(M, F + (waveCfg.easy_consolidate_band_add_minutes||6)*60));
  return { tl, th };
}

export function computeWaveBand(vF, M, waveCfg){
  const tl = Math.max(10*60, vF);
  const th = Math.max(tl+60, Math.min(M, vF + (waveCfg.target_band_add_minutes_wave||8)*60));
  return { tl, th };
}

export function computeWaveGoal({ bt, F, M, C, floorBonusSec, minGoalSec, intensity, waveCfg, rng=Math.random }){
  const vF = F + (floorBonusSec||0);
  const { tl, th } = computeWaveBand(vF, M, waveCfg);

  let pushTarget = 0;
  if (bt==="PUSH_A"){
    const pctA = jitteredPct((waveCfg.push_a_pct_of_median||0.10), (waveCfg.push_jitter_pct||0), rng);
    pushTarget = Math.round(vF * (1.0 + pctA));
  } else if (bt==="PUSH_B"){
    const pctB = jitteredPct((waveCfg.push_b_pct_of_median||0.12), (waveCfg.push_jitter_pct||0), rng);
    pushTarget = Math.round(vF * (1.0 + pctB));
  }

  if (pushTarget > 0){
    pushTarget = Math.min(pushTarget, C);
    pushTarget = Math.min(pushTarget, vF + (waveCfg.push_cap_add_minutes||12)*60);
    pushTarget = Math.max(pushTarget, th + 60);
  }

  const baseGoal = Math.max(minGoalSec, pickGoalFromBand(tl, th, intensity));
  const goal = (pushTarget>0) ? Math.max(baseGoal, pushTarget) : baseGoal;

  return { vF, tl, th, pushTarget, baseGoal, goalSec: goal };
}

/**
 * Wave Engine v2
 * - Momentum-driven adaptive cycles (replaces fixed alternating pattern)
 * - Single PUSH type (replaces PUSH_A/PUSH_B)
 * - Phase transitions, plateau detection, stability gating
 */

export const Phase = { LINEAR:"LINEAR", WAVE:"WAVE" };
export const BlockType = { CONSOLIDATE:"CONSOLIDATE", RAISE_FLOOR:"RAISE_FLOOR", PUSH:"PUSH" };

// Back-compat: map old types
export function normalizeBlockType(bt) {
  if (bt === "PUSH_A" || bt === "PUSH_B") return BlockType.PUSH;
  return bt || BlockType.CONSOLIDATE;
}

export function tierForSeconds(s){
  if (s >= 90*60) return 4;
  if (s >= 75*60) return 3;
  if (s >= 45*60) return 2;
  return 1;
}

// ── Momentum ──────────────────────────────

/** Rolling win rate over last N blocks with goals. */
export function computeMomentum(blocks, windowN = 5) {
  const withGoals = (blocks || []).filter(b => b && b.goal_seconds > 0);
  const recent = withGoals.slice(-Math.max(3, windowN));
  if (recent.length < 2) return { rate: 0.5, wins: 0, total: recent.length, level: "MID" };
  const wins = recent.filter(b => {
    const f = Number(b.focus_seconds || 0);
    const g = Number(b.goal_seconds || 0);
    // Broadened success: hit goal OR within 90% on push blocks
    const isPush = normalizeBlockType(b.block_type) === BlockType.PUSH;
    return isPush ? (f >= g * 0.90) : (f >= g);
  }).length;
  const rate = wins / recent.length;
  return { rate, wins, total: recent.length };
}

export function momentumLevel(rate, waveCfg) {
  const hi = Number(waveCfg.momentum_high_threshold ?? 0.80);
  const lo = Number(waveCfg.momentum_low_threshold ?? 0.40);
  if (rate >= hi) return "HIGH";
  if (rate < lo) return "LOW";
  return "MID";
}

// ── Adaptive Cycles ───────────────────────

export function buildAdaptiveCycle(momentum, waveCfg) {
  const level = momentumLevel(momentum.rate, waveCfg);
  if (level === "HIGH") {
    // Aggressive: 50% push
    return [BlockType.PUSH, BlockType.CONSOLIDATE, BlockType.PUSH, BlockType.CONSOLIDATE];
  }
  if (level === "LOW") {
    // Recovery: 20% push
    return [BlockType.CONSOLIDATE, BlockType.CONSOLIDATE, BlockType.PUSH, BlockType.CONSOLIDATE, BlockType.CONSOLIDATE];
  }
  // Medium: 40% push (default)
  return [BlockType.PUSH, BlockType.CONSOLIDATE, BlockType.CONSOLIDATE, BlockType.PUSH, BlockType.CONSOLIDATE];
}

export function startNewCycle(prevId, waveCfg, momentum) {
  const cycleId = (prevId || 0) + 1;
  const cycle = buildAdaptiveCycle(momentum || { rate: 0.5 }, waveCfg);
  return { cycleId, cyclePos: 0, cycle };
}

/** Push intensity percentage based on momentum level. */
export function pushPctForMomentum(momentum, waveCfg) {
  const level = momentumLevel(momentum.rate, waveCfg);
  if (level === "HIGH") return Number(waveCfg.push_pct_high ?? 0.12);
  if (level === "LOW") return Number(waveCfg.push_pct_low ?? 0.05);
  return Number(waveCfg.push_pct_mid ?? 0.08);
}

export function cyclePreview(cycle, waveCfg){
  const vis = waveCfg.wave_visibility;
  if (vis === "Hidden") return null;
  if (!cycle || !cycle.length) return null;
  if (vis === "Subtle") return "SUBTLE";
  const ab = { CONSOLIDATE:"C", RAISE_FLOOR:"R", PUSH:"P" };
  return cycle.map(t => ab[t] || t).join(" ");
}

// ── Fatigue ───────────────────────────────

/** Compute fatigue factor for the Nth block today (0-indexed). */
export function fatigueFactor(blocksToday, waveCfg) {
  const rate = Number(waveCfg.fatigue_rate_per_block ?? 0.06);
  const floor = Number(waveCfg.fatigue_floor ?? 0.75);
  return Math.max(floor, 1 - rate * blocksToday);
}

// ── Crash Severity ────────────────────────

/**
 * Determine crash recovery blocks.
 * - Fatigue crash (block 4+ of day): no penalty
 * - Mild crash (within 80% of threshold): 1 easy block
 * - Hard crash (below 80% of threshold): 2 easy blocks
 */
export function crashRecoveryBlocks(focusSec, crashThreshold, blocksToday, waveCfg) {
  // Late-day crashes get no penalty — fatigue curve already accounted for it
  if (blocksToday >= 3) return 0;
  if (crashThreshold == null || crashThreshold <= 0) return 0;

  const hardFrac = Number(waveCfg.hard_crash_fraction ?? 0.80);
  if (focusSec < crashThreshold * hardFrac) {
    return Number(waveCfg.forced_easy_hard_crash ?? 2);
  }
  return Number(waveCfg.forced_easy_mild_crash ?? 1);
}

// ── Wave Gating & Stability ───────────────

export function gateIntoWave(m, analyticsCfg){
  if (m.floor==null || m.recent_iqr==null) return false;
  if (m.recent_n < analyticsCfg.recent_window_n) return false;
  if (m.recent_crashes > analyticsCfg.wave_gate_max_crashes_in_recent) return false;
  if (m.recent_iqr > analyticsCfg.wave_gate_max_recent_iqr_minutes*60) return false;
  if (m.floor < analyticsCfg.wave_gate_min_floor_minutes*60) return false;
  return true;
}

export function dropToStability(m, prevRecentIQR, analyticsCfg){
  if (m.recent_n >= analyticsCfg.recent_window_n && m.recent_crashes >= analyticsCfg.drop_to_stability_if_crashes_ge) return true;
  if (m.recent_overshoots_7 >= analyticsCfg.drop_to_stability_if_overshoots_ge_in7) return true;
  if (prevRecentIQR!=null && m.recent_iqr!=null && prevRecentIQR>0){
    const widen = (m.recent_iqr - prevRecentIQR)/prevRecentIQR;
    if (widen > analyticsCfg.drop_to_stability_if_recent_iqr_widens_pct) return true;
  }
  return false;
}

// ── Plateau Detection ─────────────────────

export function detectPlateau(evalBlocks, waveCfg, floorCfg={}){
  const N = Math.max(6, Math.floor(waveCfg.plateau_eval_blocks || 10));
  const minFracGoal = Number((floorCfg && floorCfg.min_frac_goal) ?? 0.5);
  const recent = (evalBlocks||[])
    .filter(b=>b && b.focus_seconds!=null)
    .filter(b=>{
      const f = Number(b.focus_seconds||0);
      const g = Number(b.goal_seconds ?? b.goal_sec ?? b.goal);
      if (Number.isFinite(g) && g>0){
        if (f < minFracGoal * g) return false;
      }
      return true;
    })
    .slice(-N);
  const focusVals = recent.map(b=>Number(b.focus_seconds||0));
  const avg = focusVals.length ? focusVals.reduce((a,x)=>a+x,0)/focusVals.length : 0;
  const std = focusVals.length ? Math.sqrt(focusVals.reduce((a,x)=>a+Math.pow(x-avg,2),0)/focusVals.length) : 0;

  const half = Math.max(1, Math.floor(focusVals.length/2));
  const a1 = focusVals.slice(0,half);
  const a2 = focusVals.slice(half);
  const m1 = a1.length ? a1.reduce((a,x)=>a+x,0)/a1.length : 0;
  const m2 = a2.length ? a2.reduce((a,x)=>a+x,0)/a2.length : 0;
  const improvePct = (m1>0) ? (m2-m1)/m1 : 0;

  const fails = recent.filter(b=>b.stop_reason==="DISTRACTED" || b.crash).length;
  const plateauByFails = fails >= (waveCfg.plateau_fail_ge || 4);
  const plateauByFlat = improvePct < (waveCfg.plateau_flat_improve_pct || 0.01);
  const volRatio = (avg>0)? (std/avg) : 0;
  const plateauByVol = volRatio > (waveCfg.plateau_volatility_up_pct || 0.15);

  const plateau = (plateauByFails && plateauByFlat) || (plateauByFails && plateauByVol) || (plateauByFlat && plateauByVol);

  return { plateau, plateauByFails, plateauByFlat, plateauByVol, improvePct, volRatio, fails, sampleN: recent.length };
}

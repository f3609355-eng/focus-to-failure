/**
 * Wave Engine
 * - Owns phase transition logic helpers, cycle generation, and plateau detection.
 */

export const Phase = { LINEAR:"LINEAR", WAVE:"WAVE" };
export const BlockType = { CONSOLIDATE:"CONSOLIDATE", RAISE_FLOOR:"RAISE_FLOOR", PUSH_A:"PUSH_A", PUSH_B:"PUSH_B" };

export function tierForSeconds(s){
  if (s >= 90*60) return 4;
  if (s >= 75*60) return 3;
  if (s >= 45*60) return 2;
  return 1;
}

export function buildAlternatingCycle(len){
  const L = Math.max(3, Math.floor(len||5));
  const out = [];
  let pushFlip = false;
  for (let i=0;i<L;i++){
    if (i % 2 === 0){
      out.push(pushFlip ? BlockType.PUSH_B : BlockType.PUSH_A);
      pushFlip = !pushFlip;
    } else {
      out.push(BlockType.CONSOLIDATE);
    }
  }
  return out;
}

export function startNewCycle(prevId, cfgWave){
  const cycleId = (prevId||0) + 1;
  const cyclePos = 0;
  const cycle = buildAlternatingCycle(cfgWave.cycle_length);
  return { cycleId, cyclePos, cycle };
}

export function cyclePreview(cycle, waveCfg){
  const vis = waveCfg.wave_visibility;
  if (vis === "Hidden") return null;
  if (!cycle || !cycle.length) return null;
  if (vis === "Subtle") return "SUBTLE";
  const ab = { CONSOLIDATE:"C", RAISE_FLOOR:"R", PUSH_A:"P1", PUSH_B:"P2" };
  return cycle.map(t=>ab[t]||t).join(" ");
}

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

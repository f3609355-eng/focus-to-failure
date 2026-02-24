import { DEFAULT_CONFIG } from "../config.js";
import { computeMetrics } from "../analytics.js";
import { blendMetrics } from "../engine/blendEngine.js";
import { WavePlanner } from "../planner.js";
import { nowTimestamp, bucketForDate } from "../utils.js";

/** deterministic PRNG */
export function mulberry32(a){
  return function(){
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(x,a,b){ return Math.max(a, Math.min(b, x)); }

function dateForSim(dayIndex, blockIndex, blocksPerDay){
  // Spread blocks through day: 9:00, 12:30, 16:00, 20:00
  const hours = [9, 12, 16, 20];
  const h = hours[blockIndex % hours.length];
  const d = new Date();
  d.setHours(0,0,0,0);
  d.setDate(d.getDate() + dayIndex);
  d.setHours(h, 0, 0, 0);
  return d;
}

function simulateUserFocusSeconds(goalSec, state, model, rng){
  // "skill" increases slowly with exposure, but fatigue reduces later-in-day performance
  const noise = (rng()*2 - 1) * (model.noise || 0.1);
  const fatigue = state.blockIndexToday * (model.fatigue || 0.06);
  const skill = clamp(state.skill + noise - fatigue, 0.05, 0.95);

  // plateau: stop learning after plateauDay if configured
  const learnRate = (model.plateauDay != null && state.dayIndex >= model.plateauDay) ? 0 : (model.learnRate || 0.01);
  state.skill = clamp(state.skill + learnRate, 0.05, 0.95);

  // Focus duration: skill determines how close to goal you get.
  // At skill=0.5, average ~90% of goal. At skill=0.8, average ~110%.
  // Wide noise band creates realistic distribution of hits and misses.
  const baseMult = 0.45 + 0.9 * skill;  // 0.5→0.90, 0.7→1.08, 0.9→1.26
  const jitter = (rng()*2 - 1) * 0.20;  // ±20% jitter
  const mult = clamp(baseMult + jitter, 0.40, 1.40);
  const dur = Math.round(goalSec * mult);

  // Occasional hard interruption (simulate <50% goal — phone call, emergency, etc.)
  if (rng() < 0.05) return Math.round(goalSec * 0.3);

  // Occasional distraction-induced early quit
  if (rng() < 0.08) return Math.round(goalSec * (0.55 + rng() * 0.15));

  return dur;
}

export function runScenario(profile, cfgOverrides={}){
  // Build config
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  Object.assign(cfg, cfgOverrides);

  // Clear planner state for clean start
  try { localStorage.removeItem("ftf_training_state_v2"); } catch(e) {}
  try { localStorage.removeItem("ftf_intensity"); } catch(e) {}

  const rng = mulberry32(profile.seed || 1);

  // monkeypatch Math.random for deterministic jitter inside engines
  const origRandom = Math.random;
  Math.random = rng;

  const planner = new WavePlanner(cfg);
  const blocks = [];
  let idx = 0;

  const userState = { skill: profile.model.baseSkill || 0.5, dayIndex: 0, blockIndexToday: 0 };

  for (let day=0; day<profile.days; day++){
    if (profile.model.gapEvery && day>0 && day % profile.model.gapEvery === 0){
      continue;
    }
    userState.dayIndex = day;
    userState.blockIndexToday = 0;

    for (let bi=0; bi<profile.blocksPerDay; bi++){
      const d = dateForSim(day, bi, profile.blocksPerDay);
      const bucketNow = bucketForDate(d);
      const bucketBlocks = blocks.filter(b => b.bucket === bucketNow);

      const mGlobal = computeMetrics(blocks, cfg);
      const mBucket = computeMetrics(bucketBlocks, cfg);
      const mBlend = blendMetrics(mGlobal, mBucket, bucketBlocks.length, cfg);

      const plan = planner.planNext(blocks, {
        floor_global: mBlend.floor_global,
        floor_bucket: mBlend.floor_bucket,
        floor: mBlend.floor,
        median_global: mBlend.median_global,
        median_bucket: mBlend.median_bucket,
        median: mBlend.median,
        ceiling_global: mBlend.ceiling_global,
        ceiling_bucket: mBlend.ceiling_bucket,
        ceiling: mBlend.ceiling,
        recent_iqr: mBlend.recent_iqr,
        recent_n: mBlend.recent_n,
        recent_crashes: mBlend.recent_crashes,
        recent_overshoots_7: mBlend.recent_overshoots_7,
        bucket_weight: mBlend.bucket_weight,
        bucket_n: mBlend.bucket_n,
      }, { bucket: bucketNow, bucketBlocks });

      const goalSec = plan.goal_sec;

      const focusSec = simulateUserFocusSeconds(goalSec, userState, profile.model, rng);
      const isWin = focusSec >= goalSec;

      // Use real analytics thresholds (same as app.js finalizeFocus)
      const crashThr = mBlend.crash_threshold;
      const overThr = mBlend.overshoot_threshold;
      const crash = crashThr != null && focusSec < crashThr;
      const overshoot = overThr != null && focusSec > overThr;

      const isPush = (plan.block_type === "PUSH_A" || plan.block_type === "PUSH_B");
      const pushTarget = isPush ? plan.push_target : 0;
      const pushHit = isPush ? focusSec >= pushTarget : false;

      const stop_reason = "DISTRACTED";

      // break: approximate - use config break_percent
      const breakSeconds = Math.round((cfg.breaks.break_percent/100) * focusSec);

      const block = {
        idx: idx++,
        goal_seconds: goalSec,
        focus_seconds: focusSec,
        is_win: isWin,
        crash,
        overshoot,
        stop_reason,
        break_seconds: breakSeconds,
        bucket: bucketNow,
        timestamp: d.toISOString(),
        phase: plan.phase,
        block_type: plan.block_type,
        target_low_seconds: plan.target_low,
        target_high_seconds: plan.target_high,
        push_target_seconds: pushTarget,
        push_hit: pushHit,
        wave_cycle_id: plan.wave_cycle_id || 0,
        wave_cycle_pos: plan.wave_cycle_pos || 0,
      };

      blocks.push(block);

      // update planner with full block record (matches app.js finalizeFocus)
      planner.updateAfterBlock(block);

      userState.blockIndexToday += 1;
    }
  }

  Math.random = origRandom;

  // summary
  const last = blocks[blocks.length-1] || null;
  const floors = blocks.map(b=>b.floor_effective_seconds).filter(x=>Number.isFinite(x));
  return { blocks, last, count: blocks.length };
}

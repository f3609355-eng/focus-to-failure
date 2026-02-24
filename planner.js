import { computeRawFloor, updateEffectiveFloor } from "./engine/floorEngine.js";
import {
  Phase, BlockType, tierForSeconds, detectPlateau,
  startNewCycle, buildAlternatingCycle, cyclePreview,
  dropToStability
} from "./engine/waveEngine.js";
import {
  computeAdaptiveMinGoalSec, computeLinearBand, computeLinearGoal,
  computeWaveEasyBand, computeWaveGoal, pickGoalFromBand
} from "./engine/goalEngine.js";

export { Phase, BlockType };

// ════════════════════════════════════════════════
// localStorage key for training state
// ════════════════════════════════════════════════
const STATE_KEY = "ftf_training_state_v2";

// ════════════════════════════════════════════════
// WavePlanner
// ════════════════════════════════════════════════

export class WavePlanner {
  constructor(cfg) {
    this.cfg = cfg;

    // Core state
    this.phase = Phase.LINEAR;
    this.linearGoalSec = 0;

    // Wave cycle state
    this.cycleId = 0;
    this.cyclePos = 0;
    this.cycle = [];

    // Floor progression
    this.floorBonus = 0;
    this.cleanStreak = 0;
    this.forcedEasy = 0;

    // Floor engine persistence
    this.floorSec = null;
    this.floorDate = null;

    // Stability tracking
    this.prevRecentIQR = null;

    // Hydrate from storage (survives refresh)
    this._hydrateFromStorage();
  }

  setConfig(cfg) { this.cfg = cfg; }

  // ── Persistence ──────────────────────────────

  loadTrainingState() {
    try {
      const raw = localStorage.getItem(STATE_KEY);
      if (!raw) return null;
      const st = JSON.parse(raw);
      return {
        mode:             st.mode || Phase.LINEAR,
        linear_goal_sec:  Number(st.linear_goal_sec || 0),
        cycle_id:         Number(st.cycle_id || 0),
        cycle_pos:        Number(st.cycle_pos || 0),
        cycle:            Array.isArray(st.cycle) ? st.cycle : [],
        floor_bonus_sec:  Number(st.floor_bonus_sec || 0),
        clean_streak:     Number(st.clean_streak || 0),
        forced_easy:      Number(st.forced_easy || 0),
        prev_recent_iqr:  (st.prev_recent_iqr == null) ? null : Number(st.prev_recent_iqr),
        floor_sec:        (st.floor_sec == null) ? null : Number(st.floor_sec),
        floor_date:       st.floor_date || null,
      };
    } catch (e) {
      return null;
    }
  }

  /** Persist full planner state to localStorage. */
  _saveState() {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({
        mode:             this.phase,
        linear_goal_sec:  this.linearGoalSec,
        cycle_id:         this.cycleId,
        cycle_pos:        this.cyclePos,
        cycle:            this.cycle,
        floor_bonus_sec:  this.floorBonus,
        clean_streak:     this.cleanStreak,
        forced_easy:      this.forcedEasy,
        prev_recent_iqr:  this.prevRecentIQR,
        floor_sec:        this.floorSec ?? null,
        floor_date:       this.floorDate ?? null,
      }));
    } catch (e) { /* ignore */ }
  }

  // Alias for backward compat
  saveTrainingState() { this._saveState(); }

  _hydrateFromStorage() {
    const st = this.loadTrainingState();
    if (!st) return;

    this.phase         = (st.mode === Phase.WAVE) ? Phase.WAVE : Phase.LINEAR;
    this.linearGoalSec = st.linear_goal_sec || 0;
    this.cycleId       = st.cycle_id || 0;
    this.cyclePos      = st.cycle_pos || 0;
    this.cycle         = Array.isArray(st.cycle) ? st.cycle : [];
    this.floorBonus    = st.floor_bonus_sec || 0;
    this.cleanStreak   = st.clean_streak || 0;
    this.forcedEasy    = st.forced_easy || 0;
    this.prevRecentIQR = (st.prev_recent_iqr == null) ? null : st.prev_recent_iqr;
    this.floorSec      = (st.floor_sec == null) ? null : st.floor_sec;
    this.floorDate     = st.floor_date || null;

    // If wave mode was active but cycle is missing (older builds), rebuild it.
    if (this.phase === Phase.WAVE && !this.cycle.length) {
      this.cycle = buildAlternatingCycle(this.cfg.wave.cycle_length);
      this.cyclePos = 0;
    }
  }

  // ── Floor Engine ─────────────────────────────

  _computeEffectiveFloor(blocks, evalBlocks, m) {
    const fc = this.cfg.floor_engine || {};

    const rawGlobal = computeRawFloor(blocks, {
      windowN:     fc.window_n ?? 11,
      percentile:  fc.percentile ?? 0.35,
      minFracGoal: fc.min_frac_goal ?? 0.5,
    });
    const rawBucket = computeRawFloor(evalBlocks, {
      windowN:     fc.window_n ?? 11,
      percentile:  fc.percentile ?? 0.35,
      minFracGoal: fc.min_frac_goal ?? 0.5,
    });

    // Blend raw floors using bucket weight from metrics
    const bw = (m && Number.isFinite(m.bucket_weight)) ? Number(m.bucket_weight) : 0;
    let rawEff = rawGlobal.rawFloorSec;
    if (rawBucket.rawFloorSec != null && rawGlobal.rawFloorSec != null) {
      rawEff = Math.round((1 - bw) * rawGlobal.rawFloorSec + bw * rawBucket.rawFloorSec);
    } else if (rawBucket.rawFloorSec != null && rawGlobal.rawFloorSec == null) {
      rawEff = rawBucket.rawFloorSec;
    }

    // Asymmetric smoothing + daily decay guard
    const upd = updateEffectiveFloor(
      this.floorSec, rawEff, new Date(), this.floorDate,
      {
        upRate:           fc.up_rate ?? 0.35,
        downRate:         fc.down_rate ?? 0.10,
        maxDailyDropFrac: fc.max_daily_drop_frac ?? 0.02,
      }
    );

    this.floorSec  = upd.floorSec;
    this.floorDate = upd.ymd;

    return {
      effectiveFloorSec: upd.floorSec,
      rawEff,
      rawGlobal,
      rawBucket,
      bucketWeight: bw,
    };
  }

  // ── Main Planning ────────────────────────────

  planNext(blocks, m, ctx = {}) {
    if (m.recent_iqr != null) this.prevRecentIQR = m.recent_iqr;

    const w = this.cfg.wave;
    const strategy = w.training_strategy || "LINEAR_THEN_WAVE";
    const intensity = localStorage.getItem("ftf_intensity") || "Balanced";

    // Bucket-aware evaluation blocks
    const evalBlocks = (ctx && Array.isArray(ctx.bucketBlocks) && ctx.bucketBlocks.length)
      ? ctx.bucketBlocks : blocks;

    // ── Floor engine (single source of truth for floor) ──
    const fe = this._computeEffectiveFloor(blocks, evalBlocks, m);

    // ── BOOT: no stats yet ──
    if (m.floor == null || m.median == null) {
      const tl = (w.start_goal_band_low_minutes || 20) * 60;
      const th = (w.start_goal_band_high_minutes || 30) * 60;
      const goal = pickGoalFromBand(tl, th, intensity);
      this._saveState();
      return {
        phase: Phase.LINEAR,
        block_type: BlockType.CONSOLIDATE,
        target_low: tl, target_high: th,
        push_target: 0, goal_sec: goal,
        floor_sec: 0,
        min_goal_sec: (w.milestone_minutes ?? 25) * 60,
        wave_cycle_id: this.cycleId, wave_cycle_pos: 0,
        cycle_preview: null,
        debug: { mode: "BOOT", strategy },
      };
    }

    // ── Effective metrics ──
    const F_raw = m.floor;
    const M = m.median;
    const C = m.ceiling ?? M;
    // Use floor engine output; fall back to analytics floor if engine returned null
    const F = fe.effectiveFloorSec ?? F_raw;

    const minGoalSec = computeAdaptiveMinGoalSec(F, w);
    const tier = tierForSeconds(F);

    // ── Plateau detection ──
    const pz = detectPlateau(evalBlocks, w, this.cfg.floor_engine);

    // ── Phase transition: LINEAR → WAVE ──
    if (strategy === "LINEAR_THEN_WAVE") {
      if (this.phase !== Phase.WAVE && pz.plateau) {
        this.phase = Phase.WAVE;
        this.linearGoalSec = 0;
        const nc = startNewCycle(this.cycleId, w);
        this.cycleId  = nc.cycleId;
        this.cyclePos = nc.cyclePos;
        this.cycle    = nc.cycle;
      }
    } else {
      this.phase = Phase.WAVE;
    }

    // ── Stability check (wave mode safety valve) ──
    if (this.phase === Phase.WAVE) {
      if (dropToStability(m, this.prevRecentIQR, this.cfg.analytics)) {
        this.forcedEasy = Math.max(this.forcedEasy, w.forced_easy_consolidate_blocks_after_crash || 2);
        this.cleanStreak = 0;
      }
    }

    // ── LINEAR MODE ──
    if (this.phase === Phase.LINEAR) {
      const { tl, th } = computeLinearBand(F, M, w);
      const lin = computeLinearGoal({
        tl, th, minGoalSec, intensity,
        linearGoalSec: this.linearGoalSec,
        evalBlocks, tier, waveCfg: w,
      });
      this.linearGoalSec = lin.nextLinearGoalSec;
      this._saveState();

      return {
        phase: Phase.LINEAR,
        block_type: BlockType.CONSOLIDATE,
        target_low: tl, target_high: th,
        push_target: 0, goal_sec: lin.goalSec,
        floor_sec: F, min_goal_sec: minGoalSec, tier,
        wave_cycle_id: this.cycleId, wave_cycle_pos: 0,
        cycle_preview: null,
        debug: {
          mode: "LINEAR", strategy,
          plateau: pz.plateau, plateauByFails: pz.plateauByFails,
          plateauByFlat: pz.plateauByFlat, plateauByVol: pz.plateauByVol,
          improvePct: pz.improvePct, volRatio: pz.volRatio, fails: pz.fails,
          success: lin.success, winN: lin.winN, bumped: lin.bumped, tier,
          floor_raw: F_raw, floor_effective: F,
          floor_engine: fe,
        },
      };
    }

    // ── WAVE MODE ──

    // Start new cycle if needed
    if (!this.cycle.length || this.cyclePos >= w.cycle_length) {
      const nc = startNewCycle(this.cycleId, w);
      this.cycleId  = nc.cycleId;
      this.cyclePos = nc.cyclePos;
      this.cycle    = nc.cycle;
    }

    // Forced easy consolidation (after crash or stability drop)
    if (this.forcedEasy > 0) {
      this.forcedEasy -= 1;
      const { tl, th } = computeWaveEasyBand(F, M, w);
      const goal = Math.max(minGoalSec, pickGoalFromBand(tl, th, intensity));
      this._saveState();

      return {
        phase: Phase.WAVE,
        block_type: BlockType.CONSOLIDATE,
        target_low: tl, target_high: th,
        push_target: 0, goal_sec: goal,
        floor_sec: F, min_goal_sec: minGoalSec, tier,
        wave_cycle_id: this.cycleId,
        wave_cycle_pos: this.cyclePos + 1,
        cycle_preview: cyclePreview(this.cycle, w),
        debug: { mode: "WAVE_EASY", strategy, tier, floor_raw: F_raw, floor_effective: F },
      };
    }

    // Normal wave block
    const bt = this.cycle[this.cyclePos];
    this.cyclePos += 1;

    const wg = computeWaveGoal({
      bt, F, M, C,
      floorBonusSec: this.floorBonus,
      minGoalSec, intensity, waveCfg: w,
    });

    this._saveState();

    return {
      phase: Phase.WAVE,
      block_type: bt,
      target_low: wg.tl, target_high: wg.th,
      push_target: wg.pushTarget, goal_sec: wg.goalSec,
      floor_sec: F, min_goal_sec: minGoalSec, tier,
      wave_cycle_id: this.cycleId,
      wave_cycle_pos: this.cyclePos,
      cycle_preview: cyclePreview(this.cycle, w),
      debug: {
        mode: "WAVE", strategy, tier,
        floor_raw: F_raw, floor_effective: F,
        vF: wg.vF, baseGoal: wg.baseGoal, pushTarget: wg.pushTarget,
        floor_engine: fe,
      },
    };
  }

  // ── Post-block Update ────────────────────────

  updateAfterBlock(log) {
    const w = this.cfg.wave;

    if (this.phase !== Phase.WAVE) {
      this.forcedEasy = 0;
      this.cleanStreak = 0;
      this._saveState();
      return;
    }

    // Crash: reset streak, force easy blocks
    if (log.crash) {
      this.cleanStreak = 0;
      this.forcedEasy = w.forced_easy_consolidate_blocks_after_crash || 2;
      this._saveState();
      return;
    }

    // Overshoot: reset streak only
    if (log.overshoot) {
      this.cleanStreak = 0;
      this._saveState();
      return;
    }

    // Evaluate success
    const isPush = (log.block_type === BlockType.PUSH_A || log.block_type === BlockType.PUSH_B);
    let success = true;

    if (isPush) {
      success = !!log.push_hit;
    } else {
      const lo = Number(log.target_low_seconds) || 0;
      const hi = Number(log.target_high_seconds) || 0;
      const fs = Number(log.focus_seconds) || 0;
      if (lo > 0 && hi > 0) success = (fs >= lo && fs <= hi);
    }

    if (!success) {
      this.cleanStreak = 0;
      this._saveState();
      return;
    }

    this.cleanStreak += 1;
    if (this.cleanStreak >= w.floor_raise_clean_streak) {
      this.cleanStreak = 0;
      this.floorBonus += w.floor_raise_increment_seconds;
    }

    this._saveState();
  }
}

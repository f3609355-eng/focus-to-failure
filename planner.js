import { computeRawFloor, updateEffectiveFloor } from "./engine/floorEngine.js";
import {
  Phase, BlockType, normalizeBlockType, tierForSeconds, detectPlateau,
  startNewCycle, cyclePreview, computeMomentum, momentumLevel,
  dropToStability, fatigueFactor, crashRecoveryBlocks,
  buildAdaptiveCycle
} from "./engine/waveEngine.js";
import {
  computeAdaptiveMinGoalSec, computeLinearBand, computeLinearGoal,
  computeWaveEasyBand, computeWaveGoal, pickGoalFromBand
} from "./engine/goalEngine.js";

export { Phase, BlockType };

const STATE_KEY = "ftf_training_state_v3";

export class WavePlanner {
  constructor(cfg) {
    this.cfg = cfg;

    this.phase = Phase.LINEAR;
    this.linearGoalSec = 0;

    this.cycleId = 0;
    this.cyclePos = 0;
    this.cycle = [];

    this.forcedEasy = 0;
    this.forcedRecoveryMode = false;

    this.floorSec = null;
    this.floorDate = null;
    this.earnedMilestones = [];

    this.prevRecentIQR = null;

    this._committedForN = -1;
    this._lastPlan = null;

    this._hydrateFromStorage();
  }

  setConfig(cfg) {
    this.cfg = cfg;
    this._committedForN = -1;
    this._lastPlan = null;
  }

  _commitPlan(plan, blockCount) {
    this._committedForN = blockCount;
    this._lastPlan = plan;
    this._saveState();
    return plan;
  }

  // ── Persistence ──────────────────────────────

  loadTrainingState() {
    try {
      let raw = localStorage.getItem(STATE_KEY);
      if (!raw) raw = localStorage.getItem("ftf_training_state_v2");
      if (!raw) return null;
      const st = JSON.parse(raw);
      return {
        mode:               st.mode || Phase.LINEAR,
        linear_goal_sec:    Number(st.linear_goal_sec || 0),
        cycle_id:           Number(st.cycle_id || 0),
        cycle_pos:          Number(st.cycle_pos || 0),
        cycle:              Array.isArray(st.cycle) ? st.cycle : [],
        forced_easy:        Number(st.forced_easy || 0),
        forced_recovery:    !!st.forced_recovery,
        prev_recent_iqr:    (st.prev_recent_iqr == null) ? null : Number(st.prev_recent_iqr),
        floor_sec:          (st.floor_sec == null) ? null : Number(st.floor_sec),
        floor_date:         st.floor_date || null,
        earned_milestones:  Array.isArray(st.earned_milestones) ? st.earned_milestones : [],
      };
    } catch (e) {
      return null;
    }
  }

  _saveState() {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({
        mode:               this.phase,
        linear_goal_sec:    this.linearGoalSec,
        cycle_id:           this.cycleId,
        cycle_pos:          this.cyclePos,
        cycle:              this.cycle,
        forced_easy:        this.forcedEasy,
        forced_recovery:    this.forcedRecoveryMode,
        prev_recent_iqr:    this.prevRecentIQR,
        floor_sec:          this.floorSec ?? null,
        floor_date:         this.floorDate ?? null,
        earned_milestones:  this.earnedMilestones,
      }));
    } catch (e) { /* ignore */ }
  }

  saveTrainingState() { this._saveState(); }

  _hydrateFromStorage() {
    const st = this.loadTrainingState();
    if (!st) return;

    this.phase              = (st.mode === Phase.WAVE) ? Phase.WAVE : Phase.LINEAR;
    this.linearGoalSec      = st.linear_goal_sec || 0;
    this.cycleId            = st.cycle_id || 0;
    this.cyclePos           = st.cycle_pos || 0;
    this.cycle              = Array.isArray(st.cycle) ? st.cycle : [];
    this.forcedEasy         = st.forced_easy || 0;
    this.forcedRecoveryMode = !!st.forced_recovery;
    this.prevRecentIQR      = (st.prev_recent_iqr == null) ? null : st.prev_recent_iqr;
    this.floorSec           = (st.floor_sec == null) ? null : st.floor_sec;
    this.floorDate          = st.floor_date || null;
    this.earnedMilestones   = Array.isArray(st.earned_milestones) ? st.earned_milestones : [];

    if (this.cycle.length) {
      this.cycle = this.cycle.map(normalizeBlockType);
    }

    if (this.phase === Phase.WAVE && !this.cycle.length) {
      this.cycle = buildAdaptiveCycle({ rate: 0.5 }, this.cfg.wave);
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

    const bw = (m && Number.isFinite(m.bucket_weight)) ? Number(m.bucket_weight) : 0;
    let rawEff = rawGlobal.rawFloorSec;
    if (rawBucket.rawFloorSec != null && rawGlobal.rawFloorSec != null) {
      rawEff = Math.round((1 - bw) * rawGlobal.rawFloorSec + bw * rawBucket.rawFloorSec);
    } else if (rawBucket.rawFloorSec != null && rawGlobal.rawFloorSec == null) {
      rawEff = rawBucket.rawFloorSec;
    }

    const upd = updateEffectiveFloor(
      this.floorSec, rawEff, new Date(), this.floorDate,
      {
        upRate:           fc.up_rate ?? 0.35,
        downRate:         fc.down_rate ?? 0.10,
        maxDailyDropFrac: fc.max_daily_drop_frac ?? 0.02,
      }
    );

    const prevFloor = this.floorSec;
    this.floorSec  = upd.floorSec;
    this.floorDate = upd.ymd;

    let newMilestone = null;
    if (upd.floorSec != null) {
      const milestones = this.cfg.wave.floor_milestones || [15,20,25,30,40,50,60,75,90,120];
      for (const ms of milestones) {
        const msSec = ms * 60;
        if (upd.floorSec >= msSec && !this.earnedMilestones.includes(ms)) {
          this.earnedMilestones.push(ms);
          newMilestone = ms;
        }
      }
    }

    return {
      effectiveFloorSec: upd.floorSec,
      rawEff, rawGlobal, rawBucket, bucketWeight: bw,
      newMilestone,
    };
  }

  // ── Main Planning ────────────────────────────

  planNext(blocks, m, ctx = {}) {
    const n = (blocks || []).length;

    if (n === this._committedForN && this._lastPlan) {
      return this._lastPlan;
    }

    if (m.recent_iqr != null) this.prevRecentIQR = m.recent_iqr;

    const w = this.cfg.wave;
    const strategy = w.training_strategy || "LINEAR_THEN_WAVE";
    const intensity = ctx.intensity || "Balanced";
    const blocksToday = ctx.blocksToday || 0;

    const evalBlocks = (ctx && Array.isArray(ctx.bucketBlocks) && ctx.bucketBlocks.length)
      ? ctx.bucketBlocks : blocks;

    const fe = this._computeEffectiveFloor(blocks, evalBlocks, m);
    const momentum = computeMomentum(blocks, w.momentum_window || 5);
    const momLevel = momentumLevel(momentum.rate, w);

    // ── BOOT ──
    if (m.floor == null || m.median == null) {
      const tl = (w.start_goal_band_low_minutes || 20) * 60;
      const th = (w.start_goal_band_high_minutes || 30) * 60;
      const goal = pickGoalFromBand(tl, th, intensity);
      return this._commitPlan({
        phase: Phase.LINEAR,
        block_type: BlockType.CONSOLIDATE,
        target_low: tl, target_high: th,
        push_target: 0, goal_sec: goal, raw_goal_sec: goal,
        floor_sec: 0,
        min_goal_sec: (w.milestone_minutes ?? 25) * 60,
        wave_cycle_id: this.cycleId, wave_cycle_pos: 0,
        cycle_preview: null,
        momentum, momLevel,
        fatigue_factor: fatigueFactor(blocksToday, w),
        blocks_today: blocksToday,
        new_milestone: fe.newMilestone,
        earned_milestones: [...this.earnedMilestones],
        debug: { mode: "BOOT", strategy },
      }, n);
    }

    const F_raw = m.floor;
    const M = m.median;
    const C = m.ceiling ?? M;
    const F = fe.effectiveFloorSec ?? F_raw;

    const minGoalSec = computeAdaptiveMinGoalSec(F, w);
    const tier = tierForSeconds(F);
    const pz = detectPlateau(evalBlocks, w, this.cfg.floor_engine);

    // ── Phase transition ──
    if (strategy === "LINEAR_THEN_WAVE") {
      if (this.phase !== Phase.WAVE && pz.plateau) {
        this.phase = Phase.WAVE;
        this.linearGoalSec = 0;
        const nc = startNewCycle(this.cycleId, w, momentum);
        this.cycleId  = nc.cycleId;
        this.cyclePos = nc.cyclePos;
        this.cycle    = nc.cycle;
      }
    } else {
      this.phase = Phase.WAVE;
    }

    // ── Stability check ──
    if (this.phase === Phase.WAVE) {
      if (dropToStability(m, this.prevRecentIQR, this.cfg.analytics)) {
        this.forcedEasy = Math.max(this.forcedEasy, w.forced_easy_hard_crash || 2);
      }
    }

    const planBase = {
      momentum, momLevel,
      fatigue_factor: fatigueFactor(blocksToday, w),
      blocks_today: blocksToday,
      new_milestone: fe.newMilestone,
      earned_milestones: [...this.earnedMilestones],
    };

    // ── LINEAR ──
    if (this.phase === Phase.LINEAR) {
      const { tl, th } = computeLinearBand(F, M, w);
      const lin = computeLinearGoal({
        tl, th, minGoalSec, intensity,
        linearGoalSec: this.linearGoalSec,
        evalBlocks, tier, waveCfg: w,
        blocksToday,
      });
      this.linearGoalSec = lin.nextLinearGoalSec;

      return this._commitPlan({
        ...planBase,
        phase: Phase.LINEAR,
        block_type: BlockType.CONSOLIDATE,
        target_low: tl, target_high: th,
        push_target: 0, goal_sec: lin.goalSec,
        raw_goal_sec: lin.rawGoalSec,
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
          fatigue_factor: lin.fatigueFactor,
          momentum_rate: momentum.rate, momentum_level: momLevel,
          floor_engine: fe,
        },
      }, n);
    }

    // ── WAVE ──

    if (!this.cycle.length || this.cyclePos >= this.cycle.length) {
      const effMomentum = this.forcedRecoveryMode ? { rate: 0 } : momentum;
      this.forcedRecoveryMode = false;
      const nc = startNewCycle(this.cycleId, w, effMomentum);
      this.cycleId  = nc.cycleId;
      this.cyclePos = nc.cyclePos;
      this.cycle    = nc.cycle;
    }

    if (this.forcedEasy > 0) {
      this.forcedEasy -= 1;
      const { tl, th } = computeWaveEasyBand(F, M, w);
      const ff = fatigueFactor(blocksToday, w);
      const rawGoal = Math.max(minGoalSec, pickGoalFromBand(tl, th, intensity));
      const goal = Math.max(minGoalSec, Math.round(rawGoal * ff));

      return this._commitPlan({
        ...planBase,
        phase: Phase.WAVE,
        block_type: BlockType.CONSOLIDATE,
        target_low: tl, target_high: th,
        push_target: 0, goal_sec: goal, raw_goal_sec: rawGoal,
        floor_sec: F, min_goal_sec: minGoalSec, tier,
        wave_cycle_id: this.cycleId,
        wave_cycle_pos: this.cyclePos + 1,
        cycle_preview: cyclePreview(this.cycle, w),
        debug: { mode: "WAVE_EASY", strategy, tier, floor_raw: F_raw, floor_effective: F,
                 fatigue_factor: ff, momentum_rate: momentum.rate, momentum_level: momLevel },
      }, n);
    }

    const bt = this.cycle[this.cyclePos];
    this.cyclePos += 1;

    const wg = computeWaveGoal({
      bt, F, M, C,
      minGoalSec, intensity, waveCfg: w,
      momentum, blocksToday,
    });

    return this._commitPlan({
      ...planBase,
      phase: Phase.WAVE,
      block_type: bt,
      target_low: wg.tl, target_high: wg.th,
      push_target: wg.pushTarget, goal_sec: wg.goalSec,
      raw_goal_sec: wg.rawGoalSec,
      floor_sec: F, min_goal_sec: minGoalSec, tier,
      wave_cycle_id: this.cycleId,
      wave_cycle_pos: this.cyclePos,
      cycle_preview: cyclePreview(this.cycle, w),
      debug: {
        mode: "WAVE", strategy, tier,
        floor_raw: F_raw, floor_effective: F,
        baseGoal: wg.baseGoal, pushTarget: wg.pushTarget,
        rawPushTarget: wg.rawPushTarget,
        fatigue_factor: wg.fatigueFactor,
        momentum_rate: momentum.rate, momentum_level: momLevel,
        floor_engine: fe,
      },
    }, n);
  }

  // ── Post-block Update ────────────────────────

  updateAfterBlock(log) {
    const w = this.cfg.wave;

    this._committedForN = -1;
    this._lastPlan = null;

    if (this.phase !== Phase.WAVE) {
      this.forcedEasy = 0;
      this._saveState();
      return;
    }

    if (log.crash) {
      const recovery = crashRecoveryBlocks(
        Number(log.focus_seconds || 0),
        Number(log.crash_threshold || 0),
        Number(log.blocks_today || 0),
        w
      );
      this.forcedEasy = recovery;

      const hardFrac = Number(w.hard_crash_fraction ?? 0.80);
      const threshold = Number(log.crash_threshold || 0);
      if (threshold > 0 && Number(log.focus_seconds || 0) < threshold * hardFrac) {
        this.forcedRecoveryMode = true;
      }

      this._saveState();
      return;
    }

    this._saveState();
  }
}

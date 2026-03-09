export function createRecoveryController({ localStorage, sessionKey, nowTimestamp, bucketForDate, fmtHHMMSS }) {
  function save({ mode, startTS, elapsed, focusStartSnapshot }) {
    if (mode !== "FOCUS" || startTS == null) return;
    try {
      localStorage.setItem(sessionKey, JSON.stringify({
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

  function clear() {
    try { localStorage.removeItem(sessionKey); } catch (e) { /* ignore */ }
  }

  function get() {
    try {
      const raw = localStorage.getItem(sessionKey);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (Date.now() - (s.savedAt || 0) > 12 * 3600 * 1000) {
        clear();
        return null;
      }
      if (!s.elapsed || s.elapsed < 10) {
        clear();
        return null;
      }
      return s;
    } catch (e) {
      return null;
    }
  }

  async function recover({ session, blocks, putBlock, planner, invalidateCache, renderTable, redrawCharts, syncHeader, setStatus, computeBreakSeconds }) {
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
    clear();

    renderTable();
    redrawCharts();
    syncHeader();
    setStatus(`Recovered ${fmtHHMMSS(focusSeconds)} focus block from interrupted session.`, "good");
  }

  return { save, clear, get, recover };
}

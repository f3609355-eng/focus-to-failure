import { clamp } from "../utils.js";

/**
 * Floor Engine — simple, asymmetric, low-surprise.
 *
 * Raw floor: rolling quantile of last N valid blocks.
 * Update: asymmetric smoothing (up faster than down) + max daily decay guard.
 *
 * All units are seconds.
 */

/** Return sorted numeric array */
function sorted(nums){
  return [...nums].sort((a,b)=>a-b);
}

/** Simple (unweighted) quantile. q in [0,1]. */
function quantile(nums, q){
  if (!nums || !nums.length) return null;
  const s = sorted(nums);
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
 * Extract focus seconds for "valid-ish" blocks.
 * Ignore blocks with focus < minFracGoal * goal (if goal exists).
 */
export function extractValidFocusSeconds(blocks, opts={}){
  const minFracGoal = Number(opts.minFracGoal ?? 0.5);
  const out = [];
  for (const b of (blocks || [])){
    if (!b) continue;
    const f = Number(b.focus_seconds);
    if (!Number.isFinite(f) || f <= 0) continue;

    const g = Number(b.goal_seconds ?? b.goal_sec ?? b.goal);
    if (Number.isFinite(g) && g > 0){
      if (f < minFracGoal * g) continue; // treat as fatigue/interruption for floor
    }
    out.push(f);
  }
  return out;
}

/**
 * Raw floor estimate from last N valid blocks.
 * Returns { rawFloorSec, sampleN }.
 */
export function computeRawFloor(blocks, opts={}){
  const N = Math.max(3, Math.floor(opts.windowN ?? 11));
  const q = clamp(Number(opts.percentile ?? 0.35), 0.05, 0.95);
  const valsAll = extractValidFocusSeconds(blocks, opts);
  const vals = valsAll.slice(-N);
  if (vals.length < 3) return { rawFloorSec: null, sampleN: vals.length };
  const raw = quantile(vals, q);
  return { rawFloorSec: (raw==null?null:Math.round(raw)), sampleN: vals.length };
}

function ymd(d){
  const dt = (d instanceof Date) ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  const y = dt.getFullYear();
  const m = String(dt.getMonth()+1).padStart(2,'0');
  const da = String(dt.getDate()).padStart(2,'0');
  return `${y}-${m}-${da}`;
}

function daysBetween(a, b){
  const A = new Date(a+"T00:00:00");
  const B = new Date(b+"T00:00:00");
  const ms = B.getTime() - A.getTime();
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.round(ms / (24*3600*1000)));
}

/**
 * Apply asymmetric smoothing + max daily decay.
 * prevFloorSec: previous stored effective floor (seconds) or null.
 * rawFloorSec: new raw estimate (seconds) or null.
 * now: Date
 * prevDateYMD: 'YYYY-MM-DD' when prevFloorSec was last updated (or null).
 *
 * opts:
 *  - upRate (default 0.35)
 *  - downRate (default 0.10)
 *  - maxDailyDropFrac (default 0.02)
 */
export function updateEffectiveFloor(prevFloorSec, rawFloorSec, now, prevDateYMD, opts={}){
  const upRate = clamp(Number(opts.upRate ?? 0.35), 0, 1);
  const downRate = clamp(Number(opts.downRate ?? 0.10), 0, 1);
  const maxDailyDropFrac = clamp(Number(opts.maxDailyDropFrac ?? 0.02), 0, 0.2);

  if (rawFloorSec == null){
    return { floorSec: prevFloorSec ?? null, ymd: ymd(now) };
  }

  let floor = (prevFloorSec==null)? rawFloorSec : Number(prevFloorSec);

  const delta = rawFloorSec - floor;
  const rate = (delta >= 0) ? upRate : downRate;
  floor = floor + rate * delta;

  floor = Math.round(floor);

  // Max daily decay guard
  const today = ymd(now);
  if (prevFloorSec != null && prevDateYMD && today){
    const d = daysBetween(prevDateYMD, today);
    const allowedDrop = Math.round(Number(prevFloorSec) * (maxDailyDropFrac * Math.max(1, d)));
    const minAllowed = Math.round(Number(prevFloorSec) - allowedDrop);
    if (floor < minAllowed) floor = minAllowed;
  }

  return { floorSec: floor, ymd: today };
}

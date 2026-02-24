import { clamp } from "../utils.js";

/**
 * Soft bucket blending shared by app + simulations.
 * - If bucket count is small, rely mostly on global.
 * - As bucket count approaches K_full, trust bucket more.
 *
 * cfg.analytics.bucket_min_n   (default 3)
 * cfg.analytics.bucket_full_n  (default 9)
 */
export function bucketBlendWeight(bucketN, cfg){
  const minN = Math.max(0, Number(cfg?.analytics?.bucket_min_n ?? 3));
  const fullN = Math.max(minN+1, Number(cfg?.analytics?.bucket_full_n ?? 9));
  const n = Math.max(0, Number(bucketN || 0));
  if (n <= minN) return 0;
  const w = (n - minN) / (fullN - minN);
  return clamp(w, 0, 1);
}

export function blendScalar(globalVal, bucketVal, w){
  if (bucketVal == null || !Number.isFinite(bucketVal)) return globalVal;
  if (globalVal == null || !Number.isFinite(globalVal)) return bucketVal;
  return (1-w)*globalVal + w*bucketVal;
}

/** Blend metrics object (floor/median/ceiling/iqr + recent_iqr passthrough). */
export function blendMetrics(mGlobal, mBucket, bucketN, cfg){
  const w = bucketBlendWeight(bucketN, cfg);
  return {
    bucket_weight: w,
    bucket_n: bucketN || 0,
    floor_global: mGlobal?.floor ?? null,
    median_global: mGlobal?.median ?? null,
    ceiling_global: mGlobal?.ceiling ?? null,
    iqr_global: mGlobal?.iqr ?? null,

    floor_bucket: mBucket?.floor ?? null,
    median_bucket: mBucket?.median ?? null,
    ceiling_bucket: mBucket?.ceiling ?? null,
    iqr_bucket: mBucket?.iqr ?? null,

    floor: blendScalar(mGlobal?.floor ?? null, mBucket?.floor ?? null, w),
    median: blendScalar(mGlobal?.median ?? null, mBucket?.median ?? null, w),
    ceiling: blendScalar(mGlobal?.ceiling ?? null, mBucket?.ceiling ?? null, w),
    iqr: blendScalar(mGlobal?.iqr ?? null, mBucket?.iqr ?? null, w),

    // recent metrics: keep global as default
    recent_iqr: mGlobal?.recent_iqr ?? null,
    recent_n: mGlobal?.recent_n ?? 0,
    recent_crashes: mGlobal?.recent_crashes ?? 0,
    recent_overshoots_7: mGlobal?.recent_overshoots_7 ?? 0,

    // thresholds: use global (derived from global floor/median)
    crash_threshold: mGlobal?.crash_threshold ?? null,
    overshoot_threshold: mGlobal?.overshoot_threshold ?? null,
  };
}
